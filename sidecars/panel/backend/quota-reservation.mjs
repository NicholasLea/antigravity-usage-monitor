/**
 * @fileoverview 实验性配额预占估算器（`quota-reservation.mjs`）。
 *
 * 基于分布式配额租约（Per-Bucket / Per-Session Quota Lease）的行为特征：
 * 1. 5h 桶及周限桶各自独立追踪（支持错档触发）；
 * 2. 多高消耗会话并发时支持多笔租约线性叠加（如 0.5% / 1.0% / 2.0%+）；
 * 3. 在租约期内继续产生真实消耗时按单桶换算率扣减可退差额；
 * 4. 上游退还租约（同周期内 officialUsedPct 下降）时按 FIFO 精准核销并反向校准单桶费率；
 * 5. 轻量 O(1) 状态机 + DATA_DIR 节流持久化（保留最近 500 条事件，重启及热更新后自动恢复）。
 */

import { parseIsoMs } from '../trajectory-metrics.mjs';
import {
  QUOTA_RESERVATION_STATE_FILE,
  loadJson,
  lsRuntimeEndpoint,
  saveJson,
} from './config.mjs';

export const QR_LEASE_TTL_MS = 10 * 60 * 1000;
export const QR_LEASE_GRACE_MS = 90 * 1000;
export const QR_LEASE_IDLE_EXPIRY_MS = QR_LEASE_TTL_MS + QR_LEASE_GRACE_MS;
export const QR_LEASE_MAX_AGE_MS = 22 * 60 * 1000;
export const QR_PENDING_COST_TTL_MS = 60 * 1000;
export const QR_CYCLE_RESET_SHIFT_MS = 30 * 60 * 1000;
export const QR_MIN_JUMP_EXCESS_PCT = 0.35;
export const QR_COLD_START_JUMP_PCT = 0.45;
export const QR_COLD_START_MAX_COST_USD = 0.25;
export const QR_REFUND_EPSILON_PCT = 0.04;
export const QR_MIN_DISPLAY_RESERVED_PCT = 0.05;
export const QR_IDLE_CONFIRM_REFUND_MS = 5 * 60 * 1000;
export const QR_REFUND_CONFIRM_WINDOW_MS = 90 * 1000;
export const QR_REFUND_CONFIRM_MIN_SAMPLES = 3;
export const QR_RATE_BOUNCE_COOLDOWN_MS = 60 * 1000;
export const QR_RATE_WINDOW_SIZE = 20;
export const QR_RATE_OUTLIER_MIN_RATIO = 0.45;
export const QR_RATE_OUTLIER_MAX_RATIO = 2.0;
export const QR_RATE_DRIFT_STREAK = 5;
export const QR_CONSUME_MIN_SHORTFALL_PCT = 0.03;
export const QR_CONSUME_SHORTFALL_RATIO = 0.35;
const QR_MAX_TRACKED_BUCKETS = 128;
const QR_MAX_ACTIVE_LEASES = 16;
const QR_MAX_EVENT_LOG = 500;
const QR_PERSIST_MIN_INTERVAL_MS = 5000;
const QR_STATE_SCHEMA_VERSION = 2;

function qrClamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function qrRound1(val) {
  return Math.round(val * 10) / 10;
}

function qrClampRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return qrClamp(rate, 0.005, 50);
}

function qrResolveExactUsedPct(poolObj, win) {
  const rawFrac =
    win === 'weekly' ? poolObj?.weeklyRemainingFraction : poolObj?.remainingFraction;
  if (rawFrac !== undefined && rawFrac !== null && Number.isFinite(Number(rawFrac))) {
    return qrClamp((1 - qrClamp(Number(rawFrac), 0, 1)) * 100, 0, 100);
  }
  const rawUsed = win === 'weekly' ? poolObj?.weeklyUsedPct : poolObj?.usedPct;
  if (rawUsed !== undefined && rawUsed !== null && Number.isFinite(Number(rawUsed))) {
    return qrClamp(Number(rawUsed), 0, 100);
  }
  return null;
}

function qrSumLeases(leases) {
  let sum = 0;
  for (let i = 0; i < leases.length; i += 1) {
    sum += Math.max(0, Number(leases[i]?.remainingPct) || 0);
  }
  return sum;
}

function qrConsumeLeasesFifo(leases, amountPct) {
  let left = Math.max(0, Number(amountPct) || 0);
  if (left <= 0 || leases.length === 0) return 0;
  let consumed = 0;
  for (let i = 0; i < leases.length && left > 1e-6; i += 1) {
    const cur = Math.max(0, Number(leases[i].remainingPct) || 0);
    const take = Math.min(cur, left);
    leases[i].remainingPct = cur - take;
    left -= take;
    consumed += take;
  }
  for (let i = leases.length - 1; i >= 0; i -= 1) {
    if (leases[i].remainingPct <= 1e-4) {
      leases.splice(i, 1);
    }
  }
  return consumed;
}

function qrComputeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function qrRecordRateSample(state, sampleRate) {
  const clamped = qrClampRate(sampleRate);
  if (clamped === null) return false;
  const win = Array.isArray(state.rateWindow) ? state.rateWindow : (state.rateWindow = []);

  if (win.length >= 4) {
    const med = qrComputeMedian(win);
    const lowBound = med * QR_RATE_OUTLIER_MIN_RATIO;
    const highBound = med * QR_RATE_OUTLIER_MAX_RATIO;
    if (clamped < lowBound || clamped > highBound) {
      const side = clamped > highBound ? 1 : -1;
      if (state.rateOutlierSide !== side) {
        state.rateOutlierSide = side;
        state.rateOutlierBuf = [clamped];
      } else {
        state.rateOutlierBuf.push(clamped);
      }
      if (state.rateOutlierBuf.length >= QR_RATE_DRIFT_STREAK) {
        // 连续多次干净同向偏移（如账号套餐倍率变化），重置中位数窗口
        state.rateWindow = state.rateOutlierBuf.slice(-QR_RATE_WINDOW_SIZE);
        state.rateOutlierSide = 0;
        state.rateOutlierBuf = [];
        state.ratePctPerUsd = qrClampRate(qrComputeMedian(state.rateWindow));
        state.rateSamples += 1;
        return true;
      }
      return false;
    }
  }

  state.rateOutlierSide = 0;
  state.rateOutlierBuf = [];
  win.push(clamped);
  if (win.length > QR_RATE_WINDOW_SIZE) {
    win.splice(0, win.length - QR_RATE_WINDOW_SIZE);
  }
  state.ratePctPerUsd = qrClampRate(qrComputeMedian(win));
  state.rateSamples += 1;
  return true;
}

function qrResolveEffectiveRate(state, officialUsedPct, cycleCostUsd) {
  if (state.ratePctPerUsd !== null && Number.isFinite(state.ratePctPerUsd)) {
    return state.ratePctPerUsd;
  }
  if (cycleCostUsd >= 0.5 && officialUsedPct >= 0.3) {
    return qrClampRate(officialUsedPct / cycleCostUsd);
  }
  return null;
}

function qrPruneExpiredLeases(state, nowMs) {
  if (state.activeLeases.length === 0) return;
  for (let i = state.activeLeases.length - 1; i >= 0; i -= 1) {
    const lease = state.activeLeases[i];
    const lastActiveMs = lease.lastTouchedMs || lease.createdAtMs || 0;
    const idleExpired = lastActiveMs > 0 && nowMs - lastActiveMs >= QR_LEASE_IDLE_EXPIRY_MS;
    const maxAgeExpired = nowMs - (lease.createdAtMs || 0) >= QR_LEASE_MAX_AGE_MS;
    if (idleExpired || maxAgeExpired) {
      state.activeLeases.splice(i, 1);
    }
  }
}

function qrFormatOutput(state, officialUsedPct) {
  const rawSum = qrSumLeases(state.activeLeases);
  let dropOffset = 0;
  if (state.pendingDrop && Number.isFinite(state.pendingDrop.preDropUsedPct)) {
    const costSinceDrop = Math.max(
      0,
      Number(state.lastCycleCostUsd || 0) - Number(state.pendingDrop.preDropCostUsd || 0)
    );
    const expectedSinceDrop =
      state.ratePctPerUsd !== null && Number.isFinite(state.ratePctPerUsd)
        ? costSinceDrop * state.ratePctPerUsd
        : 0;
    dropOffset = Math.max(0, state.pendingDrop.preDropUsedPct + expectedSinceDrop - officialUsedPct);
  }
  const visibleRaw = Math.max(0, rawSum - dropOffset);
  const rawReserved = qrClamp(visibleRaw, 0, officialUsedPct);
  if (rawReserved < QR_MIN_DISPLAY_RESERVED_PCT) {
    return {
      reservedPct: 0,
      reservedLeaseCount: 0,
      reservedExpiresAtMs: null,
    };
  }
  const rounded = qrClamp(qrRound1(rawReserved), 0, qrRound1(officialUsedPct));
  let earliestExpiresAtMs = null;
  for (let i = 0; i < state.activeLeases.length; i += 1) {
    const exp =
      (state.activeLeases[i].lastTouchedMs || state.activeLeases[i].createdAtMs || 0) +
      QR_LEASE_TTL_MS;
    if (exp > 0 && (earliestExpiresAtMs === null || exp < earliestExpiresAtMs)) {
      earliestExpiresAtMs = exp;
    }
  }
  return {
    reservedPct: rounded,
    reservedLeaseCount: state.activeLeases.length,
    reservedExpiresAtMs: earliestExpiresAtMs,
  };
}

function qrSanitizePersistedLeases(rawLeases) {
  if (!Array.isArray(rawLeases)) return [];
  const out = [];
  for (let i = 0; i < rawLeases.length && out.length < QR_MAX_ACTIVE_LEASES; i += 1) {
    const item = rawLeases[i];
    if (!item || typeof item !== 'object') continue;
    const rem = Number(item.remainingPct);
    const amt = Number(item.amountPct);
    const createdAtMs = Number(item.createdAtMs) || 0;
    const lastTouchedMs = Number(item.lastTouchedMs) || createdAtMs;
    if (!Number.isFinite(rem) || rem <= 1e-4) continue;
    out.push({
      amountPct: Number.isFinite(amt) && amt > 0 ? amt : rem,
      remainingPct: rem,
      createdAtMs,
      lastTouchedMs,
      sessionCount: Math.max(1, Number(item.sessionCount) || 1),
    });
  }
  return out;
}

function qrSanitizePersistedPendingDrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const preDropUsedPct = Number(raw.preDropUsedPct);
  const lowestUsedPct = Number(raw.lowestUsedPct);
  const dropPct = Number(raw.dropPct);
  const droppedAtMs = Number(raw.droppedAtMs) || 0;
  if (!Number.isFinite(preDropUsedPct) || !Number.isFinite(lowestUsedPct) || !Number.isFinite(dropPct) || dropPct <= 0 || droppedAtMs <= 0) {
    return null;
  }
  return {
    preDropUsedPct: qrClamp(preDropUsedPct, 0, 100),
    preDropCostUsd: Math.max(0, Number(raw.preDropCostUsd) || 0),
    dropPct: qrClamp(dropPct, 0, 100),
    droppedAtMs,
    lowSamples: Math.max(1, Math.floor(Number(raw.lowSamples) || 1)),
    lowestUsedPct: qrClamp(lowestUsedPct, 0, 100),
  };
}

function qrSanitizePersistedBucket(raw, { preserveRate = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lastOfficial =
    raw.lastOfficialUsedPct !== undefined &&
    raw.lastOfficialUsedPct !== null &&
    Number.isFinite(Number(raw.lastOfficialUsedPct))
      ? qrClamp(Number(raw.lastOfficialUsedPct), 0, 100)
      : null;
  const rateWindow =
    preserveRate && Array.isArray(raw.rateWindow)
      ? raw.rateWindow
          .map((v) => qrClampRate(Number(v)))
          .filter((v) => v !== null)
          .slice(-QR_RATE_WINDOW_SIZE)
      : [];
  const rate = preserveRate
    ? rateWindow.length > 0
      ? qrClampRate(qrComputeMedian(rateWindow))
      : raw.ratePctPerUsd !== undefined && raw.ratePctPerUsd !== null
        ? qrClampRate(Number(raw.ratePctPerUsd))
        : null
    : null;
  return {
    resetTimeMs: Math.max(0, Number(raw.resetTimeMs) || 0),
    lastQuotaTs: Math.max(0, Number(raw.lastQuotaTs) || 0),
    lastOfficialUsedPct: lastOfficial,
    lastCycleCostUsd: Math.max(0, Number(raw.lastCycleCostUsd) || 0),
    lastUnpricedCalls: Math.max(0, Number(raw.lastUnpricedCalls) || 0),
    pendingCostUsd: 0,
    pendingCostAtMs: 0,
    ratePctPerUsd: rate,
    rateSamples: preserveRate ? Math.max(rateWindow.length, Math.floor(Number(raw.rateSamples) || 0)) : 0,
    rateWindow,
    rateOutlierSide: 0,
    rateOutlierBuf: [],
    activeLeases: qrSanitizePersistedLeases(raw.activeLeases),
    pendingDrop: preserveRate ? qrSanitizePersistedPendingDrop(raw.pendingDrop) : null,
    lastBounceAtMs: Math.max(0, Number(raw.lastBounceAtMs) || 0),
    lastRefundAtMs: Math.max(0, Number(raw.lastRefundAtMs) || 0),
    lastRefundPct: Math.max(0, Number(raw.lastRefundPct) || 0),
  };
}

/**
 * 创建独立的配额预占状态追踪器（支持可选持久化钩子及单元测试隔离）。
 *
 * @param {{ loadState?: () => object|null, saveState?: (payload: object) => void }} [options]
 */
export function createQuotaReservationTracker({ loadState = null, saveState = null } = {}) {
  const buckets = new Map();
  const eventLog = [];
  let hydrated = typeof loadState !== 'function';
  let lastPersistMs = 0;

  function ensureHydrated() {
    if (hydrated) return;
    hydrated = true;
    try {
      const persisted = loadState?.();
      if (!persisted || typeof persisted !== 'object') return;
      const isCurrentSchema = Number(persisted.version) === QR_STATE_SCHEMA_VERSION;
      if (persisted.buckets && typeof persisted.buckets === 'object') {
        const entries = Object.entries(persisted.buckets).slice(-QR_MAX_TRACKED_BUCKETS);
        for (const [k, rawSt] of entries) {
          // 从 v1 升级到 v2 时丢弃旧版可能被双副本抖动污染的 EMA 费率，保留历史事件日志
          const clean = qrSanitizePersistedBucket(rawSt, { preserveRate: isCurrentSchema });
          if (k && clean) {
            buckets.set(k, clean);
          }
        }
      }
      if (Array.isArray(persisted.events)) {
        const recent = persisted.events
          .filter((e) => e && typeof e === 'object' && typeof e.ts === 'string')
          .slice(-QR_MAX_EVENT_LOG);
        eventLog.push(...recent);
      }
    } catch {
      // 忽略损坏的持久化状态，自动从空白基线重建
    }
  }

  function serializeState(nowMs = Date.now()) {
    const serializedBuckets = {};
    for (const [k, st] of buckets.entries()) {
      serializedBuckets[k] = {
        resetTimeMs: st.resetTimeMs,
        lastQuotaTs: st.lastQuotaTs,
        lastOfficialUsedPct: st.lastOfficialUsedPct,
        lastCycleCostUsd: st.lastCycleCostUsd,
        lastUnpricedCalls: st.lastUnpricedCalls,
        ratePctPerUsd: st.ratePctPerUsd,
        rateSamples: st.rateSamples,
        rateWindow: st.rateWindow,
        activeLeases: st.activeLeases,
        pendingDrop: st.pendingDrop,
        lastBounceAtMs: st.lastBounceAtMs,
        lastRefundAtMs: st.lastRefundAtMs,
        lastRefundPct: st.lastRefundPct,
      };
    }
    return {
      version: QR_STATE_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      buckets: serializedBuckets,
      events: eventLog.slice(-QR_MAX_EVENT_LOG),
    };
  }

  function persistIfNeeded(eventKind, nowMs) {
    if (typeof saveState !== 'function') return;
    if (
      !eventKind ||
      eventKind === 'idle' ||
      eventKind === 'lag_pending' ||
      eventKind === 'drop_pending' ||
      eventKind === 'replica_flip'
    ) {
      return;
    }
    const isUrgent =
      eventKind === 'lease' ||
      eventKind === 'refund' ||
      eventKind === 'reset' ||
      eventKind === 'expire';
    if (!isUrgent && lastPersistMs > 0 && nowMs - lastPersistMs < QR_PERSIST_MIN_INTERVAL_MS) {
      return;
    }
    lastPersistMs = nowMs;
    try {
      saveState(serializeState(nowMs));
    } catch {
      // 持久化失败不影响内存态主流程
    }
  }

  function appendEventLog(entry, nowMs) {
    eventLog.push(entry);
    if (eventLog.length > QR_MAX_EVENT_LOG) {
      eventLog.splice(0, eventLog.length - QR_MAX_EVENT_LOG);
    }
    persistIfNeeded(entry.event, nowMs);
  }

  function getOrCreateBucket(bucketKey) {
    let st = buckets.get(bucketKey);
    if (st) {
      buckets.delete(bucketKey);
      buckets.set(bucketKey, st);
      return st;
    }
    if (buckets.size >= QR_MAX_TRACKED_BUCKETS) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    st = {
      resetTimeMs: 0,
      lastQuotaTs: 0,
      lastOfficialUsedPct: null,
      lastCycleCostUsd: 0,
      lastUnpricedCalls: 0,
      pendingCostUsd: 0,
      pendingCostAtMs: 0,
      ratePctPerUsd: null,
      rateSamples: 0,
      rateWindow: [],
      rateOutlierSide: 0,
      rateOutlierBuf: [],
      activeLeases: [],
      pendingDrop: null,
      lastBounceAtMs: 0,
      lastRefundAtMs: 0,
      lastRefundPct: 0,
    };
    buckets.set(bucketKey, st);
    return st;
  }

  function observeBucket({
    bucketKey,
    poolKey = '',
    win = '',
    officialUsedPct,
    resetTimeMs = 0,
    quotaFetchedAtMs = 0,
    cycleCostUsd = 0,
    unpricedCalls = 0,
    poolLastActivityMs = 0,
    activeSessionCount10m = 0,
    recent10mCostUsd = 0,
    nowMs = Date.now(),
  }) {
    if (officialUsedPct === null || !Number.isFinite(officialUsedPct)) {
      return { reservedPct: 0, reservedLeaseCount: 0, reservedExpiresAtMs: null };
    }
    ensureHydrated();
    const safeUsed = qrClamp(Number(officialUsedPct), 0, 100);
    const safeCost = Math.max(0, Number(cycleCostUsd) || 0);
    const safeUnpriced = Math.max(0, Number(unpricedCalls) || 0);
    const safeResetMs = Number(resetTimeMs) > 0 ? Number(resetTimeMs) : 0;
    const safeFetchTs = Number(quotaFetchedAtMs) > 0 ? Number(quotaFetchedAtMs) : nowMs;
    const safeSess10m = Math.max(0, Number(activeSessionCount10m) || 0);
    const safeCost10m = Math.max(0, Number(recent10mCostUsd) || 0);
    const parsedParts = String(bucketKey || '').split('::');
    const logPool = poolKey || parsedParts[2] || '';
    const logWin = win || parsedParts[3] || '';
    const st = getOrCreateBucket(bucketKey);

    const recordLog = (event, fields = {}) => {
      appendEventLog(
        {
          ts: new Date(nowMs).toISOString(),
          pool: logPool,
          win: logWin,
          event,
          usedPct: +safeUsed.toFixed(3),
          dUsed: +(Number(fields.deltaOfficial) || 0).toFixed(3),
          costUsd: +safeCost.toFixed(4),
          dCost: +(Number(fields.rawDeltaCost) || 0).toFixed(4),
          expPct: +(Number(fields.expectedDeltaPct) || 0).toFixed(3),
          excessPct: +(Number(fields.excessPct) || 0).toFixed(3),
          rate: st.ratePctPerUsd !== null ? +st.ratePctPerUsd.toFixed(4) : null,
          rsvPct: Number(fields.reservedPct) || 0,
          leases: Number(fields.reservedLeaseCount) || 0,
          sess10m: safeSess10m,
          cost10m: +safeCost10m.toFixed(4),
        },
        nowMs
      );
    };

    // 1. 周期重置检测：静默忽略 0% 空闲池的滑动重置时间漂移；真正跨周期时清空租约但保留单桶费率
    const resetShifted =
      safeResetMs > 0 &&
      st.resetTimeMs > 0 &&
      Math.abs(safeResetMs - st.resetTimeMs) > QR_CYCLE_RESET_SHIFT_MS;
    const rolloverDrop =
      st.lastOfficialUsedPct !== null && st.lastOfficialUsedPct >= 5 && safeUsed < 1;
    if (resetShifted || rolloverDrop) {
      const prevUsed = st.lastOfficialUsedPct ?? 0;
      const isIdleZeroDrift =
        !rolloverDrop &&
        prevUsed < 0.05 &&
        safeUsed < 0.05 &&
        st.activeLeases.length === 0 &&
        st.pendingDrop === null;
      st.resetTimeMs = safeResetMs;
      st.lastQuotaTs = safeFetchTs;
      st.lastOfficialUsedPct = safeUsed;
      st.lastCycleCostUsd = safeCost;
      st.lastUnpricedCalls = safeUnpriced;
      if (isIdleZeroDrift) {
        return qrFormatOutput(st, safeUsed);
      }
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
      st.activeLeases = [];
      st.pendingDrop = null;
      const out = qrFormatOutput(st, safeUsed);
      recordLog('reset', { deltaOfficial: safeUsed - prevUsed, ...out });
      return out;
    }

    // 2. 首次观测：建立基线并按当前周期已有消耗做冷启动费率估计（不入中位数样本池）
    if (st.lastOfficialUsedPct === null) {
      st.resetTimeMs = safeResetMs;
      st.lastQuotaTs = safeFetchTs;
      st.lastOfficialUsedPct = safeUsed;
      st.lastCycleCostUsd = safeCost;
      st.lastUnpricedCalls = safeUnpriced;
      if (safeCost >= 0.5 && safeUsed >= 0.3) {
        st.ratePctPerUsd = qrClampRate(safeUsed / safeCost);
        st.rateSamples = 1;
      }
      const out = qrFormatOutput(st, safeUsed);
      recordLog('baseline', out);
      return out;
    }

    if (safeResetMs > 0 && st.resetTimeMs === 0) {
      st.resetTimeMs = safeResetMs;
    }

    // 3. 同一份缓存配额响应：跳过重复差分，仅检查租约超时清理
    const isFreshSample =
      safeFetchTs !== st.lastQuotaTs || Math.abs(safeUsed - st.lastOfficialUsedPct) > 1e-4;
    if (!isFreshSample) {
      const beforeCachePrune = st.activeLeases.length;
      qrPruneExpiredLeases(st, nowMs);
      const out = qrFormatOutput(st, safeUsed);
      if (beforeCachePrune > st.activeLeases.length) {
        recordLog('expire', out);
      }
      return out;
    }

    const deltaOfficial = safeUsed - st.lastOfficialUsedPct;
    const rawDeltaCost = Math.max(0, safeCost - st.lastCycleCostUsd);
    const deltaUnpriced = Math.max(0, safeUnpriced - st.lastUnpricedCalls);
    const pendingValid =
      st.pendingCostUsd > 0 && nowMs - st.pendingCostAtMs <= QR_PENDING_COST_TTL_MS;
    const effectiveDeltaCost = rawDeltaCost + (pendingValid ? st.pendingCostUsd : 0);
    const rate = qrResolveEffectiveRate(st, safeUsed, safeCost);
    const expectedDeltaPct = rate !== null ? effectiveDeltaCost * rate : 0;
    const excessPct = deltaOfficial - expectedDeltaPct;
    const isIdleRefundReady =
      poolLastActivityMs > 0 && nowMs - poolLastActivityMs >= QR_IDLE_CONFIRM_REFUND_MS;
    let eventKind = 'idle';

    const confirmRefund = (refundedPct, { keepPendingCost = false } = {}) => {
      const amt = Math.max(0, Number(refundedPct) || 0);
      if (amt > 0) {
        qrConsumeLeasesFifo(st.activeLeases, amt);
      }
      st.lastRefundAtMs = nowMs;
      st.lastRefundPct = amt;
      st.lastBounceAtMs = nowMs;
      st.pendingDrop = null;
      if (!keepPendingCost) {
        st.pendingCostUsd = 0;
        st.pendingCostAtMs = 0;
      }
      if (qrSumLeases(st.activeLeases) < QR_MIN_DISPLAY_RESERVED_PCT) {
        st.activeLeases = [];
      }
      eventKind = 'refund';
    };

    if (deltaOfficial <= -QR_REFUND_EPSILON_PCT) {
      // 4A. 同周期余额回升：区分「静默到期真退还」及「活跃期双副本回落待确认」
      const prevHigh = st.pendingDrop
        ? Math.max(st.pendingDrop.preDropUsedPct, st.lastOfficialUsedPct)
        : st.lastOfficialUsedPct;
      const totalDrop = Math.max(0, prevHigh - safeUsed);
      st.lastBounceAtMs = nowMs;
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;

      if (isIdleRefundReady && st.activeLeases.length > 0) {
        confirmRefund(totalDrop);
      } else if (st.pendingDrop) {
        st.pendingDrop.preDropUsedPct = prevHigh;
        st.pendingDrop.lowestUsedPct = Math.min(st.pendingDrop.lowestUsedPct, safeUsed);
        st.pendingDrop.dropPct = Math.max(0, prevHigh - st.pendingDrop.lowestUsedPct);
        st.pendingDrop.lowSamples += 1;
        if (
          st.pendingDrop.lowSamples >= QR_REFUND_CONFIRM_MIN_SAMPLES &&
          nowMs - st.pendingDrop.droppedAtMs >= QR_REFUND_CONFIRM_WINDOW_MS
        ) {
          confirmRefund(st.pendingDrop.dropPct);
        } else {
          eventKind = 'drop_pending';
        }
      } else {
        st.pendingDrop = {
          preDropUsedPct: st.lastOfficialUsedPct,
          preDropCostUsd: st.lastCycleCostUsd,
          dropPct: -deltaOfficial,
          droppedAtMs: nowMs,
          lowSamples: 1,
          lowestUsedPct: safeUsed,
        };
        eventKind = 'drop_pending';
      }
    } else if (st.pendingDrop) {
      // 4B-Pending. 当前处于回落观察窗内：判断是「弹回高副本」还是「持续低位确认退还」
      const pd = st.pendingDrop;
      const costSinceDrop = Math.max(0, safeCost - pd.preDropCostUsd);
      const expectedSinceDrop = rate !== null ? costSinceDrop * rate : 0;
      const expectedOnTick = rate !== null ? rawDeltaCost * rate : 0;
      const jumpAboveTickSpend = deltaOfficial - expectedOnTick;
      const reboundFloor = pd.preDropUsedPct - Math.min(0.15, pd.dropPct * 0.35);
      const isReplicaRebound =
        deltaOfficial > 1e-3 &&
        jumpAboveTickSpend >= Math.max(QR_REFUND_EPSILON_PCT, pd.dropPct * 0.45) &&
        safeUsed >= reboundFloor;

      if (isReplicaRebound) {
        const excessAboveHighWater = safeUsed - (pd.preDropUsedPct + expectedSinceDrop);
        st.pendingDrop = null;
        st.lastBounceAtMs = nowMs;
        st.pendingCostUsd = 0;
        st.pendingCostAtMs = 0;
        if (rate !== null && excessAboveHighWater >= QR_MIN_JUMP_EXCESS_PCT) {
          st.activeLeases.push({
            amountPct: excessAboveHighWater,
            remainingPct: excessAboveHighWater,
            createdAtMs: nowMs,
            lastTouchedMs: nowMs,
            sessionCount: Math.max(1, safeSess10m || 1),
          });
          if (st.activeLeases.length > QR_MAX_ACTIVE_LEASES) {
            st.activeLeases.splice(0, st.activeLeases.length - QR_MAX_ACTIVE_LEASES);
          }
          eventKind = 'lease';
        } else {
          eventKind = 'replica_flip';
        }
      } else {
        pd.lowSamples += 1;
        const sustainedLow =
          isIdleRefundReady ||
          (pd.lowSamples >= QR_REFUND_CONFIRM_MIN_SAMPLES &&
            nowMs - pd.droppedAtMs >= QR_REFUND_CONFIRM_WINDOW_MS);
        if (sustainedLow) {
          if (rawDeltaCost > 0 && deltaOfficial <= 1e-3) {
            st.pendingCostUsd = effectiveDeltaCost;
            st.pendingCostAtMs = nowMs;
          }
          const effectiveDrop = Math.max(0, pd.preDropUsedPct + expectedSinceDrop - safeUsed);
          confirmRefund(effectiveDrop > 0 ? Math.min(pd.dropPct, effectiveDrop) : pd.dropPct, {
            keepPendingCost: deltaOfficial <= 1e-3 && st.pendingCostUsd > 0,
          });
        } else if (deltaOfficial > 1e-3) {
          st.pendingCostUsd = 0;
          st.pendingCostAtMs = 0;
          eventKind = 'drop_pending';
        } else if (rawDeltaCost > 0) {
          st.pendingCostUsd = effectiveDeltaCost;
          st.pendingCostAtMs = nowMs;
          eventKind = 'lag_pending';
        }
      }
    } else if (deltaOfficial > 1e-3) {
      // 4B. 官方已用比例上升：区分租约跳变、真实租约内消费及常规消耗
      const detectedWithRate = rate !== null && excessPct >= QR_MIN_JUMP_EXCESS_PCT;
      const detectedColdStart =
        rate === null &&
        deltaOfficial >= QR_COLD_START_JUMP_PCT &&
        effectiveDeltaCost <= QR_COLD_START_MAX_COST_USD;
      const shortfall = expectedDeltaPct - deltaOfficial;
      const isSignificantShortfall =
        st.activeLeases.length > 0 &&
        expectedDeltaPct > 0 &&
        shortfall >= Math.max(QR_CONSUME_MIN_SHORTFALL_PCT, expectedDeltaPct * QR_CONSUME_SHORTFALL_RATIO);

      if (detectedWithRate || detectedColdStart) {
        const leaseRemaining = detectedWithRate ? excessPct : deltaOfficial;
        st.activeLeases.push({
          amountPct: leaseRemaining,
          remainingPct: leaseRemaining,
          createdAtMs: nowMs,
          lastTouchedMs: nowMs,
          sessionCount: Math.max(1, safeSess10m || 1),
        });
        if (st.activeLeases.length > QR_MAX_ACTIVE_LEASES) {
          st.activeLeases.splice(0, st.activeLeases.length - QR_MAX_ACTIVE_LEASES);
        }
        eventKind = 'lease';
      } else if (isSignificantShortfall) {
        // 租约期内出现明显低于预期的官方增量：仅把显著缺口计入当前租约内消费
        qrConsumeLeasesFifo(st.activeLeases, shortfall);
        for (let i = 0; i < st.activeLeases.length; i += 1) {
          st.activeLeases[i].lastTouchedMs = nowMs;
        }
        eventKind = 'consume';
      } else {
        const outsideBounceCooldown =
          st.lastBounceAtMs === 0 || nowMs - st.lastBounceAtMs >= QR_RATE_BOUNCE_COOLDOWN_MS;
        if (
          st.activeLeases.length === 0 &&
          outsideBounceCooldown &&
          !pendingValid &&
          rawDeltaCost >= 0.04 &&
          deltaUnpriced === 0 &&
          deltaOfficial > 0.005 &&
          deltaOfficial < QR_MIN_JUMP_EXCESS_PCT
        ) {
          // 纯净未租约且无近期副本抖动的单步消耗：进入滚动中位数费率校准池
          qrRecordRateSample(st, deltaOfficial / rawDeltaCost);
        }
        eventKind = 'normal';
      }
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
    } else if (rawDeltaCost > 0) {
      // 4C. 官方已用比例持平但本地产生真实消耗
      if (st.activeLeases.length > 0) {
        // 正在原地消耗已预借租约：按换算率缩减可退差额并刷新租约活跃时刻
        const consumedPct = rate !== null ? rawDeltaCost * rate : 0;
        if (consumedPct > 0) {
          qrConsumeLeasesFifo(st.activeLeases, consumedPct);
        }
        for (let i = 0; i < st.activeLeases.length; i += 1) {
          st.activeLeases[i].lastTouchedMs = nowMs;
        }
        st.pendingCostUsd = 0;
        st.pendingCostAtMs = 0;
        eventKind = 'consume';
      } else {
        // 尚未租约：暂存短时待配对成本，吸收 10~30s 记账延迟或小额步长累积
        st.pendingCostUsd = effectiveDeltaCost;
        st.pendingCostAtMs = nowMs;
        eventKind = 'lag_pending';
      }
    }

    st.lastQuotaTs = safeFetchTs;
    st.lastOfficialUsedPct = safeUsed;
    st.lastCycleCostUsd = safeCost;
    st.lastUnpricedCalls = safeUnpriced;

    // 5. 租约 TTL 超时兜底（租约本身超过 11.5 分钟无实质扣减或满 22 分钟自动清理）
    const beforePrune = st.activeLeases.length;
    qrPruneExpiredLeases(st, nowMs);
    if (beforePrune > st.activeLeases.length && eventKind === 'idle') {
      eventKind = 'expire';
    }

    const out = qrFormatOutput(st, safeUsed);
    if (eventKind !== 'idle') {
      recordLog(eventKind, {
        deltaOfficial,
        rawDeltaCost,
        expectedDeltaPct,
        excessPct,
        ...out,
      });
    }
    return out;
  }

  function updatePools({
    endpointId = 'local',
    accountScope = '',
    quotaPoolsMap = null,
    poolCycleStats = null,
    quotaFetchedAtMs = 0,
    nowMs = Date.now(),
  } = {}) {
    if (!(quotaPoolsMap instanceof Map) || quotaPoolsMap.size === 0) return;
    const scopePrefix = `${String(endpointId || 'local')}::${String(accountScope || '')}`;

    for (const [poolKey, poolObj] of quotaPoolsMap.entries()) {
      if (!poolObj || typeof poolObj !== 'object') continue;
      const pStats = poolCycleStats instanceof Map ? poolCycleStats.get(poolKey) : null;
      const recent10m = pStats?.recent10m || null;
      const poolLastActivityMs = Number(recent10m?.lastActivityMs) || 0;
      const activeSessionCount10m = Number(recent10m?.activeSessionCount) || 0;
      const recent10mCostUsd = Number(recent10m?.costUsd) || 0;

      const used5hExact = poolObj.has5h ? qrResolveExactUsedPct(poolObj, '5h') : null;
      const res5h =
        used5hExact !== null
          ? observeBucket({
              bucketKey: `${scopePrefix}::${poolKey}::5h`,
              poolKey,
              win: '5h',
              officialUsedPct: used5hExact,
              resetTimeMs: parseIsoMs(poolObj.resetTime),
              quotaFetchedAtMs,
              cycleCostUsd: pStats?.exactCost5hUsd ?? pStats?.cycle5h?.costUsd ?? 0,
              unpricedCalls: pStats?.cycle5h?.unpricedCalls || 0,
              poolLastActivityMs,
              activeSessionCount10m,
              recent10mCostUsd,
              nowMs,
            })
          : { reservedPct: 0, reservedLeaseCount: 0, reservedExpiresAtMs: null };

      const usedWkExact = poolObj.hasWeekly ? qrResolveExactUsedPct(poolObj, 'weekly') : null;
      const resWk =
        usedWkExact !== null
          ? observeBucket({
              bucketKey: `${scopePrefix}::${poolKey}::weekly`,
              poolKey,
              win: 'weekly',
              officialUsedPct: usedWkExact,
              resetTimeMs: parseIsoMs(poolObj.weeklyResetTime),
              quotaFetchedAtMs,
              cycleCostUsd: pStats?.exactCostWeeklyUsd ?? pStats?.cycleWeekly?.costUsd ?? 0,
              unpricedCalls: pStats?.cycleWeekly?.unpricedCalls || 0,
              poolLastActivityMs,
              activeSessionCount10m,
              recent10mCostUsd,
              nowMs,
            })
          : { reservedPct: 0, reservedLeaseCount: 0, reservedExpiresAtMs: null };

      poolObj.reservedPct = res5h.reservedPct;
      poolObj.reservedLeaseCount = res5h.reservedLeaseCount;
      poolObj.reservedExpiresAtMs = res5h.reservedExpiresAtMs;
      poolObj.weeklyReservedPct = resWk.reservedPct;
      poolObj.weeklyReservedLeaseCount = resWk.reservedLeaseCount;
      poolObj.weeklyReservedExpiresAtMs = resWk.reservedExpiresAtMs;
    }
  }

  function getLogSnapshot() {
    ensureHydrated();
    const bucketSummaries = [];
    for (const [key, st] of buckets.entries()) {
      const parts = key.split('::');
      const usedPct = st.lastOfficialUsedPct ?? 0;
      const out = qrFormatOutput(st, usedPct);
      bucketSummaries.push({
        pool: parts[2] || key,
        win: parts[3] || '',
        usedPct: +usedPct.toFixed(3),
        cycleCostUsd: +Number(st.lastCycleCostUsd || 0).toFixed(4),
        ratePctPerUsd: st.ratePctPerUsd !== null ? +st.ratePctPerUsd.toFixed(4) : null,
        rateSamples: st.rateSamples,
        reservedPct: out.reservedPct,
        leases: out.reservedLeaseCount,
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      count: eventLog.length,
      maxEntries: QR_MAX_EVENT_LOG,
      buckets: bucketSummaries,
      events: eventLog.slice(),
    };
  }

  function reset() {
    buckets.clear();
    eventLog.length = 0;
    lastPersistMs = 0;
    hydrated = true;
  }

  return {
    observeBucket,
    updatePools,
    getLogSnapshot,
    reset,
    _buckets: buckets,
  };
}

function qrIsTestRuntime() {
  return (
    lsRuntimeEndpoint?.addr === 'test.invalid' ||
    String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid'
  );
}

const defaultQuotaReservationTracker = createQuotaReservationTracker({
  loadState: () => {
    if (qrIsTestRuntime()) return null;
    return loadJson(QUOTA_RESERVATION_STATE_FILE, null);
  },
  saveState: (payload) => {
    if (qrIsTestRuntime()) return;
    saveJson(QUOTA_RESERVATION_STATE_FILE, payload);
  },
});

/**
 * 使用全局默认追踪器为 `quotaPoolsMap` 中的所有配额池刷新 5h 及周限的实验性预占估算字段。
 */
export function updatePoolQuotaReservationEstimates(params) {
  return defaultQuotaReservationTracker.updatePools(params);
}

/**
 * 获取当前内存中的配额预占观测日志快照（供「其他 → 试验性功能」复制到剪贴板）。
 */
export function getQuotaReservationLogSnapshot() {
  return defaultQuotaReservationTracker.getLogSnapshot();
}

/**
 * 清空全局默认配额预占状态（供测试隔离使用）。
 */
export function resetQuotaReservationState() {
  defaultQuotaReservationTracker.reset();
}
