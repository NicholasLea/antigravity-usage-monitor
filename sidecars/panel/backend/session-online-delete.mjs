/**
 * @fileoverview 按客户端隔离的在线会话删除 Connect RPC 适配层 (`session-online-delete.mjs`)。
 *
 * 职责边界：
 * 1. 严格按客户端 (`desktop` / `cli`) 发现并验证对应的本地 `product.v1.ConversationService` 回环端点，
 *    禁止跨端串用（绝不把 CLI 会话发送给 Desktop LS，也不向旧版 IDE 发起在线删除）；
 * 2. 通过 `ListConversations(pageSize: 1)` 活性探针过滤 Windows 上可能因 PID 复用而残留的陈旧 `hub_*.json`；
 * 3. 在执行 `DeleteConversation` 前通过 `GetConversation` 实时复核会话存在性与运行态 (`RUN_STATE_RUNNING`)；
 * 4. 所有请求严格限制在回环地址 (`127.0.0.1` / `localhost` / `::1`) 并带有独立超时保护。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lsRuntimeEndpoint } from './config.mjs';
import { readHubDaemonCandidates } from './ls-discovery.mjs';
import { isStrictLoopbackUrl, postLoopbackHttpsJson } from './ls-rpc.mjs';
import { getSessionClientDef, resolveGeminiDir } from './session-store.mjs';

export const ONLINE_DELETE_SUPPORTED_CLIENTS = new Set(['desktop', 'cli']);

const CONVERSATION_SERVICE_PATH_PREFIX = '/product.v1.ConversationService/';
const ENDPOINT_CACHE_TTL_MS = 5_000;
const MAX_ENDPOINT_CACHE_ENTRIES = 16;
const MAX_CANDIDATES_TO_PROBE = 6;
const PROBE_TIMEOUT_MS = 1_500;
const GET_CONVERSATION_TIMEOUT_MS = 4_000;
const DELETE_CONVERSATION_TIMEOUT_MS = 10_000;

const endpointCache = new Map(); // cacheKey -> { ts, endpoint }
const endpointInFlight = new Map(); // cacheKey -> Promise<endpoint | null>

export function clearOnlineDeleteEndpointCache() {
  endpointCache.clear();
  endpointInFlight.clear();
}

function setCachedEndpoint(cacheKey, endpoint) {
  if (endpointCache.has(cacheKey)) endpointCache.delete(cacheKey);
  endpointCache.set(cacheKey, { ts: Date.now(), endpoint });
  while (endpointCache.size > MAX_ENDPOINT_CACHE_ENTRIES) {
    const oldest = endpointCache.keys().next().value;
    if (!oldest) break;
    endpointCache.delete(oldest);
  }
}

export function invalidateOnlineDeleteEndpointCache(clientId, explicitGeminiDir = '') {
  const geminiDir = resolveGeminiDir(explicitGeminiDir);
  const cacheKey = `${geminiDir}|${String(clientId || '').trim().toLowerCase()}`;
  endpointCache.delete(cacheKey);
}

function parseConnectErrorCode(status, parsedJson, rawText) {
  const jsonCode = String(parsedJson?.code || '').trim().toLowerCase();
  if (jsonCode) return jsonCode;
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'permission_denied';
  if (status === 400) return 'invalid_argument';
  if (status === 408 || status === 504) return 'deadline_exceeded';
  if (/not[_ ]?found/i.test(String(rawText || ''))) return 'not_found';
  return status >= 500 ? 'internal' : 'unknown';
}

function buildConversationHeaders(csrfToken) {
  const token = String(csrfToken || '').trim();
  return {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    ...(token
      ? {
          'x-antigravity-csrf-token': token,
          'x-codeium-csrf-token': token,
        }
      : {}),
  };
}

/**
 * 向指定回环端点发起 `product.v1.ConversationService/<method>` Connect JSON RPC 调用。
 *
 * @param {{ baseUrl?: string, csrfToken?: string, invoker?: Function }} endpoint
 * @param {string} method
 * @param {object} payload
 * @param {{ timeoutMs?: number, fetchFn?: Function }} [opts={}]
 */
export async function callConversationServiceRpc(endpoint, method, payload = {}, opts = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    return { ok: false, status: 0, code: 'unavailable', error: 'online_endpoint_unavailable' };
  }
  const cleanMethod = String(method || '').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_]+$/.test(cleanMethod)) {
    return { ok: false, status: 400, code: 'invalid_argument', error: 'invalid_rpc_method' };
  }

  if (typeof endpoint.invoker === 'function') {
    try {
      const mockRes = await endpoint.invoker(cleanMethod, payload);
      if (!mockRes || typeof mockRes !== 'object') {
        return { ok: false, status: 500, code: 'internal', error: 'invalid_mock_response' };
      }
      if (mockRes.ok === false) {
        const status = Number(mockRes.status || 500);
        const code = String(mockRes.code || parseConnectErrorCode(status, mockRes.data, mockRes.error || '')).toLowerCase();
        return {
          ok: false,
          status,
          code,
          data: mockRes.data ?? null,
          error: String(mockRes.error || mockRes.message || code || 'rpc_failed'),
        };
      }
      return {
        ok: true,
        status: Number(mockRes.status || 200),
        code: 'ok',
        data: mockRes.data !== undefined ? mockRes.data : mockRes,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        code: 'unavailable',
        error: String(err?.message || err || 'rpc_invoker_error'),
      };
    }
  }

  const baseUrl = String(endpoint.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !isStrictLoopbackUrl(baseUrl)) {
    return { ok: false, status: 0, code: 'invalid_argument', error: 'non_loopback_endpoint_rejected' };
  }

  const urlStr = `${baseUrl}${CONVERSATION_SERVICE_PATH_PREFIX}${cleanMethod}`;
  if (!isStrictLoopbackUrl(urlStr)) {
    return { ok: false, status: 0, code: 'invalid_argument', error: 'non_loopback_endpoint_rejected' };
  }

  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(300, Number(opts.timeoutMs)) : GET_CONVERSATION_TIMEOUT_MS;
  const bodyText = JSON.stringify(payload || {});
  const headers = buildConversationHeaders(endpoint.csrfToken);
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : globalThis.fetch;

  try {
    let res;
    if (urlStr.startsWith('https://') && typeof opts.fetchFn !== 'function') {
      res = await postLoopbackHttpsJson(urlStr, endpoint.csrfToken, bodyText, timeoutMs, {
        'Connect-Protocol-Version': '1',
        ...(endpoint.csrfToken ? { 'x-antigravity-csrf-token': String(endpoint.csrfToken).trim() } : {}),
      });
    } else {
      if (typeof fetchFn !== 'function') {
        return { ok: false, status: 0, code: 'unavailable', error: 'fetch_unavailable' };
      }
      res = await fetchFn(urlStr, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    }

    const status = Number(res?.status || 0);
    const rawText = typeof res?.text === 'function' ? await res.text() : '';
    let parsedJson = null;
    if (rawText && rawText.trim()) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        parsedJson = null;
      }
    } else {
      parsedJson = {};
    }

    if (res?.ok && parsedJson !== null && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
      return { ok: true, status, code: 'ok', data: parsedJson };
    }

    const code = parseConnectErrorCode(status, parsedJson, rawText);
    const message = String(parsedJson?.message || parsedJson?.error || (res?.ok ? 'non_json_response' : `http_${status}`));
    return {
      ok: false,
      status,
      code,
      data: parsedJson,
      error: message,
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || /timeout|aborted/i.test(String(err?.message || ''));
    return {
      ok: false,
      status: 0,
      code: isTimeout ? 'deadline_exceeded' : 'unavailable',
      error: String(err?.message || err || 'network_error'),
    };
  }
}

async function probeConversationServiceEndpoint(candidate, opts = {}) {
  const res = await callConversationServiceRpc(
    candidate,
    'ListConversations',
    { pageSize: 1 },
    { timeoutMs: opts.probeTimeoutMs || PROBE_TIMEOUT_MS, fetchFn: opts.fetchFn }
  );
  if (!res.ok) return false;
  // 防御端口被无关本地 HTTP JSON 服务复用：确认响应结构符合 ConversationService
  const data = res.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (Object.keys(data).length === 0) return true; // 空会话列表时 protobuf JSON 返回 `{}`
  return Array.isArray(data.conversations) || typeof data.nextPageToken === 'string';
}

function parseUrlPort(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const port = Number(parsed.port || 0);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

function collectHostPreferredPids() {
  const set = new Set();
  for (const token of String(process?.env?.USAGE_MONITOR_HOST_PPID || '').split(',')) {
    const n = Number(token.trim());
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return set;
}

function isIsolatedGeminiDir(geminiDir, rawGeminiOverride) {
  if (rawGeminiOverride) return true;
  const envDir = String(process?.env?.ANTIGRAVITY_GEMINI_DIR || '').trim();
  if (!envDir) return false;
  const defaultDir = resolve(join(homedir(), '.gemini'));
  const resolved = resolve(geminiDir);
  return process.platform === 'win32'
    ? resolved.toLowerCase() !== defaultDir.toLowerCase()
    : resolved !== defaultDir;
}

function buildClientEndpointCandidates(clientId, geminiDir, rawGeminiOverride, options = {}) {
  const def = getSessionClientDef(clientId);
  if (!def || !ONLINE_DELETE_SUPPORTED_CLIENTS.has(def.id)) return [];

  const daemonDir = join(geminiDir, def.dirName, 'daemon');
  const preferredPids = collectHostPreferredPids();
  const isPidAliveFn = typeof options.isPidAliveFn === 'function' ? options.isPidAliveFn : undefined;
  const hubCandidates = readHubDaemonCandidates([daemonDir], preferredPids, isPidAliveFn);
  const isolatedStore = isIsolatedGeminiDir(geminiDir, rawGeminiOverride);

  const hostUrl =
    def.id === 'desktop' &&
    !isolatedStore &&
    lsRuntimeEndpoint.addr &&
    lsRuntimeEndpoint.addr !== 'test.invalid' &&
    lsRuntimeEndpoint.baseUrl &&
    isStrictLoopbackUrl(lsRuntimeEndpoint.baseUrl)
      ? String(lsRuntimeEndpoint.baseUrl).trim().replace(/\/+$/, '')
      : '';
  const hostPort = hostUrl ? parseUrlPort(hostUrl) : 0;
  const hostToken = hostUrl ? String(lsRuntimeEndpoint.csrfToken || '').trim() : '';

  // 若宿主注入的 lsRuntimeEndpoint 恰好对应 antigravity-cli/daemon，则绝不将其误归属为 Desktop
  let hostBelongsToCli = false;
  if (hostUrl && (hostPort > 0 || hostToken)) {
    const cliDaemonDir = join(geminiDir, 'antigravity-cli', 'daemon');
    const cliHubs = readHubDaemonCandidates([cliDaemonDir], new Set(), isPidAliveFn);
    for (const ch of cliHubs) {
      const tokenMatches = Boolean(hostToken && ch.csrfToken === hostToken);
      const portMatches = Boolean(hostPort > 0 && ch.targets.some((t) => t.port === hostPort));
      if (tokenMatches || portMatches) {
        hostBelongsToCli = true;
        break;
      }
    }
  }

  // 把与当前宿主端口/令牌精确吻合的 hub 文件置顶，避免先探测旧残留
  const orderedHubs = [...hubCandidates];
  if (def.id === 'desktop' && !hostBelongsToCli && (hostPort > 0 || hostToken)) {
    orderedHubs.sort((a, b) => {
      const aMatch =
        (hostToken && a.csrfToken === hostToken) ||
        (hostPort > 0 && a.targets.some((t) => t.port === hostPort))
          ? 1
          : 0;
      const bMatch =
        (hostToken && b.csrfToken === hostToken) ||
        (hostPort > 0 && b.targets.some((t) => t.port === hostPort))
          ? 1
          : 0;
      return bMatch - aMatch || b.priority - a.priority || b.mtimeMs - a.mtimeMs || b.pid - a.pid;
    });
  }

  const probeList = [];
  const seen = new Set();
  const pushCandidate = (baseUrl, csrfToken, pid, source) => {
    const cleanUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    const cleanToken = String(csrfToken || '').trim();
    if (!cleanUrl || !cleanToken || !isStrictLoopbackUrl(cleanUrl)) return;
    const key = `${cleanUrl}|${cleanToken}`;
    if (seen.has(key)) return;
    seen.add(key);
    probeList.push({ clientId: def.id, baseUrl: cleanUrl, csrfToken: cleanToken, pid: pid || 0, source });
  };

  for (const hub of orderedHubs.slice(0, MAX_CANDIDATES_TO_PROBE)) {
    for (const target of hub.targets || []) {
      const primaryProto = target.protos?.[0] || 'http';
      pushCandidate(`${primaryProto}://127.0.0.1:${target.port}`, hub.csrfToken, hub.pid, 'hub_daemon');
    }
  }

  if (def.id === 'desktop' && !hostBelongsToCli && hostUrl && hostToken) {
    pushCandidate(hostUrl, hostToken, 0, 'host_env');
  }

  return probeList;
}

/**
 * 解析并验证指定运行中客户端的本地 `ConversationService` 端点。
 *
 * @param {string} clientId
 * @param {object} [options={}]
 * @returns {Promise<{ clientId: string, baseUrl?: string, csrfToken?: string, invoker?: Function, pid?: number, source: string } | null>}
 */
export async function resolveClientOnlineDeleteEndpoint(clientId, options = {}) {
  const def = getSessionClientDef(clientId);
  if (!def || !ONLINE_DELETE_SUPPORTED_CLIENTS.has(def.id)) return null;

  if (options.onlineEndpointsOverride && Object.prototype.hasOwnProperty.call(options.onlineEndpointsOverride, def.id)) {
    const override = options.onlineEndpointsOverride[def.id];
    if (!override) return null;
    return {
      clientId: def.id,
      baseUrl: override.baseUrl ? String(override.baseUrl).trim().replace(/\/+$/, '') : '',
      csrfToken: String(override.csrfToken || ''),
      invoker: typeof override.invoker === 'function' ? override.invoker : undefined,
      pid: Number(override.pid || 0),
      source: 'override',
    };
  }

  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const cacheKey = `${geminiDir}|${def.id}`;
  const bypassCache = Boolean(options.forceRefresh || typeof options.fetchFn === 'function' || typeof options.isPidAliveFn === 'function');

  if (!bypassCache) {
    const cached = endpointCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ENDPOINT_CACHE_TTL_MS) {
      return cached.endpoint;
    }
    const existing = endpointInFlight.get(cacheKey);
    if (existing) return existing;
  }

  const task = (async () => {
    const candidates = buildClientEndpointCandidates(def.id, geminiDir, rawGeminiOverride, options);
    let resolved = null;
    for (const cand of candidates) {
      const alive = await probeConversationServiceEndpoint(cand, options);
      if (alive) {
        resolved = cand;
        break;
      }
    }
    if (!bypassCache) {
      setCachedEndpoint(cacheKey, resolved);
    }
    return resolved;
  })();

  if (!bypassCache) {
    endpointInFlight.set(cacheKey, task);
  }
  try {
    return await task;
  } finally {
    if (endpointInFlight.get(cacheKey) === task) {
      endpointInFlight.delete(cacheKey);
    }
  }
}

/**
 * 并行探测各运行中客户端是否支持在线删除。
 *
 * @param {{ desktop?: boolean, cli?: boolean, ide_legacy?: boolean, checked?: boolean }} runningClients
 * @param {object} [options={}]
 * @returns {Promise<{ desktop: boolean, cli: boolean, ide_legacy: boolean }>}
 */
export async function detectOnlineDeleteClientsAsync(runningClients, options = {}) {
  const result = { desktop: false, cli: false, ide_legacy: false };
  if (!runningClients?.checked) return result;

  if (options.onlineDeleteClientsOverride && typeof options.onlineDeleteClientsOverride === 'object') {
    result.desktop = Boolean(runningClients.desktop && options.onlineDeleteClientsOverride.desktop);
    result.cli = Boolean(runningClients.cli && options.onlineDeleteClientsOverride.cli);
    result.ide_legacy = false;
    return result;
  }

  const targets = ['desktop', 'cli'].filter((id) => Boolean(runningClients[id]));
  if (targets.length === 0) return result;

  await Promise.all(
    targets.map(async (clientId) => {
      const ep = await resolveClientOnlineDeleteEndpoint(clientId, options);
      result[clientId] = Boolean(ep);
    })
  );
  return result;
}

export function isLiveConversationRunning(conversationData) {
  if (!conversationData || typeof conversationData !== 'object') return false;
  const runState = String(
    conversationData?.state?.runState ||
      conversationData?.state?.run_state ||
      conversationData?.runState ||
      conversationData?.status ||
      ''
  )
    .trim()
    .toUpperCase();
  if (
    runState === 'RUN_STATE_RUNNING' ||
    runState === 'CASCADE_RUN_STATUS_RUNNING' ||
    runState === 'RUNNING' ||
    runState === 'RUN_STATE_WAITING_FOR_USER' ||
    runState === 'WAITING_FOR_USER'
  ) {
    return true;
  }
  if (conversationData?.state?.pendingApproval || conversationData?.state?.pending_approval) {
    return true;
  }
  return false;
}

/**
 * 在线删除前实时核验单条会话是否存在及是否正在生成中。
 *
 * @param {object} endpoint
 * @param {string} conversationId
 * @param {object} [opts={}]
 */
export async function getConversationLiveState(endpoint, conversationId, opts = {}) {
  const res = await callConversationServiceRpc(
    endpoint,
    'GetConversation',
    { conversationId },
    { timeoutMs: opts.timeoutMs || GET_CONVERSATION_TIMEOUT_MS, fetchFn: opts.fetchFn }
  );
  if (res.ok) {
    const runState = String(res.data?.state?.runState || res.data?.state?.run_state || '');
    return {
      ok: true,
      found: true,
      running: isLiveConversationRunning(res.data),
      runState,
      data: res.data,
    };
  }
  if (res.code === 'not_found') {
    return { ok: true, found: false, running: false, runState: '', data: null };
  }
  return {
    ok: false,
    found: false,
    running: false,
    unimplemented: res.code === 'unimplemented',
    authError: res.code === 'unauthenticated' || res.code === 'permission_denied',
    code: res.code,
    error: res.error || res.code || 'get_conversation_failed',
  };
}

/**
 * 调用运行中客户端官方 `product.v1.ConversationService/DeleteConversation` 删除单条会话。
 *
 * @param {object} endpoint
 * @param {string} conversationId
 * @param {object} [opts={}]
 */
export async function deleteConversationOnline(endpoint, conversationId, opts = {}) {
  const res = await callConversationServiceRpc(
    endpoint,
    'DeleteConversation',
    { conversationId },
    { timeoutMs: opts.timeoutMs || DELETE_CONVERSATION_TIMEOUT_MS, fetchFn: opts.fetchFn }
  );
  if (res.ok) {
    return { ok: true, status: res.status };
  }
  return {
    ok: false,
    status: res.status,
    code: res.code,
    notFound: res.code === 'not_found',
    unimplemented: res.code === 'unimplemented',
    authError: res.code === 'unauthenticated' || res.code === 'permission_denied',
    error: res.error || res.code || 'delete_conversation_failed',
  };
}
