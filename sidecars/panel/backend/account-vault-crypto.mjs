/**
 * @fileoverview Inner envelope encryption (scrypt + AES-256-GCM) for saved account
 * credentials, in-memory session unlock lifecycle, unlock rate-limiting, and
 * HMAC action nonces against local CSRF / blind mutation requests.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

export const VAULT_CIPHER_PREFIX = 'agv1:';
const VAULT_VERIFIER_CHALLENGE = 'ag-vault-v1:ok';
const VAULT_VERIFIER_AAD = 'ag-vault-verifier:v1';
const VAULT_ENTRY_AAD_PREFIX = 'ag-vault-entry:v1:';

const VAULT_SCRYPT_N = 16384;
const VAULT_SCRYPT_R = 8;
const VAULT_SCRYPT_P = 1;
const VAULT_KEY_LEN = 32;
const VAULT_SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const VAULT_PASSWORD_MIN_LEN = 4;
export const VAULT_PASSWORD_MAX_LEN = 128;

const ACTION_NONCE_SECRET = randomBytes(32);
const ACTION_NONCE_BUCKET_MS = 10 * 60 * 1000;

let activeVaultKeyState = null;
let unlockFailureCount = 0;
let unlockCooldownUntilMs = 0;

export function normalizeVaultPassword(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length < VAULT_PASSWORD_MIN_LEN || raw.length > VAULT_PASSWORD_MAX_LEN) return null;
  if (!raw.trim()) return null;
  return raw;
}

export function isEncryptedVaultCredential(raw) {
  return typeof raw === 'string' && raw.startsWith(VAULT_CIPHER_PREFIX);
}

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n >= 1024 && n <= 65536 && (n & (n - 1)) === 0;
}

function deriveVaultKey(password, saltBuf, params = {}) {
  const N = isPowerOfTwo(params.N) ? params.N : VAULT_SCRYPT_N;
  const r = Number.isInteger(params.r) && params.r >= 1 && params.r <= 16 ? params.r : VAULT_SCRYPT_R;
  const p = Number.isInteger(params.p) && params.p >= 1 && params.p <= 8 ? params.p : VAULT_SCRYPT_P;
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      saltBuf,
      VAULT_KEY_LEN,
      { N, r, p, maxmem: VAULT_SCRYPT_MAXMEM },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });
}

function aeadSeal(plaintextUtf8, keyBuf, aadUtf8) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  cipher.setAAD(Buffer.from(aadUtf8, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintextUtf8, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function aeadOpen(b64Payload, keyBuf, aadUtf8) {
  const raw = Buffer.from(String(b64Payload || ''), 'base64');
  if (raw.length < 28) {
    throw new Error('vaultDecryptFailed');
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aadUtf8, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export async function createVaultSecurityMetadata(password) {
  const validPassword = normalizeVaultPassword(password);
  if (!validPassword) {
    throw new Error('invalidPassword');
  }
  const saltBuf = randomBytes(16);
  const salt = saltBuf.toString('base64');
  const keyBuf = await deriveVaultKey(validPassword, saltBuf);
  const verifier = aeadSeal(VAULT_VERIFIER_CHALLENGE, keyBuf, VAULT_VERIFIER_AAD);
  return {
    security: {
      enabled: true,
      version: 1,
      kdf: 'scrypt',
      salt,
      N: VAULT_SCRYPT_N,
      r: VAULT_SCRYPT_R,
      p: VAULT_SCRYPT_P,
      verifier,
    },
    keyBuf,
  };
}

export async function verifyVaultPassword(password, security) {
  if (!security?.enabled || typeof security.salt !== 'string' || typeof security.verifier !== 'string') {
    throw new Error('storeFailed');
  }
  const validPassword = normalizeVaultPassword(password);
  if (!validPassword) {
    throw new Error('wrongPassword');
  }
  const saltBuf = Buffer.from(security.salt, 'base64');
  if (saltBuf.length < 16) {
    throw new Error('storeFailed');
  }
  const keyBuf = await deriveVaultKey(validPassword, saltBuf, security);
  try {
    const opened = aeadOpen(security.verifier, keyBuf, VAULT_VERIFIER_AAD);
    if (opened !== VAULT_VERIFIER_CHALLENGE) {
      keyBuf.fill(0);
      throw new Error('wrongPassword');
    }
    return keyBuf;
  } catch {
    keyBuf.fill(0);
    throw new Error('wrongPassword');
  }
}

export function encryptVaultEntryCredential(plainJson, keyBuf, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !Buffer.isBuffer(keyBuf) || keyBuf.length !== VAULT_KEY_LEN) {
    throw new Error('storeFailed');
  }
  return `${VAULT_CIPHER_PREFIX}${aeadSeal(plainJson, keyBuf, `${VAULT_ENTRY_AAD_PREFIX}${normalizedEmail}`)}`;
}

export function decryptVaultEntryCredential(storedText, keyBuf, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!isEncryptedVaultCredential(storedText) || !normalizedEmail) {
    throw new Error('vaultDecryptFailed');
  }
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== VAULT_KEY_LEN) {
    throw new Error('vaultLocked');
  }
  const payload = storedText.slice(VAULT_CIPHER_PREFIX.length);
  try {
    return aeadOpen(payload, keyBuf, `${VAULT_ENTRY_AAD_PREFIX}${normalizedEmail}`);
  } catch {
    throw new Error('vaultDecryptFailed');
  }
}

export function setUnlockedVaultSessionKey(salt, keyBuf) {
  if (!salt || !Buffer.isBuffer(keyBuf) || keyBuf.length !== VAULT_KEY_LEN) {
    throw new Error('storeFailed');
  }
  const nextCopy = Buffer.from(keyBuf);
  if (activeVaultKeyState?.keyBuf) {
    activeVaultKeyState.keyBuf.fill(0);
  }
  activeVaultKeyState = { salt: String(salt), keyBuf: nextCopy };
}

export function lockVaultSession() {
  if (activeVaultKeyState?.keyBuf) {
    activeVaultKeyState.keyBuf.fill(0);
  }
  activeVaultKeyState = null;
}

export function getUnlockedVaultSessionKey(expectedSalt = '') {
  if (!activeVaultKeyState?.keyBuf) return null;
  if (expectedSalt && activeVaultKeyState.salt !== String(expectedSalt)) {
    lockVaultSession();
    return null;
  }
  return activeVaultKeyState.keyBuf;
}

export function isVaultSessionUnlocked(security) {
  if (!security?.enabled) return true;
  return Boolean(getUnlockedVaultSessionKey(security.salt));
}

export function checkVaultUnlockCooldown(nowMs = Date.now()) {
  if (unlockCooldownUntilMs <= nowMs) return 0;
  return Math.max(1, Math.ceil((unlockCooldownUntilMs - nowMs) / 1000));
}

export function recordVaultUnlockFailure(nowMs = Date.now()) {
  unlockFailureCount += 1;
  if (unlockFailureCount >= 5) {
    const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(4, unlockFailureCount - 5));
    unlockCooldownUntilMs = nowMs + delayMs;
  }
  return checkVaultUnlockCooldown(nowMs);
}

export function resetVaultUnlockFailures() {
  unlockFailureCount = 0;
  unlockCooldownUntilMs = 0;
}

function computeBucketNonceMac(bucket) {
  return createHmac('sha256', ACTION_NONCE_SECRET)
    .update(`ag-acct-nonce:${bucket}`)
    .digest('base64url')
    .slice(0, 32);
}

export function issueAccountActionNonce(nowMs = Date.now()) {
  const bucket = Math.floor(nowMs / ACTION_NONCE_BUCKET_MS).toString(36);
  return `${bucket}.${computeBucketNonceMac(bucket)}`;
}

export function verifyAccountActionNonce(token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 96) return false;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return false;
  const bucketStr = token.slice(0, dotIdx);
  const macStr = token.slice(dotIdx + 1);
  const bucketNum = Number.parseInt(bucketStr, 36);
  if (!Number.isSafeInteger(bucketNum) || bucketNum <= 0) return false;
  const curBucket = Math.floor(nowMs / ACTION_NONCE_BUCKET_MS);
  if (Math.abs(curBucket - bucketNum) > 1) return false;
  const expectedMac = computeBucketNonceMac(bucketNum.toString(36));
  const a = Buffer.from(macStr, 'utf8');
  const b = Buffer.from(expectedMac, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
