import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAccountLoginController } from '../backend/account-login.mjs';
import { exchangeGoogleAccountCode } from '../backend/account-oauth.mjs';

const TEST_OAUTH_CLIENTS = async () => [
  {
    id: '1234567890-synthetic-test.apps.googleusercontent.com',
    secret: 'synthetic-test-secret',
  },
];

function callbackUrl(session, values) {
  const authorization = new URL(session.url);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), ...values }).toString();
  return callback;
}

test('browser login accepts its loopback callback once and saves the verified account before reporting success', async () => {
  const saved = [];
  let opened;
  let exchanges = 0;
  const controller = createAccountLoginController({
    getClients: TEST_OAUTH_CLIENTS,
    openBrowser: async (url) => { opened = url; return true; },
    exchangeCode: async (code, redirectUri, verifier) => {
      exchanges += 1;
      assert.equal(code, 'synthetic-code');
      assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
      assert.match(verifier, /^[\w-]{43,128}$/);
      return { email: 'verified@example.com', credential: { token: { refresh_token: 'synthetic-private' } } };
    },
  });
  const session = await controller.start(async (account) => { saved.push(account.email); });
  try {
    assert.equal(session.opened, true);
    const authorization = new URL(opened);
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('access_type'), 'offline');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('prompt'), /select_account/);
    const invalid = await fetch(callbackUrl(session, { state: 'unrelated', code: 'bad-code' }));
    assert.equal(invalid.status, 400);
    assert.equal(controller.getStatus(session.id).status, 'waiting');
    assert.equal(exchanges, 0);
    const response = await fetch(callbackUrl(session, { code: 'synthetic-code' }));
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(page, /账号已添加/);
    assert.equal(page.includes('synthetic-code'), false);
    assert.equal(page.includes('synthetic-private'), false);
    assert.deepEqual(saved, ['verified@example.com']);
    assert.deepEqual(controller.getStatus(session.id), { id: session.id, status: 'success', error: '', email: 'verified@example.com' });
    assert.equal(exchanges, 1);
  } finally {
    controller.cancel(session.id);
  }
});

test('login offers a usable browser link when opening fails, and cancellation closes the listener', async () => {
  const controller = createAccountLoginController({
    getClients: TEST_OAUTH_CLIENTS,
    openBrowser: async () => false,
  });
  const session = await controller.start(async () => { assert.fail('cancelled login must not save credentials'); });
  assert.equal(session.opened, false);
  assert.match(session.url, /^https:\/\/accounts\.google\.com\//);
  assert.equal((await controller.start(async () => {})).id, session.id);
  assert.equal(controller.cancel(session.id).status, 'cancelled');
  assert.equal(controller.getStatus(), null, 'ambient list status must not resurface manual cancellation');
  assert.equal(controller.getStatus(session.id)?.status, 'cancelled', 'explicit id lookup still reports cancellation');
  await delay(10);
  await assert.rejects(fetch(callbackUrl(session, { code: 'unused' })));
});

test('ambient getStatus expires terminal login notices after terminalTtlMs while preserving explicit id lookup', async () => {
  const controller = createAccountLoginController({
    getClients: TEST_OAUTH_CLIENTS,
    openBrowser: async () => true,
    timeoutMs: 30,
    terminalTtlMs: 40,
  });
  const expired = await controller.start(async () => { assert.fail('expired authorization'); });
  await delay(45);
  assert.equal(controller.getStatus(expired.id)?.status, 'expired');
  assert.equal(controller.getStatus()?.status, 'expired');
  await delay(55);
  assert.equal(controller.getStatus(), null, 'ambient status clears after terminalTtlMs');
  assert.equal(controller.getStatus(expired.id)?.status, 'expired', 'explicit id lookup stays readable');
});

test('denied authorization and expired sessions never save an account', async () => {
  const controller = createAccountLoginController({
    getClients: TEST_OAUTH_CLIENTS,
    openBrowser: async () => true,
    timeoutMs: 50,
  });
  const denied = await controller.start(async () => { assert.fail('denied authorization'); }, 'en-US');
  const response = await fetch(callbackUrl(denied, { error: 'access_denied' }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sign-in incomplete/);
  assert.equal(controller.getStatus(denied.id).status, 'cancelled');
  const expired = await controller.start(async () => { assert.fail('expired authorization'); });
  await delay(100);
  assert.equal(controller.getStatus(expired.id).status, 'expired');
  await assert.rejects(fetch(callbackUrl(expired, { code: 'late' })));
});

test('cancelled code exchange cannot add an account after the next login starts', async () => {
  let release;
  let exchangeStarted;
  const started = new Promise((resolve) => { exchangeStarted = resolve; });
  const credential = new Promise((resolve) => { release = resolve; });
  const controller = createAccountLoginController({
    getClients: TEST_OAUTH_CLIENTS,
    openBrowser: async () => true,
    exchangeCode: async () => { exchangeStarted(); return credential; },
  });
  const original = await controller.start(async () => { assert.fail('old login was cancelled'); });
  const request = fetch(callbackUrl(original, { code: 'pending' }));
  await started;
  controller.cancel(original.id);
  const replacement = await controller.start(async () => {});
  release({ email: 'old@example.com', credential: {} });
  assert.equal((await request).status, 409);
  assert.equal(controller.getStatus(replacement.id).status, 'waiting');
  controller.cancel(replacement.id);
});

test('authorization code exchange sends the callback and verifier, then identifies the Google account', async () => {
  const verified = await exchangeGoogleAccountCode('synthetic-code', 'http://127.0.0.1:12345/oauth-callback', 'synthetic-verifier', {
    getClients: TEST_OAUTH_CLIENTS,
    fetchFn: async (url, request) => {
      if (url.endsWith('/token')) {
        assert.equal(request.body.get('grant_type'), 'authorization_code');
        assert.equal(request.body.get('code'), 'synthetic-code');
        assert.equal(request.body.get('code_verifier'), 'synthetic-verifier');
        assert.equal(request.body.get('redirect_uri'), 'http://127.0.0.1:12345/oauth-callback');
        return { ok: true, json: async () => ({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }) };
      }
      assert.equal(request.headers.Authorization, 'Bearer test-access');
      return { ok: true, json: async () => ({ email: 'verified@example.com', verified_email: true }) };
    },
  });
  assert.equal(verified.email, 'verified@example.com');
  assert.equal(verified.credential.token.refresh_token, 'test-refresh');
});
