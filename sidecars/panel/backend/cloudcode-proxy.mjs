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
import { DATA_DIR, loadJson, lsRuntimeEndpoint, saveJson } from './config.mjs';
import { callLsRpc } from './ls-rpc.mjs';

export const DEFAULT_UPSTREAM_CLOUDCODE_URL = 'https://daily-cloudcode-pa.googleapis.com';

const CC_PROXY_UPSTREAM_URL_RE = /https:\/\/[a-z0-9.-]*cloudcode-pa\.googleapis\.com/gi;
const CC_PROXY_CHECKPOINTER_KEY = 'CASCADE_USE_EXPERIMENT_CHECKPOINTER';
const CC_PROXY_CHECKPOINTER_PREFIX = `${CC_PROXY_CHECKPOINTER_KEY}/`;
const CC_PROXY_MAX_LOG_READ_BYTES = 512 * 1024;
const CC_PROXY_RETRY_COOLDOWN_MS = 15_000;
const CC_PROXY_SYS_PROXY_CACHE_MS = 15_000;
const CC_PROXY_DEFAULT_TUNNEL_TIMEOUT_MS = 15_000;
const CC_PROXY_AGENT_FREE_SOCKET_TIMEOUT_MS = 25_000;
const CC_PROXY_HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
];
const ccProxyNoopSocketError = () => {};

let ccProxyNodeModulesPromise = null;

async function loadCcProxyNodeModules() {
  if (!ccProxyNodeModulesPromise) {
    ccProxyNodeModulesPromise = Promise.all([
      import('node:http'),
      import('node:https'),
      import('node:net'),
      import('node:tls'),
      import('node:zlib'),
      import('node:child_process'),
      import('node:fs'),
    ]).then(([httpMod, httpsMod, netMod, tlsMod, zlibMod, cpMod, fsMod]) => ({
      http: httpMod.default || httpMod,
      https: httpsMod.default || httpsMod,
      net: netMod.default || netMod,
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

export function shouldCcProxyBypassHost(hostname, noProxyRaw) {
  const target = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const list = String(noProxyRaw || '').trim();
  if (!target || !list) return false;
  for (const part of list.split(/[;,\s]+/)) {
    const raw = part.trim().toLowerCase();
    if (!raw) continue;
    if (raw === '*') return true;
    if (raw === '<local>') {
      if (isCcProxyLoopbackHost(target) || (!target.includes('.') && !target.includes(':'))) {
        return true;
      }
      continue;
    }
    const strippedPort = raw.startsWith('[')
      ? raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
      : raw.includes(':') && raw.indexOf(':') === raw.lastIndexOf(':')
        ? raw.replace(/:\d+$/, '')
        : raw;
    if (!strippedPort) continue;
    if (strippedPort.includes('*') && !(strippedPort.startsWith('*.') && !strippedPort.slice(2).includes('*'))) {
      const pattern = `^${strippedPort.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`;
      if (new RegExp(pattern, 'i').test(target)) return true;
      continue;
    }
    const rule = strippedPort.replace(/^\*\./, '.');
    if (!rule) continue;
    if (rule.startsWith('.')) {
      if (target.endsWith(rule) || target === rule.slice(1)) return true;
    } else if (target === rule || target.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

export function normalizeCcProxyCandidateUrl(rawVal) {
  let s = String(rawVal || '').trim();
  if (!s) return '';
  if (/^socks:\/\//i.test(s)) {
    s = `socks5://${s.slice('socks://'.length)}`;
  }
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  if (hasExplicitScheme && !/^(?:https?|socks5h?):\/\//i.test(s)) {
    return '';
  }
  const candidate = hasExplicitScheme ? s : `http://${s}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return '';
    if (parsed.port) {
      const p = Number(parsed.port);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return '';
    }
    return candidate;
  } catch {
    return '';
  }
}

function parseWindowsProxyServerValue(rawVal) {
  const srv = String(rawVal || '').trim();
  if (!srv) return '';
  if (srv.includes('=')) {
    const parts = srv.split(';').map((p) => p.trim()).filter(Boolean);
    const httpsPart = parts.find((p) => p.toLowerCase().startsWith('https='));
    const httpPart = parts.find((p) => p.toLowerCase().startsWith('http='));
    const socksPart = parts.find((p) => p.toLowerCase().startsWith('socks='));
    const chosen = httpsPart || httpPart || socksPart || '';
    if (!chosen) return '';
    const rawHostPort = chosen.slice(chosen.indexOf('=') + 1).trim();
    if (!rawHostPort) return '';
    if (chosen === socksPart && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawHostPort)) {
      return normalizeCcProxyCandidateUrl(`socks5://${rawHostPort}`);
    }
    return normalizeCcProxyCandidateUrl(rawHostPort);
  }
  return normalizeCcProxyCandidateUrl(srv);
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
  const envCandidates = [
    env?.HTTPS_PROXY,
    env?.https_proxy,
    env?.ALL_PROXY,
    env?.all_proxy,
  ];
  for (const rawCandidate of envCandidates) {
    const normalized = normalizeCcProxyCandidateUrl(rawCandidate);
    if (normalized) return normalized;
  }
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

function ccProxySafeDecodeUriPart(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return String(raw);
  }
}

function ccProxyReadExactBytes(socket, count) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
      socket.off('end', onClose);
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SOCKS5 proxy closed connection prematurely'));
    };
    const onData = (chunk) => {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      if (acc.length >= count) {
        cleanup();
        socket.pause();
        const needed = acc.subarray(0, count);
        const rest = acc.subarray(count);
        if (rest.length > 0) {
          socket.unshift(rest);
        }
        resolve(needed);
      }
    };
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
    socket.once('end', onClose);
    socket.resume();
  });
}

function ccProxyEncodeIpv6Bytes(ipv6Str) {
  let host = String(ipv6Str || '').trim().replace(/^\[|\]$/g, '');
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  const lastColon = host.lastIndexOf(':');
  if (lastColon !== -1 && host.slice(lastColon + 1).includes('.')) {
    const v4Parts = host
      .slice(lastColon + 1)
      .split('.')
      .map((n) => Number(n));
    if (v4Parts.length !== 4 || v4Parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    host = `${host.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const dblParts = host.split('::');
  if (dblParts.length > 2) return null;
  const left = dblParts[0] ? dblParts[0].split(':') : [];
  const right = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (dblParts.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = dblParts.length === 2 ? [...left, ...new Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 8; i += 1) {
    const val = Number.parseInt(groups[i], 16);
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
    buf.writeUInt16BE(val, i * 2);
  }
  return buf;
}

async function ccProxyConnectSocks5Socket(net, parsedProxy, targetHost, targetPort) {
  const proxyHost = parsedProxy.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(parsedProxy.port || 1080);
  const rawUser = ccProxySafeDecodeUriPart(parsedProxy.username);
  const rawPass = ccProxySafeDecodeUriPart(parsedProxy.password);
  const hasAuth = Boolean(rawUser || rawPass);

  const socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host: proxyHost, port: proxyPort });
    const onErr = (err) => {
      s.destroy();
      reject(err);
    };
    s.once('error', onErr);
    s.once('connect', () => {
      s.off('error', onErr);
      s.on('error', ccProxyNoopSocketError);
      resolve(s);
    });
  });

  try {
    // 1. Method negotiation (RFC 1928)
    const greeting = hasAuth
      ? Buffer.from([0x05, 0x02, 0x00, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(greeting);
    const methodReply = await ccProxyReadExactBytes(socket, 2);
    if (methodReply[0] !== 0x05 || methodReply[1] === 0xff) {
      throw new Error('SOCKS5 proxy rejected authentication methods');
    }
    if (methodReply[1] === 0x02) {
      if (!hasAuth) {
        throw new Error('SOCKS5 proxy requires username/password authentication');
      }
      const userBuf = Buffer.from(rawUser, 'utf8');
      const passBuf = Buffer.from(rawPass, 'utf8');
      if (userBuf.length > 255 || passBuf.length > 255) {
        throw new Error('SOCKS5 credentials exceed 255 bytes');
      }
      const authReq = Buffer.concat([
        Buffer.from([0x01, userBuf.length]),
        userBuf,
        Buffer.from([passBuf.length]),
        passBuf,
      ]);
      socket.write(authReq);
      const authReply = await ccProxyReadExactBytes(socket, 2);
      if (authReply[1] !== 0x00) {
        throw new Error('SOCKS5 username/password authentication failed');
      }
    } else if (methodReply[1] !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method (${methodReply[1]})`);
    }

    // 2. CONNECT targetHost:targetPort
    const cleanHost = String(targetHost || '').replace(/^\[|\]$/g, '');
    const ipVer = net.isIP(cleanHost);
    let addrPart;
    if (ipVer === 4) {
      const octets = cleanHost.split('.').map((n) => Number(n));
      addrPart = Buffer.from([0x01, octets[0], octets[1], octets[2], octets[3]]);
    } else if (ipVer === 6) {
      const ipv6Bytes = ccProxyEncodeIpv6Bytes(cleanHost);
      if (!ipv6Bytes) {
        throw new Error('Invalid SOCKS5 target IPv6 address');
      }
      addrPart = Buffer.concat([Buffer.from([0x04]), ipv6Bytes]);
    } else {
      const hostBuf = Buffer.from(cleanHost, 'utf8');
      if (hostBuf.length === 0 || hostBuf.length > 255) {
        throw new Error('Invalid SOCKS5 target hostname');
      }
      addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.allocUnsafe(2);
    portBuf.writeUInt16BE(Number(targetPort), 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));

    const repHead = await ccProxyReadExactBytes(socket, 4);
    if (repHead[0] !== 0x05 || repHead[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed (code ${repHead[1]})`);
    }
    const atyp = repHead[3];
    if (atyp === 0x01) {
      await ccProxyReadExactBytes(socket, 4 + 2);
    } else if (atyp === 0x03) {
      const lenBuf = await ccProxyReadExactBytes(socket, 1);
      await ccProxyReadExactBytes(socket, lenBuf[0] + 2);
    } else if (atyp === 0x04) {
      await ccProxyReadExactBytes(socket, 16 + 2);
    } else {
      throw new Error(`Unsupported SOCKS5 reply address type (${atyp})`);
    }
    socket.resume();
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

export function openCcProxyTunnelSocket(
  mods,
  targetHost,
  targetPort,
  proxyUrl,
  { timeoutMs = CC_PROXY_DEFAULT_TUNNEL_TIMEOUT_MS, tlsOptions = null } = {}
) {
  const normalizedUrl = normalizeCcProxyCandidateUrl(proxyUrl);
  if (!normalizedUrl) return Promise.resolve(null);
  const parsedProxy = new URL(normalizedUrl);
  const { http, https, net, tls } = mods;
  const cleanTargetHost = String(targetHost || '').replace(/^\[|\]$/g, '');
  const sniOpts = net && net.isIP(cleanTargetHost) !== 0 ? {} : { servername: cleanTargetHost };
  const connectAuthority = cleanTargetHost.includes(':')
    ? `[${cleanTargetHost}]:${targetPort}`
    : `${cleanTargetHost}:${targetPort}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectReq = null;
    let rawSocket = null;
    let tlsSocket = null;

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            fail(new Error(`Proxy tunnel timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    timer?.unref?.();

    function cleanupTimer() {
      if (timer) clearTimeout(timer);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupTimer();
      try {
        connectReq?.destroy();
      } catch {}
      try {
        tlsSocket?.destroy();
      } catch {}
      try {
        rawSocket?.destroy();
      } catch {}
      reject(err);
    }

    function upgradeToTls(sock, headBuf = null) {
      rawSocket = sock;
      sock.on('error', ccProxyNoopSocketError);
      if (headBuf && headBuf.length > 0) {
        sock.unshift(headBuf);
      }
      tlsSocket = tls.connect({
        socket: sock,
        ALPNProtocols: ['http/1.1'],
        ...sniOpts,
        ...(tlsOptions && typeof tlsOptions === 'object' ? tlsOptions : {}),
      });
      tlsSocket.on('error', ccProxyNoopSocketError);
      tlsSocket.once('secureConnect', () => {
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        settled = true;
        cleanupTimer();
        tlsSocket.off('error', fail);
        resolve(tlsSocket);
      });
      tlsSocket.once('error', fail);
    }

    const proto = parsedProxy.protocol.toLowerCase();
    if (proto === 'socks5:' || proto === 'socks5h:') {
      ccProxyConnectSocks5Socket(net, parsedProxy, cleanTargetHost, targetPort)
        .then((sock) => {
          if (settled) {
            sock.destroy();
            return;
          }
          upgradeToTls(sock);
        })
        .catch(fail);
      return;
    }

    const isHttpsProxy = proto === 'https:';
    const proxyTransport = isHttpsProxy ? https : http;
    const headers = { Host: connectAuthority };
    if (parsedProxy.username || parsedProxy.password) {
      const user = ccProxySafeDecodeUriPart(parsedProxy.username);
      const pass = ccProxySafeDecodeUriPart(parsedProxy.password);
      const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
      headers['Proxy-Authorization'] = `Basic ${token}`;
    }

    connectReq = proxyTransport.request({
      hostname: parsedProxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(parsedProxy.port || (isHttpsProxy ? 443 : 80)),
      method: 'CONNECT',
      path: connectAuthority,
      headers,
    });
    connectReq.on('connect', (res, socket, head) => {
      socket.on('error', ccProxyNoopSocketError);
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT failed (${res.statusCode})`));
        return;
      }
      upgradeToTls(socket, head);
    });
    connectReq.on('error', fail);
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
  tunnelTimeoutMs = CC_PROXY_DEFAULT_TUNNEL_TIMEOUT_MS,
  upstreamTlsOptions = null,
  stateFilePath = '',
  loadJsonFn = loadJson,
  saveJsonFn = saveJson,
} = {}) {
  let server = null;
  let localUrl = '';
  let preferredPort = 0;
  let upstreamUrl = '';
  let lsSwitched = false;
  let stateHydratedOnce = false;
  let activeRules = {};
  let upstreamDefaults = {};
  let appliedSig = '';
  let lastFailedSig = '';
  let lastErrorAtMs = 0;
  let cachedSysProxy = { url: '', checkedAtMs: 0, host: '' };
  let activeAgentEntry = null;
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

  function hydratePersistedStateOnce() {
    if (stateHydratedOnce) return;
    stateHydratedOnce = true;
    if (!stateFilePath || typeof loadJsonFn !== 'function') return;
    try {
      const saved = loadJsonFn(stateFilePath, null);
      if (!saved || typeof saved !== 'object') return;
      const savedPort = Number(saved.localPort || 0);
      if (Number.isInteger(savedPort) && savedPort > 0 && savedPort <= 65535) {
        preferredPort = savedPort;
      }
      const savedUpstream = String(saved.upstreamUrl || '').trim();
      if (
        savedUpstream &&
        !upstreamUrl &&
        isValidUpstreamCloudCodeUrl(savedUpstream, { allowHttp: allowHttpUpstream })
      ) {
        upstreamUrl = savedUpstream.replace(/\/+$/, '');
      }
      if (saved.switched === true) {
        lsSwitched = true;
      }
    } catch {
      // 忽略损坏的状态快照
    }
  }

  function persistProxyStateSnapshot(switchedFlag) {
    if (!stateFilePath || typeof saveJsonFn !== 'function') return;
    try {
      saveJsonFn(stateFilePath, {
        switched: Boolean(switchedFlag),
        localPort: preferredPort > 0 ? preferredPort : undefined,
        localUrl: switchedFlag && localUrl ? localUrl : undefined,
        upstreamUrl: upstreamUrl || DEFAULT_UPSTREAM_CLOUDCODE_URL,
        updatedAtMs: Date.now(),
      });
    } catch {
      // 忽略持久化状态异常
    }
  }

  function destroyActiveUpstreamAgent() {
    if (!activeAgentEntry) return;
    const prevAgent = activeAgentEntry.agent;
    activeAgentEntry = null;
    try {
      prevAgent?.destroy?.();
    } catch {
      // 忽略连接池销毁异常
    }
  }

  function getPooledUpstreamAgent(mods, isUpstreamHttps, upstreamHost, upstreamPort, proxyUrl) {
    const cleanProxy = isUpstreamHttps ? String(proxyUrl || '') : '';
    const key = `${isUpstreamHttps ? 'https' : 'http'}|${upstreamHost}:${upstreamPort}|${cleanProxy || 'direct'}`;
    if (activeAgentEntry && activeAgentEntry.key === key) {
      return activeAgentEntry.agent;
    }
    destroyActiveUpstreamAgent();

    const baseAgentOpts = {
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: 32,
      maxFreeSockets: 4,
      timeout: CC_PROXY_AGENT_FREE_SOCKET_TIMEOUT_MS,
      ...(isUpstreamHttps && upstreamTlsOptions ? upstreamTlsOptions : {}),
    };

    let agent;
    if (isUpstreamHttps && cleanProxy) {
      class CcProxyTunnelHttpsAgent extends mods.https.Agent {
        createConnection(_opts, callback) {
          openCcProxyTunnelSocket(mods, upstreamHost, upstreamPort, cleanProxy, {
            timeoutMs: tunnelTimeoutMs,
            tlsOptions: upstreamTlsOptions,
          }).then(
            (tlsSock) => callback(null, tlsSock),
            (err) => callback(err)
          );
          return null;
        }
      }
      agent = new CcProxyTunnelHttpsAgent(baseAgentOpts);
    } else {
      const AgentCtor = isUpstreamHttps ? mods.https.Agent : mods.http.Agent;
      agent = new AgentCtor(baseAgentOpts);
    }
    activeAgentEntry = { key, agent };
    return agent;
  }

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
      const rawDetected = String((await detectProxyFn(targetHostname)) || '').trim();
      proxyUrl = normalizeCcProxyCandidateUrl(rawDetected);
    } else {
      proxyUrl = await detectSystemHttpsProxy(targetHostname);
    }
    cachedSysProxy = { host: targetHostname, url: proxyUrl, checkedAtMs: now };
    return proxyUrl;
  }

  async function closeProxyServer() {
    destroyActiveUpstreamAgent();
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
    const mods = await loadCcProxyNodeModules();
    const { http, https, zlib } = mods;
    const targetBase = await resolveUpstreamUrl();
    const upstreamParsed = new URL(targetBase);
    const isUpstreamHttps = upstreamParsed.protocol === 'https:';
    const upstreamPort = Number(upstreamParsed.port || (isUpstreamHttps ? 443 : 80));

    const srv = http.createServer(async (req, res) => {
      const reqUrl = req.url || '/';
      const isFetchModels = reqUrl.includes('fetchAvailableModels');
      let clientAborted = false;
      let activeUpReq = null;
      let activeUpRes = null;

      const abortUpstreamOnClientDisconnect = () => {
        if (res.writableEnded) return;
        clientAborted = true;
        try {
          activeUpRes?.destroy();
        } catch {}
        try {
          activeUpReq?.destroy();
        } catch {}
      };
      req.once('aborted', abortUpstreamOnClientDisconnect);
      res.once('close', abortUpstreamOnClientDisconnect);
      req.on('error', abortUpstreamOnClientDisconnect);
      res.on('error', abortUpstreamOnClientDisconnect);

      try {
        const fwdHeaders = { ...req.headers, host: upstreamParsed.host };
        for (const hopKey of CC_PROXY_HOP_BY_HOP_HEADERS) {
          delete fwdHeaders[hopKey];
        }
        if (isFetchModels) {
          delete fwdHeaders['accept-encoding'];
        }
        const proxyUrl = isUpstreamHttps
          ? await resolveSystemProxyForHost(upstreamParsed.hostname)
          : '';
        if (clientAborted || req.destroyed || res.destroyed || res.writableEnded) {
          return;
        }
        const agent = getPooledUpstreamAgent(
          mods,
          isUpstreamHttps,
          upstreamParsed.hostname,
          upstreamPort,
          proxyUrl
        );
        const upOpts = {
          hostname: upstreamParsed.hostname,
          port: upstreamPort,
          path: reqUrl,
          method: req.method,
          headers: fwdHeaders,
          agent,
          ...(isUpstreamHttps && upstreamTlsOptions ? upstreamTlsOptions : {}),
        };

        req.setTimeout?.(0);
        const transport = isUpstreamHttps ? https : http;
        const upReq = transport.request(upOpts, (upRes) => {
          activeUpRes = upRes;
          upRes.on('error', (err) => {
            if (clientAborted || res.destroyed || res.writableEnded) return;
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(`Upstream stream error: ${err.message}`);
            } else {
              res.destroy();
            }
          });
          if (clientAborted || res.destroyed || res.writableEnded) {
            upRes.destroy();
            return;
          }
          if (!isFetchModels || Number(upRes.statusCode || 0) !== 200) {
            const passthroughHeaders = { ...upRes.headers };
            for (const hopKey of CC_PROXY_HOP_BY_HOP_HEADERS) {
              delete passthroughHeaders[hopKey];
            }
            res.writeHead(upRes.statusCode || 502, passthroughHeaders);
            res.flushHeaders?.();
            upRes.pipe(res);
            return;
          }
          const chunks = [];
          upRes.on('data', (chunk) => chunks.push(chunk));
          upRes.on('end', () => {
            if (clientAborted || res.destroyed || res.writableEnded) return;
            const rawBuf = Buffer.concat(chunks);
            let outBuf = rawBuf;
            const outHeaders = { ...upRes.headers };
            for (const hopKey of CC_PROXY_HOP_BY_HOP_HEADERS) {
              delete outHeaders[hopKey];
            }
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
        });
        activeUpReq = upReq;

        upReq.setTimeout?.(0);
        upReq.on('error', (err) => {
          if (clientAborted || res.destroyed || res.writableEnded) return;
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Proxy upstream error: ${err.message}`);
          } else {
            res.destroy();
          }
        });
        req.pipe(upReq);
      } catch (err) {
        if (clientAborted || res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Proxy setup error: ${err.message}`);
        } else {
          res.destroy();
        }
      }
    });

    const tryListenOnPort = (candidatePort) =>
      new Promise((resolve, reject) => {
        const onErr = (err) => {
          srv.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          srv.off('error', onErr);
          resolve();
        };
        srv.once('error', onErr);
        srv.once('listening', onListening);
        srv.listen(candidatePort, '127.0.0.1');
      });

    if (preferredPort > 0) {
      try {
        await tryListenOnPort(preferredPort);
      } catch {
        await tryListenOnPort(0);
      }
    } else {
      await tryListenOnPort(0);
    }

    srv.unref?.();
    const addrInfo = srv.address();
    const port = typeof addrInfo === 'object' && addrInfo ? Number(addrInfo.port || 0) : 0;
    if (port > 0) {
      preferredPort = port;
    }
    server = srv;
    localUrl = `http://127.0.0.1:${port}`;
    return localUrl;
  }

  async function restoreLsCloudCodeUrl({ timeoutMs = 4000, clearEvenOnFailure = false } = {}) {
    if (!lsSwitched) return true;
    appliedSig = '';
    const targetRestore = (await resolveUpstreamUrl().catch(() => '')) || DEFAULT_UPSTREAM_CLOUDCODE_URL;
    try {
      await callRpcFn('SetCloudCodeURL', { url: targetRestore }, timeoutMs);
      lsSwitched = false;
      persistProxyStateSnapshot(false);
      return true;
    } catch {
      if (clearEvenOnFailure) {
        lsSwitched = false;
      }
      return false;
    }
  }

  async function reconcileInternal({ enabled = false, rulesByModelId = {}, initialCatalogModels = null } = {}) {
    hydratePersistedStateOnce();
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
      appliedSig = '';
      if (lsSwitched && hasUsableLs) {
        await restoreLsCloudCodeUrl({ timeoutMs: 3000 });
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
      persistProxyStateSnapshot(true);
      await callRpcFn('SetCloudCodeURL', { url: listenUrl }, 5000);
      lsSwitched = true;
      appliedSig = desiredSig;
      lastFailedSig = '';
      lastErrorAtMs = 0;
      persistProxyStateSnapshot(true);
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
        persistProxyStateSnapshot(false);
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
        hydratePersistedStateOnce();
        activeRules = {};
        lastFailedSig = '';
        lastErrorAtMs = 0;
        appliedSig = '';
        const ep = getEndpointFn() || {};
        const hasUsableLs =
          Boolean(ep.baseUrl) && (allowTestEndpoint || String(ep.addr || '') !== 'test.invalid');
        if (lsSwitched && hasUsableLs) {
          await restoreLsCloudCodeUrl({ timeoutMs: 900, clearEvenOnFailure: true });
        } else {
          lsSwitched = false;
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

function resolveDefaultCloudCodeProxyStatePath() {
  const normDir = String(DATA_DIR || '').replace(/\\/g, '/');
  if (!normDir || normDir.startsWith('/test/') || normDir.startsWith('/test-home/')) {
    return '';
  }
  return join(DATA_DIR, 'cloudcode-proxy-state.json');
}

let defaultCloudCodeProxyController = null;

export function getDefaultCloudCodeProxy() {
  if (!defaultCloudCodeProxyController) {
    defaultCloudCodeProxyController = createCloudCodeProxyController({
      stateFilePath: resolveDefaultCloudCodeProxyStatePath(),
    });
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
