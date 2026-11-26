/**
 * @fileoverview 免 API Key 的实时汇率同步与本地 24h 磁盘缓存服务 (`fx-rates.mjs`)。
 *
 * 供应商降级链与离线韧性：
 * 1. 主数据源：Frankfurter (`https://api.frankfurter.dev/v1/latest?base=USD`)，欧洲央行官方参考汇率；
 * 2. 补充/降级数据源：ExchangeRate-API Open Daily (`https://open.er-api.com/v6/latest/USD`)，
 *    自动补齐 ECB 未覆盖币种（如 `TWD`、`VND`），并在主源不可达时无缝接管；
 * 3. 本地持久化：原子写入 `DATA_DIR/fx_rates_cache.json`，24 小时 TTL；离线或网络异常时
 *    依次回退至磁盘缓存与 `BUILTIN_FX_RATES` 静态参考汇率，绝不阻塞主遥测链路。
 */

import {
  BUILTIN_FX_RATES,
  SUPPORTED_CURRENCY_CODES,
} from '../shared/currency-catalog.mjs';
import { FX_RATES_CACHE_FILE, loadJson, lsRuntimeEndpoint, saveJson } from './config.mjs';

export const FRANKFURTER_USD_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
export const ER_API_USD_URL = 'https://open.er-api.com/v6/latest/USD';

export const FX_SYNC_TTL_MS = 24 * 60 * 60 * 1000;
export const FX_SYNC_RETRY_COOLDOWN_MS = 60 * 1000;
const FX_FETCH_TIMEOUT_MS = 6000;
const FX_MAX_REASONABLE_RATE = 1_000_000;

const ALLOWED_FX_HOSTS = new Set(['api.frankfurter.dev', 'open.er-api.com']);
const TRACKED_NON_USD_CODES = Object.freeze(
  SUPPORTED_CURRENCY_CODES.filter((code) => code !== 'USD')
);

/**
 * 校验并清洗外部或缓存的汇率字典，仅保留受支持且数值合理的正向汇率。
 *
 * @param {unknown} rawRates
 * @returns {Record<string, number>}
 */
export function sanitizeFxRatesMap(rawRates) {
  const out = {};
  if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
    return out;
  }
  for (const code of TRACKED_NON_USD_CODES) {
    const val = Number(rawRates[code]);
    if (Number.isFinite(val) && val > 0 && val < FX_MAX_REASONABLE_RATE) {
      out[code] = +val.toFixed(6);
    }
  }
  return out;
}

function normalizeIsoDate(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function assertAllowedFxUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ''));
  if (parsed.protocol !== 'https:' || !ALLOWED_FX_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Disallowed FX provider URL: ${rawUrl}`);
  }
  return parsed.toString();
}

async function fetchJsonWithTimeout(url, fetchImpl = globalThis.fetch, timeoutMs = FX_FETCH_TIMEOUT_MS) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable');
  }
  const safeUrl = assertAllowedFxUrl(url);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  try {
    const res = await fetchImpl(safeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res?.ok) {
      throw new Error(`HTTP ${res?.status || 'ERR'}`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 解析 Frankfurter `/v1/latest?base=USD` 响应。
 */
export function parseFrankfurterResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid Frankfurter response');
  }
  const rates = sanitizeFxRatesMap(json.rates);
  if (Object.keys(rates).length === 0) {
    throw new Error('Empty Frankfurter rates');
  }
  return {
    source: 'frankfurter',
    date: normalizeIsoDate(json.date),
    rates,
  };
}

/**
 * 解析 ExchangeRate-API Open `/v6/latest/USD` 响应。
 */
export function parseErApiResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid ExchangeRate-API response');
  }
  if (json.result && json.result !== 'success') {
    throw new Error(`ExchangeRate-API error: ${json.result}`);
  }
  const rates = sanitizeFxRatesMap(json.rates);
  if (Object.keys(rates).length === 0) {
    throw new Error('Empty ExchangeRate-API rates');
  }
  const date =
    normalizeIsoDate(json.time_last_update_utc) ||
    (Number.isFinite(Number(json.time_last_update_unix)) && Number(json.time_last_update_unix) > 0
      ? new Date(Number(json.time_last_update_unix) * 1000).toISOString().slice(0, 10)
      : null);
  return {
    source: 'er-api',
    date,
    rates,
  };
}

/**
 * 创建可独立实例化与单测隔离的汇率状态管理器。
 */
export function createFxRatesManager({
  cacheFile = FX_RATES_CACHE_FILE,
  fetchImpl = undefined,
  nowFn = () => Date.now(),
  loadJsonFn = loadJson,
  saveJsonFn = saveJson,
  ttlMs = FX_SYNC_TTL_MS,
  retryCooldownMs = FX_SYNC_RETRY_COOLDOWN_MS,
  primaryUrl = FRANKFURTER_USD_URL,
  fallbackUrl = ER_API_USD_URL,
  isTestEnvFn = () => lsRuntimeEndpoint.addr === 'test.invalid',
} = {}) {
  const state = {
    initialized: false,
    source: 'builtin', // 'builtin' | 'frankfurter' | 'er-api' | 'mixed'
    date: null,
    fetchedAtMs: 0,
    lastAttemptMs: 0,
    isSyncing: false,
    lastError: null,
    rates: {},
    inFlight: null,
  };

  function ensureLoadedFromDisk() {
    if (state.initialized) return;
    state.initialized = true;
    const cached = loadJsonFn(cacheFile, null);
    if (!cached || typeof cached !== 'object') return;
    const rates = sanitizeFxRatesMap(cached.rates);
    if (Object.keys(rates).length === 0) return;
    const src = String(cached.source || '').trim();
    state.source =
      src === 'frankfurter' || src === 'er-api' || src === 'mixed' ? src : 'frankfurter';
    state.date = normalizeIsoDate(cached.date);
    state.fetchedAtMs = Number.isFinite(Number(cached.fetchedAtMs)) ? Number(cached.fetchedAtMs) : 0;
    state.rates = rates;
  }

  function getStatus() {
    ensureLoadedFromDisk();
    return {
      source: state.source,
      date: state.date,
      fetchedAtMs: state.fetchedAtMs,
      isSyncing: Boolean(state.isSyncing),
      lastError: state.lastError || null,
      rates: {
        ...BUILTIN_FX_RATES,
        ...state.rates,
        USD: 1,
      },
    };
  }

  async function sync({ force = false } = {}) {
    ensureLoadedFromDisk();
    if (!force && isTestEnvFn()) {
      return getStatus();
    }
    if (state.inFlight) return state.inFlight;
    const now = nowFn();
    if (!force) {
      if (state.fetchedAtMs > 0 && now - state.fetchedAtMs < ttlMs) {
        return getStatus();
      }
      if (state.lastAttemptMs > 0 && now - state.lastAttemptMs < retryCooldownMs) {
        return getStatus();
      }
    }

    const activeFetch = fetchImpl || globalThis.fetch;
    state.inFlight = (async () => {
      state.isSyncing = true;
      state.lastAttemptMs = nowFn();
      let primaryRes = null;
      let fallbackRes = null;
      let primaryErr = null;
      let fallbackErr = null;

      try {
        const json = await fetchJsonWithTimeout(primaryUrl, activeFetch);
        primaryRes = parseFrankfurterResponse(json);
      } catch (err) {
        primaryErr = err;
      }

      const missingTracked = primaryRes
        ? TRACKED_NON_USD_CODES.some((code) => primaryRes.rates[code] === undefined)
        : true;

      if (!primaryRes || missingTracked) {
        try {
          const json = await fetchJsonWithTimeout(fallbackUrl, activeFetch);
          fallbackRes = parseErApiResponse(json);
        } catch (err) {
          fallbackErr = err;
        }
      }

      try {
        if (primaryRes || fallbackRes) {
          const mergedRates = {
            ...(fallbackRes?.rates || {}),
            ...(primaryRes?.rates || {}),
          };
          const usedBoth = Boolean(
            primaryRes &&
              fallbackRes &&
              TRACKED_NON_USD_CODES.some(
                (code) => primaryRes.rates[code] === undefined && fallbackRes.rates[code] !== undefined
              )
          );
          const nextSource = usedBoth
            ? 'mixed'
            : primaryRes
              ? 'frankfurter'
              : 'er-api';
          const nextDate = primaryRes?.date || fallbackRes?.date || null;
          const fetchedAtMs = nowFn();

          state.source = nextSource;
          state.date = nextDate;
          state.fetchedAtMs = fetchedAtMs;
          state.rates = mergedRates;
          state.lastError = null;

          saveJsonFn(cacheFile, {
            version: 1,
            base: 'USD',
            source: nextSource,
            date: nextDate,
            fetchedAtMs,
            rates: mergedRates,
          });
        } else {
          state.lastError =
            primaryErr?.message || fallbackErr?.message || 'Failed to sync exchange rates';
        }
      } finally {
        state.isSyncing = false;
        state.inFlight = null;
      }
      return getStatus();
    })();

    return state.inFlight;
  }

  return {
    getStatus,
    sync,
  };
}

const defaultFxManager = createFxRatesManager();

export function getFxStatus() {
  return defaultFxManager.getStatus();
}

export function syncFxRates(options = {}) {
  return defaultFxManager.sync(options);
}
