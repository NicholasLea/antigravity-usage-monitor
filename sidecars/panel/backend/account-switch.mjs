/** @fileoverview Antigravity shared credentials and cross-platform encrypted credential vault. */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  clearPosixKeyringRuntimeCaches,
  extractHostCredentialEmail,
  isAccountPlatformSupported,
  resolvePosixAccountStoragePaths,
  runPosixCredentialStore,
  unwrapGoKeyringBase64,
} from './account-keyring-store.mjs';
import { accountLoginController } from './account-login.mjs';
import {
  isAllowedOAuthClientId,
  loadNativeOAuthClients,
  resolveGoogleCredential,
  retrieveCredentialQuota,
} from './account-oauth.mjs';
import {
  recordAccountQuotaSnapshot,
  removeAccountQuotaHistory,
} from './account-quota-history.mjs';
import {
  checkVaultUnlockCooldown,
  createVaultSecurityMetadata,
  decryptVaultEntryCredential,
  encryptVaultEntryCredential,
  getUnlockedVaultSessionKey,
  isEncryptedVaultCredential,
  isVaultSessionUnlocked,
  lockVaultSession,
  normalizeVaultPassword,
  recordVaultUnlockFailure,
  resetVaultUnlockFailures,
  setUnlockedVaultSessionKey,
  verifyVaultPassword,
} from './account-vault-crypto.mjs';
import { HERE } from './config.mjs';
import { callLsRpc } from './ls-rpc.mjs';

const ACCOUNT_ERRORS = new Set([
  'unsupported', 'invalidEmail', 'invalidCredential', 'credentialTooLarge', 'notFound',
  'noCurrentCredential', 'busy', 'storeFailed', 'rollbackFailed', 'credentialAccessDenied',
  'credentialChanged', 'credentialRejected', 'identityMismatch', 'oauthClientUnavailable',
  'oauthUnavailable', 'quotaUnavailable',
  'switchStartFailed', 'clientCloseFailed', 'clientRestartFailed',
  'vaultLocked', 'wrongPassword', 'invalidPassword', 'passwordRateLimited',
  'vaultDecryptFailed', 'passphraseRequired', 'keyringUnavailable',
  'invalidActionNonce', 'riskNotAccepted',
]);

const ALLOWED_ACTIONS = new Set([
  'list', 'save', 'capture', 'switch', 'remove', 'quota',
  'loginStart', 'loginStatus', 'loginCancel',
  'setPassword', 'unlockVault', 'lockVault', 'changePassword', 'disablePassword', 'resetVault',
]);

const MAX_TRANSIENT_TOKENS = 32;
const transientAccessTokens = new Map();
const vaultSecurityByPath = new Map();

export function clearAccountVaultRuntimeState() {
  lockVaultSession();
  resetVaultUnlockFailures();
  clearPosixKeyringRuntimeCaches();
  transientAccessTokens.clear();
  vaultSecurityByPath.clear();
}

function rememberTransientAccessToken(email, credential) {
  const addr = normalizeAccountEmail(email);
  const tok = credential?.token;
  if (!addr || !tok?.access_token || !tok?.refresh_token) return;
  const expiryMs = Date.parse(tok.expiry || '');
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() + 60_000) return;
  if (!transientAccessTokens.has(addr) && transientAccessTokens.size >= MAX_TRANSIENT_TOKENS) {
    const oldestKey = transientAccessTokens.keys().next().value;
    if (oldestKey !== undefined) transientAccessTokens.delete(oldestKey);
  }
  transientAccessTokens.set(addr, {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiry: tok.expiry,
    ...(typeof credential.id_token === 'string' && credential.id_token
      ? { idToken: credential.id_token }
      : {}),
  });
}

function clearTransientAccessTokens(email = '') {
  if (email) {
    transientAccessTokens.delete(normalizeAccountEmail(email));
    return;
  }
  transientAccessTokens.clear();
}

export function normalizeAccountEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function normalizeAccountCredential(input, { allowedClientIds = null } = {}) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 24576) return null;
  const unwrapped = unwrapGoKeyringBase64(input);
  if (Buffer.byteLength(unwrapped, 'utf8') > 16384) return null;
  const text = unwrapped.replace(/^\uFEFF/, '').trim();
  let source;
  try {
    source = JSON.parse(text);
  } catch {
    if (!/^1\/{1,2}[\w.-]{20,}$/.test(text)) return null;
    source = { refresh_token: text };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  if (
    source.type !== undefined &&
    !['authorized_user', 'oauth2'].includes(String(source.type).trim().toLowerCase())
  ) {
    return null;
  }
  const explicitClientId =
    source.client_id ??
    source.token?.client_id ??
    source.installed?.client_id ??
    source.web?.client_id;
  if (explicitClientId !== undefined && explicitClientId !== null && String(explicitClientId).trim() !== '') {
    if (
      typeof explicitClientId !== 'string' ||
      !isAllowedOAuthClientId(explicitClientId, allowedClientIds)
    ) {
      return null;
    }
  }
  const token = source?.token || source;
  if (
    !token ||
    (source.auth_method && source.auth_method !== 'consumer') ||
    typeof token.refresh_token !== 'string' ||
    !token.refresh_token.trim() ||
    /\s/.test(token.refresh_token) ||
    (token.token_type && !/^bearer$/i.test(token.token_type))
  ) {
    return null;
  }
  const timestamp = token.expiry_date ?? Number(token.expiry_timestamp) * 1000;
  const expiry =
    token.expiry ||
    (Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799999
      ? new Date(timestamp).toISOString()
      : '1970-01-01T00:00:00Z');
  if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) return null;
  const payload = {
    token: {
      access_token: typeof token.access_token === 'string' ? token.access_token : '',
      refresh_token: token.refresh_token.trim(),
      token_type: 'Bearer',
      expiry: new Date(expiry).toISOString(),
    },
    auth_method: 'consumer',
  };
  const idToken = source.id_token || token.id_token;
  if (typeof idToken === 'string' && idToken) payload.id_token = idToken;
  if (
    Number.isSafeInteger(source.aicode_scope_sign_out_attempted_at) &&
    source.aicode_scope_sign_out_attempted_at > 0
  ) {
    payload.aicode_scope_sign_out_attempted_at = source.aicode_scope_sign_out_attempted_at;
  }
  return JSON.stringify(payload);
}

/**
 * At-rest minimization: strips short-lived `access_token`, `id_token`, `expiry`,
 * and any extra fields before persisting to `accounts.dpapi`.
 */
export function serializeVaultCredential(credential) {
  const refreshToken = String(credential?.token?.refresh_token || '').trim();
  if (!refreshToken || /\s/.test(refreshToken)) {
    throw new Error('invalidCredential');
  }
  return JSON.stringify({
    token: { refresh_token: refreshToken, token_type: 'Bearer' },
    auth_method: 'consumer',
  });
}

export function runWindowsCredentialStore(request) {
  const scriptPath = join(HERE, 'backend', 'account-credentials.ps1');
  const shell = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return new Promise((resolve, reject) => {
    // The helper exchanges private data over its pipes, keeping it out of process arguments.
    const child = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('storeFailed'));
      try {
        resolve(JSON.parse(output.replace(/^\uFEFF/, '')));
      } catch {
        reject(new Error('storeFailed'));
      }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

function serializeHostCredential(
  credential,
  { forHostSwitch = false, fallbackEmail = '', maxBytes = 2560 } = {}
) {
  const cleanFallbackEmail = normalizeAccountEmail(fallbackEmail);
  let target =
    cleanFallbackEmail && !credential.id_token_email
      ? { ...credential, id_token_email: cleanFallbackEmail }
      : credential;
  if (forHostSwitch && !target.aicode_scope_sign_out_attempted_at) {
    target = { ...target, aicode_scope_sign_out_attempted_at: Math.floor(Date.now() / 1000) };
  }
  let payload = JSON.stringify(target);
  if (Buffer.byteLength(payload, 'utf8') > maxBytes && target.id_token) {
    const { id_token: _ignored, ...compact } = target;
    payload = JSON.stringify(compact);
  }
  if (Buffer.byteLength(payload, 'utf8') > maxBytes) throw new Error('credentialTooLarge');
  return payload;
}

let cachedPublicVaultState = null;
let cachedPublicVaultSig = '';

function computePublicVaultDiskSig(config) {
  try {
    const vStat = statSync(config.vault, { throwIfNoEntry: false });
    const sStat = config.statusFile ? statSync(config.statusFile, { throwIfNoEntry: false }) : null;
    return `${config.vault}|${vStat ? `${vStat.size}:${vStat.mtimeMs}` : '0'}|${sStat ? `${sStat.size}:${sStat.mtimeMs}` : '0'}`;
  } catch {
    return '';
  }
}

function recordKnownVaultSecurity(vaultPath, security, meta = null) {
  if (!vaultPath) return;
  const prev = vaultSecurityByPath.get(vaultPath);
  const keyringAvailable =
    meta && typeof meta.keyringAvailable === 'boolean'
      ? meta.keyringAvailable
      : prev?.keyringAvailable !== false;
  const passphraseRequired =
    meta && typeof meta.passphraseRequired === 'boolean'
      ? meta.passphraseRequired
      : !keyringAvailable && !security?.enabled;
  if (!vaultSecurityByPath.has(vaultPath) && vaultSecurityByPath.size >= 16) {
    const oldest = vaultSecurityByPath.keys().next().value;
    if (oldest !== undefined) vaultSecurityByPath.delete(oldest);
  }
  vaultSecurityByPath.set(vaultPath, {
    enabled: Boolean(security?.enabled),
    salt: security?.enabled ? String(security.salt || '') : '',
    keyringAvailable,
    passphraseRequired: Boolean(passphraseRequired && !security?.enabled),
  });
}

function cacheSanitizedVaultState(config, result) {
  const sig = computePublicVaultDiskSig(config);
  if (!sig || !result || !Array.isArray(result.accounts)) return;
  cachedPublicVaultSig = sig;
  cachedPublicVaultState = {
    accounts: [...result.accounts],
    selectedEmail: result.selectedEmail || '',
    quotas: result.quotas ? { ...result.quotas } : {},
    ...(typeof result.backend === 'string' && result.backend ? { backend: result.backend } : {}),
    ...(typeof result.keyringAvailable === 'boolean'
      ? { keyringAvailable: result.keyringAvailable }
      : {}),
    ...(result.passphraseRequired ? { passphraseRequired: true } : {}),
    ...(result.security?.enabled
      ? { security: { enabled: true, salt: String(result.security.salt || '') } }
      : {}),
    ...(result.switchState ? { switchState: { ...result.switchState } } : {}),
  };
}

export async function warmAccountPublicListCache() {
  if (!isAccountPlatformSupported(process.platform)) return;
  await handleAccountCredentialAction({ action: 'list' }).catch(() => null);
}

function openStoredVaultCredential(storedRaw, email, vaultSecurity) {
  let jsonText = storedRaw;
  if (isEncryptedVaultCredential(storedRaw)) {
    const keyBuf = getUnlockedVaultSessionKey(vaultSecurity?.salt || '');
    if (!keyBuf) throw new Error('vaultLocked');
    jsonText = decryptVaultEntryCredential(storedRaw, keyBuf, email);
  } else if (vaultSecurity?.enabled && !isVaultSessionUnlocked(vaultSecurity)) {
    throw new Error('vaultLocked');
  }
  const normalized = normalizeAccountCredential(jsonText);
  if (!normalized) throw new Error('invalidCredential');
  const parsed = JSON.parse(normalized);
  if (!parsed.token.access_token) {
    const cached = transientAccessTokens.get(normalizeAccountEmail(email));
    if (
      cached &&
      cached.refreshToken === parsed.token.refresh_token &&
      Date.parse(cached.expiry) > Date.now() + 60_000
    ) {
      parsed.token.access_token = cached.accessToken;
      parsed.token.expiry = cached.expiry;
      if (cached.idToken && !parsed.id_token) parsed.id_token = cached.idToken;
    }
  }
  return parsed;
}

function sealVaultCredential(credentialObj, email, vaultSecurity) {
  const minJson = serializeVaultCredential(credentialObj);
  if (vaultSecurity?.enabled) {
    const keyBuf = getUnlockedVaultSessionKey(vaultSecurity.salt);
    if (!keyBuf) throw new Error('vaultLocked');
    return {
      stored: encryptVaultEntryCredential(minJson, keyBuf, email),
      vaultUnlocked: true,
      expectedSecuritySalt: String(vaultSecurity.salt),
    };
  }
  return { stored: minJson, vaultUnlocked: false, expectedSecuritySalt: '' };
}

export async function handleAccountCredentialAction(
  data,
  {
    platform = process.platform,
    store = undefined,
    rpc = callLsRpc,
    resolveCredential = resolveGoogleCredential,
    getQuota = retrieveCredentialQuota,
    login = accountLoginController,
  } = {}
) {
  if (!isAccountPlatformSupported(platform)) {
    return { supported: false, accounts: [], error: 'unsupported' };
  }
  const action = data?.action || 'list';
  if (!ALLOWED_ACTIONS.has(action)) return { error: 'invalidCredential' };
  const email = normalizeAccountEmail(data?.email);
  if (['switch', 'remove', 'quota'].includes(action) && !email) return { error: 'invalidEmail' };

  const gemini = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  const posixPaths =
    platform === 'win32' ? null : resolvePosixAccountStoragePaths({ platform });
  const config =
    platform === 'win32'
      ? {
          target: 'gemini:antigravity',
          vault: join(
            process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
            'AntigravityUsageMonitor',
            'accounts.dpapi'
          ),
          statusFile: join(
            process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
            'AntigravityUsageMonitor',
            'switch-state.json'
          ),
          scriptPath: join(HERE, 'backend', 'account-credentials.ps1'),
          fallbacks: [
            join(gemini, 'jetski-standalone-oauth-token'),
            join(gemini, 'antigravity-cli', 'antigravity-oauth-token'),
          ],
        }
      : {
          target: 'gemini:antigravity',
          vault: posixPaths.vault,
          statusFile: posixPaths.statusFile,
          fallbacks: posixPaths.fallbacks,
        };

  const effectiveStore =
    store ||
    (platform === 'win32'
      ? runWindowsCredentialStore
      : (req) => runPosixCredentialStore(req, { platform }));
  const useDiskSigCache = !store;

  async function runStore(fields) {
    const result = await effectiveStore({ ...config, ...fields });
    if (!result || result.error) {
      if (result?.error === 'passphraseRequired' || result?.error === 'keyringUnavailable') {
        recordKnownVaultSecurity(config.vault, resolveKnownVaultSecurity(), {
          keyringAvailable: false,
          passphraseRequired: true,
        });
        if (useDiskSigCache) {
          cachedPublicVaultState = null;
          cachedPublicVaultSig = '';
        }
      }
      throw new Error(result?.error || 'storeFailed');
    }
    if (['list', 'read', 'readVault', 'writeVault', 'save', 'scheduleSwitch'].includes(fields.action)) {
      recordKnownVaultSecurity(config.vault, result.security, result);
    }
    if (useDiskSigCache) {
      if (fields.action === 'scheduleSwitch') {
        cachedPublicVaultState = null;
        cachedPublicVaultSig = '';
      } else if (['list', 'save', 'remove', 'saveQuota', 'writeVault'].includes(fields.action)) {
        cacheSanitizedVaultState(config, result);
      }
    }
    return result;
  }

  function resolveKnownVaultSecurity() {
    if (useDiskSigCache && cachedPublicVaultState) {
      return cachedPublicVaultState.security || null;
    }
    const recorded = vaultSecurityByPath.get(config.vault);
    return recorded?.enabled ? recorded : null;
  }

  function isPassphraseRequiredWithoutKeyring() {
    if (useDiskSigCache && cachedPublicVaultState) {
      return Boolean(
        cachedPublicVaultState.passphraseRequired && !cachedPublicVaultState.security?.enabled
      );
    }
    const recorded = vaultSecurityByPath.get(config.vault);
    return Boolean(recorded?.passphraseRequired && !recorded?.enabled);
  }

  async function ensureUnlockedVaultContext({ requireSaveReady = false } = {}) {
    if (
      (useDiskSigCache && !cachedPublicVaultState) ||
      (requireSaveReady && platform !== 'win32' && !vaultSecurityByPath.has(config.vault) && !cachedPublicVaultState)
    ) {
      await runStore({ action: 'list', email: '' });
    }
    const sec = resolveKnownVaultSecurity();
    if (sec?.enabled && !isVaultSessionUnlocked(sec)) {
      throw new Error('vaultLocked');
    }
    if (requireSaveReady && !sec?.enabled && isPassphraseRequiredWithoutKeyring()) {
      throw new Error('passphraseRequired');
    }
    return sec;
  }

  function buildSummaryFromReadVault(vaultData, securityOverride = undefined) {
    const entries = Array.isArray(vaultData?.entries) ? vaultData.entries : [];
    const effectiveSec = securityOverride !== undefined ? securityOverride : vaultData?.security;
    return {
      accounts: entries.map((e) => e?.email).filter(Boolean),
      selectedEmail: vaultData?.selectedEmail || '',
      quotas: Object.fromEntries(entries.filter((e) => e?.quota).map((e) => [e.email, e.quota])),
      ...(typeof vaultData?.backend === 'string' && vaultData.backend
        ? { backend: vaultData.backend }
        : {}),
      ...(typeof vaultData?.keyringAvailable === 'boolean'
        ? { keyringAvailable: vaultData.keyringAvailable }
        : {}),
      ...(vaultData?.passphraseRequired ? { passphraseRequired: true } : {}),
      ...(effectiveSec?.enabled ? { security: { enabled: true, salt: effectiveSec.salt } } : {}),
      ...(vaultData?.switchState ? { switchState: vaultData.switchState } : {}),
    };
  }

  function publicList(result) {
    const rawSwitchState = result.switchState;
    const switchAgeMs = rawSwitchState ? Date.now() - Number(rawSwitchState.updatedAt || 0) : Infinity;
    const stalled = rawSwitchState?.state === 'starting' && switchAgeMs > 120000;
    const expiredSwitchState =
      rawSwitchState && rawSwitchState.state !== 'starting' && switchAgeMs > 5 * 60 * 1000;
    const switchState = expiredSwitchState ? null : rawSwitchState;
    const sec = result.security?.enabled ? result.security : null;
    const cooldownSec = checkVaultUnlockCooldown();
    const keyringAvailable = result.keyringAvailable !== false;
    const passphraseRequired = Boolean(result.passphraseRequired && !sec?.enabled);
    return {
      supported: true,
      accounts: (Array.isArray(result.accounts) ? result.accounts : [])
        .map(normalizeAccountEmail)
        .filter(Boolean),
      selectedEmail: expiredSwitchState ? '' : normalizeAccountEmail(result.selectedEmail),
      quotas: result.quotas || {},
      ...(typeof result.backend === 'string' && result.backend ? { backend: result.backend } : {}),
      ...(!keyringAvailable ? { keyringAvailable: false } : {}),
      ...(passphraseRequired ? { passphraseRequired: true } : {}),
      ...(sec || data?.includeSecurity
        ? {
            security: {
              enabled: Boolean(sec?.enabled),
              unlocked: isVaultSessionUnlocked(sec),
              ...(cooldownSec > 0 ? { cooldownSec } : {}),
            },
          }
        : {}),
      ...(login.getStatus() ? { login: login.getStatus() } : {}),
      ...(switchState
        ? {
            switchState: {
              email: normalizeAccountEmail(switchState.email),
              state:
                !stalled && ['starting', 'written', 'failed'].includes(switchState.state)
                  ? switchState.state
                  : 'failed',
              error: stalled
                ? 'switchStartFailed'
                : ACCOUNT_ERRORS.has(switchState.error)
                  ? switchState.error
                  : '',
            },
          }
        : {}),
    };
  }

  async function verifyCredentialObj(parsedObj, refresh = false) {
    let result;
    try {
      result = await resolveCredential(parsedObj, { refresh });
    } catch (error) {
      throw new Error(ACCOUNT_ERRORS.has(error?.message) ? error.message : 'oauthUnavailable');
    }
    result.email = normalizeAccountEmail(result.email);
    if (!result.email) throw new Error('credentialRejected');
    rememberTransientAccessToken(result.email, result.credential);
    return result;
  }

  async function verifyCredential(raw, refresh = false) {
    let normalized = normalizeAccountCredential(raw);
    if (!normalized && typeof raw === 'string' && raw.includes('client_id')) {
      const liveClients = await loadNativeOAuthClients().catch(() => []);
      if (liveClients.length > 0) {
        normalized = normalizeAccountCredential(raw, {
          allowedClientIds: liveClients.map((c) => c.id),
        });
      }
    }
    if (!normalized) throw new Error('invalidCredential');
    return verifyCredentialObj(JSON.parse(normalized), refresh);
  }

  try {
    if (action === 'list') {
      if (
        useDiskSigCache &&
        cachedPublicVaultState &&
        cachedPublicVaultState.keyringAvailable !== false
      ) {
        const curSig = computePublicVaultDiskSig(config);
        if (curSig && curSig === cachedPublicVaultSig) {
          return publicList(cachedPublicVaultState);
        }
      }
      return publicList(await runStore({ action, email }));
    }

    if (action === 'setPassword') {
      const vaultData = await runStore({ action: 'readVault' });
      if (vaultData.security?.enabled) throw new Error('credentialChanged');
      const { security, keyBuf } = await createVaultSecurityMetadata(
        data?.newPassword ?? data?.password
      );
      try {
        const nextEntries = (Array.isArray(vaultData.entries) ? vaultData.entries : []).map((entry) => {
          const entryEmail = normalizeAccountEmail(entry?.email);
          if (!entryEmail) throw new Error('invalidEmail');
          const norm = normalizeAccountCredential(entry.credential);
          if (!norm) throw new Error('invalidCredential');
          const minJson = serializeVaultCredential(JSON.parse(norm));
          return {
            ...entry,
            email: entryEmail,
            credential: encryptVaultEntryCredential(minJson, keyBuf, entryEmail),
          };
        });
        const savedVault = await runStore({
          action: 'writeVault',
          entries: nextEntries,
          selectedEmail: vaultData.selectedEmail || '',
          security,
        });
        setUnlockedVaultSessionKey(security.salt, keyBuf);
        resetVaultUnlockFailures();
        return publicList(savedVault);
      } finally {
        keyBuf.fill(0);
      }
    }

    if (action === 'unlockVault') {
      const cooldownSec = checkVaultUnlockCooldown();
      if (cooldownSec > 0) {
        return { error: 'passwordRateLimited', retryAfterSec: cooldownSec };
      }
      const vaultData = await runStore({ action: 'readVault' });
      if (!vaultData.security?.enabled) {
        return publicList(buildSummaryFromReadVault(vaultData, null));
      }
      let keyBuf = null;
      try {
        keyBuf = await verifyVaultPassword(data?.password, vaultData.security);
      } catch (err) {
        if (err?.message === 'wrongPassword') {
          const waitSec = recordVaultUnlockFailure();
          return waitSec > 0
            ? { error: 'passwordRateLimited', retryAfterSec: waitSec }
            : { error: 'wrongPassword' };
        }
        throw err;
      }
      try {
        const firstEnc = (vaultData.entries || []).find((e) =>
          isEncryptedVaultCredential(e?.credential)
        );
        if (firstEnc) {
          decryptVaultEntryCredential(firstEnc.credential, keyBuf, firstEnc.email);
        }
        setUnlockedVaultSessionKey(vaultData.security.salt, keyBuf);
        resetVaultUnlockFailures();
        return publicList(
          buildSummaryFromReadVault(vaultData, { enabled: true, salt: vaultData.security.salt })
        );
      } finally {
        keyBuf.fill(0);
      }
    }

    if (action === 'lockVault') {
      lockVaultSession();
      clearTransientAccessTokens();
      const curLogin = login.getStatus();
      if (curLogin?.id && curLogin.status === 'waiting') {
        login.cancel(curLogin.id);
      }
      return publicList(await runStore({ action: 'list', email: '' }));
    }

    if (action === 'changePassword') {
      const cooldownSec = checkVaultUnlockCooldown();
      if (cooldownSec > 0) {
        return { error: 'passwordRateLimited', retryAfterSec: cooldownSec };
      }
      if (!normalizeVaultPassword(data?.newPassword)) {
        throw new Error('invalidPassword');
      }
      const vaultData = await runStore({ action: 'readVault' });
      if (!vaultData.security?.enabled) throw new Error('notFound');
      let oldKeyBuf = null;
      try {
        oldKeyBuf = await verifyVaultPassword(data?.currentPassword, vaultData.security);
      } catch (err) {
        if (err?.message === 'wrongPassword') {
          const waitSec = recordVaultUnlockFailure();
          return waitSec > 0
            ? { error: 'passwordRateLimited', retryAfterSec: waitSec }
            : { error: 'wrongPassword' };
        }
        throw err;
      }
      resetVaultUnlockFailures();
      let newKeyBuf = null;
      try {
        const created = await createVaultSecurityMetadata(data.newPassword);
        newKeyBuf = created.keyBuf;
        const nextEntries = (vaultData.entries || []).map((entry) => {
          const entryEmail = normalizeAccountEmail(entry?.email);
          if (!entryEmail) throw new Error('invalidEmail');
          const plainJson = isEncryptedVaultCredential(entry.credential)
            ? decryptVaultEntryCredential(entry.credential, oldKeyBuf, entryEmail)
            : entry.credential;
          const norm = normalizeAccountCredential(plainJson);
          if (!norm) throw new Error('invalidCredential');
          const minJson = serializeVaultCredential(JSON.parse(norm));
          return {
            ...entry,
            email: entryEmail,
            credential: encryptVaultEntryCredential(minJson, newKeyBuf, entryEmail),
          };
        });
        const savedVault = await runStore({
          action: 'writeVault',
          entries: nextEntries,
          selectedEmail: vaultData.selectedEmail || '',
          security: created.security,
        });
        clearTransientAccessTokens();
        setUnlockedVaultSessionKey(created.security.salt, newKeyBuf);
        return publicList(savedVault);
      } finally {
        oldKeyBuf?.fill(0);
        newKeyBuf?.fill(0);
      }
    }

    if (action === 'disablePassword') {
      const cooldownSec = checkVaultUnlockCooldown();
      if (cooldownSec > 0) {
        return { error: 'passwordRateLimited', retryAfterSec: cooldownSec };
      }
      const vaultData = await runStore({ action: 'readVault' });
      if (vaultData.keyringAvailable === false) {
        return { error: 'keyringUnavailable' };
      }
      if (!vaultData.security?.enabled) {
        return publicList(buildSummaryFromReadVault(vaultData, null));
      }
      let oldKeyBuf = null;
      try {
        oldKeyBuf = await verifyVaultPassword(data?.currentPassword, vaultData.security);
      } catch (err) {
        if (err?.message === 'wrongPassword') {
          const waitSec = recordVaultUnlockFailure();
          return waitSec > 0
            ? { error: 'passwordRateLimited', retryAfterSec: waitSec }
            : { error: 'wrongPassword' };
        }
        throw err;
      }
      resetVaultUnlockFailures();
      try {
        const plainEntries = (vaultData.entries || []).map((entry) => {
          const entryEmail = normalizeAccountEmail(entry?.email);
          if (!entryEmail) throw new Error('invalidEmail');
          const plainJson = isEncryptedVaultCredential(entry.credential)
            ? decryptVaultEntryCredential(entry.credential, oldKeyBuf, entryEmail)
            : entry.credential;
          const norm = normalizeAccountCredential(plainJson);
          if (!norm) throw new Error('invalidCredential');
          return {
            ...entry,
            email: entryEmail,
            credential: serializeVaultCredential(JSON.parse(norm)),
          };
        });
        const savedVault = await runStore({
          action: 'writeVault',
          entries: plainEntries,
          selectedEmail: vaultData.selectedEmail || '',
          security: null,
        });
        lockVaultSession();
        clearTransientAccessTokens();
        return publicList(savedVault);
      } finally {
        oldKeyBuf?.fill(0);
      }
    }

    if (action === 'resetVault') {
      if (data?.confirmReset !== 'RESET') throw new Error('invalidCredential');
      lockVaultSession();
      clearTransientAccessTokens();
      resetVaultUnlockFailures();
      clearPosixKeyringRuntimeCaches();
      const curLogin = login.getStatus();
      if (curLogin?.id && curLogin.status === 'waiting') {
        login.cancel(curLogin.id);
      }
      const savedVault = await runStore({
        action: 'writeVault',
        entries: [],
        selectedEmail: '',
        security: null,
        clearStatus: true,
      });
      return publicList(savedVault);
    }

    if (action === 'loginStart') {
      await ensureUnlockedVaultContext({ requireSaveReady: true });
      const session = await login.start(async (verified) => {
        const address = normalizeAccountEmail(verified.email);
        if (!address) throw new Error('credentialRejected');
        rememberTransientAccessToken(address, verified.credential);
        const activeSec = await ensureUnlockedVaultContext({ requireSaveReady: true });
        const sealed = sealVaultCredential(verified.credential, address, activeSec);
        await runStore({
          action: 'save',
          email: address,
          credential: sealed.stored,
          ...(sealed.vaultUnlocked
            ? { vaultUnlocked: true, expectedSecuritySalt: sealed.expectedSecuritySalt }
            : {}),
        });
      }, data.language);
      return { supported: true, login: session };
    }

    if (action === 'loginStatus' || action === 'loginCancel') {
      const session = action === 'loginCancel' ? login.cancel(data.id) : login.getStatus(data.id);
      return {
        supported: true,
        login: session || { id: data.id, status: 'expired', error: 'loginExpired' },
      };
    }

    if (action === 'remove') {
      const activeSec = await ensureUnlockedVaultContext();
      clearTransientAccessTokens(email);
      removeAccountQuotaHistory(email);
      return publicList(
        await runStore({
          action,
          email,
          ...(activeSec?.enabled
            ? { vaultUnlocked: true, expectedSecuritySalt: String(activeSec.salt) }
            : {}),
        })
      );
    }

    if (action === 'save') {
      const activeSec = await ensureUnlockedVaultContext({ requireSaveReady: true });
      const verified = await verifyCredential(data.credential, true);
      const sealed = sealVaultCredential(verified.credential, verified.email, activeSec);
      return publicList(
        await runStore({
          action,
          email: verified.email,
          credential: sealed.stored,
          ...(sealed.vaultUnlocked
            ? { vaultUnlocked: true, expectedSecuritySalt: sealed.expectedSecuritySalt }
            : {}),
        })
      );
    }

    if (action === 'capture') {
      const activeSec = await ensureUnlockedVaultContext({ requireSaveReady: true });
      const status = await rpc('GetUserStatus', {}, 2000).catch(() => null);
      const activeEmail = normalizeAccountEmail(status?.userStatus?.email);
      if (!activeEmail) throw new Error('noCurrentCredential');
      const { credential } = await runStore({ action: 'readCurrent', email: activeEmail });
      const embeddedEmail = extractHostCredentialEmail(credential);
      if (embeddedEmail && embeddedEmail !== activeEmail) {
        throw new Error('identityMismatch');
      }
      const verified = await verifyCredential(credential);
      if (verified.email !== activeEmail) throw new Error('identityMismatch');
      const sealed = sealVaultCredential(verified.credential, activeEmail, activeSec);
      return publicList(
        await runStore({
          action: 'save',
          email: activeEmail,
          credential: sealed.stored,
          ...(sealed.vaultUnlocked
            ? { vaultUnlocked: true, expectedSecuritySalt: sealed.expectedSecuritySalt }
            : {}),
        })
      );
    }

    const saved = await runStore({ action: 'read', email });
    const entrySec = saved.security || resolveKnownVaultSecurity();
    const openedObj = openStoredVaultCredential(saved.credential, email, entrySec);

    if (action === 'quota') {
      const verified = await verifyCredentialObj(openedObj);
      if (verified.email !== email) throw new Error('identityMismatch');
      const sealedCurrent = sealVaultCredential(verified.credential, email, entrySec);
      const tokenRotated =
        verified.credential.token.refresh_token !== openedObj.token.refresh_token;
      const legacyUnminimized =
        useDiskSigCache && !entrySec?.enabled && saved.credential !== sealedCurrent.stored;
      let expectedCredForQuota = saved.credential;
      if (tokenRotated || legacyUnminimized) {
        await runStore({
          action: 'save',
          email,
          credential: sealedCurrent.stored,
          expectedCredential: saved.credential,
          ...(sealedCurrent.vaultUnlocked
            ? { vaultUnlocked: true, expectedSecuritySalt: sealedCurrent.expectedSecuritySalt }
            : {}),
        });
        expectedCredForQuota = sealedCurrent.stored;
      }
      const pools = await getQuota(verified.credential.token.access_token);
      const tierInfo = pools?.tierInfo || null;
      const tierName = tierInfo?.tierName || (typeof pools?.tierName === 'string' ? pools.tierName : '');
      const tierMeta = {
        ...(tierInfo?.tierId ? { tierId: tierInfo.tierId } : {}),
        ...(tierName ? { tierName } : {}),
        ...(tierInfo?.tierMultiplier ? { tierMultiplier: tierInfo.tierMultiplier } : {}),
      };
      const fetchedAt = Date.now();
      const quotaPayload = { pools, fetchedAt, ...tierMeta };
      await runStore({
        action: 'saveQuota',
        email,
        expectedCredential: expectedCredForQuota,
        quota: quotaPayload,
      });
      if (useDiskSigCache) {
        recordAccountQuotaSnapshot(email, pools, fetchedAt, { isActiveHost: false });
      }
      return { email, pools, fetchedAt, ...tierMeta };
    }

    let verified;
    let offlineFallbackUsed = false;
    try {
      verified = await verifyCredentialObj(openedObj);
    } catch (verifyErr) {
      if (
        ['oauthUnavailable', 'oauthClientUnavailable'].includes(verifyErr?.message) &&
        openedObj?.token?.refresh_token
      ) {
        verified = {
          email,
          credential: {
            ...openedObj,
            auth_method: 'consumer',
            id_token_email: email,
          },
        };
        offlineFallbackUsed = true;
      } else {
        throw verifyErr;
      }
    }
    if (verified.email !== email) throw new Error('identityMismatch');

    const sealedCurrent = offlineFallbackUsed
      ? {
          stored: saved.credential,
          vaultUnlocked: Boolean(entrySec?.enabled),
          expectedSecuritySalt: entrySec?.enabled ? String(entrySec.salt) : '',
        }
      : sealVaultCredential(verified.credential, email, entrySec);

    const prevActiveEmail = normalizeAccountEmail(data?.activeEmail);
    const knownSwitchState = saved.switchState || cachedPublicVaultState?.switchState || null;
    const knownSwitchAge = knownSwitchState
      ? Date.now() - Number(knownSwitchState.updatedAt || 0)
      : Infinity;
    const midPendingSwitch =
      (knownSwitchState?.state === 'starting' && knownSwitchAge < 120_000) ||
      (knownSwitchState?.state === 'written' &&
        knownSwitchAge < 5 * 60_000 &&
        normalizeAccountEmail(knownSwitchState.email) !== prevActiveEmail);

    if (prevActiveEmail && prevActiveEmail !== email && !midPendingSwitch) {
      try {
        const existingPrev = await effectiveStore({ ...config, action: 'read', email: prevActiveEmail });
        if (!existingPrev || existingPrev.error === 'notFound') {
          const currentHost = await effectiveStore({
            ...config,
            action: 'readCurrent',
            email: prevActiveEmail,
          });
          if (currentHost?.credential) {
            const hostEmbeddedEmail = extractHostCredentialEmail(currentHost.credential);
            if (!hostEmbeddedEmail || hostEmbeddedEmail === prevActiveEmail) {
              const verifiedPrev = await verifyCredential(currentHost.credential);
              if (verifiedPrev.email === prevActiveEmail) {
                const sealedPrev = sealVaultCredential(
                  verifiedPrev.credential,
                  prevActiveEmail,
                  entrySec
                );
                await runStore({
                  action: 'save',
                  email: prevActiveEmail,
                  credential: sealedPrev.stored,
                  ...(sealedPrev.vaultUnlocked
                    ? { vaultUnlocked: true, expectedSecuritySalt: sealedPrev.expectedSecuritySalt }
                    : {}),
                });
              }
            }
          }
        }
      } catch {
        // Best-effort backup of active host login before switching away
      }
    }

    const hostSwitchCredential = serializeHostCredential(verified.credential, {
      forHostSwitch: true,
      fallbackEmail: email,
      maxBytes: platform === 'darwin' ? 1900 : 2560,
    });
    const updated = await runStore({
      action: 'scheduleSwitch',
      email,
      credential: hostSwitchCredential,
      vaultCredential: sealedCurrent.stored,
      expectedCredential: saved.credential,
      ...(sealedCurrent.vaultUnlocked
        ? { vaultUnlocked: true, expectedSecuritySalt: sealedCurrent.expectedSecuritySalt }
        : {}),
    });
    return { ...publicList(updated), restarting: updated.scheduled === true };
  } catch (error) {
    return { error: ACCOUNT_ERRORS.has(error?.message) ? error.message : 'storeFailed' };
  }
}
