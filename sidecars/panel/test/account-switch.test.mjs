import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAccountLoginController } from '../backend/account-login.mjs';
import {
  buildGoogleAccountLoginUrl,
  collectNativeOAuthBinaryCandidates,
  extractNativeOAuthClients,
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
