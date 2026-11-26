import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clearPosixKeyringRuntimeCaches,
  extractHostCredentialEmail,
  runPosixCredentialStore,
} from '../backend/account-keyring-store.mjs';
import {
  classifyLinuxProcCandidate,
  inspectAndStopDarwinClients,
} from '../backend/account-switch-posix-worker.mjs';
import {
  createAccountLoginController,
  openGoogleAccountBrowser,
} from '../backend/account-login.mjs';
import {
  buildGoogleAccountLoginUrl,
  collectNativeOAuthBinaryCandidates,
  extractNativeOAuthClients,
  loadNativeOAuthClients,
  resolveGoogleCredential,
  retrieveCredentialQuota,
} from '../backend/account-oauth.mjs';
import {
  clearAccountVaultRuntimeState,
  handleAccountCredentialAction,
  normalizeAccountCredential,
  runWindowsCredentialStore,
  serializeVaultCredential,
} from '../backend/account-switch.mjs';
import {
  decryptVaultEntryCredential,
  issueAccountActionNonce,
  resetVaultUnlockFailures,
  verifyAccountActionNonce,
} from '../backend/account-vault-crypto.mjs';
import {
  createAccountQuotaHistoryTracker,
  sanitizeQuotaHistoryPoints,
} from '../backend/account-quota-history.mjs';
import { executeAccountCredentialAction } from '../backend/api-actions.mjs';
import {
  buildQuotaWindowSeries,
  resolveQuotaWindowBounds,
} from '../src/components/widgets/AccountQuotaTrendCard.js';

test('accepts a shared OAuth credential or refresh token, and rejects other credential types', () => {
  const refreshToken = '1//synthetic-refresh-token-for-test';
  assert.deepEqual(JSON.parse(normalizeAccountCredential(refreshToken)), {
    auth_method: 'consumer',
    token: { access_token: '', token_type: 'Bearer', refresh_token: refreshToken, expiry: '1970-01-01T00:00:00.000Z' },
  });
  const saved = JSON.parse(normalizeAccountCredential(JSON.stringify({
    token: { refresh_token: refreshToken, access_token: 'example-access', expiry_timestamp: 1800000000 },
  })));
  assert.equal(saved.token.access_token, 'example-access');
  assert.equal(saved.token.expiry, '2027-01-15T08:00:00.000Z');
  assert.equal(normalizeAccountCredential(JSON.stringify({ auth_method: 'enterprise', refresh_token: refreshToken })), null);
  assert.equal(normalizeAccountCredential('example-api-key'), null);
});

test('import uses the verified email and switches only after checking the credential identity', async () => {
  const calls = [];
  const input = '1//synthetic-refresh-token-for-test';
  const credential = JSON.parse(normalizeAccountCredential(input));
  const saved = JSON.stringify(credential);
  let verifiedEmail = 'Next@example.com';
  const options = {
    platform: 'win32',
    resolveCredential: async (_credential, opts) => {
      calls.push(opts.refresh ? 'refresh-identity' : 'verify-identity');
      return { email: verifiedEmail, credential };
    },
    rpc: async (method) => {
      calls.push(method);
      return { userStatus: { email: 'Next@example.com' } };
    },
    store: async (request) => {
      calls.push(request.action);
      if (request.action === 'read') return { credential: saved };
      assert.equal(request.target, 'gemini:antigravity');
      assert.equal(request.email, 'next@example.com');
      if (request.action === 'scheduleSwitch') assert.equal(request.expectedCredential, saved);
      return { accounts: ['next@example.com'], selectedEmail: request.email, credential: saved, scheduled: request.action === 'scheduleSwitch' };
    },
  };
  assert.deepEqual(await handleAccountCredentialAction({ action: 'save', email: 'ignored@example.com', credential: input }, options), {
    supported: true, accounts: ['next@example.com'], selectedEmail: 'next@example.com', quotas: {},
  });
  assert.deepEqual(calls.splice(0), ['refresh-identity', 'save']);
  const result = await handleAccountCredentialAction({ action: 'switch', email: 'NEXT@example.com' }, options);
  assert.deepEqual(result, { supported: true, accounts: ['next@example.com'], selectedEmail: 'next@example.com', quotas: {}, restarting: true });
  assert.deepEqual(calls.splice(0), ['read', 'verify-identity', 'scheduleSwitch']);
  verifiedEmail = 'different@example.com';
  assert.deepEqual(await handleAccountCredentialAction({ action: 'switch', email: 'next@example.com' }, options), { error: 'identityMismatch' });
  assert.deepEqual(calls, ['read', 'verify-identity']);
});

test('a saved credential can query its quota without replacing the active login', async () => {
  const credential = normalizeAccountCredential(JSON.stringify({ refresh_token: 'test', access_token: 'saved-access' }));
  const pools = [{ poolKey: 'Gemini', remainingPct: 0, weeklyRemainingPct: 29 }];
  const result = await handleAccountCredentialAction({ action: 'quota', email: 'next@example.com' }, {
    platform: 'win32',
    store: async (request) => {
      assert.ok(['read', 'saveQuota'].includes(request.action));
      return { credential };
    },
    resolveCredential: async (stored) => ({ email: 'next@example.com', credential: stored }),
    getQuota: async (token) => {
      assert.equal(token, 'saved-access');
      return pools;
    },
  });
  assert.deepEqual({ email: result.email, pools: result.pools }, { email: 'next@example.com', pools });
  assert.ok(result.fetchedAt > 0);
});

test('Google OAuth confirms the email and the same account token retrieves quota pools', async () => {
  const endpoints = [];
  const refreshToken = 'first-refresh';
  const token = { access_token: 'new-access', refresh_token: 'latest-refresh', expires_in: 3600 };
  const fetchFn = async (url, request) => {
    endpoints.push(url);
    assert.equal(request.redirect, 'error');
    if (url.endsWith('/token')) {
      assert.equal(request.body.get('refresh_token'), refreshToken);
      return { ok: true, json: async () => token };
    }
    assert.equal(request.headers.Authorization, 'Bearer new-access');
    if (url.endsWith('/userinfo')) return { ok: true, json: async () => ({ email: 'owner@example.com', verified_email: true }) };
    assert.match(request.headers['User-Agent'], /^antigravity\/hub\//);
    if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: { id: 'test-project' } }) };
    assert.equal(JSON.parse(request.body).project, 'test-project');
    if (url.endsWith(':fetchAvailableModels')) return { ok: true, json: async () => ({ models: {} }) };
    assert.match(url, /:retrieveUserQuotaSummary$/);
    return { ok: true, json: async () => ({ response: { quotaSummary: { groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0 }, { window: 'weekly', remainingFraction: 0.29 }] },
    ] } } }) };
  };
  const resolved = await resolveGoogleCredential({ token: { refresh_token: refreshToken } }, {
    fetchFn, getClients: async () => [{ id: 'desktop-client', secret: 'test-config' }],
  });
  assert.equal(resolved.email, 'owner@example.com');
  assert.equal(resolved.credential.token.refresh_token, token.refresh_token);
  const pools = await retrieveCredentialQuota(resolved.credential.token.access_token, fetchFn);
  assert.deepEqual(pools.map(({ poolKey, remainingPct, weeklyRemainingPct }) => [poolKey, remainingPct, weeklyRemainingPct]), [['Gemini', 0, 29]]);
  assert.equal(endpoints.length, 5);
});

test('quota queries keep the native header and omit project when Google did not return one', async () => {
  const requests = [];
  const pools = await retrieveCredentialQuota('native-access', async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ url, body });
    assert.match(request.headers['User-Agent'], /^antigravity\/hub\//);
    if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ allowedTiers: [] }) };
    assert.deepEqual(body, {});
    if (url.endsWith(':fetchAvailableModels')) return { ok: true, json: async () => ({ models: {} }) };
    return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.42 }] }] }) };
  });
  assert.equal(pools[0].weeklyRemainingPct, 42);
  assert.equal(requests.length, 3);
});

test('a forbidden project is retried without that project before another endpoint', async () => {
  let retried = 0;
  const pools = await retrieveCredentialQuota('native-access', async (url, request) => {
    const body = JSON.parse(request.body);
    if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: 'stale-project' }) };
    if (body.project) return { ok: false, status: 403 };
    retried += 1;
    if (url.endsWith(':fetchAvailableModels')) return { ok: true, json: async () => ({ models: {} }) };
    return { ok: true, json: async () => ({ groups: [{ displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 0 }] }] }) };
  });
  assert.equal(retried, 2);
  assert.equal(pools[0].remainingPct, 0);
});

test('Windows vault atomically saves, reloads and removes encrypted entries', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.account-test-', import.meta.url)));
  const vault = join(directory, 'test.dpapi');
  const run = (action, email, credential) => runWindowsCredentialStore({ action, email, credential, vault });
  try {
    const credential = normalizeAccountCredential('1//synthetic-refresh-token-for-test');
    assert.deepEqual(await run('list'), { accounts: [], selectedEmail: '', quotas: {} });
    assert.deepEqual(await run('save', 'active@example.com', credential), { accounts: ['active@example.com'], selectedEmail: '', quotas: {} });
    assert.deepEqual(await run('save', 'next@example.com', credential), { accounts: ['active@example.com', 'next@example.com'], selectedEmail: '', quotas: {} });
    assert.deepEqual(await run('read', 'next@example.com'), { credential });
    assert.deepEqual(await runWindowsCredentialStore({ action: 'save', email: 'next@example.com', credential, expectedCredential: 'stale', vault }), { error: 'credentialChanged' });
    assert.equal((await readFile(vault)).includes('synthetic-refresh-token-for-test'), false);
    assert.deepEqual(await run('list'), { accounts: ['active@example.com', 'next@example.com'], selectedEmail: '', quotas: {} });
    const quota = { fetchedAt: 100, pools: [{ poolKey: 'Gemini', remainingPct: 0, weeklyRemainingPct: 70 }] };
    await runWindowsCredentialStore({ action: 'saveQuota', email: 'active@example.com', expectedCredential: credential, quota, vault });
    assert.deepEqual((await run('list')).quotas, { 'active@example.com': quota });
    assert.deepEqual(await run('remove', 'next@example.com'), { accounts: ['active@example.com'], selectedEmail: '', quotas: { 'active@example.com': quota } });
  } finally {
    await unlink(vault).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    await rmdir(directory);
  }
});

test('browser authorization adds a credential through the normal account actions and encrypted vault', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.account-login-test-', import.meta.url)));
  const vault = join(directory, 'test.dpapi');
  const credential = JSON.parse(normalizeAccountCredential('1//synthetic-browser-authorized-credential'));
  const login = createAccountLoginController({
    getClients: async () => [
      { id: '1234567890-synthetic-test.apps.googleusercontent.com', secret: 'synthetic-test-secret' },
    ],
    openBrowser: async () => true,
    exchangeCode: async () => ({ email: 'browser@example.com', credential }),
  });
  const options = { platform: 'win32', login, store: (request) => runWindowsCredentialStore({ ...request, vault, statusFile: '' }) };
  let id;
  try {
    const result = await handleAccountCredentialAction({ action: 'loginStart', language: 'zh-CN' }, options);
    assert.equal(result.supported, true);
    assert.equal(result.login.status, 'waiting');
    id = result.login.id;
    const authorization = new URL(result.login.url);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-code' }).toString();
    assert.equal((await fetch(callback)).status, 200);
    assert.equal((await handleAccountCredentialAction({ action: 'loginStatus', id }, options)).login.status, 'success');
    const accounts = await handleAccountCredentialAction({ action: 'list' }, options);
    assert.deepEqual(accounts.accounts, ['browser@example.com']);
    assert.equal(accounts.selectedEmail, '');
    assert.equal(JSON.stringify(accounts).includes('synthetic-browser-authorized-credential'), false);
    assert.equal((await readFile(vault)).includes('synthetic-browser-authorized-credential'), false);
  } finally {
    if (id) login.cancel(id);
    await unlink(vault).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});

test('login scope includes auth/aicode, switch auto-backs-up unsaved active login with 2.34 signout guard, and quota extracts tierName', async () => {
  const loginUrl = new URL(
    await buildGoogleAccountLoginUrl('http://127.0.0.1:9999/oauth-callback', 'st', 'ch', {
      getClients: async () => [
        { id: '1234567890-synthetic-test.apps.googleusercontent.com', secret: 'synthetic-test-secret' },
      ],
    })
  );
  const scopes = (loginUrl.searchParams.get('scope') || '').split(/\s+/);
  assert.ok(scopes.includes('https://www.googleapis.com/auth/aicode'));

  const savedEntries = new Map([
    ['target@example.com', normalizeAccountCredential('1//target-refresh-token-value-1234567890')],
  ]);
  const liveCurrent = normalizeAccountCredential('1//active-host-refresh-token-value-1234567890');
  let scheduledPayload = null;

  const res = await handleAccountCredentialAction(
    { action: 'switch', email: 'target@example.com', activeEmail: 'current@example.com' },
    {
      platform: 'win32',
      resolveCredential: async (cred) => ({
        email: cred.token.refresh_token.includes('active-host')
          ? 'current@example.com'
          : 'target@example.com',
        credential: cred,
      }),
      store: async (req) => {
        if (req.action === 'read') {
          const hit = savedEntries.get(req.email);
          return hit ? { credential: hit } : { error: 'notFound' };
        }
        if (req.action === 'readCurrent') {
          return { credential: liveCurrent };
        }
        if (req.action === 'save') {
          savedEntries.set(req.email, req.credential);
          return { accounts: [...savedEntries.keys()], selectedEmail: '' };
        }
        if (req.action === 'scheduleSwitch') {
          scheduledPayload = JSON.parse(req.credential);
          return {
            scheduled: true,
            accounts: [...savedEntries.keys()],
            selectedEmail: req.email,
          };
        }
        return { error: 'storeFailed' };
      },
    }
  );

  assert.equal(res.restarting, true);
  assert.ok(savedEntries.has('current@example.com'), 'Active host account must be auto-backed-up before switching away');
  assert.ok(
    Number.isSafeInteger(scheduledPayload?.aicode_scope_sign_out_attempted_at) &&
      scheduledPayload.aicode_scope_sign_out_attempted_at > 0,
    'Switched host credential must include 2.34 aicode_scope_sign_out_attempted_at guard'
  );

  const pools = await retrieveCredentialQuota('tok', async (url) => {
    if (url.endsWith(':loadCodeAssist')) {
      return {
        ok: true,
        json: async () => ({
          paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
          cloudaicompanionProject: 'p1',
        }),
      };
    }
    if (url.endsWith(':fetchAvailableModels')) {
      return { ok: true, json: async () => ({ models: {} }) };
    }
    return {
      ok: true,
      json: async () => ({
        groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.85 }] }],
      }),
    };
  });
  assert.equal(pools.tierName, 'Google AI Ultra');
  assert.equal(pools.tierInfo.tierMultiplier, '20x');
  assert.equal(pools[0].weeklyRemainingPct, 85);

  const litePools = await retrieveCredentialQuota('tok-5x', async (url) => {
    if (url.endsWith(':loadCodeAssist')) {
      return {
        ok: true,
        json: async () => ({
          paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
          cloudaicompanionProject: 'p2',
        }),
      };
    }
    if (url.endsWith(':fetchAvailableModels')) {
      return { ok: true, json: async () => ({ models: {} }) };
    }
    return {
      ok: true,
      json: async () => ({
        groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.91 }] }],
      }),
    };
  });
  assert.deepEqual(litePools.tierInfo, {
    tierId: 'g1-ultra-lite-tier',
    tierName: 'Google AI Ultra',
    tierMultiplier: '5x',
  });
});

test('enforces OAuth client_id allowlist, minimizes at-rest vault payload, and validates actionNonce on mutations', async () => {
  const rt = '1//synthetic-refresh-token-for-allowlist-check';
  assert.equal(
    normalizeAccountCredential(
      JSON.stringify({ client_id: 'evil-third-party.apps.googleusercontent.com', refresh_token: rt })
    ),
    null,
    'Must reject unknown third-party OAuth client_id'
  );
  assert.equal(
    normalizeAccountCredential(
      JSON.stringify({ type: 'service_account', refresh_token: rt })
    ),
    null,
    'Must reject non-user OAuth credential types'
  );
  const syntheticOfficialId = '1234567890-synthetic-test.apps.googleusercontent.com';
  const validWithOfficialClient = normalizeAccountCredential(
    JSON.stringify({
      client_id: syntheticOfficialId,
      client_secret: 'should-be-stripped',
      access_token: 'ephemeral-access-token',
      id_token: 'ephemeral-id-token',
      refresh_token: rt,
    }),
    { allowedClientIds: [syntheticOfficialId] }
  );
  assert.ok(validWithOfficialClient, 'Allowlisted Antigravity OAuth client_id must be accepted');
  assert.equal(validWithOfficialClient.includes('should-be-stripped'), false);

  // Verify PE .text/.rdata native OAuth client extraction & multi-path candidate discovery
  const fakeId = '9876543210-unit-test-client.apps.googleusercontent.com';
  const fakeSecret = 'GOCSPX-unit-test';
  const peBuf = Buffer.alloc(1024);
  peBuf.writeUInt16LE(0x5a4d, 0);
  peBuf.writeUInt32LE(0x80, 60);
  peBuf.writeUInt32LE(0x4550, 0x80);
  peBuf.writeUInt16LE(0x8664, 0x84);
  peBuf.writeUInt16LE(2, 0x86);
  peBuf.writeUInt16LE(0, 0x94);
  const secTable = 0x80 + 24;
  peBuf.write('.text', secTable, 'ascii');
  peBuf.writeUInt32LE(0x1000, secTable + 12);
  peBuf.writeUInt32LE(0x100, secTable + 16);
  peBuf.writeUInt32LE(0x200, secTable + 20);
  peBuf.write('.rdata', secTable + 40, 'ascii');
  peBuf.writeUInt32LE(0x2000, secTable + 52);
  peBuf.writeUInt32LE(0x100, secTable + 56);
  peBuf.writeUInt32LE(0x300, secTable + 60);
  peBuf.write(fakeId + fakeSecret + 'trailing-go-str', 0x300, 'ascii');
  const codeStart = 0x200;
  Buffer.from([0x48, 0xc7, 0x40, 0x08]).copy(peBuf, codeStart);
  peBuf.writeUInt32LE(fakeId.length, codeStart + 4);
  Buffer.from([0x48, 0x8d, 0x0d]).copy(peBuf, codeStart + 8);
  peBuf.writeInt32LE(0x2000 - (0x1000 + 11 + 4), codeStart + 11);
  Buffer.from([0x48, 0x89, 0x08, 0x48, 0xc7, 0x40, 0x18]).copy(peBuf, codeStart + 15);
  peBuf.writeUInt32LE(fakeSecret.length, codeStart + 22);
  Buffer.from([0x48, 0x8d, 0x0d]).copy(peBuf, codeStart + 26);
  peBuf.writeInt32LE(0x2000 + fakeId.length - (0x1000 + 29 + 4), codeStart + 29);
  assert.deepEqual(extractNativeOAuthClients(peBuf), [{ id: fakeId, secret: fakeSecret }]);

  const discoveredCands = collectNativeOAuthBinaryCandidates({
    platform: 'win32',
    env: {
      USAGE_MONITOR_HOST_EXE: 'D:\\Custom\\Antigravity\\Antigravity.exe',
      ANTIGRAVITY_GEMINI_DIR: 'D:\\CustomGemini',
    },
    homeDir: 'C:\\Users\\Test',
    existsFn: null,
  });
  assert.ok(discoveredCands.some((p) => /D:\\Custom\\Antigravity\\resources\\bin\\language_server\.exe$/i.test(p)));
  assert.ok(discoveredCands.some((p) => /D:\\CustomGemini\\bin\\agy\.exe$/i.test(p)));

  const minStored = serializeVaultCredential(JSON.parse(validWithOfficialClient));
  assert.equal(minStored.includes('ephemeral-access-token'), false);
  assert.equal(minStored.includes('ephemeral-id-token'), false);
  assert.deepEqual(JSON.parse(minStored), {
    token: { refresh_token: rt, token_type: 'Bearer' },
    auth_method: 'consumer',
  });

  const nonce = issueAccountActionNonce(1_700_000_000_000);
  assert.equal(verifyAccountActionNonce(nonce, 1_700_000_000_000), true);
  assert.equal(verifyAccountActionNonce(`${nonce}x`, 1_700_000_000_000), false);
  assert.equal(verifyAccountActionNonce(nonce, 1_700_000_000_000 + 45 * 60_000), false);

  // Default risk gate blocks mutations until accepted, and list returns riskLocked without vault access
  const riskBlockedRes = await executeAccountCredentialAction({
    action: 'remove',
    email: 'a@example.com',
  });
  assert.equal(JSON.parse(riskBlockedRes.body).error, 'riskNotAccepted');

  const riskLockedList = JSON.parse((await executeAccountCredentialAction(undefined)).body);
  assert.equal(riskLockedList.riskLocked, true);
  assert.deepEqual(riskLockedList.accounts, []);

  // Once risk check passes, mutations still require a valid HMAC actionNonce
  const missingNonceRes = await executeAccountCredentialAction(
    { action: 'remove', email: 'a@example.com' },
    { bypassRiskCheck: true }
  );
  const missingBody = JSON.parse(missingNonceRes.body);
  assert.equal(missingBody.error, 'invalidActionNonce');
  assert.equal(typeof missingBody.actionNonce, 'string');

  // Quota history tracker compresses flat heartbeats while preserving real dips and QR seeds
  let persistedHistory = null;
  const histTracker = createAccountQuotaHistoryTracker({
    loadState: () => null,
    saveState: (p) => {
      persistedHistory = p;
    },
    loadSeedEvents: () => ({
      events: [
        { ts: '2026-11-24T08:00:00.000Z', pool: 'Gemini', win: '5h', usedPct: 4.0 },
        { ts: '2026-11-24T09:00:00.000Z', pool: 'Gemini', win: '5h', usedPct: 10.4 },
      ],
    }),
  });
  const baseTs = Date.parse('2026-11-24T10:00:00.000Z');
  histTracker.recordSnapshot(
    'owner@example.com',
    [
      { poolKey: 'Gemini', remainingPct: 89.6, weeklyRemainingPct: 89.4 },
      { poolKey: 'Claude & GPT', remainingPct: 100, weeklyRemainingPct: 100 },
    ],
    baseTs,
    { isActiveHost: true }
  );
  histTracker.recordSnapshot(
    'owner@example.com',
    [{ poolKey: 'Claude & GPT', remainingPct: 100, weeklyRemainingPct: 100 }],
    baseTs + 20 * 60_000
  );
  histTracker.recordSnapshot(
    'owner@example.com',
    [{ poolKey: 'Claude & GPT', remainingPct: 100, weeklyRemainingPct: 100 }],
    baseTs + 40 * 60_000
  );
  histTracker.flush(baseTs + 40 * 60_000);
  const payload = histTracker.getHistoryPayload({ allowedEmails: ['owner@example.com'] });
  assert.equal(
    payload['owner@example.com'].pools['Claude & GPT'].points.length,
    2,
    'Collinear flat heartbeats must compress in-place to start + latest endpoints'
  );
  assert.equal(payload['owner@example.com'].pools.Gemini.points[0][1], 96);
  assert.equal(payload['owner@example.com'].pools.Gemini.points.at(-1)[1], 89.6);
  assert.ok(persistedHistory?.accounts?.['owner@example.com']);
});

test('secondary passphrase encrypts credentials with scrypt + AES-256-GCM, preserves cached list while locked, throttles brute force, and rotates/resets cleanly', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.account-sec-test-', import.meta.url)));
  const vault = join(directory, 'sec-test.dpapi');
  t.after(async () => {
    clearAccountVaultRuntimeState();
    await unlink(vault).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await rmdir(directory);
  });

  clearAccountVaultRuntimeState();
  const options = {
    platform: 'win32',
    resolveCredential: async (cred) => {
      const rt = cred.token.refresh_token;
      const email = rt.includes('alpha') ? 'alpha@example.com' : 'beta@example.com';
      return {
        email,
        credential: {
          token: {
            access_token: `live-access-for-${email}`,
            refresh_token: rt,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
          id_token: 'live-jwt-id-token',
        },
      };
    },
    getQuota: async () => [{ poolKey: 'Gemini', remainingPct: 88, weeklyRemainingPct: 92 }],
    store: (req) => {
      if (req.action === 'scheduleSwitch') {
        // Verify host receives live access_token while vault receives encrypted agv1: ciphertext
        assert.equal(req.credential.includes('live-access-for-'), true);
        assert.equal(String(req.vaultCredential || '').startsWith('agv1:'), true);
        return Promise.resolve({
          scheduled: true,
          accounts: ['alpha@example.com', 'beta@example.com'],
          selectedEmail: req.email,
          security: { enabled: true, salt: req.expectedSecuritySalt },
        });
      }
      return runWindowsCredentialStore({ ...req, vault, statusFile: '' });
    },
  };

  await handleAccountCredentialAction(
    { action: 'save', credential: '1//alpha-refresh-token-1234567890123456' },
    options
  );
  await handleAccountCredentialAction(
    { action: 'save', credential: '1//beta-refresh-token-1234567890123456' },
    options
  );
  await handleAccountCredentialAction({ action: 'quota', email: 'alpha@example.com' }, options);

  // Set secondary passphrase -> encrypts all saved entries inside DPAPI vault
  const setRes = await handleAccountCredentialAction(
    { action: 'setPassword', newPassword: 'correct-horse-battery' },
    options
  );
  assert.deepEqual(setRes.security, { enabled: true, unlocked: true });

  const rawVaultAfterSet = await runWindowsCredentialStore({ action: 'readVault', vault });
  assert.equal(rawVaultAfterSet.entries.length, 2);
  for (const entry of rawVaultAfterSet.entries) {
    assert.equal(entry.credential.startsWith('agv1:'), true);
    assert.equal(entry.credential.includes('refresh-token'), false);
    assert.equal(entry.credential.includes('live-access'), false);
  }
  // AAD binds ciphertext to email: swapping ciphertext onto another email must fail decryption
  assert.throws(
    () =>
      decryptVaultEntryCredential(
        rawVaultAfterSet.entries[0].credential,
        Buffer.alloc(32, 1),
        'beta@example.com'
      ),
    /vaultDecryptFailed/
  );

  // Lock session -> emails & cached quotas remain readable, all mutations/decryptions blocked
  const lockedList = await handleAccountCredentialAction({ action: 'lockVault' }, options);
  assert.deepEqual(lockedList.security, { enabled: true, unlocked: false });
  assert.deepEqual(lockedList.accounts, ['alpha@example.com', 'beta@example.com']);
  assert.equal(lockedList.quotas['alpha@example.com'].pools[0].remainingPct, 88);

  for (const blockedAction of [
    { action: 'switch', email: 'alpha@example.com' },
    { action: 'remove', email: 'beta@example.com' },
    { action: 'quota', email: 'alpha@example.com' },
    { action: 'save', credential: '1//alpha-refresh-token-1234567890123456' },
    { action: 'loginStart', language: 'zh-CN' },
  ]) {
    const blocked = await handleAccountCredentialAction(blockedAction, options);
    assert.equal(blocked.error, 'vaultLocked', `Action ${blockedAction.action} must reject while locked`);
  }

  // Wrong passphrase -> wrongPassword, then rate-limited on 5th consecutive failure
  for (let i = 0; i < 4; i++) {
    const bad = await handleAccountCredentialAction(
      { action: 'unlockVault', password: `wrong-pass-${i}` },
      options
    );
    assert.equal(bad.error, 'wrongPassword');
  }
  const throttled = await handleAccountCredentialAction(
    { action: 'unlockVault', password: 'wrong-pass-5' },
    options
  );
  assert.equal(throttled.error, 'passwordRateLimited');
  assert.ok(throttled.retryAfterSec >= 1);

  resetVaultUnlockFailures();
  const unlockedRes = await handleAccountCredentialAction(
    { action: 'unlockVault', password: 'correct-horse-battery' },
    options
  );
  assert.deepEqual(unlockedRes.security, { enabled: true, unlocked: true });

  // Switch while unlocked keeps vault entry encrypted
  const switched = await handleAccountCredentialAction(
    { action: 'switch', email: 'alpha@example.com' },
    options
  );
  assert.equal(switched.restarting, true);

  // Change passphrase -> old password rejected, new password works
  const changed = await handleAccountCredentialAction(
    {
      action: 'changePassword',
      currentPassword: 'correct-horse-battery',
      newPassword: 'new-passphrase-9876',
    },
    options
  );
  assert.deepEqual(changed.security, { enabled: true, unlocked: true });
  await handleAccountCredentialAction({ action: 'lockVault' }, options);
  assert.equal(
    (await handleAccountCredentialAction({ action: 'unlockVault', password: 'correct-horse-battery' }, options)).error,
    'wrongPassword'
  );
  assert.deepEqual(
    (await handleAccountCredentialAction({ action: 'unlockVault', password: 'new-passphrase-9876' }, options)).security,
    { enabled: true, unlocked: true }
  );

  // Disable passphrase requires valid current password
  assert.equal(
    (await handleAccountCredentialAction({ action: 'disablePassword', currentPassword: 'wrong-current' }, options)).error,
    'wrongPassword'
  );
  const disabled = await handleAccountCredentialAction(
    { action: 'disablePassword', currentPassword: 'new-passphrase-9876', includeSecurity: true },
    options
  );
  assert.deepEqual(disabled.security, { enabled: false, unlocked: true });
  const rawAfterDisable = await runWindowsCredentialStore({ action: 'readVault', vault });
  assert.equal(rawAfterDisable.entries[0].credential.startsWith('agv1:'), false);
  assert.equal(rawAfterDisable.entries[0].credential.includes('live-access'), false);

  // Reset vault clears entries only when confirmReset === 'RESET'
  assert.equal(
    (await handleAccountCredentialAction({ action: 'resetVault' }, options)).error,
    'invalidCredential'
  );
  const resetRes = await handleAccountCredentialAction(
    { action: 'resetVault', confirmReset: 'RESET' },
    options
  );
  assert.deepEqual(resetRes.accounts, []);
});

test('cycle quota chart strips pre-reset tail points and cross-account impulse spikes', () => {
  const cycleStartMs = 1795518262000; // 20:04:22
  const reset5hMs = cycleStartMs + 5 * 3600_000; // 01:04:22
  const nowMs = cycleStartMs + 3.5 * 3600_000;

  // Unused 100% pool appears first with rolling reset (now + 5h), active Gemini pool second
  const pools = [
    {
      poolKey: 'Argon',
      label: 'Argon',
      reset5hMs: nowMs + 5 * 3600_000 - 15_000,
      resetWeeklyMs: nowMs + 7 * 86400_000,
      live5h: 100,
      liveWk: 100,
      points: [[nowMs, 100, 100]],
    },
    {
      poolKey: 'Gemini',
      label: 'Gemini',
      reset5hMs,
      resetWeeklyMs: nowMs + 6 * 86400_000,
      live5h: 88.2,
      liveWk: 89.2,
      points: [
        [cycleStartMs - 47_000, 84.5, 92.4], // 20:03:35 pre-reset old cycle point
        [cycleStartMs + 3_582, 100, 92.4], // 20:04:25 fresh cycle reset
        [cycleStartMs + 58 * 60_000, 94.8, 90.6], // 21:02:00
        [cycleStartMs + 61 * 60_000, 100, 100], // 21:05:19 isolated cross-account init spike
        [cycleStartMs + 63 * 60_000, 94.7, 90.6], // 21:07:33 back to real slope
        [nowMs, 88.2, 89.2],
      ],
    },
  ];

  const bounds = resolveQuotaWindowBounds({
    pools,
    selectedRange: 'cycle',
    selectedWin: '5h',
    selectedPool: 'all',
    nowMs,
  });
  assert.equal(bounds.startMs, cycleStartMs, 'Active consumed pool must anchor cycle start');

  const built = buildQuotaWindowSeries({
    visiblePools: pools,
    rawBounds: bounds,
    selectedRange: 'cycle',
    selectedWin: '5h',
    nowMs,
  });
  const geminiSeries = built.rawBuilt.find((s) => s.poolKey === 'Gemini');
  assert.ok(geminiSeries);
  assert.equal(
    geminiSeries.rawPoints[0].val,
    100,
    'Cycle start must begin at 100% without carrying 84.5% from the expired cycle'
  );
  for (let i = 1; i < geminiSeries.rawPoints.length; i++) {
    const jump = geminiSeries.rawPoints[i].val - geminiSeries.rawPoints[i - 1].val;
    assert.ok(jump < 1, `Unexpected upward spike inside cycle series: +${jump}`);
  }

  // Even when a stale pre-reset poll lands slightly inside cycleStartMs due to clock jitter,
  // cycle mode must slice after the reset jump instead of drawing an upward vertical wall.
  const jitterBuilt = buildQuotaWindowSeries({
    visiblePools: [
      {
        poolKey: 'Gemini',
        label: 'Gemini',
        reset5hMs,
        resetWeeklyMs: 0,
        live5h: 95,
        liveWk: null,
        points: [
          [cycleStartMs + 2_000, 84.5, 92.4],
          [cycleStartMs + 15_000, 100, 92.4],
          [nowMs, 95, 91.8],
        ],
      },
    ],
    rawBounds: bounds,
    selectedRange: 'cycle',
    selectedWin: '5h',
    nowMs,
  });
  assert.equal(jitterBuilt.rawBuilt[0].rawPoints[0].val, 100);

  // Backend history sanitizer removes isolated cross-account impulse spikes while keeping real resets
  const persistedPts = [
    [cycleStartMs - 60_000, 84.5, 92.4],
    [cycleStartMs + 3_000, 100, 92.4],
    [cycleStartMs + 58 * 60_000, 94.8, 90.6],
    [cycleStartMs + 61 * 60_000, 100, 100],
    [cycleStartMs + 63 * 60_000, 94.7, 90.6],
  ];
  assert.equal(sanitizeQuotaHistoryPoints(persistedPts), true);
  assert.equal(persistedPts.length, 4);
  assert.equal(persistedPts[1][1], 100, 'Genuine 5h reset stays intact for multi-cycle views');
  assert.equal(
    persistedPts.some((p) => p[0] === cycleStartMs + 61 * 60_000),
    false,
    'Isolated cross-account [100, 100] spike is removed'
  );
});

test('macOS Keychain store seals vault with agmk1 master key, avoids argv secret leaks, guards drift, and syncs app_storage.json', async (t) => {
  const dir = await mkdtemp(fileURLToPath(new URL('../.account-mac-test-', import.meta.url)));
  t.after(async () => {
    clearAccountVaultRuntimeState();
    await rm(dir, { recursive: true, force: true });
  });

  const keychain = new Map();
  const spawnCalls = [];
  const runSpawn = (cmd, args, opts = {}) => {
    spawnCalls.push({ cmd, args });
    assert.equal(cmd, '/usr/bin/security');
    // Ensure no token or hex payload is ever passed on command-line arguments
    assert.equal(args.join(' ').includes('1//'), false);
    assert.equal(args.includes('-X'), false);
    if (args[0] === 'find-generic-password') {
      const k = `${args[2]}:${args[4]}`;
      if (!keychain.has(k)) return { status: 44, stdout: '', stderr: 'could not be found' };
      return { status: 0, stdout: `${keychain.get(k)}\n`, stderr: '' };
    }
    if (args[0] === '-i') {
      const m = String(opts.input || '').match(
        /^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)\n$/i
      );
      assert.ok(m, 'Interactive security stdin command must use hex encoding');
      keychain.set(`${m[1]}:${m[2]}`, Buffer.from(m[3], 'hex').toString('utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      keychain.delete(`${args[2]}:${args[4]}`);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  const appStorageDir = join(dir, 'Library', 'Application Support', 'Antigravity');
  await mkdir(appStorageDir, { recursive: true });
  const appStoragePath = join(appStorageDir, 'app_storage.json');
  await writeFile(
    appStoragePath,
    JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'old@example.com' }),
    'utf8'
  );
  const tokenFallbackPath = join(dir, '.gemini', 'jetski-standalone-oauth-token');
  await mkdir(join(dir, '.gemini'), { recursive: true });

  const vaultPath = join(dir, 'vault', 'accounts.vault.json');
  const statusFile = join(dir, 'vault', 'switch-state.json');
  let workerJob = null;

  const store = (req) =>
    runPosixCredentialStore(
      { ...req, vault: vaultPath, statusFile, fallbacks: [tokenFallbackPath] },
      {
        platform: 'darwin',
        homeDir: dir,
        env: {},
        runSpawn,
        spawnBackgroundWorker: async (job) => {
          workerJob = job;
        },
      }
    );

  const options = {
    platform: 'darwin',
    store,
    rpc: async () => ({ userStatus: { email: 'active@example.com' } }),
    resolveCredential: async (cred) => {
      const rt = cred.token.refresh_token;
      const email = rt.includes('mac-next') ? 'mac-next@example.com' : 'active@example.com';
      return {
        email,
        credential: {
          token: {
            access_token: `access-${email}`,
            refresh_token: rt,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
          id_token_email: email,
        },
      };
    },
  };

  // List on empty macOS vault spawns zero security subprocesses
  const initialList = await handleAccountCredentialAction({ action: 'list' }, options);
  assert.equal(initialList.supported, true);
  assert.equal(initialList.backend, 'darwin-keychain');
  assert.equal(spawnCalls.length, 0);

  // Save encrypts entry with agmk1: master key stored in macOS Keychain
  const saveRes = await handleAccountCredentialAction(
    { action: 'save', credential: '1//mac-next-refresh-token-1234567890' },
    options
  );
  assert.deepEqual(saveRes.accounts, ['mac-next@example.com']);
  const rawDiskVault = await readFile(vaultPath, 'utf8');
  assert.equal(rawDiskVault.includes('mac-next-refresh-token'), false);
  assert.match(rawDiskVault, /"agmk1:/);
  assert.ok(keychain.has('antigravity-usage-monitor:vault-master-key'));

  // Capture blocks credential/UI drift immediately before network refresh when keyring holds wrong email
  keychain.set(
    'gemini:antigravity',
    JSON.stringify({
      token: { refresh_token: '1//drifted-other-account-token-1234567890', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'drifted@example.com',
    })
  );
  const driftCapture = await handleAccountCredentialAction({ action: 'capture' }, options);
  assert.equal(driftCapture.error, 'identityMismatch');

  // Offline-resilient switch falls back cleanly on transient oauthUnavailable, then worker commit writes Keychain + app_storage.json
  const offlineSwitch = await handleAccountCredentialAction(
    { action: 'switch', email: 'mac-next@example.com' },
    {
      ...options,
      resolveCredential: async () => {
        throw new Error('oauthUnavailable');
      },
    }
  );
  assert.equal(offlineSwitch.restarting, true);
  assert.ok(workerJob);

  const workerCommit = await runPosixCredentialStore(
    { ...workerJob, action: 'switch' },
    { platform: 'darwin', homeDir: dir, env: {}, runSpawn }
  );
  assert.equal(workerCommit.selectedEmail, 'mac-next@example.com');
  assert.equal(extractHostCredentialEmail(keychain.get('gemini:antigravity')), 'mac-next@example.com');
  const updatedStorage = JSON.parse(await readFile(appStoragePath, 'utf8'));
  assert.equal(updatedStorage['agy.onboarding.lastLoginUsername'], 'mac-next@example.com');
});

test('Linux without secret-tool enforces passphraseRequired fallback, while WSL2 bridges master key to Windows Credential Manager', async (t) => {
  const dir = await mkdtemp(fileURLToPath(new URL('../.account-linux-test-', import.meta.url)));
  t.after(async () => {
    clearAccountVaultRuntimeState();
    await rm(dir, { recursive: true, force: true });
  });

  // 1. Headless / no-keyring Linux (`secret-tool` ENOENT)
  const vaultNoKeyring = join(dir, 'headless', 'accounts.vault.json');
  const tokenFile = join(dir, 'headless', 'jetski-standalone-oauth-token');
  const headlessStore = (req) =>
    runPosixCredentialStore(
      { ...req, vault: vaultNoKeyring, statusFile: '', fallbacks: [tokenFile] },
      {
        platform: 'linux',
        homeDir: dir,
        env: {},
        runSpawn: () => ({ status: 1, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
      }
    );
  const headlessOpts = {
    platform: 'linux',
    store: headlessStore,
    resolveCredential: async (cred) => ({
      email: 'linux@example.com',
      credential: {
        token: {
          access_token: 'linux-access',
          refresh_token: cred.token.refresh_token,
          token_type: 'Bearer',
          expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
        auth_method: 'consumer',
      },
    }),
  };

  const headlessList = await handleAccountCredentialAction({ action: 'list' }, headlessOpts);
  assert.equal(headlessList.supported, true);
  assert.equal(headlessList.keyringAvailable, false);
  assert.equal(headlessList.passphraseRequired, true);

  // Saving without passphrase must reject with passphraseRequired and never write vault file
  const blockedSave = await handleAccountCredentialAction(
    { action: 'save', credential: '1//linux-headless-token-12345678901234' },
    headlessOpts
  );
  assert.equal(blockedSave.error, 'passphraseRequired');

  // Setting passphrase unlocks encrypted local storage (`agv1:`) without OS keyring
  const setPwd = await handleAccountCredentialAction(
    { action: 'setPassword', newPassword: 'linux-strong-passphrase' },
    headlessOpts
  );
  assert.equal(setPwd.security?.enabled, true);
  assert.equal(setPwd.passphraseRequired, undefined);

  const savedLinux = await handleAccountCredentialAction(
    { action: 'save', credential: '1//linux-headless-token-12345678901234' },
    headlessOpts
  );
  assert.deepEqual(savedLinux.accounts, ['linux@example.com']);
  const rawHeadlessVault = await readFile(vaultNoKeyring, 'utf8');
  assert.equal(rawHeadlessVault.includes('linux-headless-token'), false);
  assert.match(rawHeadlessVault, /"agv1:/);

  // Disabling passphrase while OS keyring is unavailable must reject with keyringUnavailable
  const disableAttempt = await handleAccountCredentialAction(
    { action: 'disablePassword', currentPassword: 'linux-strong-passphrase' },
    headlessOpts
  );
  assert.equal(disableAttempt.error, 'keyringUnavailable');

  // 2. WSL2 (`wsl-wincred`) bridges master key to Windows CredMan and writes active token to ~/.gemini/jetski-standalone-oauth-token
  clearAccountVaultRuntimeState();
  const winCred = new Map();
  const wslTokenFile = join(dir, 'wsl-home', '.gemini', 'jetski-standalone-oauth-token');
  const wslVault = join(dir, 'wsl-home', '.local', 'share', 'AntigravityUsageMonitor', 'accounts.vault.json');
  const winAppStorageDir = join(dir, 'mnt-c-appdata', 'Antigravity');
  await mkdir(winAppStorageDir, { recursive: true });
  await writeFile(
    join(winAppStorageDir, 'app_storage.json'),
    JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'before@example.com' }),
    'utf8'
  );

  const wslRunSpawn = (cmd, args, opts = {}) => {
    if (cmd === 'cmd.exe') {
      return { status: 0, stdout: 'C:\\Users\\Alice\\AppData\\Roaming\r\n', stderr: '' };
    }
    if (cmd === 'wslpath') {
      return { status: 0, stdout: `${join(dir, 'mnt-c-appdata')}\n`, stderr: '' };
    }
    assert.equal(cmd, 'powershell.exe');
    assert.match(String(opts.env?.WSLENV || ''), /UM_CRED_OP/);
    const op = opts.env.UM_CRED_OP;
    const target = opts.env.UM_CRED_TARGET;
    if (op === 'probe') return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    if (op === 'read') {
      if (!winCred.has(target)) return { status: 0, stdout: '{"ok":true,"exists":false,"data":""}\n', stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, exists: true, data: Buffer.from(winCred.get(target), 'utf8').toString('base64') }),
        stderr: '',
      };
    }
    if (op === 'write') {
      winCred.set(target, Buffer.from(String(opts.input || '').trim(), 'base64').toString('utf8'));
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };

  let wslJob = null;
  const wslEnv = { WSL_DISTRO_NAME: 'Ubuntu-24.04' };
  const wslStore = (req) =>
    runPosixCredentialStore(
      { ...req, vault: wslVault, statusFile: '', fallbacks: [wslTokenFile] },
      {
        platform: 'linux',
        homeDir: join(dir, 'wsl-home'),
        env: wslEnv,
        runSpawn: wslRunSpawn,
        spawnBackgroundWorker: async (job) => {
          wslJob = job;
        },
      }
    );

  const wslSaved = await handleAccountCredentialAction(
    { action: 'save', credential: '1//wsl-account-token-123456789012345' },
    {
      platform: 'linux',
      store: wslStore,
      resolveCredential: async (cred) => ({
        email: 'wsl@example.com',
        credential: {
          token: {
            access_token: 'wsl-access',
            refresh_token: cred.token.refresh_token,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
        },
      }),
    }
  );
  assert.equal(wslSaved.backend, 'wsl-wincred');
  assert.ok(winCred.has('AntigravityUsageMonitor:wsl:Ubuntu-24.04:master-key'));

  await handleAccountCredentialAction(
    { action: 'switch', email: 'wsl@example.com' },
    {
      platform: 'linux',
      store: wslStore,
      resolveCredential: async (cred) => ({ email: 'wsl@example.com', credential: cred }),
    }
  );
  assert.ok(wslJob);
  await runPosixCredentialStore(
    { ...wslJob, action: 'switch' },
    { platform: 'linux', homeDir: join(dir, 'wsl-home'), env: wslEnv, runSpawn: wslRunSpawn }
  );
  assert.equal(extractHostCredentialEmail(await readFile(wslTokenFile, 'utf8')), 'wsl@example.com');
  const wslSyncedStorage = JSON.parse(
    await readFile(join(winAppStorageDir, 'app_storage.json'), 'utf8')
  );
  assert.equal(wslSyncedStorage['agy.onboarding.lastLoginUsername'], 'wsl@example.com');
});

test('extracts OAuth clients from packed ELF64 and Universal Fat Mach-O 64 binaries and opens browsers cross-platform', async () => {
  const fakeId = '109876543210-linux-elf-client.apps.googleusercontent.com';
  // 35-char standard Google desktop secret packed back-to-back with next Go string without \0
  const fakeSecret35 = 'GOCSPX-AbCdEfGhIjKlMnOpQrStUvWx1234';
  const packedGoRodata = Buffer.from(
    `leadingLiteral${fakeSecret35}nextPackedGoStringWithoutNulls...${fakeId}trailingGoString`,
    'ascii'
  );

  // 1. Synthetic 64-bit ELF (`.shstrtab` + `.rodata`)
  const shstr = Buffer.from('\0.shstrtab\0.rodata\0', 'ascii');
  const rodataOff = 256;
  const shstrOff = rodataOff + packedGoRodata.length;
  const shoff = shstrOff + shstr.length;
  const elfBuf = Buffer.alloc(shoff + 3 * 64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elfBuf, 0);
  elfBuf.writeUInt32LE(shoff, 40);
  elfBuf.writeUInt16LE(64, 58); // e_shentsize
  elfBuf.writeUInt16LE(3, 60); // e_shnum
  elfBuf.writeUInt16LE(1, 62); // e_shstrndx
  packedGoRodata.copy(elfBuf, rodataOff);
  shstr.copy(elfBuf, shstrOff);
  // Section 1: .shstrtab (nameOff=1, sh_type=3)
  elfBuf.writeUInt32LE(1, shoff + 64 + 0);
  elfBuf.writeUInt32LE(3, shoff + 64 + 4);
  elfBuf.writeUInt32LE(shstrOff, shoff + 64 + 24);
  elfBuf.writeUInt32LE(shstr.length, shoff + 64 + 32);
  // Section 2: .rodata (nameOff=11, sh_type=1 SHT_PROGBITS)
  elfBuf.writeUInt32LE(11, shoff + 128 + 0);
  elfBuf.writeUInt32LE(1, shoff + 128 + 4);
  elfBuf.writeUInt32LE(rodataOff, shoff + 128 + 24);
  elfBuf.writeUInt32LE(packedGoRodata.length, shoff + 128 + 32);

  assert.deepEqual(extractNativeOAuthClients(elfBuf), [{ id: fakeId, secret: fakeSecret35 }]);

  // 2. Synthetic Universal Fat Binary (`0xcafebabe`) wrapping Mach-O 64 (`0xfeedfacf` arm64 `__TEXT,__rodata`)
  const sliceOff = 64;
  const cmdSize = 72 + 80; // LC_SEGMENT_64 + 1 section_64
  const machDataOff = 32 + cmdSize + 16;
  const sliceSize = machDataOff + packedGoRodata.length;
  const fatBuf = Buffer.alloc(sliceOff + sliceSize);
  fatBuf.writeUInt32BE(0xcafebabe, 0);
  fatBuf.writeUInt32BE(1, 4); // nfat_arch = 1
  fatBuf.writeUInt32BE(sliceOff, 16); // fat_arch[0].offset
  fatBuf.writeUInt32BE(sliceSize, 20); // fat_arch[0].size
  // mach_header_64 at sliceOff
  fatBuf.writeUInt32LE(0xfeedfacf, sliceOff + 0);
  fatBuf.writeUInt32LE(1, sliceOff + 16); // ncmds = 1
  fatBuf.writeUInt32LE(cmdSize, sliceOff + 20); // sizeofcmds
  // LC_SEGMENT_64 at sliceOff + 32
  const segPos = sliceOff + 32;
  fatBuf.writeUInt32LE(0x19, segPos + 0); // LC_SEGMENT_64
  fatBuf.writeUInt32LE(cmdSize, segPos + 4);
  fatBuf.write('__TEXT', segPos + 8, 'ascii');
  fatBuf.writeUInt32LE(1, segPos + 64); // nsects = 1
  // section_64 at segPos + 72
  const secPos = segPos + 72;
  fatBuf.write('__rodata', secPos + 0, 'ascii');
  fatBuf.write('__TEXT', secPos + 16, 'ascii');
  fatBuf.writeUInt32LE(packedGoRodata.length, secPos + 40); // size (64-bit lo)
  fatBuf.writeUInt32LE(machDataOff, secPos + 48); // offset relative to slice
  packedGoRodata.copy(fatBuf, sliceOff + machDataOff);

  assert.deepEqual(extractNativeOAuthClients(fatBuf), [{ id: fakeId, secret: fakeSecret35 }]);

  // 3. Cross-platform candidate paths & browser launcher validation
  const macCands = collectNativeOAuthBinaryCandidates({
    platform: 'darwin',
    env: { USAGE_MONITOR_HOST_EXE: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
    homeDir: '/Users/alice',
    existsFn: null,
  });
  assert.ok(macCands.some((p) => p.includes('language_server_macos_arm')));
  const linuxCands = collectNativeOAuthBinaryCandidates({
    platform: 'linux',
    env: {},
    homeDir: '/home/alice',
    existsFn: null,
  });
  assert.ok(linuxCands.some((p) => p.includes('language_server_linux_x64')));

  const browserCalls = [];
  const mockExecFile = (cmd, args, opts, cb) => {
    browserCalls.push({ cmd, args, env: opts?.env });
    cb(null);
  };
  assert.equal(
    await openGoogleAccountBrowser('javascript:alert(1)', { platform: 'darwin', execFileFn: mockExecFile }),
    false,
    'Must reject non-Google OAuth URLs'
  );
  assert.equal(
    await openGoogleAccountBrowser('https://accounts.google.com/o/oauth2/v2/auth?client_id=1', {
      platform: 'darwin',
      execFileFn: mockExecFile,
    }),
    true
  );
  assert.equal(browserCalls.at(-1).cmd, '/usr/bin/open');

  assert.equal(
    await openGoogleAccountBrowser('https://accounts.google.com/o/oauth2/v2/auth?client_id=1', {
      platform: 'linux',
      env: {},
      execFileFn: mockExecFile,
    }),
    false,
    'Headless Linux without DISPLAY/WAYLAND must return false cleanly so manual link is shown'
  );
  assert.equal(
    await openGoogleAccountBrowser('https://accounts.google.com/o/oauth2/v2/auth?client_id=1', {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      execFileFn: mockExecFile,
    }),
    true
  );
  assert.equal(browserCalls.at(-1).cmd, 'xdg-open');
});

test('cross-platform audit regressions: macOS 4095B security -i guard & hex decode, WSL2 host WinCred sync, AppImage /proc isolation, detached worker port cleanup & restart error guard, and 1MB boundary / stripped ELF64 streaming', async (t) => {
  const dir = await mkdtemp(fileURLToPath(new URL('../.account-audit-reg-', import.meta.url)));
  t.after(async () => {
    clearAccountVaultRuntimeState();
    await rm(dir, { recursive: true, force: true });
  });

  // 1. macOS: realistic 4095-byte `security -i` line limit + hex stdout from `find-generic-password -w` + double-envelope (`agmk1:` + `agv1:`)
  {
    clearAccountVaultRuntimeState();
    const keychain = new Map();
    const macSpawn = (cmd, args, opts = {}) => {
      assert.equal(cmd, '/usr/bin/security');
      if (args[0] === 'find-generic-password') {
        const k = `${args[2]}:${args[4]}`;
        if (!keychain.has(k)) return { status: 44, stdout: '', stderr: 'could not be found' };
        const raw = keychain.get(k);
        if (/[\r\n]|[^\x20-\x7e]/.test(raw)) {
          return { status: 0, stdout: `${Buffer.from(raw, 'utf8').toString('hex')}\n`, stderr: '' };
        }
        return { status: 0, stdout: `${raw}\n`, stderr: '' };
      }
      if (args[0] === '-i') {
        const line = String(opts.input || '').replace(/\n$/, '');
        assert.ok(line.length <= 4095, `security -i line exceeded 4095B fgets limit: ${line.length}`);
        const m = line.match(/^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)$/i);
        assert.ok(m);
        keychain.set(`${m[1]}:${m[2]}`, Buffer.from(m[3], 'hex').toString('utf8'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        keychain.delete(`${args[2]}:${args[4]}`);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };

    const macVault = join(dir, 'mac', 'accounts.vault.json');
    const macStatus = join(dir, 'mac', 'switch-state.json');
    const macFb = join(dir, 'mac', 'jetski-standalone-oauth-token');
    let macWorkerJob = null;
    const macStore = (req) =>
      runPosixCredentialStore(
        { ...req, vault: macVault, statusFile: macStatus, fallbacks: [macFb] },
        {
          platform: 'darwin',
          homeDir: join(dir, 'mac'),
          env: {},
          runSpawn: macSpawn,
          spawnBackgroundWorker: async (job) => {
            macWorkerJob = job;
          },
        }
      );

    // Pretty-printed JSON in Keychain triggers hex output on `find-generic-password -w`
    keychain.set(
      'gemini:antigravity',
      JSON.stringify(
        {
          token: { refresh_token: '1//pretty-mac-host-token-1234567890', token_type: 'Bearer' },
          auth_method: 'consumer',
          id_token_email: 'pretty@example.com',
        },
        null,
        2
      )
    );
    const largeJwt = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(1500)}.${'b'.repeat(350)}`;
    const macOpts = {
      platform: 'darwin',
      store: macStore,
      rpc: async () => ({ userStatus: { email: 'pretty@example.com' } }),
      resolveCredential: async (cred) => ({
        email: 'pretty@example.com',
        credential: {
          token: {
            access_token: `ya29.${'x'.repeat(220)}`,
            refresh_token: cred.token.refresh_token,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
          id_token: largeJwt,
        },
      }),
    };

    const captured = await handleAccountCredentialAction({ action: 'capture' }, macOpts);
    assert.deepEqual(captured.accounts, ['pretty@example.com']);

    await handleAccountCredentialAction(
      { action: 'setPassword', newPassword: 'mac-layered-passphrase' },
      macOpts
    );
    const switched = await handleAccountCredentialAction(
      { action: 'switch', email: 'pretty@example.com' },
      macOpts
    );
    assert.equal(switched.restarting, true);
    assert.ok(Buffer.byteLength(macWorkerJob.credential, 'utf8') <= 1900);
    const committed = await runPosixCredentialStore(
      { ...macWorkerJob, action: 'switch' },
      { platform: 'darwin', homeDir: join(dir, 'mac'), env: {}, runSpawn: macSpawn }
    );
    assert.equal(committed.selectedEmail, 'pretty@example.com');
    assert.equal(extractHostCredentialEmail(keychain.get('gemini:antigravity')), 'pretty@example.com');
  }

  // 2. WSL2: `capture` reads Windows CredMan, `switch` updates BOTH WinCred & WSL token file, and `probe()` memoizes per adapter
  {
    clearAccountVaultRuntimeState();
    const wslHome = join(dir, 'wsl2');
    const wslVault = join(wslHome, 'vault', 'accounts.vault.json');
    const wslToken = join(wslHome, '.gemini', 'jetski-standalone-oauth-token');
    const winCred = new Map([
      [
        'gemini:antigravity',
        JSON.stringify({
          token: { refresh_token: '1//win-gui-active-token-123456789012', token_type: 'Bearer' },
          auth_method: 'consumer',
          id_token_email: 'win-gui@example.com',
        }),
      ],
    ]);
    let probeCalls = 0;
    const wslEnv = { WSL_DISTRO_NAME: 'Ubuntu-24.04' };
    const wslSpawn = (cmd, _args, opts = {}) => {
      if (cmd === 'cmd.exe' || cmd === 'wslpath') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'powershell.exe') {
        const op = opts.env?.UM_CRED_OP;
        const target = opts.env?.UM_CRED_TARGET;
        if (op === 'probe') {
          probeCalls += 1;
          return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
        }
        if (op === 'read') {
          if (!winCred.has(target)) return { status: 0, stdout: '{"ok":true,"exists":false,"data":""}\n', stderr: '' };
          return {
            status: 0,
            stdout: JSON.stringify({ ok: true, exists: true, data: Buffer.from(winCred.get(target), 'utf8').toString('base64') }),
            stderr: '',
          };
        }
        if (op === 'write') {
          winCred.set(target, Buffer.from(String(opts.input || '').trim(), 'base64').toString('utf8'));
          return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
        }
        if (op === 'delete') {
          winCred.delete(target);
          return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    };

    let wslJob = null;
    const wslStore = (req) =>
      runPosixCredentialStore(
        { ...req, vault: wslVault, statusFile: '', fallbacks: [wslToken] },
        {
          platform: 'linux',
          homeDir: wslHome,
          env: wslEnv,
          runSpawn: wslSpawn,
          spawnBackgroundWorker: async (job) => {
            wslJob = job;
          },
        }
      );

    const wslOpts = {
      platform: 'linux',
      store: wslStore,
      rpc: async () => ({ userStatus: { email: 'win-gui@example.com' } }),
      resolveCredential: async (cred) => ({
        email: cred.token.refresh_token.includes('win-gui') ? 'win-gui@example.com' : 'wsl-target@example.com',
        credential: {
          token: {
            access_token: 'ya29.wsl',
            refresh_token: cred.token.refresh_token,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
        },
      }),
    };

    const capturedWsl = await handleAccountCredentialAction({ action: 'capture' }, wslOpts);
    assert.deepEqual(capturedWsl.accounts, ['win-gui@example.com']);

    probeCalls = 0;
    await handleAccountCredentialAction(
      { action: 'save', credential: '1//wsl-target-token-123456789012345' },
      wslOpts
    );
    assert.equal(probeCalls, 1, 'Adapter must memoize probe() across internal read/write calls');

    await handleAccountCredentialAction({ action: 'switch', email: 'wsl-target@example.com' }, wslOpts);
    await runPosixCredentialStore(
      { ...wslJob, action: 'switch' },
      { platform: 'linux', homeDir: wslHome, env: wslEnv, runSpawn: wslSpawn }
    );
    assert.equal(extractHostCredentialEmail(winCred.get('gemini:antigravity')), 'wsl-target@example.com');
    assert.equal(extractHostCredentialEmail(await readFile(wslToken, 'utf8')), 'wsl-target@example.com');

    // Unrecognized fs errors during switch rollback must normalize to `'storeFailed'` so UI displays error feedback
    const realFs = await import('node:fs');
    const diskFullRes = await runPosixCredentialStore(
      { ...wslJob, action: 'switch' },
      {
        platform: 'linux',
        homeDir: wslHome,
        env: wslEnv,
        runSpawn: wslSpawn,
        fsOps: {
          ...realFs,
          writeFileSync: (p, data, o) => {
            if (typeof p === 'string' && p.includes('jetski-standalone-oauth-token')) {
              throw new Error('ENOSPC: no space left on device');
            }
            return realFs.writeFileSync(p, data, o);
          },
        },
      }
    );
    assert.equal(diskFullRes.error, 'storeFailed');
  }

  // 3. Linux AppImage `/proc` classification + real detached POSIX worker port cleanup & restart error guard
  {
    assert.equal(
      classifyLinuxProcCandidate({
        exePath: '/usr/bin/bash',
        argv: ['/usr/bin/bash', '-i'],
        rawEnviron: 'APPIMAGE=/home/alice/Antigravity-1.5.6.AppImage\0HOME=/home/alice',
      }),
      null,
      'User shells inheriting APPIMAGE must never be classified as Antigravity clients'
    );
    assert.deepEqual(
      classifyLinuxProcCandidate({
        exePath: '/tmp/.mount_Antigr1234/AppRun',
        argv: ['/tmp/.mount_Antigr1234/AppRun', '--remote-debugging-port=0'],
        rawEnviron: 'APPIMAGE=/home/alice/Antigravity-1.5.6.AppImage',
      }),
      {
        role: 'client-root',
        restartExe: '/home/alice/Antigravity-1.5.6.AppImage',
        useDebugPort: true,
      }
    );
    assert.equal(
      classifyLinuxProcCandidate({
        exePath: '/opt/Antigravity/antigravity',
        argv: ['/opt/Antigravity/antigravity', 'sidecar_sdk/register_loader.js'],
        rawEnviron: 'ELECTRON_RUN_AS_NODE=1',
      })?.role,
      'client-helper'
    );

    clearAccountVaultRuntimeState();
    const wkHome = join(dir, 'worker');
    const wkVault = join(wkHome, 'vault', 'accounts.vault.json');
    const wkStatus = join(wkHome, 'vault', 'switch-state.json');
    const wkToken = join(wkHome, 'jetski-standalone-oauth-token');
    const explicitPortFile = join(wkHome, 'custom-DevToolsActivePort');
    await mkdir(join(wkHome, '.local', 'bin'), { recursive: true });
    await writeFile(explicitPortFile, '9222\n/devtools/browser/1\n', 'utf8');
    // Non-executable stub triggers async spawn error without crashing worker
    await writeFile(join(wkHome, '.local', 'bin', 'antigravity'), 'not-an-elf', 'utf8');

    const wkStore = (req) =>
      runPosixCredentialStore(
        { ...req, vault: wkVault, statusFile: wkStatus, fallbacks: [wkToken] },
        {
          platform: 'linux',
          homeDir: wkHome,
          env: {},
          runSpawn: () => ({ status: 1, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
        }
      );
    await handleAccountCredentialAction(
      { action: 'setPassword', newPassword: 'wk-passphrase' },
      { platform: 'linux', store: wkStore }
    );
    await handleAccountCredentialAction(
      { action: 'save', credential: '1//wk-refresh-token-123456789012345' },
      {
        platform: 'linux',
        store: wkStore,
        resolveCredential: async (cred) => ({
          email: 'wk@example.com',
          credential: {
            token: {
              access_token: 'ya29.wk',
              refresh_token: cred.token.refresh_token,
              token_type: 'Bearer',
              expiry: new Date(Date.now() + 3600_000).toISOString(),
            },
            auth_method: 'consumer',
          },
        }),
      }
    );
    const savedEntry = await wkStore({ action: 'read', email: 'wk@example.com' });
    const workerScript = fileURLToPath(new URL('../backend/account-switch-posix-worker.mjs', import.meta.url));
    const exitCode = await new Promise((resolveExit) => {
      const child = spawn(process.execPath, [workerScript], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          ...process.env,
          HOME: wkHome,
          USERPROFILE: wkHome,
          ANTIGRAVITY_DEVTOOLS_PORT_FILE: explicitPortFile,
          DBUS_SESSION_BUS_ADDRESS: '',
          DISPLAY: '',
          WAYLAND_DISPLAY: '',
        },
      });
      child.on('close', resolveExit);
      child.stdin.end(
        JSON.stringify({
          email: 'wk@example.com',
          credential: JSON.stringify({
            token: { access_token: 'ya29.wk', refresh_token: '1//wk-refresh-token-123456789012345', token_type: 'Bearer', expiry: '2030-01-01T00:00:00.000Z' },
            auth_method: 'consumer',
            id_token_email: 'wk@example.com',
          }),
          vaultCredential: savedEntry.credential,
          expectedCredential: savedEntry.credential,
          vaultUnlocked: true,
          expectedSecuritySalt: savedEntry.security.salt,
          vault: wkVault,
          statusFile: wkStatus,
          fallbacks: [wkToken],
          platform: 'linux',
          homeDir: wkHome,
        }),
        'utf8'
      );
    });
    assert.equal(exitCode, 0);
    assert.equal(existsSync(explicitPortFile), false, 'Stale DevToolsActivePort must be removed');
    const finalStatus = JSON.parse(await readFile(wkStatus, 'utf8'));
    assert.equal(finalStatus.state, 'failed');
    assert.equal(finalStatus.error, 'clientRestartFailed');
  }

  // 4. Streaming >2MB ELF64 across 1MB chunk boundary + section-stripped ELF64 + login callback vaultLocked preservation
  {
    const boundaryId = '554433221100-boundary-stream.apps.googleusercontent.com';
    const boundarySecret35 = 'GOCSPX-BoundarySecretTest1234567890';
    const rodataSize = 1024 * 1024 + 4096;
    const rodataBuf = Buffer.alloc(rodataSize, 0x2e);
    const splitPos = 1024 * 1024 - 17;
    rodataBuf.write(`${boundarySecret35}PackedNextGoLiteral`, splitPos, 'ascii');
    rodataBuf.write(boundaryId, splitPos + 80, 'ascii');

    const shstr = Buffer.from('\0.shstrtab\0.rodata\0', 'ascii');
    const rodataOff = 256;
    const shstrOff = rodataOff + rodataBuf.length;
    const shoff = shstrOff + shstr.length;
    const elfBig = Buffer.alloc(shoff + 3 * 64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elfBig, 0);
    elfBig.writeBigUInt64LE(BigInt(shoff), 40);
    elfBig.writeUInt16LE(64, 58);
    elfBig.writeUInt16LE(3, 60);
    elfBig.writeUInt16LE(1, 62);
    rodataBuf.copy(elfBig, rodataOff);
    shstr.copy(elfBig, shstrOff);
    elfBig.writeUInt32LE(1, shoff + 64);
    elfBig.writeUInt32LE(3, shoff + 64 + 4);
    elfBig.writeBigUInt64LE(BigInt(shstrOff), shoff + 64 + 24);
    elfBig.writeBigUInt64LE(BigInt(shstr.length), shoff + 64 + 32);
    elfBig.writeUInt32LE(11, shoff + 128);
    elfBig.writeUInt32LE(1, shoff + 128 + 4);
    elfBig.writeBigUInt64LE(BigInt(rodataOff), shoff + 128 + 24);
    elfBig.writeBigUInt64LE(BigInt(rodataBuf.length), shoff + 128 + 32);

    const elfBigPath = join(dir, 'language_server_linux_x64');
    await writeFile(elfBigPath, elfBig);
    const streamed = await loadNativeOAuthClients({
      platform: 'linux',
      env: { ANTIGRAVITY_LS_BIN: elfBigPath },
      homeDir: dir,
      discoverRunningFn: async () => [],
    });
    assert.equal(streamed[0]?.id, boundaryId);
    assert.equal(streamed[0]?.secret, boundarySecret35);

    const strippedElf = Buffer.alloc(2048);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(strippedElf, 0);
    strippedElf.write(`${boundaryId}\0${boundarySecret35}\0`, 512, 'ascii');
    const strippedPath = join(dir, 'language_server_stripped');
    await writeFile(strippedPath, strippedElf);
    const strippedClients = await loadNativeOAuthClients({
      platform: 'linux',
      env: { ANTIGRAVITY_LS_BIN: strippedPath },
      homeDir: dir,
      discoverRunningFn: async () => [],
    });
    assert.deepEqual(strippedClients, [{ id: boundaryId, secret: boundarySecret35 }]);

    const loginCtrl = createAccountLoginController({
      getClients: async () => [{ id: boundaryId, secret: boundarySecret35 }],
      openBrowser: async () => true,
      exchangeCode: async () => ({
        email: 'cb@example.com',
        credential: { token: { refresh_token: '1//cb-12345678901234567890' } },
      }),
    });
    const loginSession = await loginCtrl.start(async () => {
      throw new Error('vaultLocked');
    });
    const authUrl = new URL(loginSession.url);
    const cbUrl = new URL(authUrl.searchParams.get('redirect_uri'));
    cbUrl.search = new URLSearchParams({
      state: authUrl.searchParams.get('state'),
      code: 'ok',
    }).toString();
    await fetch(cbUrl);
    assert.equal(loginCtrl.getStatus(loginSession.id)?.error, 'vaultLocked');
  }
});

test('deep cross-platform regressions: 0B lock contention, D-Bus secret-service absence fallback, master-key self-healing, Darwin UID/sidecar filtering, Linux leaf boundaries, Mach-O slice fallback, and unlock state preservation', async (t) => {
  const dir = await mkdtemp(fileURLToPath(new URL('../.account-deep-reg-', import.meta.url)));
  t.after(async () => {
    clearAccountVaultRuntimeState();
    await rm(dir, { recursive: true, force: true });
  });

  // 1. 0-byte mid-write lock file must NEVER be unlinked by a contending process; releases cleanly once holder finishes
  {
    const realFs = await import('node:fs');
    const lockDir = join(dir, 'lock-race');
    await mkdir(lockDir, { recursive: true });
    const vault = join(lockDir, 'accounts.vault.json');
    const lockFile = `${vault}.lock`;
    await writeFile(lockFile, '', { mode: 0o600 });

    let stoleZeroByteLock = false;
    setTimeout(() => {
      try {
        realFs.unlinkSync(lockFile);
      } catch {
        // already removed
      }
    }, 110);

    const res = await runPosixCredentialStore(
      { action: 'list', vault, statusFile: '' },
      {
        platform: 'darwin',
        homeDir: lockDir,
        env: {},
        runSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
        fsOps: {
          ...realFs,
          unlinkSync: (p) => {
            if (p === lockFile && realFs.existsSync(lockFile) && realFs.readFileSync(lockFile, 'utf8') === '') {
              stoleZeroByteLock = true;
            }
            return realFs.unlinkSync(p);
          },
        },
      }
    );
    assert.equal(stoleZeroByteLock, false, 'Contending store call must wait rather than unlinking active 0B lock');
    assert.deepEqual(res.accounts, []);
  }

  // 2. Linux with `secret-tool` binary installed but missing `org.freedesktop.secrets` D-Bus service degrades to passphrase-only & preserves state across unlockVault
  {
    clearAccountVaultRuntimeState();
    const swayDir = join(dir, 'sway');
    await mkdir(swayDir, { recursive: true });
    const vault = join(swayDir, 'accounts.vault.json');
    const statusFile = join(swayDir, 'switch-state.json');
    await writeFile(
      statusFile,
      JSON.stringify({ email: 'prev@example.com', state: 'failed', error: 'clientRestartFailed', updatedAt: Date.now() }),
      'utf8'
    );

    const noDaemonSpawn = (cmd, args) => {
      if (cmd === 'secret-tool' && args[0] === '--version') {
        return { status: 0, stdout: '0.21.4\n', stderr: '' };
      }
      return {
        status: 1,
        stdout: '',
        stderr: 'secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n',
      };
    };
    const store = (req) =>
      runPosixCredentialStore(
        { ...req, vault, statusFile, fallbacks: [join(swayDir, 'tok')] },
        { platform: 'linux', homeDir: swayDir, env: { DISPLAY: ':0' }, runSpawn: noDaemonSpawn }
      );
    const opts = {
      platform: 'linux',
      store,
      resolveCredential: async (c) => ({
        email: 'sway@example.com',
        credential: {
          token: {
            access_token: 'ya29.sway',
            refresh_token: c.token.refresh_token,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
        },
      }),
    };

    const firstSave = await handleAccountCredentialAction(
      { action: 'save', credential: '1//sway-token-123456789012345' },
      opts
    );
    assert.equal(firstSave.error, 'passphraseRequired');

    const setPwd = await handleAccountCredentialAction(
      { action: 'setPassword', newPassword: 'sway-passphrase' },
      opts
    );
    assert.equal(setPwd.security?.enabled, true);

    // Even on empty vault without keyring, disablePassword must reject with keyringUnavailable
    const emptyDisable = await handleAccountCredentialAction(
      { action: 'disablePassword', currentPassword: 'sway-passphrase' },
      opts
    );
    assert.equal(emptyDisable.error, 'keyringUnavailable');

    const saved = await handleAccountCredentialAction(
      { action: 'save', credential: '1//sway-token-123456789012345' },
      opts
    );
    assert.deepEqual(saved.accounts, ['sway@example.com']);
    assert.equal(saved.keyringAvailable, false);
    assert.equal(saved.backend, 'linux-passphrase-only');

    await handleAccountCredentialAction({ action: 'lockVault' }, opts);
    const unlocked = await handleAccountCredentialAction(
      { action: 'unlockVault', password: 'sway-passphrase', includeSecurity: true },
      opts
    );
    assert.equal(unlocked.keyringAvailable, false, 'unlockVault must preserve keyringAvailable=false');
    assert.equal(unlocked.backend, 'linux-passphrase-only');
    assert.equal(unlocked.switchState?.error, 'clientRestartFailed', 'unlockVault must preserve switchState');
  }

  // 3. Master key durability: self-heals deleted OS Keychain item on active vault AND mints fresh key after resetVault
  {
    clearAccountVaultRuntimeState();
    const mkDir = join(dir, 'mk-heal');
    const vault = join(mkDir, 'accounts.vault.json');
    const kc = new Map();
    const macSpawn = (_cmd, args, opts = {}) => {
      if (args[0] === 'find-generic-password') {
        const k = `${args[2]}:${args[4]}`;
        return kc.has(k)
          ? { status: 0, stdout: `${kc.get(k)}\n`, stderr: '' }
          : { status: 44, stdout: '', stderr: 'not found' };
      }
      if (args[0] === '-i') {
        const m = String(opts.input || '').match(/^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)\n$/i);
        kc.set(`${m[1]}:${m[2]}`, Buffer.from(m[3], 'hex').toString('utf8'));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const store = (req) =>
      runPosixCredentialStore(
        { ...req, vault, statusFile: '', fallbacks: [join(mkDir, 'tok')] },
        { platform: 'darwin', homeDir: mkDir, env: {}, runSpawn: macSpawn, spawnBackgroundWorker: async () => {} }
      );
    const makeOpts = (email) => ({
      platform: 'darwin',
      store,
      resolveCredential: async (c) => ({
        email,
        credential: {
          token: {
            access_token: 'ya29.m',
            refresh_token: c.token.refresh_token,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
          auth_method: 'consumer',
        },
      }),
    });

    await handleAccountCredentialAction({ action: 'save', credential: '1//acc1-token-123456789012345' }, makeOpts('acc1@example.com'));
    // Case A: Accidental Keychain deletion while vault still holds acc1 -> saving acc2 re-persists RAM key so BOTH survive restart
    kc.delete('antigravity-usage-monitor:vault-master-key');
    await handleAccountCredentialAction({ action: 'save', credential: '1//acc2-token-123456789012345' }, makeOpts('acc2@example.com'));
    assert.equal(kc.has('antigravity-usage-monitor:vault-master-key'), true);
    clearPosixKeyringRuntimeCaches();
    assert.equal((await store({ action: 'read', email: 'acc1@example.com' })).error, undefined);
    assert.equal((await store({ action: 'read', email: 'acc2@example.com' })).error, undefined);

    // Case B: Keychain deletion + resetVault -> saving acc3 mints fresh master key in Keychain
    kc.delete('antigravity-usage-monitor:vault-master-key');
    await handleAccountCredentialAction({ action: 'resetVault', confirmReset: 'RESET' }, makeOpts('acc3@example.com'));
    await handleAccountCredentialAction({ action: 'save', credential: '1//acc3-token-123456789012345' }, makeOpts('acc3@example.com'));
    assert.equal(kc.has('antigravity-usage-monitor:vault-master-key'), true);
    clearPosixKeyringRuntimeCaches();
    const swAfterReset = await handleAccountCredentialAction(
      { action: 'switch', email: 'acc3@example.com' },
      makeOpts('acc3@example.com')
    );
    assert.equal(swAfterReset.restarting, true);
  }

  // 4. Darwin UID/sidecar isolation, Linux leaf boundaries, midPendingSwitch via saved.switchState, WSL error 5, and Mach-O slice fallback
  {
    const osaQuitTargets = [];
    const psOut = [
      ' 4100   501 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0',
      ' 4120   501 /Applications/Antigravity.app/Contents/MacOS/Antigravity --import=/Applications/Antigravity.app/Contents/Resources/app/extensions/sidecar_sdk/register_loader.js /Users/alice/main.mjs',
      ' 8801   502 /Users/bob/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
      ' 8820   502 /Users/bob/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm',
    ].join('\n');
    const darwinSnap = inspectAndStopDarwinClients('/Users/alice', {}, {
      myUid: 501,
      selfPid: 9999,
      resolveFallbackFn: () => ({ found: false }),
      runSpawn: (cmd, args) => {
        if (cmd === '/bin/ps') return { status: 0, stdout: psOut, stderr: '' };
        if (cmd === '/usr/bin/osascript') osaQuitTargets.push(args.at(-1));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(darwinSnap.rootPids, [4100]);
    assert.deepEqual(darwinSnap.hubPids, []);
    assert.deepEqual(osaQuitTargets, ['/Applications/Antigravity.app']);

    assert.equal(
      classifyLinuxProcCandidate({
        exePath: '/usr/local/bin/antigravity-cli',
        argv: ['/usr/local/bin/antigravity-cli', 'status'],
      }),
      null
    );
    assert.equal(
      classifyLinuxProcCandidate({
        exePath: '/home/alice/.antigravity-server/bin/antigravity-server',
        argv: ['/home/alice/.antigravity-server/bin/antigravity-server'],
      }),
      null
    );
    assert.equal(
      classifyLinuxProcCandidate({
        exePath: '/home/alice/Apps/Antigravity_Linux_x86_64.AppImage',
        argv: ['/home/alice/Apps/Antigravity_Linux_x86_64.AppImage', '--remote-debugging-port=0'],
      })?.role,
      'client-root'
    );

    // WSL2 Win32 error 5 maps to credentialAccessDenied
    const wslDenied = await runPosixCredentialStore(
      {
        action: 'save',
        email: 'w@example.com',
        vault: join(dir, 'wsl-denied', 'accounts.vault.json'),
        statusFile: '',
        credential: '{"token":{"refresh_token":"1//abc","token_type":"Bearer"},"auth_method":"consumer"}',
      },
      {
        platform: 'linux',
        homeDir: join(dir, 'wsl-denied'),
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        runSpawn: (_c, _a, o = {}) => {
          if (o.env?.UM_CRED_OP === 'probe') return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
          if (o.env?.UM_CRED_OP === 'read') return { status: 0, stdout: '{"ok":true,"exists":false,"data":""}\n', stderr: '' };
          return { status: 1, stdout: '{"ok":false,"error":"wincred_write_5"}\n', stderr: '' };
        },
      }
    );
    assert.equal(wslDenied.error, 'credentialAccessDenied');

    // Mach-O 64 file-streaming slice fallback for custom section names
    const machoId = '887766554433-macho-custom-sec.apps.googleusercontent.com';
    const machoSec = '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';
    const payload = Buffer.from(`prefix\0${machoId}\0${machoSec}\0`, 'ascii');
    const cmdSize = 72 + 80;
    const dataOff = 32 + cmdSize + 16;
    const machBuf = Buffer.alloc(dataOff + payload.length);
    machBuf.writeUInt32LE(0xfeedfacf, 0);
    machBuf.writeUInt32LE(1, 16);
    machBuf.writeUInt32LE(cmdSize, 20);
    machBuf.writeUInt32LE(0x19, 32);
    machBuf.writeUInt32LE(cmdSize, 36);
    machBuf.write('__TEXT', 40, 'ascii');
    machBuf.writeUInt32LE(1, 32 + 64);
    machBuf.write('__go_rodata', 32 + 72, 'ascii');
    machBuf.write('__TEXT', 32 + 72 + 16, 'ascii');
    machBuf.writeUInt32LE(payload.length, 32 + 72 + 40);
    machBuf.writeUInt32LE(dataOff, 32 + 72 + 48);
    payload.copy(machBuf, dataOff);
    const machPath = join(dir, 'language_server_macos_arm64');
    await writeFile(machPath, machBuf);
    const machoClients = await loadNativeOAuthClients({
      platform: 'darwin',
      env: { ANTIGRAVITY_LS_BIN: machPath },
      homeDir: dir,
      discoverRunningFn: async () => [],
    });
    assert.deepEqual(machoClients, [{ id: machoId, secret: machoSec }]);
  }
});
