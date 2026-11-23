/**
 * @fileoverview 本地透明 CloudCode 反代与 `SetCloudCodeURL` 调度器 (`cloudcode-proxy.mjs`)。
 *
 * 用于在不修改宿主二进制、无需 `--dev_mode` 或自签证书的前提下，通过 Language Server 原生
 * `SetCloudCodeURL` RPC 将 `/v1internal:fetchAvailableModels` 流量经由 `127.0.0.1` 随机端口
 * 透明转发至官方 CloudCode 上游，并在响应中按模型改写 `CASCADE_USE_EXPERIMENT_CHECKPOINTER`
 * 实验配置（覆盖非 `self` 子代理与蜂群 worker），其余请求零缓冲流式透传。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lsRuntimeEndpoint } from './config.mjs';
import { callLsRpc } from './ls-rpc.mjs';

export const DEFAULT_UPSTREAM_CLOUDCODE_URL = 'https://daily-cloudcode-pa.googleapis.com';

const CC_PROXY_UPSTREAM_URL_RE = /https:\/\/[a-z0-9.-]*cloudcode-pa\.googleapis\.com/gi;
const CC_PROXY_CHECKPOINTER_KEY = 'CASCADE_USE_EXPERIMENT_CHECKPOINTER';
const CC_PROXY_CHECKPOINTER_PREFIX = `${CC_PROXY_CHECKPOINTER_KEY}/`;
const CC_PROXY_MAX_LOG_READ_BYTES = 512 * 1024;
const CC_PROXY_RETRY_COOLDOWN_MS = 15_000;
const CC_PROXY_SYS_PROXY_CACHE_MS = 15_000;

let ccProxyNodeModulesPromise = null;

async function loadCcProxyNodeModules() {
  if (!ccProxyNodeModulesPromise) {
    ccProxyNodeModulesPromise = Promise.all([
      import('node:http'),
      import('node:https'),
      import('node:tls'),
      import('node:zlib'),
      import('node:child_process'),
      import('node:fs'),
    ]).then(([httpMod, httpsMod, tlsMod, zlibMod, cpMod, fsMod]) => ({
      http: httpMod.default || httpMod,
      https: httpsMod.default || httpsMod,
      tls: tlsMod.default || tlsMod,
      zlib: zlibMod.default || zlibMod,
      execFile: cpMod.execFile,
      openSync: fsMod.openSync,
      readSync: fsMod.readSync,
      closeSync: fsMod.closeSync,
    }));
  }
  return ccProxyNodeModulesPromise;
}

function isCcProxyLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

export function isValidUpstreamCloudCodeUrl(rawUrl, { allowHttp = false } = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return false;
    }
    if (!allowHttp && isCcProxyLoopbackHost(parsed.hostname)) {
      return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function readLogFileTailUtf8(filePath, sizeBytes, fsTailOps = null) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= CC_PROXY_MAX_LOG_READ_BYTES || !fsTailOps) {
    return readFileSync(filePath, 'utf8');
  }
  const { openSync, readSync, closeSync } = fsTailOps;
  const start = Math.max(0, sizeBytes - CC_PROXY_MAX_LOG_READ_BYTES);
  const length = sizeBytes - start;
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function getCcProxyLogCandidateDirs(env, platform, homeDir) {
  const safeEnv = env || {};
  const home = String(homeDir || '').trim();
  if (platform === 'win32') {
    return [
      safeEnv.APPDATA ? join(safeEnv.APPDATA, 'Antigravity', 'logs') : '',
      safeEnv.LOCALAPPDATA ? join(safeEnv.LOCALAPPDATA, 'Antigravity', 'logs') : '',
      home ? join(home, '.gemini', 'antigravity', 'logs') : '',
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      home ? join(home, 'Library', 'Application Support', 'Antigravity', 'logs') : '',
      home ? join(home, '.gemini', 'antigravity', 'logs') : '',
    ].filter(Boolean);
  }
  return [
    home ? join(home, '.config', 'Antigravity', 'logs') : '',
    home ? join(home, '.gemini', 'antigravity', 'logs') : '',
  ].filter(Boolean);
}

/**
 * 探测宿主真实上游 CloudCode URL（严格排除本地回环地址，防止自环）。
 *
 * @param {object} [opts]
 * @returns {string}
 */
export function detectUpstreamCloudCodeUrl({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fsTailOps = null,
} = {}) {
  const envUrl = String(env?.ANTIGRAVITY_CLOUDCODE_URL || env?.CLOUDCODE_URL || '').trim();
  if (isValidUpstreamCloudCodeUrl(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }

  for (const dir of getCcProxyLogCandidateDirs(env, platform, homeDir)) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir)
        .filter((name) => /\.log$/i.test(String(name || '')))
        .map((name) => {
          const fullPath = join(dir, String(name));
          const st = statSync(fullPath);
          return { fullPath, mtimeMs: Number(st?.mtimeMs || 0), size: Number(st?.size || 0) };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of entries.slice(0, 5)) {
        const text = readLogFileTailUtf8(item.fullPath, item.size, fsTailOps);
        const matches = text.match(CC_PROXY_UPSTREAM_URL_RE);
        if (matches && matches.length > 0) {
          for (let i = matches.length - 1; i >= 0; i -= 1) {
            const candidate = matches[i].replace(/\/+$/, '');
            if (isValidUpstreamCloudCodeUrl(candidate)) {
              return candidate;
            }
          }
        }
      }
    } catch {
      // 忽略单个日志目录读取异常
    }
  }

  return DEFAULT_UPSTREAM_CLOUDCODE_URL;
}

function shouldCcProxyBypassHost(hostname, noProxyRaw) {
  const target = String(hostname || '').trim().toLowerCase();
  const list = String(noProxyRaw || '').trim();
  if (!target || !list) return false;
  for (const part of list.split(/[;,]/)) {
    const raw = part.trim().toLowerCase();
    if (!raw) continue;
    if (raw === '*') return true;
    const rule = raw.replace(/^\*\./, '.').replace(/:\d+$/, '');
    if (!rule) continue;
    if (rule.startsWith('.')) {
      if (target.endsWith(rule) || target === rule.slice(1)) return true;
    } else if (target === rule || target.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

function parseWindowsProxyServerValue(rawVal) {
  let srv = String(rawVal || '').trim();
  if (!srv) return '';
  if (srv.includes('=')) {
    const parts = srv.split(';').map((p) => p.trim()).filter(Boolean);
    const httpsPart = parts.find((p) => p.toLowerCase().startsWith('https='));
    const httpPart = parts.find((p) => p.toLowerCase().startsWith('http='));
    const chosen = httpsPart || httpPart || '';
    srv = chosen.slice(chosen.indexOf('=') + 1).trim();
  }
  if (!srv) return '';
  return /^https?:\/\//i.test(srv) ? srv : `http://${srv}`;
}

let winRegProxyMemo = {
  rawOut: '',
  fetchedAtMs: 0,
  inFlight: null,
};

async function readWindowsInternetSettingsAsync() {
  const nowMs = Date.now();
  if (winRegProxyMemo.fetchedAtMs > 0 && nowMs - winRegProxyMemo.fetchedAtMs < CC_PROXY_SYS_PROXY_CACHE_MS) {
    return winRegProxyMemo.rawOut;
  }
  if (winRegProxyMemo.inFlight) {
    return winRegProxyMemo.inFlight;
  }
  winRegProxyMemo.inFlight = (async () => {
    try {
      const { execFile } = await loadCcProxyNodeModules();
      const out = await new Promise((resolveOut) => {
        execFile(
          'reg',
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
          { encoding: 'utf8', timeout: 2500, windowsHide: true },
          (err, stdout) => {
            resolveOut(err ? '' : String(stdout || ''));
          }
        );
      });
      winRegProxyMemo.rawOut = out;
      winRegProxyMemo.fetchedAtMs = Date.now();
      return out;
    } catch {
      winRegProxyMemo.rawOut = '';
      winRegProxyMemo.fetchedAtMs = Date.now();
      return '';
    } finally {
      winRegProxyMemo.inFlight = null;
    }
  })();
  return winRegProxyMemo.inFlight;
}

export async function detectSystemHttpsProxy(targetHostname = '', { env = process.env, platform = process.platform } = {}) {
  const noProxy = env?.NO_PROXY || env?.no_proxy || '';
  if (shouldCcProxyBypassHost(targetHostname, noProxy)) return '';
  const envProxy = String(
    env?.HTTPS_PROXY || env?.https_proxy || env?.ALL_PROXY || env?.all_proxy || ''
  ).trim();
  if (envProxy) return /^https?:\/\//i.test(envProxy) ? envProxy : `http://${envProxy}`;
  if (platform !== 'win32') return '';
  try {
    const out = await readWindowsInternetSettingsAsync();
    if (!out || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return '';
    const overrideMatch = out.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i);
    if (overrideMatch && shouldCcProxyBypassHost(targetHostname, overrideMatch[1])) {
      return '';
    }
    const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    return serverMatch ? parseWindowsProxyServerValue(serverMatch[1]) : '';
  } catch {
    return '';
  }
}

function parseCcProxyPositiveLimit(rawValue) {
  const num = Number(rawValue);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/**
 * 从模型目录（`GetAvailableModels` 或 `/v1internal:fetchAvailableModels` 的 `models` 映射）中
 * 提取各模型上游原始的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER.max_token_limit`。
 *
 * @param {Record<string, any>|null|undefined} modelsMap
 * @returns {Record<string, number>}
 */
export function extractUpstreamCheckpointDefaults(modelsMap) {
  const defaultsByModelId = {};
  if (!modelsMap || typeof modelsMap !== 'object' || Array.isArray(modelsMap)) {
    return defaultsByModelId;
  }
  for (const entry of Object.values(modelsMap)) {
    const modelId = typeof entry?.model === 'string' ? entry.model.trim() : '';
    if (!modelId) continue;
    const rawStr = entry?.modelExperiments?.experiments?.[CC_PROXY_CHECKPOINTER_KEY]?.stringValue;
    if (typeof rawStr !== 'string' || !rawStr.trim()) continue;
    try {
      const parsed = JSON.parse(rawStr);
      const lim = parseCcProxyPositiveLimit(parsed?.max_token_limit ?? parsed?.maxTokenLimit);
      if (lim !== null) {
        defaultsByModelId[modelId] = lim;
      }
    } catch {
      // 忽略非法 JSON
    }
  }
  return defaultsByModelId;
}

/**
 * 按解析后的 `rulesByModelId`（键为 `MODEL_*` 枚举 ID，值为数值 token 上限或命名档位）
 * 原地改写 `/v1internal:fetchAvailableModels` 响应体中的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER`。
 *
 * @param {any} fetchResp
 * @param {Record<string, number|string>} rulesByModelId
 * @returns {{ modified: boolean, applied: Array<{ modelKey: string, modelId: string, prevLimit: number|null, nextRule: number|string }>, defaultsByModelId: Record<string, number> }}
 */
export function rewriteFetchAvailableModelsPayload(fetchResp, rulesByModelId) {
  const models = fetchResp?.models;
  const defaultsByModelId = extractUpstreamCheckpointDefaults(models);
  if (
    !models ||
    typeof models !== 'object' ||
    Array.isArray(models) ||
    !rulesByModelId ||
    typeof rulesByModelId !== 'object'
  ) {
    return { modified: false, applied: [], defaultsByModelId };
  }

  const applied = [];
  for (const [modelKey, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue;
    const modelId = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!modelId || !Object.prototype.hasOwnProperty.call(rulesByModelId, modelId)) continue;
    const rule = rulesByModelId[modelId];
    const isNumericRule = typeof rule === 'number' && Number.isSafeInteger(rule) && rule > 0;
    const isNamedRule = typeof rule === 'string' && rule.trim().length > 0;
    if (!isNumericRule && !isNamedRule) continue;

    if (!entry.modelExperiments || typeof entry.modelExperiments !== 'object') {
      entry.modelExperiments = {};
    }
    if (!entry.modelExperiments.experiments || typeof entry.modelExperiments.experiments !== 'object') {
      entry.modelExperiments.experiments = {};
    }
    const expMap = entry.modelExperiments.experiments;
    const ckKeys = Object.keys(expMap).filter(
      (k) => k === CC_PROXY_CHECKPOINTER_KEY || k.startsWith(CC_PROXY_CHECKPOINTER_PREFIX)
    );
    if (!ckKeys.includes(CC_PROXY_CHECKPOINTER_KEY)) {
      ckKeys.unshift(CC_PROXY_CHECKPOINTER_KEY);
    }

    const prevLimit = defaultsByModelId[modelId] ?? null;
    if (isNumericRule) {
      for (const ckKey of ckKeys) {
        const prevRaw = expMap[ckKey]?.stringValue;
        let ckObj = {};
        if (typeof prevRaw === 'string' && prevRaw.trim()) {
          try {
            const parsed = JSON.parse(prevRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              ckObj = parsed;
            }
          } catch {
            ckObj = {};
          }
        }
        ckObj.max_token_limit = String(rule);
        delete ckObj.maxTokenLimit;
        expMap[ckKey] = {
          ...(expMap[ckKey] && typeof expMap[ckKey] === 'object' ? expMap[ckKey] : {}),
          stringValue: JSON.stringify(ckObj),
        };
      }
    } else {
      const variantKey = `${CC_PROXY_CHECKPOINTER_PREFIX}context-window_${rule.trim()}`;
      const variantRaw = expMap[variantKey]?.stringValue;
      if (typeof variantRaw !== 'string' || !variantRaw.trim()) {
        continue;
      }
      for (const ckKey of ckKeys) {
        expMap[ckKey] = {
          ...(expMap[ckKey] && typeof expMap[ckKey] === 'object' ? expMap[ckKey] : {}),
          stringValue: variantRaw,
        };
      }
    }

    if (Array.isArray(entry.ignoreExperiments)) {
      entry.ignoreExperiments = entry.ignoreExperiments.filter(
        (x) =>
          x !== CC_PROXY_CHECKPOINTER_KEY &&
          !String(x || '').startsWith(CC_PROXY_CHECKPOINTER_PREFIX) &&
          x !== 'checkpoint-variant'
      );
    }

    applied.push({ modelKey, modelId, prevLimit, nextRule: rule });
  }

  return { modified: applied.length > 0, applied, defaultsByModelId };
}

function sanitizeCcProxyRules(rulesByModelId) {
  const out = {};
  if (!rulesByModelId || typeof rulesByModelId !== 'object' || Array.isArray(rulesByModelId)) {
    return out;
  }
  for (const [modelId, value] of Object.entries(rulesByModelId)) {
    if (!modelId) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      out[modelId] = value;
    } else if (typeof value === 'string' && value.trim().length > 0) {
      out[modelId] = value.trim();
    }
  }
  return out;
}

function canonicalizeCcProxyRules(rules) {
  const keys = Object.keys(rules).sort();
  return JSON.stringify(keys.map((k) => [k, rules[k]]));
}

function decompressCcProxyBody(zlib, buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc.includes('gzip')) return zlib.gunzipSync(buf);
  if (enc.includes('deflate')) return zlib.inflateSync(buf);
  if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  return buf;
}

function openCcProxyTunnelSocket(http, tls, targetHost, targetPort, proxyUrl) {
  if (!proxyUrl) return Promise.resolve(null);
  const parsedProxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: parsedProxy.hostname,
      port: Number(parsedProxy.port || (parsedProxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed (${res.statusCode})`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost });
      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/**
 * 创建本地 CloudCode 反代生命周期控制器。
 *
 * @param {object} [options]
 */
export function createCloudCodeProxyController({
  callRpcFn = callLsRpc,
  getEndpointFn = () => lsRuntimeEndpoint,
  detectUpstreamFn = null,
  detectProxyFn = null,
  allowHttpUpstream = false,
  allowTestEndpoint = false,
  retryCooldownMs = CC_PROXY_RETRY_COOLDOWN_MS,
} = {}) {
  let server = null;
  let localUrl = '';
  let upstreamUrl = '';
  let lsSwitched = false;
  let activeRules = {};
  let upstreamDefaults = {};
  let appliedSig = '';
  let lastFailedSig = '';
  let lastErrorAtMs = 0;
  let cachedSysProxy = { url: '', checkedAtMs: 0, host: '' };
  let syncChain = Promise.resolve();

  let status = {
    state: 'disabled', // 'disabled' | 'active' | 'error'
    active: false,
    ruleCount: 0,
    appliedModels: [],
    upstreamUrl: '',
    localUrl: '',
    syncedAtMs: 0,
    error: '',
  };

  function getStatus() {
    return {
      ...status,
      appliedModels: [...status.appliedModels],
    };
  }

  function getUpstreamDefaults() {
    return { ...upstreamDefaults };
  }

  function seedUpstreamDefaultsFromCatalog(catalogModels) {
    if (lsSwitched) return;
    const extracted = extractUpstreamCheckpointDefaults(catalogModels);
    if (Object.keys(extracted).length > 0) {
      upstreamDefaults = { ...upstreamDefaults, ...extracted };
    }
  }

  async function resolveUpstreamUrl() {
    if (upstreamUrl && isValidUpstreamCloudCodeUrl(upstreamUrl, { allowHttp: allowHttpUpstream })) {
      return upstreamUrl;
    }
    let detected = '';
    if (typeof detectUpstreamFn === 'function') {
      detected = String((await detectUpstreamFn()) || '').trim();
    } else {
      const mods = await loadCcProxyNodeModules().catch(() => null);
      detected = detectUpstreamCloudCodeUrl({
        fsTailOps: mods
          ? { openSync: mods.openSync, readSync: mods.readSync, closeSync: mods.closeSync }
          : null,
      });
    }
    upstreamUrl = isValidUpstreamCloudCodeUrl(detected, { allowHttp: allowHttpUpstream })
      ? detected.replace(/\/+$/, '')
      : DEFAULT_UPSTREAM_CLOUDCODE_URL;
    return upstreamUrl;
  }

  async function resolveSystemProxyForHost(targetHostname) {
    const now = Date.now();
    if (
      cachedSysProxy.host === targetHostname &&
      now - cachedSysProxy.checkedAtMs < CC_PROXY_SYS_PROXY_CACHE_MS
    ) {
      return cachedSysProxy.url;
    }
    let proxyUrl = '';
    if (typeof detectProxyFn === 'function') {
      proxyUrl = String((await detectProxyFn(targetHostname)) || '').trim();
    } else {
      proxyUrl = await detectSystemHttpsProxy(targetHostname);
    }
    cachedSysProxy = { host: targetHostname, url: proxyUrl, checkedAtMs: now };
    return proxyUrl;
  }

  async function closeProxyServer() {
    const srv = server;
    server = null;
    localUrl = '';
    if (!srv) return;
    try {
      srv.closeAllConnections?.();
    } catch {
      // Node <18.2 fallback
    }
    await new Promise((resolve) => {
      try {
        srv.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function ensureProxyServerStarted() {
    if (server && localUrl) return localUrl;
    const { http, https, tls, zlib } = await loadCcProxyNodeModules();
    const targetBase = await resolveUpstreamUrl();
    const upstreamParsed = new URL(targetBase);
    const isUpstreamHttps = upstreamParsed.protocol === 'https:';
    const upstreamPort = Number(upstreamParsed.port || (isUpstreamHttps ? 443 : 80));

    const srv = http.createServer(async (req, res) => {
      const reqUrl = req.url || '/';
      const isFetchModels = reqUrl.includes('fetchAvailableModels');
      try {
        const fwdHeaders = { ...req.headers, host: upstreamParsed.host };
        if (isFetchModels) {
          delete fwdHeaders['accept-encoding'];
        }
        let customSocket = null;
        if (isUpstreamHttps) {
          const proxyUrl = await resolveSystemProxyForHost(upstreamParsed.hostname);
          if (proxyUrl) {
            customSocket = await openCcProxyTunnelSocket(
              http,
              tls,
              upstreamParsed.hostname,
              upstreamPort,
              proxyUrl
            );
          }
        }
        const upOpts = {
          hostname: upstreamParsed.hostname,
          port: upstreamPort,
          path: reqUrl,
          method: req.method,
          headers: fwdHeaders,
          ...(customSocket ? { agent: false, createConnection: () => customSocket } : {}),
        };

        req.setTimeout?.(0);
        const transport = isUpstreamHttps ? https : http;
        const upReq = transport.request(upOpts, (upRes) => {
          if (!isFetchModels || Number(upRes.statusCode || 0) !== 200) {
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            res.flushHeaders?.();
            upRes.pipe(res);
            return;
          }
          const chunks = [];
          upRes.on('data', (chunk) => chunks.push(chunk));
          upRes.on('end', () => {
            const rawBuf = Buffer.concat(chunks);
            let outBuf = rawBuf;
            const outHeaders = { ...upRes.headers };
            try {
              const plain = decompressCcProxyBody(zlib, rawBuf, upRes.headers['content-encoding']);
              const parsed = JSON.parse(plain.toString('utf8'));
              const rewriteRes = rewriteFetchAvailableModelsPayload(parsed, activeRules);
              if (Object.keys(rewriteRes.defaultsByModelId).length > 0) {
                upstreamDefaults = { ...upstreamDefaults, ...rewriteRes.defaultsByModelId };
              }
              if (rewriteRes.modified) {
                const rewritten = Buffer.from(JSON.stringify(parsed), 'utf8');
                delete outHeaders['content-encoding'];
                delete outHeaders['transfer-encoding'];
                outHeaders['content-length'] = String(rewritten.length);
                outBuf = rewritten;
                status = {
                  ...status,
                  syncedAtMs: Date.now(),
                };
              }
            } catch {
              // 解析失败时原样回传上游响应
            }
            res.writeHead(upRes.statusCode || 200, outHeaders);
            res.end(outBuf);
          });
          upRes.on('error', (err) => {
            if (!res.headersSent) res.writeHead(502);
            res.end(`Upstream stream error: ${err.message}`);
          });
        });

        upReq.setTimeout?.(0);
        upReq.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(`Proxy upstream error: ${err.message}`);
        });
        req.pipe(upReq);
      } catch (err) {
        if (!res.headersSent) res.writeHead(502);
        res.end(`Proxy setup error: ${err.message}`);
      }
    });

    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv.off('error', reject);
        resolve();
      });
    });
    srv.unref?.();
    const addrInfo = srv.address();
    const port = typeof addrInfo === 'object' && addrInfo ? Number(addrInfo.port || 0) : 0;
    server = srv;
    localUrl = `http://127.0.0.1:${port}`;
    return localUrl;
  }

  async function restoreLsCloudCodeUrl() {
    if (!lsSwitched) return;
    lsSwitched = false;
    appliedSig = '';
    const targetRestore = upstreamUrl || DEFAULT_UPSTREAM_CLOUDCODE_URL;
    try {
      await callRpcFn('SetCloudCodeURL', { url: targetRestore }, 4000);
    } catch {
      // 忽略 LS 已退出或暂不可达时的还原异常
    }
  }

  async function reconcileInternal({ enabled = false, rulesByModelId = {}, initialCatalogModels = null } = {}) {
    if (initialCatalogModels) {
      seedUpstreamDefaultsFromCatalog(initialCatalogModels);
    }
    const cleanRules = sanitizeCcProxyRules(rulesByModelId);
    const ruleKeys = Object.keys(cleanRules);
    const shouldEnable = Boolean(enabled && ruleKeys.length > 0);
    const ep = getEndpointFn() || {};
    const hasUsableLs =
      Boolean(ep.baseUrl) && (allowTestEndpoint || String(ep.addr || '') !== 'test.invalid');

    if (!shouldEnable) {
      activeRules = {};
      lastFailedSig = '';
      lastErrorAtMs = 0;
      if (lsSwitched && hasUsableLs) {
        await restoreLsCloudCodeUrl();
      } else {
        lsSwitched = false;
        appliedSig = '';
      }
      await closeProxyServer();
      status = {
        state: 'disabled',
        active: false,
        ruleCount: 0,
        appliedModels: [],
        upstreamUrl: upstreamUrl || '',
        localUrl: '',
        syncedAtMs: 0,
        error: '',
      };
      return getStatus();
    }

    if (!hasUsableLs) {
      activeRules = cleanRules;
      status = {
        state: 'disabled',
        active: false,
        ruleCount: ruleKeys.length,
        appliedModels: ruleKeys,
        upstreamUrl: upstreamUrl || '',
        localUrl: '',
        syncedAtMs: 0,
        error: '',
      };
      return getStatus();
    }

    activeRules = cleanRules;
    const epKey = `${String(ep.addr || ep.baseUrl)}|${String(ep.csrfToken || '')}`;
    const rulesCanon = canonicalizeCcProxyRules(cleanRules);
    const desiredSig = `${epKey}|${rulesCanon}`;

    if (lsSwitched && server && localUrl && appliedSig === desiredSig && status.state === 'active') {
      return getStatus();
    }

    if (
      lastFailedSig === desiredSig &&
      lastErrorAtMs > 0 &&
      Date.now() - lastErrorAtMs < retryCooldownMs
    ) {
      return getStatus();
    }

    try {
      const targetUpstream = await resolveUpstreamUrl();
      const listenUrl = await ensureProxyServerStarted();
      await callRpcFn('SetCloudCodeURL', { url: listenUrl }, 5000);
      lsSwitched = true;
      appliedSig = desiredSig;
      lastFailedSig = '';
      lastErrorAtMs = 0;
      status = {
        state: 'active',
        active: true,
        ruleCount: ruleKeys.length,
        appliedModels: ruleKeys,
        upstreamUrl: targetUpstream,
        localUrl: listenUrl,
        syncedAtMs: Date.now(),
        error: '',
      };
    } catch (err) {
      lastFailedSig = desiredSig;
      lastErrorAtMs = Date.now();
      if (!lsSwitched) {
        await closeProxyServer();
      }
      status = {
        state: 'error',
        active: false,
        ruleCount: ruleKeys.length,
        appliedModels: ruleKeys,
        upstreamUrl: upstreamUrl || '',
        localUrl: lsSwitched ? localUrl : '',
        syncedAtMs: status.syncedAtMs || 0,
        error: String(err?.message || 'SetCloudCodeURL failed'),
      };
    }
    return getStatus();
  }

  function reconcile(opts) {
    syncChain = syncChain.then(() => reconcileInternal(opts)).catch(() => getStatus());
    return syncChain;
  }

  function stop() {
    syncChain = syncChain
      .then(async () => {
        activeRules = {};
        lastFailedSig = '';
        lastErrorAtMs = 0;
        const ep = getEndpointFn() || {};
        const hasUsableLs =
          Boolean(ep.baseUrl) && (allowTestEndpoint || String(ep.addr || '') !== 'test.invalid');
        if (lsSwitched && hasUsableLs) {
          await restoreLsCloudCodeUrl();
        } else {
          lsSwitched = false;
          appliedSig = '';
        }
        await closeProxyServer();
        status = {
          state: 'disabled',
          active: false,
          ruleCount: 0,
          appliedModels: [],
          upstreamUrl: upstreamUrl || '',
          localUrl: '',
          syncedAtMs: 0,
          error: '',
        };
        return getStatus();
      })
      .catch(() => getStatus());
    return syncChain;
  }

  return {
    reconcile,
    stop,
    getStatus,
    getUpstreamDefaults,
    seedUpstreamDefaultsFromCatalog,
  };
}

let defaultCloudCodeProxyController = null;

export function getDefaultCloudCodeProxy() {
  if (!defaultCloudCodeProxyController) {
    defaultCloudCodeProxyController = createCloudCodeProxyController();
  }
  return defaultCloudCodeProxyController;
}

export function getDefaultCloudCodeProxyStatus() {
  if (!defaultCloudCodeProxyController) {
    return {
      state: 'disabled',
      active: false,
      ruleCount: 0,
      appliedModels: [],
      upstreamUrl: '',
      localUrl: '',
      syncedAtMs: 0,
      error: '',
    };
  }
  return defaultCloudCodeProxyController.getStatus();
}

export function getDefaultCloudCodeUpstreamDefaults() {
  if (!defaultCloudCodeProxyController) return {};
  return defaultCloudCodeProxyController.getUpstreamDefaults();
}

export function reconcileDefaultCloudCodeProxy(opts) {
  return getDefaultCloudCodeProxy().reconcile(opts);
}

export function stopDefaultCloudCodeProxy() {
  if (!defaultCloudCodeProxyController) return Promise.resolve();
  return defaultCloudCodeProxyController.stop();
}
