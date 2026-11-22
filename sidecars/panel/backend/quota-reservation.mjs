/**
 * @fileoverview 实验性配额预占估算器（`quota-reservation.mjs`）。
 *
 * 基于分布式配额租约（Per-Bucket / Per-Session Quota Lease）的行为特征：
 * 1. 5h 桶及周限桶各自独立追踪（支持错档触发）；
 * 2. 多高消耗会话并发时支持多笔租约线性叠加（如 0.5% / 1.0% / 2.0%+）；
 * 3. 在租约期内继续产生真实消耗时按单桶换算率扣减可退差额；
 * 4. 上游退还租约（同周期内 officialUsedPct 下降）时按 FIFO 精准核销并反向校准单桶费率；
 * 5. 纯内存 O(1) 状态机，零额外 RPC、零额外磁盘写入。
 */

import { parseIsoMs } from '../trajectory-metrics.mjs';

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
const QR_MAX_TRACKED_BUCKETS = 128;
const QR_MAX_ACTIVE_LEASES = 16;
const QR_MAX_EVENT_LOG = 500;

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

function qrUpdateRateEma(state, sampleRate) {
  const clamped = qrClampRate(sampleRate);
  if (clamped === null) return;
  if (state.ratePctPerUsd !== null && state.rateSamples >= 3) {
    const bounded = qrClamp(clamped, state.ratePctPerUsd * 0.25, state.ratePctPerUsd * 4);
    state.ratePctPerUsd = state.ratePctPerUsd * 0.8 + bounded * 0.2;
  } else if (state.ratePctPerUsd !== null) {
    state.ratePctPerUsd = state.ratePctPerUsd * 0.55 + clamped * 0.45;
  } else {
    state.ratePctPerUsd = clamped;
  }
  state.rateSamples += 1;
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

function qrCalibrateFromSettled(state, officialUsedPct, cycleCostUsd, nowMs) {
  if (
    state.lastSettledUsedPct !== null &&
    state.lastSettledCostUsd !== null &&
    cycleCostUsd > state.lastSettledCostUsd + 0.25 &&
    officialUsedPct > state.lastSettledUsedPct + 0.05
  ) {
    const dUsed = officialUsedPct - state.lastSettledUsedPct;
    const dCost = cycleCostUsd - state.lastSettledCostUsd;
    qrUpdateRateEma(state, dUsed / dCost);
  }
  state.lastSettledUsedPct = officialUsedPct;
  state.lastSettledCostUsd = cycleCostUsd;
  state.lastSettledAtMs = nowMs;
}

function qrPruneExpiredLeases(state, poolLastActivityMs, officialUsedPct, cycleCostUsd, nowMs) {
  if (state.activeLeases.length === 0) return;
  const beforeLen = state.activeLeases.length;
  for (let i = state.activeLeases.length - 1; i >= 0; i -= 1) {
    const lease = state.activeLeases[i];
    const lastActiveMs = Math.max(lease.lastTouchedMs || 0, poolLastActivityMs || 0);
    const idleExpired = lastActiveMs > 0 && nowMs - lastActiveMs >= QR_LEASE_IDLE_EXPIRY_MS;
    const maxAgeExpired = nowMs - (lease.createdAtMs || 0) >= QR_LEASE_MAX_AGE_MS;
    if (idleExpired || maxAgeExpired) {
      state.activeLeases.splice(i, 1);
    }
  }
  if (beforeLen > 0 && state.activeLeases.length === 0) {
    qrCalibrateFromSettled(state, officialUsedPct, cycleCostUsd, nowMs);
  }
}

function qrFormatOutput(state, officialUsedPct) {
  const rawReserved = qrClamp(qrSumLeases(state.activeLeases), 0, officialUsedPct);
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
    const exp = (state.activeLeases[i].lastTouchedMs || state.activeLeases[i].createdAtMs || 0) + QR_LEASE_TTL_MS;
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

/**
 * 创建独立的配额预占状态追踪器（支持单元测试隔离，同时后端提供全局默认实例）。
 */
export function createQuotaReservationTracker() {
  const buckets = new Map();
  const eventLog = [];

  function appendEventLog(entry) {
    eventLog.push(entry);
    if (eventLog.length > QR_MAX_EVENT_LOG) {
      eventLog.splice(0, eventLog.length - QR_MAX_EVENT_LOG);
    }
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
      lastSettledUsedPct: null,
      lastSettledCostUsd: null,
      lastSettledAtMs: 0,
      activeLeases: [],
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
      appendEventLog({
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
      });
    };

    // 1. 周期重置检测：清空旧租约及待配对成本，保留已校准的单桶费率
    const resetShifted =
      safeResetMs > 0 &&
      st.resetTimeMs > 0 &&
      Math.abs(safeResetMs - st.resetTimeMs) > QR_CYCLE_RESET_SHIFT_MS;
    const rolloverDrop =
      st.lastOfficialUsedPct !== null && st.lastOfficialUsedPct >= 5 && safeUsed < 1;
    if (resetShifted || rolloverDrop) {
      const prevUsed = st.lastOfficialUsedPct ?? 0;
      st.resetTimeMs = safeResetMs;
      st.lastQuotaTs = safeFetchTs;
      st.lastOfficialUsedPct = safeUsed;
      st.lastCycleCostUsd = safeCost;
      st.lastUnpricedCalls = safeUnpriced;
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
      st.activeLeases = [];
      st.lastSettledUsedPct = safeUsed;
      st.lastSettledCostUsd = safeCost;
      st.lastSettledAtMs = nowMs;
      const out = qrFormatOutput(st, safeUsed);
      recordLog('reset', { deltaOfficial: safeUsed - prevUsed, ...out });
      return out;
    }

    // 2. 首次观测：建立基线并按当前周期已有消耗做低权重冷启动费率估计
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
      st.lastSettledUsedPct = safeUsed;
      st.lastSettledCostUsd = safeCost;
      st.lastSettledAtMs = nowMs;
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
      qrPruneExpiredLeases(st, poolLastActivityMs, safeUsed, safeCost, nowMs);
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
    let eventKind = 'idle';

    if (deltaOfficial <= -QR_REFUND_EPSILON_PCT) {
      // 4A. 同周期余额回升：上游租约到期退还差额（FIFO 核销 + 结算校准）
      const refundedPct = -deltaOfficial;
      qrConsumeLeasesFifo(st.activeLeases, refundedPct);
      st.lastRefundAtMs = nowMs;
      st.lastRefundPct = refundedPct;
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
      if (qrSumLeases(st.activeLeases) < QR_MIN_DISPLAY_RESERVED_PCT) {
        st.activeLeases = [];
        qrCalibrateFromSettled(st, safeUsed, safeCost, nowMs);
      }
      eventKind = 'refund';
    } else if (deltaOfficial > 1e-3) {
      // 4B. 官方已用比例上升：区分租约跳变及常规消耗
      const detectedWithRate = rate !== null && excessPct >= QR_MIN_JUMP_EXCESS_PCT;
      const detectedColdStart =
        rate === null &&
        deltaOfficial >= QR_COLD_START_JUMP_PCT &&
        effectiveDeltaCost <= QR_COLD_START_MAX_COST_USD;

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
      } else if (st.activeLeases.length > 0 && expectedDeltaPct > deltaOfficial) {
        // 租约期内同时出现官方微增及本地消耗：超出官方增量的消耗计入当前租约内消费
        const shortfall = expectedDeltaPct - deltaOfficial;
        qrConsumeLeasesFifo(st.activeLeases, shortfall);
        for (let i = 0; i < st.activeLeases.length; i += 1) {
          st.activeLeases[i].lastTouchedMs = nowMs;
        }
        eventKind = 'consume';
      } else {
        if (
          st.activeLeases.length === 0 &&
          effectiveDeltaCost >= 0.05 &&
          deltaUnpriced === 0 &&
          deltaOfficial < QR_COLD_START_JUMP_PCT
        ) {
          // 纯净未租约消耗：平稳校准该桶 $/1% 换算率
          qrUpdateRateEma(st, deltaOfficial / effectiveDeltaCost);
          st.lastSettledUsedPct = safeUsed;
          st.lastSettledCostUsd = safeCost;
          st.lastSettledAtMs = nowMs;
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

    // 5. 租约 TTL 超时兜底（静默超过 11.5 分钟仍未退还，说明租约已在窗内耗尽）
    const beforePrune = st.activeLeases.length;
    qrPruneExpiredLeases(st, poolLastActivityMs, safeUsed, safeCost, nowMs);
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
  }

  return {
    observeBucket,
    updatePools,
    getLogSnapshot,
    reset,
    _buckets: buckets,
  };
}

const defaultQuotaReservationTracker = createQuotaReservationTracker();

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
