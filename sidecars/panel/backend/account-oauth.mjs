/** @fileoverview Google OAuth identity and quota queries for saved Antigravity credentials. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsPromises } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fetchGoogleAccount } from './account-http.mjs';
import { buildOfficialQuotaPools } from './quota-pools.mjs';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USER_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CLOUD_CODE_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
];
const OAUTH_CLIENT_ID_RE = /^\d+-[\w-]+\.apps\.googleusercontent\.com$/;
const OAUTH_CLIENT_SECRET_RE = /^GOCSPX-[\w-]+$/;
// One-way SHA-256 digest of the official Antigravity desktop OAuth client_id for synchronous allowlist checks
// without embedding plaintext OAuth credentials in source control.
const OFFICIAL_OAUTH_CLIENT_ID_HASHES = Object.freeze(
  new Set(['bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea'])
);
const ACCOUNT_USER_AGENT = `antigravity/hub/4.3.0 (os_type=${process.platform === 'win32' ? 'windows' : process.platform}; arch=${process.arch === 'x64' ? 'amd64' : process.arch})`;

const PE_ID_LEN_OP = Buffer.from([0x48, 0xc7, 0x40, 0x08]);
const PE_LEA_RIP_OP = Buffer.from([0x48, 0x8d, 0x0d]);
const PE_BETWEEN_OP = Buffer.from([0x48, 0x89, 0x08, 0x48, 0xc7, 0x40, 0x18]);

let nativeOAuthClientsPromise = null;
const discoveredAllowedClientIds = new Set();

function sha256Hex(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parsePeTextAndRdata(headerBuf) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 64) return null;
  const pe = headerBuf.readUInt16LE(0) === 0x5a4d ? headerBuf.readUInt32LE(60) : 0;
  if (!pe || pe + 24 > headerBuf.length || headerBuf.readUInt32LE(pe) !== 0x4550 || headerBuf.readUInt16LE(pe + 4) !== 0x8664) {
    return null;
  }
  const count = headerBuf.readUInt16LE(pe + 6);
  const table = pe + 24 + headerBuf.readUInt16LE(pe + 20);
  if (table + count * 40 > headerBuf.length) return null;

  let text = null;
  let rodata = null;
  for (let i = 0; i < count; i += 1) {
    const offset = table + i * 40;
    const name = headerBuf.toString('ascii', offset, offset + 8).replace(/\0+$/, '');
    const section = {
      name,
      rva: headerBuf.readUInt32LE(offset + 12),
      size: headerBuf.readUInt32LE(offset + 16),
      start: headerBuf.readUInt32LE(offset + 20),
    };
    if (name === '.text') text = section;
    else if (name === '.rdata') rodata = section;
  }
  return text && rodata ? { text, rodata } : null;
}

// Go's x64 OAuth config initializer stores ClientID and ClientSecret as two consecutive pointer/length pairs.
function scanGoOAuthInitializerMatches(machineCode, textRva, rodata) {
  const matches = [];
  for (
    let i = machineCode.indexOf(PE_ID_LEN_OP);
    i >= 0 && i + 33 <= machineCode.length;
    i = machineCode.indexOf(PE_ID_LEN_OP, i + 1)
  ) {
    if (
      !machineCode.subarray(i + 8, i + 11).equals(PE_LEA_RIP_OP) ||
      !machineCode.subarray(i + 15, i + 22).equals(PE_BETWEEN_OP) ||
      !machineCode.subarray(i + 26, i + 29).equals(PE_LEA_RIP_OP)
    ) {
      continue;
    }
    const idLen = machineCode.readUInt32LE(i + 4);
    const secretLen = machineCode.readUInt32LE(i + 22);
    if (idLen <= 0 || idLen > 100 || secretLen <= 0 || secretLen > 100) continue;
    const idRva = textRva + (i + 11) + 4 + machineCode.readInt32LE(i + 11);
    const secretRva = textRva + (i + 29) + 4 + machineCode.readInt32LE(i + 29);
    const idOffset = idRva - rodata.rva;
    const secretOffset = secretRva - rodata.rva;
    if (
      idOffset < 0 ||
      idOffset + idLen > rodata.size ||
      secretOffset < 0 ||
      secretOffset + secretLen > rodata.size
    ) {
      continue;
    }
    matches.push({ idOffset, idLen, secretOffset, secretLen });
  }
  return matches;
}

export function extractNativeOAuthClients(binary) {
  const sections = parsePeTextAndRdata(binary);
  if (!sections) return [];
  const { text, rodata } = sections;
  if (text.start + text.size > binary.length || rodata.start + rodata.size > binary.length) {
    return [];
  }
  const machineCode = binary.subarray(text.start, text.start + text.size);
  const clients = new Map();
  for (const m of scanGoOAuthInitializerMatches(machineCode, text.rva, rodata)) {
    const id = binary.toString('ascii', rodata.start + m.idOffset, rodata.start + m.idOffset + m.idLen);
    const secret = binary.toString('ascii', rodata.start + m.secretOffset, rodata.start + m.secretOffset + m.secretLen);
    if (OAUTH_CLIENT_ID_RE.test(id) && OAUTH_CLIENT_SECRET_RE.test(secret)) {
      clients.set(id, { id, secret });
    }
  }
  return Array.from(clients.values()).reverse();
}

async function extractNativeOAuthClientsFromFile(filePath) {
  if (typeof fsPromises === 'undefined' || typeof fsPromises?.open !== 'function') {
    return [];
  }
  let handle = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size < 64) return [];
    const headerLen = Math.min(4096, st.size);
    const headerBuf = Buffer.alloc(headerLen);
    await handle.read(headerBuf, 0, headerLen, 0);
    const sections = parsePeTextAndRdata(headerBuf);
    if (!sections) return [];
    const { text, rodata } = sections;
    if (text.start + text.size > st.size || rodata.start + rodata.size > st.size) {
      return [];
    }
    // Read only .text into memory and fetch matching <=100B literals directly from .rdata on demand.
    const textBuf = Buffer.allocUnsafe(text.size);
    let offset = 0;
    while (offset < text.size) {
      const { bytesRead } = await handle.read(textBuf, offset, text.size - offset, text.start + offset);
      if (bytesRead <= 0) return [];
      offset += bytesRead;
    }
    const matches = scanGoOAuthInitializerMatches(textBuf, text.rva, rodata);
    const clients = new Map();
    for (const m of matches) {
      const idBuf = Buffer.allocUnsafe(m.idLen);
      const secBuf = Buffer.allocUnsafe(m.secretLen);
      const [idRead, secRead] = await Promise.all([
        handle.read(idBuf, 0, m.idLen, rodata.start + m.idOffset),
        handle.read(secBuf, 0, m.secretLen, rodata.start + m.secretOffset),
      ]);
      if (idRead.bytesRead !== m.idLen || secRead.bytesRead !== m.secretLen) continue;
      const id = idBuf.toString('ascii');
      const secret = secBuf.toString('ascii');
      if (OAUTH_CLIENT_ID_RE.test(id) && OAUTH_CLIENT_SECRET_RE.test(secret)) {
        clients.set(id, { id, secret });
      }
    }
    return Array.from(clients.values()).reverse();
  } catch {
    return [];
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export function collectNativeOAuthBinaryCandidates({
  env = process.env,
  homeDir = homedir(),
  existsFn = existsSync,
} = {}) {
  const seen = new Set();
  const candidates = [];
  const add = (filePath) => {
    const clean = String(filePath || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(clean);
  };
  const addFromInstallRoot = (installRoot) => {
    if (!installRoot) return;
    add(join(installRoot, 'resources', 'bin', 'language_server.exe'));
    add(join(installRoot, 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe'));
  };

  add(env?.ANTIGRAVITY_LS_BIN);
  const hints = [
    env?.USAGE_MONITOR_HOST_EXE,
    env?.ANTIGRAVITY_AGENTAPI_EXE,
    env?.CHROME_DEVTOOLS_MCP_JS,
  ];
  for (const rawHint of hints) {
    const hint = String(rawHint || '').trim();
    if (!hint) continue;
    const leaf = basename(hint).toLowerCase();
    if (/^(?:language_server.*|agy)\.exe$/i.test(leaf)) {
      add(hint);
      continue;
    }
    if (/\.exe$/i.test(leaf)) {
      addFromInstallRoot(dirname(hint));
    }
    let cur = hint;
    for (let depth = 0; depth < 8 && cur && dirname(cur) !== cur; depth += 1) {
      if (basename(cur).toLowerCase() === 'resources') {
        addFromInstallRoot(dirname(cur));
        break;
      }
      cur = dirname(cur);
    }
  }

  const localAppData = String(env?.LOCALAPPDATA || '').trim() || join(homeDir, 'AppData', 'Local');
  const programFiles = String(env?.ProgramFiles || '').trim() || 'C:\\Program Files';
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  addFromInstallRoot(join(localAppData, 'Programs', 'Antigravity'));
  addFromInstallRoot(join(localAppData, 'Programs', 'Antigravity IDE'));
  addFromInstallRoot(join(programFiles, 'Antigravity'));
  addFromInstallRoot(join(programFiles, 'Antigravity IDE'));
  add(join(geminiBase, 'bin', 'agy.exe'));

  if (typeof existsFn !== 'function') return candidates;
  return candidates.filter((p) => {
    try {
      return Boolean(existsFn(p));
    } catch {
      return false;
    }
  });
}

function discoverRunningOAuthBinaryPaths() {
  if (process.platform !== 'win32' || typeof execFile !== 'function') {
    return Promise.resolve([]);
  }
  const shell = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const cmd =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name LIKE 'agy%'\" | Select-Object -ExpandProperty ExecutablePath -Unique";
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 3000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((p) => /^(?:language_server.*|agy)\.exe$/i.test(basename(p)));
        resolve(paths);
      }
    );
  });
}

function rememberDiscoveredClients(clients) {
  for (const client of clients) {
    if (client?.id) discoveredAllowedClientIds.add(client.id);
  }
  return Object.freeze(clients.map((c) => Object.freeze({ id: c.id, secret: c.secret })));
}

export async function loadNativeOAuthClients(options = undefined) {
  const customRun = Boolean(options && Object.keys(options).length > 0);
  const env = options?.env ?? process.env;
  const overrideId = String(env?.USAGE_MONITOR_OAUTH_CLIENT_ID || '').trim();
  const overrideSecret = String(env?.USAGE_MONITOR_OAUTH_CLIENT_SECRET || '').trim();
  if (OAUTH_CLIENT_ID_RE.test(overrideId) && OAUTH_CLIENT_SECRET_RE.test(overrideSecret)) {
    return rememberDiscoveredClients([{ id: overrideId, secret: overrideSecret }]);
  }

  const runLoad = async () => {
    const extractFromFileFn = options?.extractFromFileFn || extractNativeOAuthClientsFromFile;
    const discoverRunningFn = options?.discoverRunningFn || discoverRunningOAuthBinaryPaths;
    const candidates = collectNativeOAuthBinaryCandidates({
      env,
      homeDir: options?.homeDir ?? homedir(),
      existsFn: options?.existsFn ?? existsSync,
    });
    const tried = new Set();
    for (const filePath of candidates) {
      tried.add(filePath.toLowerCase());
      const clients = await extractFromFileFn(filePath);
      if (Array.isArray(clients) && clients.length > 0) {
        return rememberDiscoveredClients(clients);
      }
    }
    const runningPaths = await discoverRunningFn().catch(() => []);
    for (const filePath of runningPaths) {
      const key = String(filePath || '').trim().toLowerCase();
      if (!key || tried.has(key)) continue;
      tried.add(key);
      const clients = await extractFromFileFn(filePath);
      if (Array.isArray(clients) && clients.length > 0) {
        return rememberDiscoveredClients(clients);
      }
    }
    return Object.freeze([]);
  };

  if (customRun) {
    return runLoad();
  }
  if (!nativeOAuthClientsPromise) {
    nativeOAuthClientsPromise = runLoad();
  }
  const clients = await nativeOAuthClientsPromise;
  if (!clients.length) {
    nativeOAuthClientsPromise = null;
  }
  return clients;
}

export function isAllowedOAuthClientId(clientId, allowedIds = null) {
  if (typeof clientId !== 'string') return false;
  const clean = clientId.trim();
  if (!clean) return false;
  if (allowedIds) {
    if (allowedIds instanceof Set && allowedIds.has(clean)) return true;
    if (Array.isArray(allowedIds) && allowedIds.includes(clean)) return true;
  }
  if (discoveredAllowedClientIds.has(clean)) return true;
  return OFFICIAL_OAUTH_CLIENT_ID_HASHES.has(sha256Hex(clean));
}

export async function buildGoogleAccountLoginUrl(
  redirectUri,
  state,
  codeChallenge,
  { getClients = loadNativeOAuthClients } = {}
) {
  const clients = await getClients();
  if (!Array.isArray(clients) || !clients.length || !clients[0]?.id) {
    throw new Error('oauthClientUnavailable');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clients[0].id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/aicode',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeGoogleAccountCode(
  code,
  redirectUri,
  codeVerifier,
  { fetchFn = fetchGoogleAccount, getClients = loadNativeOAuthClients } = {}
) {
  const clients = await getClients();
  if (!Array.isArray(clients) || !clients.length || !clients[0]?.id || !clients[0]?.secret) {
    throw new Error('oauthClientUnavailable');
  }
  const client = clients[0];
  const response = await fetchFn(OAUTH_TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': ACCOUNT_USER_AGENT },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token || !result.refresh_token ||
      !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('loginExchangeFailed');
  return resolveGoogleCredential({
    token: { ...result, expiry: new Date(Date.now() + result.expires_in * 1000).toISOString() },
    ...(result.id_token ? { id_token: result.id_token } : {}),
  }, { fetchFn, getClients: async () => clients });
}

export async function resolveGoogleCredential(
  credential,
  { refresh = false, fetchFn = fetchGoogleAccount, getClients = loadNativeOAuthClients } = {}
) {
  let { access_token: accessToken, refresh_token: refreshToken, expiry } = credential.token;
  let idToken = credential.id_token;
  if (refresh || !accessToken || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now() + 60_000) {
    const clients = await getClients();
    if (!clients.length) throw new Error('oauthClientUnavailable');
    let refreshed = false;
    for (const { id, secret } of clients) {
      const response = await fetchFn(OAUTH_TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(result?.error)) continue;
        throw new Error('oauthUnavailable');
      }
      if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('oauthUnavailable');
      accessToken = result.access_token;
      refreshToken = result.refresh_token || refreshToken;
      idToken = result.id_token;
      expiry = new Date(Date.now() + result.expires_in * 1000).toISOString();
      refreshed = true;
      break;
    }
    if (!refreshed) throw new Error('credentialRejected');
  }
  const userResponse = await fetchFn(OAUTH_USER_URL, {
    redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) throw new Error(userResponse.status === 401 ? 'credentialRejected' : 'oauthUnavailable');
  const user = await userResponse.json();
  if (!user.email || user.verified_email === false) throw new Error('credentialRejected');
  return {
    email: user.email,
    credential: {
      token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expiry },
      auth_method: 'consumer',
      id_token_email: user.email,
      ...(idToken ? { id_token: idToken } : {}),
      ...(Number.isSafeInteger(credential.aicode_scope_sign_out_attempted_at) &&
      credential.aicode_scope_sign_out_attempted_at > 0
        ? { aicode_scope_sign_out_attempted_at: credential.aicode_scope_sign_out_attempted_at }
        : {}),
    },
  };
}

export function resolveSetupTierInfo(setup) {
  const tierObj = setup?.paidTier || setup?.currentTier || setup?.userTier || null;
  if (!tierObj) return null;
  const tierId = String(tierObj?.id || '').trim();
  const rawName = String(tierObj?.name || '').trim();
  const rawDesc = String(tierObj?.description || '').trim();
  const tierIdLower = tierId.toLowerCase();
  const tierText = `${tierId} ${rawName} ${rawDesc}`;
  const tierMultiplier = /(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(tierText)
    ? '5x'
    : /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(tierText) ||
        tierIdLower === 'g1-ultra-tier' ||
        (/^g1-ultra(?:-[a-z0-9]+)?-tier$/i.test(tierIdLower) && !/lite|5x/i.test(tierIdLower))
      ? '20x'
      : '';
  const tierName =
    rawName ||
    (/ultra/i.test(tierIdLower)
      ? 'Google AI Ultra'
      : /pro/i.test(tierIdLower)
        ? 'Google AI Pro'
        : /free|standard/i.test(tierIdLower)
          ? 'Google AI Free'
          : '');
  if (!tierName && !tierId) return null;
  return { tierId, tierName: tierName || 'Google AI', tierMultiplier };
}

export async function retrieveCredentialQuota(accessToken, fetchFn = fetchGoogleAccount) {
  let preferredHost = '';
  async function post(method, data, retryWithoutProject = true) {
    const hosts = preferredHost
      ? [preferredHost, ...CLOUD_CODE_HOSTS.filter((h) => h !== preferredHost)]
      : CLOUD_CODE_HOSTS;
    for (const host of hosts) {
      const response = await fetchFn(`https://${host}/v1internal:${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': ACCOUNT_USER_AGENT },
        body: JSON.stringify(data),
      }).catch(() => null);
      if (response?.ok) {
        const payload = await response.json().catch(() => null);
        const result = payload?.response ?? payload;
        const valid = method === 'loadCodeAssist' ? result && typeof result === 'object' :
          method === 'fetchAvailableModels' ? result?.models && typeof result.models === 'object' :
            Array.isArray(result?.groups) || Array.isArray(result?.quotaSummary?.groups) || Array.isArray(result?.buckets);
        if (valid) {
          preferredHost = host;
          return result;
        }
      }
      if (response?.status === 401) throw new Error('credentialRejected');
      if (response?.status === 403 && data.project && retryWithoutProject) return post(method, {}, false);
    }
    return null;
  }

  const setup = await post('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } });
  const project = setup?.cloudaicompanionProject?.id || setup?.cloudaicompanionProject;
  if (!setup) throw new Error('quotaUnavailable');
  const tierInfo = resolveSetupTierInfo(setup);
  const request = typeof project === 'string' && project ? { project } : {};
  const clientConfigs = setup.cascadeModelConfigData?.clientModelConfigs;
  const [summary, available] = await Promise.all([
    post('retrieveUserQuotaSummary', request),
    Array.isArray(clientConfigs) && clientConfigs.length ? null : post('fetchAvailableModels', request),
  ]);
  const configs = Array.isArray(clientConfigs) && clientConfigs.length ? clientConfigs :
    Object.entries(available?.models || {}).filter(([, model]) => model?.quotaInfo && !model.disabled)
      .map(([modelId, model]) => ({ modelId, modelOrAlias: { model: modelId }, label: model.displayName, quotaInfo: model.quotaInfo }));
  const raw = summary?.quotaSummary ?? summary;
  if (!Array.isArray(raw?.groups) && !Array.isArray(raw?.buckets) && !configs.length) throw new Error('quotaUnavailable');
  const adaptBuckets = (buckets) => (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
    ...bucket,
    bucketId: bucket?.bucketId ?? bucket?.bucket_id,
    remainingFraction: bucket?.remainingFraction ?? bucket?.remaining_fraction,
    resetTime: bucket?.resetTime ?? bucket?.reset_time,
  }));
  const quota = {
    groups: (Array.isArray(raw?.groups) ? raw.groups : []).map((group) => ({
      ...group, displayName: group?.displayName || group?.name, buckets: adaptBuckets(group?.buckets),
    })),
    buckets: adaptBuckets(raw?.buckets),
  };
  const { quotaPoolsMap } = buildOfficialQuotaPools(quota, configs);
  const pools = Array.from(quotaPoolsMap.values()).filter(({ isAvailable }) => isAvailable).map((pool) => ({
    poolKey: pool.poolKey,
    poolLabel: pool.poolLabel,
    remainingPct: pool.remainingPct,
    weeklyRemainingPct: pool.weeklyRemainingPct,
    resetTime: pool.resetTime,
    weeklyResetTime: pool.weeklyResetTime,
  }));
  if (tierInfo) {
    Object.defineProperty(pools, 'tierInfo', { value: tierInfo, enumerable: false });
    Object.defineProperty(pools, 'tierName', { value: tierInfo.tierName, enumerable: false });
  }
  return pools;
}
