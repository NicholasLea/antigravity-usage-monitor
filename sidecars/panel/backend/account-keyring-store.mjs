/**
 * @fileoverview Cross-platform OS keyring adapter, master-key AES-256-GCM vault store,
 * WSL2 credential bridge, and Antigravity `app_storage.json` onboarding synchronization.
 *
 * Architecture:
 * - macOS (`darwin`): Keychain via `/usr/bin/security` (`security -i` over stdin so
 *   secrets never appear in `ps` command-line arguments).
 * - Linux (`linux`): Secret Service via `secret-tool` (`libsecret`), automatically
 *   degrading to passphrase-only (`agv1:` scrypt + AES-256-GCM) when no desktop keyring
 *   is available so raw refresh tokens never touch disk unencrypted.
 * - WSL2 (`wsl-wincred`): Syncs the host Windows Credential Manager (`gemini:antigravity`),
 *   `~/.gemini/jetski-standalone-oauth-token`, and Windows `app_storage.json` while storing
 *   the 256-bit vault master key in Windows Credential Manager via WSL Interop.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  decryptVaultMasterCredential,
  encryptVaultMasterCredential,
  isEncryptedVaultCredential,
  isMasterEncryptedVaultCredential,
} from './account-vault-crypto.mjs';
import { HERE } from './config.mjs';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';

export const HOST_CREDENTIAL_SERVICE = 'gemini';
export const HOST_CREDENTIAL_ACCOUNT = 'antigravity';
export const HOST_CREDENTIAL_TARGET = 'gemini:antigravity';
export const MONITOR_VAULT_SERVICE = 'antigravity-usage-monitor';
export const MONITOR_MASTER_KEY_ACCOUNT = 'vault-master-key';
export const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:';

const KEYRING_EMAIL_RE = /^[^\s@"\\'`$;|<>]{1,120}@[^\s@"\\'`$;|<>]{1,120}\.[^\s@"\\'`$;|<>]{1,63}$/;
const MASTER_KEY_LEN = 32;
// Apple `/usr/bin/security -i` reads stdin lines into a 4096-byte buffer (max 4095 chars).
// Hex-encoding (`-X <hex>`) doubles payload length; 1980 raw bytes -> <= 4055 total line chars.
const DARWIN_SECURITY_STDIN_MAX_RAW_BYTES = 1980;
const UNSUPPORTED_PROBE_TTL_MS = 15_000;
const MAX_CACHED_POSIX_ENTRIES = 16;

const KNOWN_STORE_ERRORS = new Set([
  'busy',
  'notFound',
  'vaultLocked',
  'vaultDecryptFailed',
  'credentialChanged',
  'credentialTooLarge',
  'credentialAccessDenied',
  'passphraseRequired',
  'keyringUnavailable',
  'rollbackFailed',
  'noCurrentCredential',
  'switchStartFailed',
  'clientCloseFailed',
  'clientRestartFailed',
  'storeFailed',
]);

function normalizeStoreErrorCode(rawError) {
  const code = String(rawError || '');
  return KNOWN_STORE_ERRORS.has(code) ? code : 'storeFailed';
}

/**
 * Decodes `zalando/go-keyring`'s `go-keyring-base64:<base64>` wrapper used by
 * Antigravity's Go `language_server` when storing >128B OAuth JSON in macOS Keychain.
 */
export function unwrapGoKeyringBase64(rawText) {
  if (typeof rawText !== 'string') return '';
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) return rawText;
  const b64 = trimmed.slice(GO_KEYRING_BASE64_PREFIX.length).replace(/\s+/g, '');
  if (!b64 || b64.length > 32768 || !/^[A-Za-z0-9+/=_-]+$/.test(b64)) {
    return rawText;
  }
  const decodedBuf = Buffer.from(b64, 'base64');
  try {
    const decodedUtf8 = decodedBuf.toString('utf8').replace(/\0+$/, '');
    return decodedUtf8 || rawText;
  } finally {
    decodedBuf.fill(0);
  }
}

function decodeDarwinKeychainStdout(rawStdout) {
  const raw = Buffer.from(rawStdout).toString('utf8').replace(/[\r\n]+$/, '');
  let candidate = raw;
  if (raw.length >= 4 && raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw)) {
    const decodedBuf = Buffer.from(raw, 'hex');
    try {
      const decodedUtf8 = decodedBuf.toString('utf8');
      const trimmed = decodedUtf8.replace(/^\uFEFF/, '').trim();
      if (
        trimmed.startsWith(GO_KEYRING_BASE64_PREFIX) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        /^1\/{1,2}[\w.-]{20,}$/.test(trimmed)
      ) {
        candidate = decodedUtf8;
      }
    } finally {
      decodedBuf.fill(0);
    }
  }
  return unwrapGoKeyringBase64(candidate);
}

function compactCredentialBufferForDarwin(rawBuf) {
  if (rawBuf.length <= DARWIN_SECURITY_STDIN_MAX_RAW_BYTES) return rawBuf;
  try {
    const text = rawBuf.toString('utf8').trim();
    if (!text.startsWith('{')) return rawBuf;
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.id_token) {
      const { id_token: _omitted, ...compact } = parsed;
      return Buffer.from(JSON.stringify(compact), 'utf8');
    }
  } catch {
    // Keep original buffer if not JSON
  }
  return rawBuf;
}

let cachedHostProcVersion = null;
const cachedPosixMasterKeys = new Map();
const cachedPlatformProbes = new Map();
const degradedPassphraseOnlyVaults = new Set();

export function clearPosixKeyringRuntimeCaches() {
  for (const buf of cachedPosixMasterKeys.values()) {
    if (Buffer.isBuffer(buf)) buf.fill(0);
  }
  cachedPosixMasterKeys.clear();
  cachedPlatformProbes.clear();
  degradedPassphraseOnlyVaults.clear();
}

function markVaultDegradedPassphraseOnly(vaultPath) {
  if (!vaultPath) return;
  if (!degradedPassphraseOnlyVaults.has(vaultPath) && degradedPassphraseOnlyVaults.size >= MAX_CACHED_POSIX_ENTRIES) {
    const oldest = degradedPassphraseOnlyVaults.values().next().value;
    if (oldest !== undefined) degradedPassphraseOnlyVaults.delete(oldest);
  }
  degradedPassphraseOnlyVaults.add(vaultPath);
}

function setCachedPosixMasterKey(vaultPath, keyBuf) {
  if (!vaultPath || !Buffer.isBuffer(keyBuf) || keyBuf.length !== MASTER_KEY_LEN) return;
  const prev = cachedPosixMasterKeys.get(vaultPath);
  if (Buffer.isBuffer(prev)) prev.fill(0);
  if (!cachedPosixMasterKeys.has(vaultPath) && cachedPosixMasterKeys.size >= MAX_CACHED_POSIX_ENTRIES) {
    const oldestKey = cachedPosixMasterKeys.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = cachedPosixMasterKeys.get(oldestKey);
      if (Buffer.isBuffer(evicted)) evicted.fill(0);
      cachedPosixMasterKeys.delete(oldestKey);
    }
  }
  cachedPosixMasterKeys.set(vaultPath, Buffer.from(keyBuf));
}

function evictCachedPosixMasterKey(vaultPath) {
  if (!vaultPath) return;
  const prev = cachedPosixMasterKeys.get(vaultPath);
  if (Buffer.isBuffer(prev)) prev.fill(0);
  cachedPosixMasterKeys.delete(vaultPath);
}

function setCachedPlatformProbe(cacheKey, info) {
  if (!cacheKey) return;
  if (!cachedPlatformProbes.has(cacheKey) && cachedPlatformProbes.size >= MAX_CACHED_POSIX_ENTRIES) {
    const oldestKey = cachedPlatformProbes.keys().next().value;
    if (oldestKey !== undefined) cachedPlatformProbes.delete(oldestKey);
  }
  cachedPlatformProbes.set(cacheKey, { info, at: Date.now() });
}

function isSecretServiceMissingStderr(stderr) {
  return /org\.freedesktop\.secrets|not provided by any \.service|serviceunknown|cannot autolaunch|unable to autolaunch|dbus-launch|no such interface/i.test(
    String(stderr || '')
  );
}

export function isAccountPlatformSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

function normalizeSafeCredEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return email.length <= 254 && KEYRING_EMAIL_RE.test(email) ? email : '';
}

function decodeJwtPayloadEmail(jwtText) {
  if (typeof jwtText !== 'string') return '';
  const parts = jwtText.split('.');
  if (parts.length !== 3 || !parts[1] || parts[1].length > 8192) return '';
  let buf = null;
  try {
    buf = Buffer.from(parts[1], 'base64url');
    const claims = JSON.parse(buf.toString('utf8'));
    if (claims && typeof claims === 'object' && claims.email_verified !== false) {
      return normalizeSafeCredEmail(claims.email);
    }
  } catch {
    // Ignore malformed JWT hints
  } finally {
    buf?.fill(0);
  }
  return '';
}

/**
 * Extracts the owner email embedded inside an Antigravity host credential JSON
 * (`id_token_email`, base64-wrapped token envelope, or `id_token` JWT claim)
 * without mutating or logging secret token material.
 */
export function extractHostCredentialEmail(rawBufferOrText) {
  if (!rawBufferOrText) return '';
  let innerBuf = null;
  try {
    const text = unwrapGoKeyringBase64(
      Buffer.isBuffer(rawBufferOrText)
        ? rawBufferOrText.toString('utf8')
        : String(rawBufferOrText)
    );
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed.startsWith('{') || trimmed.length > 32768) return '';
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';

    const direct = normalizeSafeCredEmail(parsed.id_token_email ?? parsed.token?.id_token_email);
    if (direct) return direct;

    if (typeof parsed.token === 'string' && parsed.token && parsed.token.length <= 24576) {
      innerBuf = Buffer.from(parsed.token, 'base64');
      const nested = extractHostCredentialEmail(innerBuf);
      if (nested) return nested;
    }

    const jwtEmail = decodeJwtPayloadEmail(parsed.id_token || parsed.token?.id_token);
    if (jwtEmail) return jwtEmail;
  } catch {
    // Ignore non-JSON or partial credential blobs
  } finally {
    innerBuf?.fill(0);
  }
  return '';
}

export function computeCredentialShortHash(rawCredential) {
  if (!rawCredential) return '';
  try {
    const text = unwrapGoKeyringBase64(
      Buffer.isBuffer(rawCredential)
        ? rawCredential.toString('utf8')
        : String(rawCredential)
    );
    let canonical = text.trim();
    if (canonical.startsWith('{')) {
      const parsed = JSON.parse(canonical);
      const rt = String(parsed?.token?.refresh_token ?? parsed?.refresh_token ?? '').trim();
      if (rt) canonical = rt;
    }
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12).toUpperCase();
  } catch {
    return '';
  }
}

export function isWslEnvironment({
  platform = process.platform,
  env = process.env,
  readProcVersion = null,
} = {}) {
  if (platform !== 'linux') return false;
  if (env?.WSL_DISTRO_NAME || env?.WSL_INTEROP) return true;
  if (typeof readProcVersion === 'function') {
    try {
      return /microsoft|wsl/i.test(String(readProcVersion() || ''));
    } catch {
      return false;
    }
  }
  if (process.platform !== 'linux' || env !== process.env) return false;
  if (cachedHostProcVersion === null) {
    try {
      cachedHostProcVersion = existsSync('/proc/version')
        ? String(readFileSync('/proc/version', 'utf8') || '')
        : '';
    } catch {
      cachedHostProcVersion = '';
    }
  }
  return /microsoft|wsl/i.test(cachedHostProcVersion);
}

export function appendWslBridgeEnv(baseEnv = {}, keys = []) {
  const existing = String(baseEnv.WSLENV || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(existing.map((entry) => entry.split('/')[0]));
  for (const rawKey of keys) {
    const cleanKey = String(rawKey || '').split('/')[0];
    if (cleanKey && !seen.has(cleanKey)) {
      seen.add(cleanKey);
      existing.push(rawKey);
    }
  }
  return { ...baseEnv, WSLENV: existing.join(':') };
}

function sanitizeWslDistroSlug(env = process.env) {
  const raw = String(env?.WSL_DISTRO_NAME || 'default').trim();
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'default';
}

export function resolvePosixAccountStoragePaths({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const customDir = String(env?.USAGE_MONITOR_VAULT_DIR || '').trim();
  const baseDir = customDir
    ? customDir
    : platform === 'darwin'
      ? join(homeDir, 'Library', 'Application Support', 'AntigravityUsageMonitor')
      : join(
          String(env?.XDG_DATA_HOME || '').trim() || join(homeDir, '.local', 'share'),
          'AntigravityUsageMonitor'
        );
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  return {
    baseDir,
    vault: join(baseDir, 'accounts.vault.json'),
    statusFile: join(baseDir, 'switch-state.json'),
    lockFile: join(baseDir, 'accounts.vault.lock'),
    wslTokenFile: join(geminiBase, 'jetski-standalone-oauth-token'),
    fallbacks: [
      join(geminiBase, 'jetski-standalone-oauth-token'),
      join(geminiBase, 'antigravity-cli', 'antigravity-oauth-token'),
    ],
  };
}

export function resolveAntigravityAppStorageCandidates({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  wslMode = isWslEnvironment({ platform, env }),
  wslWindowsAppDataPosix = '',
} = {}) {
  const out = [];
  const pushUnique = (p) => {
    const clean = String(p || '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  };
  if (env?.ANTIGRAVITY_USER_DATA_DIR) {
    pushUnique(join(env.ANTIGRAVITY_USER_DATA_DIR, 'app_storage.json'));
  }
  if (platform === 'win32') {
    const appData = String(env?.APPDATA || '').trim() || join(homeDir, 'AppData', 'Roaming');
    pushUnique(join(appData, 'Antigravity', 'app_storage.json'));
    pushUnique(join(appData, 'Antigravity IDE', 'app_storage.json'));
    return out;
  }
  if (platform === 'darwin') {
    pushUnique(join(homeDir, 'Library', 'Application Support', 'Antigravity', 'app_storage.json'));
    pushUnique(
      join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'app_storage.json')
    );
    return out;
  }
  if (wslMode && wslWindowsAppDataPosix) {
    pushUnique(`${wslWindowsAppDataPosix.replace(/\/+$/, '')}/Antigravity/app_storage.json`);
    pushUnique(`${wslWindowsAppDataPosix.replace(/\/+$/, '')}/Antigravity IDE/app_storage.json`);
  }
  const configHome = String(env?.XDG_CONFIG_HOME || '').trim() || join(homeDir, '.config');
  pushUnique(join(configHome, 'Antigravity', 'app_storage.json'));
  pushUnique(join(configHome, 'antigravity', 'app_storage.json'));
  pushUnique(join(configHome, 'Antigravity IDE', 'app_storage.json'));
  return out;
}

/**
 * Updates `agy.onboarding.lastLoginUsername` inside existing `app_storage.json` files
 * after stopping the old client and before launching the switched account, preventing
 * redundant onboarding prompts on restart.
 */
export function syncAntigravityOnboardingStorage(
  email,
  {
    isGcpTos = null,
    candidates = [],
    fsOps = null,
  } = {}
) {
  const cleanEmail = normalizeSafeCredEmail(email);
  if (!cleanEmail || !Array.isArray(candidates) || candidates.length === 0) return 0;
  const existsFn = fsOps?.existsFn || existsSync;
  const lstatFn = fsOps?.lstatFn || lstatSync;
  const readFn = fsOps?.readFn || readFileSync;
  let updatedCount = 0;

  for (const filePath of candidates) {
    try {
      if (!filePath || !existsFn(filePath)) continue;
      if (typeof lstatFn === 'function') {
        const st = lstatFn(filePath);
        if (!st || st.isDirectory?.() || st.isSymbolicLink?.()) continue;
      }
      const raw = String(readFn(filePath, 'utf8') || '');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const prevEmail = normalizeSafeCredEmail(parsed['agy.onboarding.lastLoginUsername']);
      const nextTos =
        typeof isGcpTos === 'boolean' ? String(isGcpTos) : parsed['agy.onboarding.lastLoginIsGcpTos'];
      if (
        prevEmail === cleanEmail &&
        nextTos === parsed['agy.onboarding.lastLoginIsGcpTos']
      ) {
        continue;
      }
      parsed['agy.onboarding.lastLoginUsername'] = cleanEmail;
      if (typeof isGcpTos === 'boolean') {
        parsed['agy.onboarding.lastLoginIsGcpTos'] = String(isGcpTos);
      }
      writeTextFileAtomicSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, fsOps);
      updatedCount += 1;
    } catch {
      // Best-effort per storage file
    }
  }
  return updatedCount;
}

const WSL_WINCRED_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class UmWslWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, int flags, out IntPtr credPtr);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWriteW([In] ref CREDENTIAL userCred, uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, int flags);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
}
"@
$op = $env:UM_CRED_OP
$target = $env:UM_CRED_TARGET
$user = if ([string]::IsNullOrEmpty($env:UM_CRED_USER)) { 'antigravity' } else { $env:UM_CRED_USER }
if ($op -eq 'probe') {
  Write-Output '{"ok":true}'
} elseif ($op -eq 'read') {
  $ptr = [IntPtr]::Zero
  if ([UmWslWinCred]::CredReadW($target, 1, 0, [ref]$ptr)) {
    [byte[]]$bytes = $null
    try {
      $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][UmWslWinCred+CREDENTIAL])
      $sz = [int]$c.CredentialBlobSize
      $bytes = New-Object byte[] $sz
      if ($sz -gt 0 -and $c.CredentialBlob -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $sz)
      }
      Write-Output ('{"ok":true,"exists":true,"data":"' + [Convert]::ToBase64String($bytes) + '"}')
    } finally {
      if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
      [UmWslWinCred]::CredFree($ptr)
    }
  } else {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { Write-Output '{"ok":true,"exists":false,"data":""}' }
    else { Write-Output ('{"ok":false,"error":"wincred_read_' + $err + '"}'); exit 1 }
  }
} elseif ($op -eq 'write') {
  $b64 = [Console]::In.ReadToEnd().Trim()
  [byte[]]$bytes = $null
  $blobPtr = [IntPtr]::Zero
  try {
    $bytes = [Convert]::FromBase64String($b64)
    if ($bytes.Length -gt 2560) {
      Write-Output '{"ok":false,"error":"credentialTooLarge"}'; exit 1
    }
    if ($bytes.Length -gt 0) {
      $blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
    }
    $cred = New-Object UmWslWinCred+CREDENTIAL
    $cred.Type = 1
    $cred.TargetName = $target
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = $blobPtr
    $cred.Persist = 2
    $cred.UserName = $user
    if (-not [UmWslWinCred]::CredWriteW([ref]$cred, 0)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Output ('{"ok":false,"error":"wincred_write_' + $err + '"}'); exit 1
    }
    Write-Output '{"ok":true}'
  } finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($blobPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr) }
  }
} elseif ($op -eq 'delete') {
  if (-not [UmWslWinCred]::CredDeleteW($target, 1, 0)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -ne 1168) { Write-Output ('{"ok":false,"error":"wincred_del_' + $err + '"}'); exit 1 }
  }
  Write-Output '{"ok":true}'
} else {
  Write-Output '{"ok":false,"error":"unknown_op"}'; exit 1
}
`.trim();

async function getChildProcessMod() {
  return import('node:child_process');
}

async function getFsMod() {
  return import('node:fs');
}

function defaultRunSpawnSyncFactory(cpMod) {
  const spawnSyncFn = cpMod?.spawnSync || cpMod?.default?.spawnSync;
  return (cmd, args, opts = {}) => {
    if (typeof spawnSyncFn !== 'function') {
      return { status: 1, error: new Error('spawnSync unavailable'), stdout: '', stderr: '' };
    }
    return spawnSyncFn(cmd, args, opts);
  };
}

function runWslWinCredOp(runSpawn, env, op, target, { user = 'antigravity', inputB64 = undefined } = {}) {
  const bridgeEnv = appendWslBridgeEnv(
    {
      ...env,
      UM_CRED_OP: op,
      UM_CRED_TARGET: target,
      UM_CRED_USER: user,
    },
    ['UM_CRED_OP', 'UM_CRED_TARGET', 'UM_CRED_USER']
  );
  const res = runSpawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', WSL_WINCRED_PS_SCRIPT],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: bridgeEnv,
      ...(inputB64 !== undefined
        ? { input: inputB64, stdio: ['pipe', 'pipe', 'pipe'] }
        : { stdio: ['ignore', 'pipe', 'pipe'] }),
    }
  );
  const lastLine =
    String(res?.stdout || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1) || '';
  try {
    const parsed = JSON.parse(lastLine);
    if (res?.status === 0 && parsed?.ok) return parsed;
    const rawErr = String(parsed?.error || '');
    if (/^wincred_(?:read|write|del)_(?:5|1312)$/.test(rawErr)) {
      return { ok: false, error: 'credentialAccessDenied' };
    }
    return { ok: false, error: rawErr || 'storeFailed' };
  } catch {
    return { ok: false, error: res?.error?.message || 'storeFailed' };
  }
}

export function resolveWslWindowsAppDataPosix(runSpawn, env = process.env) {
  try {
    const cmdRes = runSpawn('cmd.exe', ['/d', '/c', 'echo %APPDATA%'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      env,
    });
    if (cmdRes?.error || cmdRes?.status !== 0) return '';
    const winPath =
      String(cmdRes.stdout || '')
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) || '';
    if (!winPath || winPath.toUpperCase() === '%APPDATA%') return '';
    const wslRes = runSpawn('wslpath', ['-u', winPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env,
    });
    if (!wslRes?.error && wslRes?.status === 0) {
      const converted = String(wslRes.stdout || '').trim();
      if (converted) return converted;
    }
    const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : '';
  } catch {
    return '';
  }
}

export function createPosixKeyringAdapter({
  platform = process.platform,
  env = process.env,
  wslMode = isWslEnvironment({ platform, env }),
  runSpawn = null,
  useGlobalCache = false,
  forcePassphraseOnly = false,
  onDegradePassphraseOnly = null,
} = {}) {
  const wslDistro = wslMode ? sanitizeWslDistroSlug(env) : '';
  const wslMasterKeyTarget = `AntigravityUsageMonitor:wsl:${wslDistro}:master-key`;
  const cacheKey = `${platform}|${wslMode ? `wsl:${wslDistro}` : 'native'}`;
  let instanceProbe = forcePassphraseOnly
    ? {
        supported: true,
        backend: 'linux-passphrase-only',
        keyringAvailable: false,
        requiresPassphrase: true,
      }
    : null;

  function probe({ force = false } = {}) {
    if (!force && instanceProbe) {
      return instanceProbe;
    }
    if (!force && useGlobalCache && cachedPlatformProbes.has(cacheKey)) {
      const cached = cachedPlatformProbes.get(cacheKey);
      if (cached && (cached.info.keyringAvailable || Date.now() - cached.at < UNSUPPORTED_PROBE_TTL_MS)) {
        instanceProbe = cached.info;
        return cached.info;
      }
      cachedPlatformProbes.delete(cacheKey);
    }
    let info;
    if (platform === 'darwin') {
      info = {
        supported: true,
        backend: 'darwin-keychain',
        keyringAvailable: true,
        requiresPassphrase: false,
      };
    } else if (platform === 'linux' && wslMode && typeof runSpawn === 'function') {
      const wslProbe = runWslWinCredOp(runSpawn, env, 'probe', '');
      if (wslProbe?.ok) {
        info = {
          supported: true,
          backend: 'wsl-wincred',
          keyringAvailable: true,
          requiresPassphrase: false,
        };
      }
    }
    if (!info && platform === 'linux' && typeof runSpawn === 'function') {
      const hasSession = Boolean(
        env?.DBUS_SESSION_BUS_ADDRESS || env?.DISPLAY || env?.WAYLAND_DISPLAY
      );
      if (hasSession) {
        const res = runSpawn('secret-tool', ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3000,
          env,
        });
        if (!res?.error && res?.status === 0) {
          info = {
            supported: true,
            backend: 'linux-secret-service',
            keyringAvailable: true,
            requiresPassphrase: false,
          };
        }
      }
      if (!info) {
        info = {
          supported: true,
          backend: 'linux-passphrase-only',
          keyringAvailable: false,
          requiresPassphrase: true,
        };
      }
    }
    if (!info) {
      info = {
        supported: false,
        backend: 'unsupported',
        keyringAvailable: false,
        requiresPassphrase: false,
      };
    }
    instanceProbe = info;
    if (useGlobalCache && info.supported) {
      setCachedPlatformProbe(cacheKey, info);
    }
    return info;
  }

  function degradeToPassphraseOnly() {
    const degraded = {
      supported: true,
      backend: 'linux-passphrase-only',
      keyringAvailable: false,
      requiresPassphrase: true,
    };
    instanceProbe = degraded;
    if (useGlobalCache) {
      setCachedPlatformProbe(cacheKey, degraded);
    }
    onDegradePassphraseOnly?.();
    return degraded;
  }

  function readSecret(service, account) {
    const cap = probe();
    if (!cap.keyringAvailable) return { ok: false, exists: false, error: 'keyringUnavailable' };
    if (cap.backend === 'darwin-keychain') {
      const res = runSpawn(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { timeout: 8000, env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      if (res?.status === 44) return { ok: true, exists: false, value: '' };
      if (res?.status !== 0 || !res?.stdout) {
        const stderr = String(res?.stderr || '');
        if (/could not be found|SecKeychainSearchCopyNext/i.test(stderr)) {
          return { ok: true, exists: false, value: '' };
        }
        return { ok: false, exists: false, error: 'credentialAccessDenied' };
      }
      const value = decodeDarwinKeychainStdout(res.stdout);
      return { ok: true, exists: Boolean(value), value };
    }
    if (cap.backend === 'wsl-wincred') {
      const target =
        service === HOST_CREDENTIAL_SERVICE && account === HOST_CREDENTIAL_ACCOUNT
          ? HOST_CREDENTIAL_TARGET
          : wslMasterKeyTarget;
      const res = runWslWinCredOp(runSpawn, env, 'read', target);
      if (!res?.ok) return { ok: false, exists: false, error: 'credentialAccessDenied' };
      if (!res.exists || !res.data) return { ok: true, exists: false, value: '' };
      const buf = Buffer.from(res.data, 'base64');
      try {
        return { ok: true, exists: true, value: buf.toString('utf8') };
      } finally {
        buf.fill(0);
      }
    }
    if (cap.backend === 'linux-secret-service') {
      const res = runSpawn('secret-tool', ['lookup', 'service', service, 'username', account], {
        timeout: 8000,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderr = String(res?.stderr || '').trim();
      if (res?.error?.code === 'ENOENT' || isSecretServiceMissingStderr(stderr)) {
        degradeToPassphraseOnly();
        return { ok: false, exists: false, error: 'keyringUnavailable' };
      }
      if (res?.status !== 0 || !res?.stdout) {
        if (stderr && /denied|locked|dbus/i.test(stderr)) {
          return { ok: false, exists: false, error: 'credentialAccessDenied' };
        }
        return { ok: true, exists: false, value: '' };
      }
      const value = unwrapGoKeyringBase64(Buffer.from(res.stdout).toString('utf8'));
      return { ok: true, exists: Boolean(value), value };
    }
    return { ok: false, exists: false, error: 'unsupported' };
  }

  function writeSecret(service, account, utf8Value, { label = 'Antigravity Usage Monitor' } = {}) {
    const cap = probe();
    if (!cap.keyringAvailable) return { ok: false, error: 'keyringUnavailable' };
    const rawBuf = Buffer.from(String(utf8Value ?? ''), 'utf8');
    let darwinBuf = null;
    try {
      if (rawBuf.length > 2560) {
        return { ok: false, error: 'credentialTooLarge' };
      }
      if (cap.backend === 'darwin-keychain') {
        darwinBuf = compactCredentialBufferForDarwin(rawBuf);
        if (darwinBuf.length > DARWIN_SECURITY_STDIN_MAX_RAW_BYTES) {
          return { ok: false, error: 'credentialTooLarge' };
        }
        // Pipe `-X <hex>` over `/usr/bin/security -i` stdin so secret bytes never leak to `ps` argv.
        const hex = darwinBuf.toString('hex');
        const cmd = `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -X ${hex}\n`;
        const res = runSpawn('/usr/bin/security', ['-i'], {
          input: cmd,
          stdio: ['pipe', 'ignore', 'pipe'],
          timeout: 8000,
          env,
        });
        if (res?.status !== 0) {
          return { ok: false, error: 'credentialAccessDenied' };
        }
        return { ok: true };
      }
      if (cap.backend === 'wsl-wincred') {
        const target =
          service === HOST_CREDENTIAL_SERVICE && account === HOST_CREDENTIAL_ACCOUNT
            ? HOST_CREDENTIAL_TARGET
            : wslMasterKeyTarget;
        const res = runWslWinCredOp(runSpawn, env, 'write', target, {
          user: account,
          inputB64: rawBuf.toString('base64'),
        });
        return res?.ok ? { ok: true } : { ok: false, error: res?.error || 'storeFailed' };
      }
      if (cap.backend === 'linux-secret-service') {
        const res = runSpawn(
          'secret-tool',
          ['store', `--label=${label}`, 'service', service, 'username', account],
          {
            input: rawBuf,
            stdio: ['pipe', 'ignore', 'pipe'],
            timeout: 8000,
            env,
          }
        );
        if (res?.error?.code === 'ENOENT' || isSecretServiceMissingStderr(res?.stderr)) {
          degradeToPassphraseOnly();
          return { ok: false, error: 'keyringUnavailable' };
        }
        if (res?.status !== 0) {
          return { ok: false, error: 'credentialAccessDenied' };
        }
        return { ok: true };
      }
      return { ok: false, error: 'unsupported' };
    } finally {
      if (darwinBuf && darwinBuf !== rawBuf) darwinBuf.fill(0);
      rawBuf.fill(0);
    }
  }

  function deleteSecret(service, account) {
    const cap = probe();
    if (!cap.keyringAvailable) return { ok: true };
    if (cap.backend === 'darwin-keychain') {
      const res = runSpawn(
        '/usr/bin/security',
        ['delete-generic-password', '-s', service, '-a', account],
        { stdio: 'ignore', timeout: 8000, env }
      );
      return { ok: res?.status === 0 || res?.status === 44 };
    }
    if (cap.backend === 'wsl-wincred') {
      const target =
        service === HOST_CREDENTIAL_SERVICE && account === HOST_CREDENTIAL_ACCOUNT
          ? HOST_CREDENTIAL_TARGET
          : wslMasterKeyTarget;
      return runWslWinCredOp(runSpawn, env, 'delete', target);
    }
    if (cap.backend === 'linux-secret-service') {
      const res = runSpawn('secret-tool', ['clear', 'service', service, 'username', account], {
        stdio: 'ignore',
        timeout: 8000,
        env,
      });
      return { ok: res?.status === 0 };
    }
    return { ok: false };
  }

  return {
    probe,
    readSecret,
    writeSecret,
    deleteSecret,
    wslMode,
    wslMasterKeyTarget,
  };
}

function assertSafeAccountFile(filePath, { existsFn = existsSync, lstatFn = lstatSync } = {}) {
  if (!filePath || !existsFn(filePath)) return false;
  if (typeof lstatFn === 'function') {
    const st = lstatFn(filePath);
    if (!st || st.isDirectory?.() || st.isSymbolicLink?.()) {
      throw new Error('storeFailed');
    }
  }
  return true;
}

function writeSecureAccountFile(filePath, contentOrBuf, fsMod = null) {
  const dir = dirname(filePath);
  const mkdirFn = fsMod?.mkdirSync || mkdirSync;
  const writeFn = fsMod?.writeFileSync || writeFileSync;
  const renameFn = fsMod?.renameSync || renameSync;
  const unlinkFn = fsMod?.unlinkSync || unlinkSync;
  const chmodFn = fsMod?.chmodSync || null;
  const lstatFn = fsMod?.lstatSync || lstatSync;
  const existsFn = fsMod?.existsSync || existsSync;

  assertSafeAccountFile(filePath, { existsFn, lstatFn });
  mkdirFn(dir, { recursive: true, mode: 0o700 });
  try {
    chmodFn?.(dir, 0o700);
  } catch {
    // Ignore filesystem chmod limitations
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    if (Buffer.isBuffer(contentOrBuf)) {
      writeFn(tmpPath, contentOrBuf, { mode: 0o600 });
    } else {
      writeFn(tmpPath, String(contentOrBuf), { encoding: 'utf8', mode: 0o600 });
    }
    try {
      chmodFn?.(tmpPath, 0o600);
    } catch {
      // Ignore chmod limitations
    }
    renameFn(tmpPath, filePath);
  } finally {
    try {
      if (existsFn(tmpPath)) unlinkFn(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

async function withPosixVaultLock(lockPath, fsMod, fn, timeoutMs = 5000) {
  const openFn = fsMod?.openSync;
  const closeFn = fsMod?.closeSync;
  const writeFn = fsMod?.writeFileSync || writeFileSync;
  const readFn = fsMod?.readFileSync || readFileSync;
  const unlinkFn = fsMod?.unlinkSync || unlinkSync;
  const mkdirFn = fsMod?.mkdirSync || mkdirSync;

  if (typeof openFn !== 'function' || typeof closeFn !== 'function') {
    return fn();
  }

  mkdirFn(dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (Date.now() <= deadline) {
    try {
      const fd = openFn(lockPath, 'wx', 0o600);
      let wroteMeta = false;
      try {
        writeFn(fd, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), 'utf8');
        wroteMeta = true;
      } finally {
        closeFn(fd);
        if (!wroteMeta) {
          try {
            unlinkFn(lockPath);
          } catch {
            // Ignore cleanup failure
          }
        }
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') return { error: 'storeFailed' };
      try {
        const rawLock = String(readFn(lockPath, 'utf8') || '').trim();
        if (!rawLock) {
          const lstatFn = fsMod?.lstatSync || lstatSync;
          const st = typeof lstatFn === 'function' ? lstatFn(lockPath) : null;
          if (st && Number.isFinite(st.mtimeMs) && Date.now() - st.mtimeMs > 5_000) {
            unlinkFn(lockPath);
            continue;
          }
        } else {
          const holder = JSON.parse(rawLock);
          const holderAt = Number(holder?.at);
          const holderPid = Number(holder?.pid);
          if (Number.isFinite(holderAt) && holderAt > 0) {
            const ageMs = Date.now() - holderAt;
            if ((!isProcessAlive(holderPid) && ageMs > 200) || ageMs > 30_000) {
              unlinkFn(lockPath);
              continue;
            }
          }
        }
      } catch {
        // Concurrent holder is mid-write or already released; wait briefly
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  if (!acquired) {
    return { error: 'busy' };
  }

  try {
    return await fn();
  } finally {
    try {
      const cur = JSON.parse(String(readFn(lockPath, 'utf8') || '{}'));
      if (cur?.nonce === nonce) unlinkFn(lockPath);
    } catch {
      // Ignore already cleaned lock
    }
  }
}

function readRawPosixVault(vaultPath, fsMod) {
  const existsFn = fsMod?.existsSync || existsSync;
  const lstatFn = fsMod?.lstatSync || lstatSync;
  const readFn = fsMod?.readFileSync || readFileSync;
  if (!assertSafeAccountFile(vaultPath, { existsFn, lstatFn })) {
    return { entries: [], selectedEmail: '', security: null };
  }
  const parsed = JSON.parse(String(readFn(vaultPath, 'utf8') || '{}'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('storeFailed');
  }
  return {
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    selectedEmail: typeof parsed.selectedEmail === 'string' ? parsed.selectedEmail : '',
    security: parsed.security && typeof parsed.security === 'object' ? parsed.security : null,
  };
}

function saveRawPosixVault(vaultPath, vaultObj, fsMod) {
  const payload = {
    schemaVersion: 1,
    selectedEmail: String(vaultObj.selectedEmail || ''),
    ...(vaultObj.security?.enabled ? { security: vaultObj.security } : {}),
    entries: Array.isArray(vaultObj.entries) ? vaultObj.entries : [],
  };
  writeSecureAccountFile(vaultPath, `${JSON.stringify(payload, null, 2)}\n`, fsMod);
}

function resolveOrCreateMasterKey(
  keyring,
  vaultPath,
  { createIfMissing = false, verifyKeyring = false, canRestoreExistingKey = false } = {}
) {
  const memKey = cachedPosixMasterKeys.get(vaultPath);
  if (!verifyKeyring && Buffer.isBuffer(memKey) && memKey.length === MASTER_KEY_LEN) {
    return Buffer.from(memKey);
  }
  const existing = keyring.readSecret(MONITOR_VAULT_SERVICE, MONITOR_MASTER_KEY_ACCOUNT);
  if (!existing.ok) {
    throw new Error(existing.error || 'credentialAccessDenied');
  }
  if (existing.exists && existing.value) {
    const decoded = Buffer.from(existing.value.trim(), 'base64url');
    if (decoded.length === MASTER_KEY_LEN) {
      setCachedPosixMasterKey(vaultPath, decoded);
      return decoded;
    }
    decoded.fill(0);
  }
  if (!createIfMissing) {
    evictCachedPosixMasterKey(vaultPath);
    return null;
  }
  if (canRestoreExistingKey && Buffer.isBuffer(memKey) && memKey.length === MASTER_KEY_LEN) {
    const restoredKey = Buffer.from(memKey);
    const rePersisted = keyring.writeSecret(
      MONITOR_VAULT_SERVICE,
      MONITOR_MASTER_KEY_ACCOUNT,
      restoredKey.toString('base64url'),
      { label: 'Antigravity Usage Monitor Vault Master Key' }
    );
    if (!rePersisted.ok) {
      restoredKey.fill(0);
      throw new Error(rePersisted.error || 'credentialAccessDenied');
    }
    return restoredKey;
  }
  evictCachedPosixMasterKey(vaultPath);
  const fresh = randomBytes(MASTER_KEY_LEN);
  const encoded = fresh.toString('base64url');
  const written = keyring.writeSecret(MONITOR_VAULT_SERVICE, MONITOR_MASTER_KEY_ACCOUNT, encoded, {
    label: 'Antigravity Usage Monitor Vault Master Key',
  });
  if (!written.ok) {
    fresh.fill(0);
    throw new Error(written.error || 'credentialAccessDenied');
  }
  setCachedPosixMasterKey(vaultPath, fresh);
  return fresh;
}

function unwrapMasterEntryIfNeeded(storedCred, email, keyring, vaultPath) {
  if (!isMasterEncryptedVaultCredential(storedCred)) {
    return storedCred;
  }
  const hadCachedKey = cachedPosixMasterKeys.has(vaultPath);
  const mk = resolveOrCreateMasterKey(keyring, vaultPath, { createIfMissing: false });
  if (!mk) {
    throw new Error('vaultDecryptFailed');
  }
  try {
    return decryptVaultMasterCredential(storedCred, mk, email);
  } catch (err) {
    if (!hadCachedKey) throw err;
  } finally {
    mk.fill(0);
  }
  evictCachedPosixMasterKey(vaultPath);
  const freshMk = resolveOrCreateMasterKey(keyring, vaultPath, {
    createIfMissing: false,
    verifyKeyring: true,
  });
  if (!freshMk) {
    throw new Error('vaultDecryptFailed');
  }
  try {
    return decryptVaultMasterCredential(storedCred, freshMk, email);
  } finally {
    freshMk.fill(0);
  }
}

function wrapEntryForDisk(
  innerCred,
  email,
  keyring,
  vaultPath,
  securityEnabled,
  { writeKeyMemo = null, canRestoreExistingKey = false } = {}
) {
  if (keyring.probe().keyringAvailable) {
    let mk = null;
    let shouldZeroMk = false;
    try {
      if (writeKeyMemo?.keyBuf) {
        mk = writeKeyMemo.keyBuf;
      } else {
        mk = resolveOrCreateMasterKey(keyring, vaultPath, {
          createIfMissing: true,
          verifyKeyring: true,
          canRestoreExistingKey,
        });
        if (writeKeyMemo) {
          writeKeyMemo.keyBuf = mk;
        } else {
          shouldZeroMk = true;
        }
      }
      return encryptVaultMasterCredential(innerCred, mk, email);
    } catch (err) {
      if (err?.message !== 'keyringUnavailable' || keyring.probe().keyringAvailable) {
        throw err;
      }
    } finally {
      if (shouldZeroMk && mk) mk.fill(0);
    }
  }
  // Passphrase-only fallback (Linux without OS keyring): refuse storing any unencrypted token
  if (!securityEnabled || !isEncryptedVaultCredential(innerCred)) {
    throw new Error('passphraseRequired');
  }
  return innerCred;
}

export function resolveExternalPosixNodeBinary({
  execPath = process.execPath,
  env = process.env,
  existsFn = existsSync,
} = {}) {
  if (execPath && !execPath.includes('/.mount_') && existsFn(execPath)) {
    const leaf = basename(execPath).toLowerCase();
    const needsRunAsNode = !/^node(?:\.exe)?$/.test(leaf);
    return { command: execPath, runAsNode: needsRunAsNode };
  }
  const pathDirs = String(env?.PATH || '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p && !p.includes('/.mount_'));
  for (const dir of [...pathDirs, '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']) {
    const cand = join(dir, 'node');
    try {
      if (existsFn(cand)) return { command: cand, runAsNode: false };
    } catch {
      // Ignore unreadable directory
    }
  }
  const appImage = String(env?.APPIMAGE || '').trim();
  if (appImage && existsFn(appImage)) {
    return { command: appImage, runAsNode: true };
  }
  return { command: execPath, runAsNode: true };
}

export function writeSwitchStatusFile(statusFile, email, state, errorCode = '', fsMod = null) {
  if (!statusFile) return;
  const payload = {
    email: String(email || ''),
    state,
    error: String(errorCode || ''),
    updatedAt: Date.now(),
  };
  writeSecureAccountFile(statusFile, JSON.stringify(payload), fsMod);
}

/**
 * Reads the active Antigravity credential from macOS Keychain, Linux Secret Service,
 * Windows Credential Manager (via WSL2 interop), or standalone OAuth token files.
 */
export function readPosixActiveHostCredential(
  keyring,
  cap,
  paths,
  fsMod = null,
  preferredEmail = ''
) {
  const existsFn = fsMod?.existsSync || existsSync;
  const lstatFn = fsMod?.lstatSync || lstatSync;
  const readFn = fsMod?.readFileSync || readFileSync;
  const wantEmail = normalizeSafeCredEmail(preferredEmail);

  let primaryCandidate = '';
  if (cap.keyringAvailable) {
    const primary = keyring.readSecret(HOST_CREDENTIAL_SERVICE, HOST_CREDENTIAL_ACCOUNT);
    if (!primary.ok && primary.error === 'credentialAccessDenied' && cap.backend !== 'wsl-wincred') {
      return { error: 'credentialAccessDenied' };
    }
    if (primary.ok && primary.exists && primary.value) {
      primaryCandidate = primary.value.replace(/^\uFEFF/, '').trim();
      if (
        primaryCandidate &&
        (!wantEmail ||
          cap.backend !== 'wsl-wincred' ||
          extractHostCredentialEmail(primaryCandidate) === wantEmail)
      ) {
        return { credential: primaryCandidate };
      }
    }
  }

  let fallbackCandidate = '';
  for (const fbPath of paths.fallbacks || []) {
    try {
      if (assertSafeAccountFile(fbPath, { existsFn, lstatFn })) {
        const rawBuf = readFn(fbPath);
        const text = unwrapGoKeyringBase64(Buffer.from(rawBuf).toString('utf8'))
          .replace(/^\uFEFF/, '')
          .trim();
        if (Buffer.isBuffer(rawBuf)) rawBuf.fill(0);
        if (text) {
          if (!fallbackCandidate) fallbackCandidate = text;
          if (!wantEmail || extractHostCredentialEmail(text) === wantEmail) {
            return { credential: text };
          }
        }
      }
    } catch {
      // Try next fallback
    }
  }
  if (primaryCandidate) return { credential: primaryCandidate };
  if (fallbackCandidate) return { credential: fallbackCandidate };
  return { error: 'noCurrentCredential' };
}

/**
 * Atomically writes the switched credential to the OS keyring + existing fallback token
 * files with automatic rollback on partial failure, then updates the vault & onboarding state.
 */
export function performPosixCredentialSwitchWrite({
  request,
  keyring,
  cap,
  paths,
  fsMod = null,
}) {
  const existsFn = fsMod?.existsSync || existsSync;
  const lstatFn = fsMod?.lstatSync || lstatSync;
  const readFn = fsMod?.readFileSync || readFileSync;
  const unlinkFn = fsMod?.unlinkSync || unlinkSync;

  const vault = readRawPosixVault(paths.vault, fsMod);
  const vaultSecured = Boolean(vault.security?.enabled);
  if (
    vaultSecured &&
    (!request.vaultUnlocked || request.expectedSecuritySalt !== String(vault.security.salt))
  ) {
    return { error: 'vaultLocked' };
  }
  const entry = vault.entries.find((e) => e?.email === request.email);
  if (!entry) return { error: 'notFound' };

  if (request.expectedCredential !== undefined && request.expectedCredential !== null) {
    const currentUnwrapped = unwrapMasterEntryIfNeeded(
      entry.credential,
      entry.email,
      keyring,
      paths.vault
    );
    if (currentUnwrapped !== request.expectedCredential) {
      return { error: 'credentialChanged' };
    }
  }

  const hostPayload = String(request.credential || '');
  if (Buffer.byteLength(hostPayload, 'utf8') > 2560) {
    return { error: 'credentialTooLarge' };
  }

  const usePrimaryKeyring = Boolean(cap.keyringAvailable);
  const mustWriteWslToken = !usePrimaryKeyring || cap.backend === 'wsl-wincred';
  const prevPrimary = usePrimaryKeyring
    ? keyring.readSecret(HOST_CREDENTIAL_SERVICE, HOST_CREDENTIAL_ACCOUNT)
    : { ok: true, exists: false, value: '' };

  const fallbackTargets = [];
  for (const fbPath of paths.fallbacks || []) {
    if (assertSafeAccountFile(fbPath, { existsFn, lstatFn })) {
      fallbackTargets.push({ path: fbPath, original: Buffer.from(readFn(fbPath)) });
    } else if (
      existsFn(dirname(fbPath)) ||
      (mustWriteWslToken && fbPath === paths.wslTokenFile)
    ) {
      fallbackTargets.push({ path: fbPath, original: null });
    }
  }

  if (mustWriteWslToken && fallbackTargets.length === 0) {
    const primaryFallback = (paths.fallbacks && paths.fallbacks[0]) || paths.wslTokenFile;
    if (primaryFallback) {
      fallbackTargets.push({ path: primaryFallback, original: null });
    }
  }

  const writtenFallbacks = [];
  let primaryWritten = false;
  try {
    if (usePrimaryKeyring) {
      const wrotePrimary = keyring.writeSecret(
        HOST_CREDENTIAL_SERVICE,
        HOST_CREDENTIAL_ACCOUNT,
        hostPayload,
        { label: 'Antigravity' }
      );
      if (!wrotePrimary.ok) {
        return { error: normalizeStoreErrorCode(wrotePrimary.error) };
      }
      primaryWritten = true;
    }

    for (const fb of fallbackTargets) {
      writeSecureAccountFile(fb.path, hostPayload, fsMod);
      writtenFallbacks.push(fb);
    }

    if (request.vaultCredential) {
      const hasExistingMasterEntries = vault.entries.some(
        (e) => e?.email !== request.email && isMasterEncryptedVaultCredential(e?.credential)
      );
      entry.credential = wrapEntryForDisk(
        request.vaultCredential,
        request.email,
        keyring,
        paths.vault,
        vaultSecured,
        { canRestoreExistingKey: hasExistingMasterEntries }
      );
    }
    vault.selectedEmail = request.email;
    saveRawPosixVault(paths.vault, vault, fsMod);
    return { ok: true, vault };
  } catch (err) {
    let rollbackOk = true;
    if (primaryWritten) {
      if (prevPrimary.exists && prevPrimary.value) {
        const restored = keyring.writeSecret(
          HOST_CREDENTIAL_SERVICE,
          HOST_CREDENTIAL_ACCOUNT,
          prevPrimary.value,
          { label: 'Antigravity' }
        );
        if (!restored.ok) rollbackOk = false;
      } else {
        const deleted = keyring.deleteSecret(HOST_CREDENTIAL_SERVICE, HOST_CREDENTIAL_ACCOUNT);
        if (!deleted.ok) rollbackOk = false;
      }
    }
    for (const fb of writtenFallbacks) {
      try {
        if (fb.original === null) {
          if (existsFn(fb.path)) unlinkFn(fb.path);
        } else {
          writeSecureAccountFile(fb.path, fb.original, fsMod);
        }
      } catch {
        rollbackOk = false;
      }
    }
    if (!rollbackOk) return { error: 'rollbackFailed' };
    return { error: normalizeStoreErrorCode(err?.message) };
  } finally {
    for (const fb of fallbackTargets) {
      if (Buffer.isBuffer(fb.original)) fb.original.fill(0);
    }
  }
}

export async function runPosixCredentialStore(
  request,
  {
    platform = process.platform,
    env = process.env,
    homeDir = homedir(),
    runSpawn = null,
    spawnBackgroundWorker = null,
    fsOps = null,
  } = {}
) {
  const [cpMod, fsModActual] = await Promise.all([
    runSpawn && spawnBackgroundWorker ? Promise.resolve(null) : getChildProcessMod(),
    fsOps ? Promise.resolve(fsOps) : getFsMod(),
  ]);
  const fsMod = fsOps || fsModActual;
  const isDefaultRunner = !runSpawn;
  const syncRunner = runSpawn || defaultRunSpawnSyncFactory(cpMod);
  const wslMode = isWslEnvironment({ platform, env });
  const resolvedPaths = resolvePosixAccountStoragePaths({ platform, env, homeDir });
  const paths = {
    ...resolvedPaths,
    ...(request.vault ? { vault: request.vault, lockFile: `${request.vault}.lock` } : {}),
    ...(request.statusFile !== undefined ? { statusFile: request.statusFile } : {}),
    ...(Array.isArray(request.fallbacks) ? { fallbacks: request.fallbacks } : {}),
  };

  const keyring = createPosixKeyringAdapter({
    platform,
    env,
    wslMode,
    runSpawn: syncRunner,
    useGlobalCache: isDefaultRunner && env === process.env,
    forcePassphraseOnly: platform === 'linux' && degradedPassphraseOnlyVaults.has(paths.vault),
    onDegradePassphraseOnly: () => markVaultDegradedPassphraseOnly(paths.vault),
  });
  const cap = keyring.probe();
  if (!cap.supported) {
    return { error: 'unsupported' };
  }

  function readOptionalSwitchState() {
    const existsFn = fsMod?.existsSync || existsSync;
    const lstatFn = fsMod?.lstatSync || lstatSync;
    const readFn = fsMod?.readFileSync || readFileSync;
    if (paths.statusFile && assertSafeAccountFile(paths.statusFile, { existsFn, lstatFn })) {
      try {
        return JSON.parse(String(readFn(paths.statusFile, 'utf8') || ''));
      } catch {
        // Ignore malformed status file
      }
    }
    return undefined;
  }

  function buildPublicSummary(vault) {
    const liveCap = keyring.probe();
    const quotas = {};
    for (const item of vault.entries) {
      if (item?.email && item.quota) quotas[item.email] = item.quota;
    }
    const vaultSecured = Boolean(vault.security?.enabled);
    const switchState = readOptionalSwitchState();
    return {
      accounts: vault.entries.map((e) => e?.email).filter(Boolean),
      selectedEmail: vault.selectedEmail || '',
      quotas,
      backend: liveCap.backend,
      keyringAvailable: liveCap.keyringAvailable,
      ...(liveCap.requiresPassphrase && !vaultSecured ? { passphraseRequired: true } : {}),
      ...(vaultSecured
        ? { security: { enabled: true, salt: String(vault.security.salt || '') } }
        : {}),
      ...(switchState ? { switchState } : {}),
    };
  }

  return withPosixVaultLock(paths.lockFile, fsMod, async () => {
    try {
      const vault = readRawPosixVault(paths.vault, fsMod);
      const vaultSecured = Boolean(vault.security?.enabled);
      const entry = vault.entries.find((e) => e?.email === request.email);

      if (request.expectedCredential !== undefined && request.expectedCredential !== null) {
        if (!entry) return { error: 'credentialChanged' };
        const curUnwrapped = unwrapMasterEntryIfNeeded(
          entry.credential,
          entry.email,
          keyring,
          paths.vault
        );
        if (curUnwrapped !== request.expectedCredential) {
          return { error: 'credentialChanged' };
        }
      }

      switch (request.action) {
        case 'list': {
          return buildPublicSummary(vault);
        }

        case 'readCurrent': {
          return readPosixActiveHostCredential(keyring, keyring.probe(), paths, fsMod, request.email);
        }

        case 'read': {
          if (!entry) return { error: 'notFound' };
          const unwrapped = unwrapMasterEntryIfNeeded(
            entry.credential,
            entry.email,
            keyring,
            paths.vault
          );
          const liveCap = keyring.probe();
          const switchState = readOptionalSwitchState();
          return {
            credential: unwrapped,
            backend: liveCap.backend,
            keyringAvailable: liveCap.keyringAvailable,
            ...(vaultSecured
              ? { security: { enabled: true, salt: String(vault.security.salt || '') } }
              : {}),
            ...(switchState ? { switchState } : {}),
          };
        }

        case 'readVault': {
          const unwrappedEntries = vault.entries.map((e) => ({
            ...e,
            credential: unwrapMasterEntryIfNeeded(e.credential, e.email, keyring, paths.vault),
          }));
          const liveCap = keyring.probe();
          const switchState = readOptionalSwitchState();
          return {
            entries: unwrappedEntries,
            selectedEmail: vault.selectedEmail || '',
            security: vault.security || null,
            backend: liveCap.backend,
            keyringAvailable: liveCap.keyringAvailable,
            ...(liveCap.requiresPassphrase && !vaultSecured ? { passphraseRequired: true } : {}),
            ...(switchState ? { switchState } : {}),
          };
        }

        case 'writeVault': {
          const nextEntriesRaw = Array.isArray(request.entries) ? request.entries : [];
          const nextSec =
            request.security && typeof request.security === 'object' ? request.security : null;
          const nextSecEnabled = Boolean(nextSec?.enabled);
          if (!keyring.probe().keyringAvailable && nextEntriesRaw.length > 0 && !nextSecEnabled) {
            return { error: 'keyringUnavailable' };
          }
          if (nextEntriesRaw.length === 0 && !nextSecEnabled) {
            evictCachedPosixMasterKey(paths.vault);
          }
          const hasExistingMasterEntries = vault.entries.some((e) =>
            isMasterEncryptedVaultCredential(e?.credential)
          );
          const writeKeyMemo = { keyBuf: null };
          let sealedEntries;
          try {
            sealedEntries = nextEntriesRaw.map((e) => ({
              ...e,
              credential: wrapEntryForDisk(e.credential, e.email, keyring, paths.vault, nextSecEnabled, {
                writeKeyMemo,
                canRestoreExistingKey: hasExistingMasterEntries,
              }),
            }));
          } finally {
            writeKeyMemo.keyBuf?.fill(0);
          }
          const nextVault = {
            entries: sealedEntries,
            selectedEmail: String(request.selectedEmail || ''),
            security: nextSecEnabled ? nextSec : null,
          };
          saveRawPosixVault(paths.vault, nextVault, fsMod);
          if (request.clearStatus && paths.statusFile) {
            const existsFn = fsMod?.existsSync || existsSync;
            const unlinkFn = fsMod?.unlinkSync || unlinkSync;
            try {
              if (existsFn(paths.statusFile)) unlinkFn(paths.statusFile);
            } catch {
              // Ignore status file cleanup error
            }
          }
          return buildPublicSummary(nextVault);
        }

        case 'save': {
          if (
            vaultSecured &&
            (!request.vaultUnlocked || request.expectedSecuritySalt !== String(vault.security.salt))
          ) {
            return { error: 'vaultLocked' };
          }
          const hasExistingMasterEntries = vault.entries.some(
            (e) => e?.email !== request.email && isMasterEncryptedVaultCredential(e?.credential)
          );
          const diskCred = wrapEntryForDisk(
            request.credential,
            request.email,
            keyring,
            paths.vault,
            vaultSecured,
            { canRestoreExistingKey: hasExistingMasterEntries }
          );
          if (entry) {
            entry.credential = diskCred;
          } else {
            vault.entries.push({ email: request.email, credential: diskCred });
          }
          saveRawPosixVault(paths.vault, vault, fsMod);
          return buildPublicSummary(vault);
        }

        case 'saveQuota': {
          if (!entry) return { error: 'notFound' };
          entry.quota = request.quota;
          saveRawPosixVault(paths.vault, vault, fsMod);
          return buildPublicSummary(vault);
        }

        case 'remove': {
          if (
            vaultSecured &&
            (!request.vaultUnlocked || request.expectedSecuritySalt !== String(vault.security.salt))
          ) {
            return { error: 'vaultLocked' };
          }
          if (!entry) return { error: 'notFound' };
          vault.entries = vault.entries.filter((e) => e?.email !== request.email);
          if (vault.selectedEmail === request.email) vault.selectedEmail = '';
          saveRawPosixVault(paths.vault, vault, fsMod);
          if (paths.statusFile) {
            const existsFn = fsMod?.existsSync || existsSync;
            const readFn = fsMod?.readFileSync || readFileSync;
            const unlinkFn = fsMod?.unlinkSync || unlinkSync;
            try {
              if (existsFn(paths.statusFile)) {
                const st = JSON.parse(String(readFn(paths.statusFile, 'utf8') || '{}'));
                if (st?.email === request.email && st?.state !== 'starting') {
                  unlinkFn(paths.statusFile);
                }
              }
            } catch {
              // Ignore status cleanup error
            }
          }
          return buildPublicSummary(vault);
        }

        case 'switch': {
          const liveCap = keyring.probe();
          const switched = performPosixCredentialSwitchWrite({
            request,
            keyring,
            cap: liveCap,
            paths,
            fsMod,
          });
          if (switched.error) return { error: switched.error };
          const wslWinAppData =
            liveCap.backend === 'wsl-wincred' ? resolveWslWindowsAppDataPosix(syncRunner, env) : '';
          const storageCandidates = resolveAntigravityAppStorageCandidates({
            platform,
            env,
            homeDir,
            wslMode,
            wslWindowsAppDataPosix: wslWinAppData,
          });
          syncAntigravityOnboardingStorage(request.email, {
            candidates: storageCandidates,
            fsOps: fsMod,
          });
          if (paths.statusFile) {
            writeSwitchStatusFile(paths.statusFile, request.email, 'written', '', fsMod);
          }
          return buildPublicSummary(switched.vault);
        }

        case 'scheduleSwitch': {
          if (
            vaultSecured &&
            (!request.vaultUnlocked || request.expectedSecuritySalt !== String(vault.security.salt))
          ) {
            return { error: 'vaultLocked' };
          }
          if (!entry) return { error: 'notFound' };
          if (Buffer.byteLength(String(request.credential || ''), 'utf8') > 2560) {
            return { error: 'credentialTooLarge' };
          }
          const existsFn = fsMod?.existsSync || existsSync;
          const lstatFn = fsMod?.lstatSync || lstatSync;
          const readFn = fsMod?.readFileSync || readFileSync;
          if (paths.statusFile && assertSafeAccountFile(paths.statusFile, { existsFn, lstatFn })) {
            try {
              const prevStatus = JSON.parse(String(readFn(paths.statusFile, 'utf8') || '{}'));
              if (
                prevStatus?.state === 'starting' &&
                Date.now() - Number(prevStatus?.updatedAt || 0) < 120_000
              ) {
                return { error: 'busy' };
              }
            } catch {
              // Overwrite unreadable status file
            }
          }

          writeSwitchStatusFile(paths.statusFile, request.email, 'starting', '', fsMod);

          const workerJob = {
            email: request.email,
            credential: request.credential,
            vaultCredential: request.vaultCredential,
            expectedCredential: request.expectedCredential,
            vaultUnlocked: Boolean(request.vaultUnlocked),
            expectedSecuritySalt: String(request.expectedSecuritySalt || ''),
            vault: paths.vault,
            statusFile: paths.statusFile,
            fallbacks: paths.fallbacks,
            platform,
            homeDir,
          };

          try {
            if (typeof spawnBackgroundWorker === 'function') {
              await spawnBackgroundWorker(workerJob);
            } else {
              const spawnFn = cpMod?.spawn || cpMod?.default?.spawn;
              if (typeof spawnFn !== 'function') throw new Error('switchStartFailed');
              const workerScript = join(HERE, 'backend', 'account-switch-posix-worker.mjs');
              const nodeBin = resolveExternalPosixNodeBinary({
                execPath: process.execPath,
                env,
                existsFn,
              });
              const workerEnv = {
                ...env,
                ...(nodeBin.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
              };
              const child = spawnFn(nodeBin.command, [workerScript], {
                detached: true,
                stdio: ['pipe', 'ignore', 'ignore'],
                cwd: homeDir,
                env: workerEnv,
              });
              await new Promise((resolve, reject) => {
                let settled = false;
                const done = (err) => {
                  if (settled) return;
                  settled = true;
                  if (err) reject(err);
                  else resolve();
                };
                child.once('error', done);
                child.stdin.once('error', done);
                child.stdin.end(JSON.stringify(workerJob), 'utf8', () => done(null));
              });
              child.unref?.();
            }
          } catch {
            writeSwitchStatusFile(
              paths.statusFile,
              request.email,
              'failed',
              'switchStartFailed',
              fsMod
            );
            return { error: 'switchStartFailed' };
          }

          return {
            ...buildPublicSummary(vault),
            selectedEmail: request.email,
            scheduled: true,
          };
        }

        default:
          return { error: 'storeFailed' };
      }
    } catch (err) {
      return { error: normalizeStoreErrorCode(err?.message) };
    }
  });
}
