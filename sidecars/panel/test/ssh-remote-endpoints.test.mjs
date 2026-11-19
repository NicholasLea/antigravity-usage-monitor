import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createContextWindowSyncExpression } from '../backend/context-windows.mjs';
import {
  clearRemoteEndpointRegistry,
  getRegisteredRemoteEndpoint,
  registerRemoteEndpoint,
} from '../backend/endpoint-registry.mjs';
import {
  buildWindowRemoteRpcExpression,
  classifyWindowTargetEndpoint,
  createWindowBridgeController,
  extractRemoteHostMetadata,
} from '../backend/window-bridge.mjs';
import {
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_HEADER,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  WINDOW_BRIDGE_KEY,
} from '../shared/window-bridge-protocol.mjs';
import { backendHarness } from './backend-harness.mjs';

test('Window classification strictly distinguishes local Desktop/IDE windows from SSH remote windows (including 2.33.0+ without csrfToken)', () => {
  const ideTarget = { isIdeWorkbench: true, url: 'vscode-file://vscode-app/workbench.html' };
  assert.equal(
    classifyWindowTargetEndpoint({
      target: ideTarget,
      probedInfo: { appConfig: { isRemoteControl: true, sshHost: 'remote-box' } },
    }).isRemote,
    false
  );

  // Local window matching local hub httpsPort stays local
  const localHubInfo = {
    allPorts: new Set([41000, 41001]),
    httpPorts: new Set([41000]),
    httpsPorts: new Set([41001]),
    csrfTokens: new Set(['local-csrf']),
  };
  const localWin = classifyWindowTargetEndpoint({
    target: { url: 'https://127.0.0.1:41001/c/11111111-1111-1111-1111-111111111111' },
    probedInfo: { origin: 'https://127.0.0.1:41001', csrfToken: '' },
    localHubInfo,
  });
  assert.equal(localWin.isRemote, false);
  assert.equal(localWin.endpointId, LOCAL_ENDPOINT_ID);

  // SSH window on a different loopback port with explicit sshHost -> remote with stableHostKey
  const sshWinExplicit = classifyWindowTargetEndpoint({
    target: { url: 'https://127.0.0.1:52001/c/22222222-2222-2222-2222-222222222222' },
    probedInfo: {
      origin: 'https://127.0.0.1:52001',
      csrfToken: 'remote-csrf',
      appConfig: { sshHost: 'fuxi-office-4090-test', isRemoteControl: true },
    },
    localHubInfo,
  });
  assert.equal(sshWinExplicit.isRemote, true);
  assert.equal(sshWinExplicit.stableHostKey, 'fuxi-office-4090-test');
  assert.equal(sshWinExplicit.hostLabel, 'fuxi-office-4090-test');

  // 2.33.0+ omitted csrfToken: different port when local httpsPort is known -> remote
  const sshWin233 = classifyWindowTargetEndpoint({
    target: { url: 'https://127.0.0.1:52002/c/33333333-3333-3333-3333-333333333333' },
    probedInfo: { origin: 'https://127.0.0.1:52002', csrfToken: '', appConfig: {} },
    localHubInfo,
  });
  assert.equal(sshWin233.isRemote, true);
  assert.equal(sshWin233.hostLabel, 'SSH:52002');

  // Guard against false positive: lone Desktop window when only httpPort is known (no hub_*.json httpsPort)
  const httpOnlyHubInfo = {
    allPorts: new Set([41000]),
    httpPorts: new Set([41000]),
    httpsPorts: new Set(),
    csrfTokens: new Set(['local-csrf']),
  };
  const loneLocalWin = classifyWindowTargetEndpoint({
    target: { url: 'https://127.0.0.1:41001/c/44444444-4444-4444-4444-444444444444' },
    probedInfo: { origin: 'https://127.0.0.1:41001', csrfToken: '', appConfig: {} },
    localHubInfo: httpOnlyHubInfo,
    confirmedLocalPorts: new Set(),
  });
  assert.equal(loneLocalWin.isRemote, false);

  // extractRemoteHostMetadata cleans ssh-remote+ prefixes and title tags safely
  const meta = extractRemoteHostMetadata({ remoteAuthority: 'ssh-remote+gpu-node-1' }, 'Antigravity');
  assert.equal(meta.hasExplicitRemoteFlag, true);
  assert.equal(meta.stableHostKey, 'gpu-node-1');
  assert.equal(meta.hostLabel, 'gpu-node-1');
});

test('Per-endpoint backend isolation keeps local and multiple SSH windows completely independent (telemetry, analytics, quotas, cache rebuild, and 503 guard)', async () => {
  const nowIso = new Date().toISOString();
  const h = backendHarness({
    userStatus: { email: 'local@example.com', userTier: { name: 'Google AI Pro' } },
    summaries: {
      '11111111-1111-1111-1111-111111111111': {
        annotations: { title: 'Local Session' },
        stepCount: 1,
        lastModifiedTime: nowIso,
        status: 'IDLE',
      },
    },
    trajectories: {
      '11111111-1111-1111-1111-111111111111': {
        trajectory: {
          steps: [
            {
              metadata: {
                createdAt: nowIso,
                finishedGeneratingAt: nowIso,
                modelUsage: { model: 'MODEL_PLACEHOLDER_M427', inputTokens: 1000, outputTokens: 200 },
              },
              plannerResponse: { response: 'local reply' },
            },
          ],
        },
      },
    },
    deepStats: {
      accountName: 'local@example.com',
      perConvo: {
        'ide:99999999-9999-9999-9999-999999999999': {
          appSource: 'ide',
          entries: [{ ts: nowIso, inp: 5000, cache: 0, out: 500, model: 'MODEL_PLACEHOLDER_M427' }],
        },
      },
    },
  });

  const remoteA = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:53001',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/ssh-a',
    label: 'gpu-4090',
    stableHostKey: 'gpu-4090',
  });
  const remoteB = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:53002',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/ssh-b',
    label: 'cpu-node',
    stableHostKey: 'cpu-node',
  });

  const remoteRpcLog = [];
  h.setRemoteWindowRpcInvoker(async (endpoint, method, body) => {
    remoteRpcLog.push({ id: endpoint.id, method, body });
    if (endpoint.id === remoteA.id) {
      if (method === 'GetUserStatus') {
        return { userStatus: { email: 'remote-a@example.com', userTier: { name: 'Google AI Ultra' } } };
      }
      if (method === 'GetAvailableModels') return { response: { models: {} } };
      if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': {
              annotations: { title: 'SSH-A Training Job' },
              stepCount: 1,
              lastModifiedTime: nowIso,
              status: 'IDLE',
            },
          },
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          trajectory: {
            steps: [
              {
                metadata: {
                  createdAt: nowIso,
                  finishedGeneratingAt: nowIso,
                  modelUsage: { model: 'MODEL_PLACEHOLDER_M427', inputTokens: 3000, outputTokens: 400 },
                },
                plannerResponse: { response: 'remote A reply' },
              },
            ],
          },
        };
      }
    }
    if (endpoint.id === remoteB.id) {
      if (method === 'GetUserStatus') {
        return { userStatus: { email: 'remote-b@example.com', userTier: { name: 'Google AI Pro' } } };
      }
      if (method === 'GetAvailableModels') return { response: { models: {} } };
      if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': {
              annotations: { title: 'SSH-B Kernel Build' },
              stepCount: 1,
              lastModifiedTime: nowIso,
              status: 'IDLE',
            },
          },
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          trajectory: {
            steps: [
              {
                metadata: {
                  createdAt: nowIso,
                  finishedGeneratingAt: nowIso,
                  modelUsage: { model: 'MODEL_PLACEHOLDER_M427', inputTokens: 700, outputTokens: 100 },
                },
                plannerResponse: { response: 'remote B reply' },
              },
            ],
          },
        };
      }
    }
    throw new Error(`Unexpected remote RPC: ${endpoint.id} ${method}`);
  });

  // 1. Unregistered valid remote endpoint -> 503 retryable (never silently leaks local data)
  const pendingRes = await h.executeTelemetryAction({ range: 'today' }, { endpointId: 'remote:ssh-unregistered-1234' });
  assert.equal(pendingRes.status, 503);
  assert.equal(JSON.parse(pendingRes.body).retryable, true);

  // 2. Invalid endpointId -> 400
  const invalidRes = await h.executeTelemetryAction({ range: 'today' }, { endpointId: 'remote:../evil' });
  assert.equal(invalidRes.status, 400);

  // 3. Local, Remote A, Remote B telemetry are completely isolated
  const [localRes, resA, resB] = await Promise.all([
    h.executeTelemetryAction({ range: 'all' }),
    h.executeTelemetryAction({ range: 'all' }, { endpointId: remoteA.id }),
    h.executeTelemetryAction({ range: 'all' }, { endpointId: remoteB.id }),
  ]);
  assert.equal(localRes.status, 200);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const localTel = JSON.parse(localRes.body);
  const telA = JSON.parse(resA.body);
  const telB = JSON.parse(resB.body);

  assert.equal(localTel.endpoint.id, LOCAL_ENDPOINT_ID);
  assert.equal(localTel.endpoint.isRemote, false);
  assert.equal(localTel.account.email, 'local@example.com');
  assert.equal(localTel.activeConversation.cascadeId, '11111111-1111-1111-1111-111111111111');
  // Local includes deepStats (5500) + local session (1200) = 6700
  assert.equal(localTel.consumption.account.totalTokens, 6700);

  assert.equal(telA.endpoint.id, remoteA.id);
  assert.equal(telA.endpoint.isRemote, true);
  assert.equal(telA.endpoint.label, 'gpu-4090');
  assert.equal(telA.account.email, 'remote-a@example.com');
  assert.equal(telA.activeConversation.cascadeId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  // Remote A excludes local sessions & local deepStats: strictly 3400 tokens
  assert.equal(telA.consumption.account.totalTokens, 3400);
  assert.equal(telA.consumption.sourcesBreakdown[0].name, 'Antigravity SSH');

  assert.equal(telB.endpoint.id, remoteB.id);
  assert.equal(telB.endpoint.isRemote, true);
  assert.equal(telB.account.email, 'remote-b@example.com');
  assert.equal(telB.activeConversation.cascadeId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(telB.consumption.account.totalTokens, 800);

  // 4. Rebuilding cache on remoteA clears ONLY remoteA, leaving local & remoteB caches intact
  assert.ok(h.getEndpointCacheStore(remoteA).getCachedTrajectory('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.ok(h.getEndpointCacheStore(remoteB).getCachedTrajectory('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
  const rebuildRes = h.executeRebuildCacheAction(undefined, { endpointId: remoteA.id });
  assert.equal(rebuildRes.status, 200);
  assert.equal(h.getEndpointCacheStore(remoteA).getCachedTrajectory('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), undefined);
  assert.ok(h.getEndpointCacheStore(remoteB).getCachedTrajectory('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
  assert.ok(h.getCachedTrajectory('11111111-1111-1111-1111-111111111111'));
  assert.ok(remoteRpcLog.some((c) => c.id === remoteA.id && c.method === 'GetAllCascadeTrajectories'));
});

test('Tier-1 loopback HTTPS falls back with 60s circuit breaker to Tier-2 window RPC, and stateless window RPC falls back from fetch 401 to /connect-websocket', async () => {
  const h = backendHarness({});
  const ep = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:54111',
    baseUrl: 'https://127.0.0.1:54111',
    csrfToken: 'stale-csrf',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/ssh-fallback',
    label: 'fallback-host',
    stableHostKey: 'fallback-host',
  });

  let tier1Calls = 0;
  let tier2Calls = 0;
  h.setLoopbackHttpsRequester((_opts, cb) => {
    tier1Calls += 1;
    const listeners = {};
    const req = {
      setTimeout() {},
      on(ev, fn) { listeners[ev] = fn; },
      write() {},
      end() {
        const resListeners = {};
        const res = {
          statusCode: 403,
          on(ev, fn) { resListeners[ev] = fn; },
        };
        cb(res);
        resListeners.data?.(Buffer.from('forbidden'));
        resListeners.end?.();
      },
      destroy() {},
    };
    return req;
  });
  h.setRemoteWindowRpcInvoker(async (_endpoint, method) => {
    tier2Calls += 1;
    if (method === 'GetUserStatus') return { userStatus: { email: 'tier2@example.com' } };
    if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
    if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
    if (method === 'GetAvailableModels') return { response: { models: {} } };
    return {};
  });

  const first = await h.executeTelemetryAction({ range: 'today' }, { endpointId: ep.id });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).account.email, 'tier2@example.com');
  assert.equal(tier1Calls, 1); // Circuit breaker tripped after first 403!
  assert.ok(tier2Calls >= 2);

  // Subsequent poll skips Tier-1 completely while circuit breaker is open
  const prevTier1 = tier1Calls;
  await h.executeTelemetryAction({ range: 'today', force: '1' }, { endpointId: ep.id });
  assert.equal(tier1Calls, prevTier1);

  // Verify stateless window RPC expression: fetch 401 -> /connect-websocket fallback with clean ws.close()
  let wsClosed = false;
  let sentFrame = null;
  class MockConnectWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      sentFrame = JSON.parse(raw);
      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({
            streamId: sentFrame.streamId,
            payload: { userStatus: { email: 'ws-fallback@example.com' } },
          }),
        })
      );
    }
    close() {
      wsClosed = true;
    }
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }
  const winCtx = vm.createContext({
    window: {
      location: new URL('https://127.0.0.1:54111/c/abc'),
      __APP_CONFIG__: {},
      fetch: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
      WebSocket: MockConnectWebSocket,
    },
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  const rpcRes = await vm.runInContext(
    buildWindowRemoteRpcExpression('GetUserStatus', {}, 2000),
    winCtx
  );
  assert.equal(rpcRes.ok, true);
  assert.equal(rpcRes.transport, 'ws');
  assert.equal(rpcRes.data.userStatus.email, 'ws-fallback@example.com');
  assert.equal(wsClosed, true);
  assert.equal(sentFrame.procedure, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
});

test('Context window overrides activate in SSH windows when allowRemoteHost=true and stay disabled when allowRemoteHost=false', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const carbon = 'MODEL_PLACEHOLDER_M427';
  const host = 'https://127.0.0.1:55190';
  const nativeFetch = async (_url, init) => init;
  class MockWS {
    constructor(url) { this.url = url; }
    send(data) { return data; }
  }
  const win = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket: MockWS,
    __APP_CONFIG__: { isRemoteControl: true, sshHost: 'fuxi-office-4090-test' },
  };
  const ctx = vm.createContext({
    window: win,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });

  const prefs = { 'model:gemini-4-carbon': '256000' };
  const fallbackRules = { [carbon]: 256000 };

  // Default allowRemoteHost=false keeps legacy skip behavior for isRemoteControl
  const skipped = await vm.runInContext(
    createContextWindowSyncExpression(prefs, 'boot-ssh-1', fallbackRules, false),
    ctx
  );
  assert.equal(skipped.attached, false);
  assert.equal(win.fetch, nativeFetch);

  // Desktop SSH loopback window with allowRemoteHost=true attaches, rewrites, and passively observes CSRF
  const attached = await vm.runInContext(
    createContextWindowSyncExpression(prefs, 'boot-ssh-1', fallbackRules, true),
    ctx
  );
  assert.equal(attached.attached, true);
  assert.equal(attached.ruleCount, 1);

  const payload = {
    cascadeConfig: {
      plannerConfig: { planModel: carbon },
      checkpointConfig: { maxTokenLimit: 512000 },
    },
  };
  const out = await win.fetch(host + sendPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': 'observed-ssh-csrf' },
    body: JSON.stringify(payload),
  });
  assert.equal(JSON.parse(out.body).cascadeConfig.checkpointConfig.maxTokenLimit, 256000);
  assert.equal(win.__AGUsageMonitorContextWindows.observedCsrfToken, 'observed-ssh-csrf');

  // Clean dispose restores exact nativeFetch reference
  await vm.runInContext(createContextWindowSyncExpression({}, 'boot-ssh-1', {}, true), ctx);
  assert.equal(win.fetch, nativeFetch);
});

test('CDP bridge classifies local + SSH windows simultaneously, prefetches per-endpoint initialTelemetry, routes X-Usage-Monitor-Endpoint header, and supports SSH context windows in sidebar mode', async () => {
  clearRemoteEndpointRegistry();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-ssh-cdp-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');

  const localWinObj = {
    location: new URL('https://127.0.0.1:61001/c/11111111-1111-1111-1111-111111111111'),
    __APP_CONFIG__: { csrfToken: 'local-hub-csrf' },
    fetch: async (_u, init) => init,
    WebSocket: class { constructor(u) { this.url = u; } send(d) { return d; } },
    URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  };
  localWinObj.window = localWinObj;
  localWinObj.globalThis = localWinObj;

  const sshWinObj = {
    location: new URL('https://127.0.0.1:62001/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    __APP_CONFIG__: { isRemoteControl: true, sshHost: 'fuxi-office-4090-test' },
    fetch: async (_u, init) => init,
    WebSocket: class { constructor(u) { this.url = u; } send(d) { return d; } },
    URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  };
  sshWinObj.window = sshWinObj;
  sshWinObj.globalThis = sshWinObj;

  const windowContexts = new Map([
    ['win-local', vm.createContext(localWinObj)],
    ['win-ssh', vm.createContext(sshWinObj)],
  ]);

  class MockCdpWebSocket {
    constructor(url) {
      this.url = url;
      this.targetId = url.split('/').pop();
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate') {
        const ctx = windowContexts.get(this.targetId);
        const value = vm.runInContext(msg.params.expression, ctx);
        Promise.resolve(value).then((result) =>
          this._emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value: result } } }),
          })
        );
      }
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const cdpHttpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const cdpPort = cdpHttpServer.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'win-local',
            type: 'page',
            url: 'https://127.0.0.1:61001/c/11111111-1111-1111-1111-111111111111',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win-local`,
          },
          {
            id: 'win-ssh',
            type: 'page',
            url: 'https://127.0.0.1:62001/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win-ssh`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => cdpHttpServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(portFile, `${cdpHttpServer.address().port}\n/devtools/browser/mock`, 'utf8');

  const apiCalls = [];
  let overlayEnabled = false; // First verify sidebar mode still registers SSH + attaches context windows!
  const mockAppJs = `
    (() => {
      window.__AGUsageMonitorOverlay?.dispose?.();
      const br = window.__AGUsageMonitorBridge;
      let alive = true;
      window.__AGUsageMonitorOverlay = {
        bundleVersion: br.bundleVersion,
        ensureAlive: () => alive,
        updateBridge: (next) => { Object.assign(window.__AGUsageMonitorBridge, next); },
        dispose: () => { alive = false; },
      };
    })();
  `;

  const controller = createWindowBridgeController({
    handleApiRequest: async (pathname, method, data, ctx) => {
      apiCalls.push({ pathname, method, data, endpointId: ctx?.endpointId || LOCAL_ENDPOINT_ID });
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          endpoint: { id: ctx?.endpointId || LOCAL_ENDPOINT_ID, isRemote: Boolean(ctx?.endpointId) },
          ok: true,
        }),
      };
    },
    readAssetFn: async (rel) => (rel === 'styles.css' ? ':host{}' : mockAppJs),
    getSettingsFn: () => ({
      enableWindowOverlay: overlayEnabled,
      windowMountMode: overlayEnabled ? 'dual' : 'sidebar',
      modelContextWindows: { 'model:gemini-4-carbon': '256000' },
    }),
    getBundleVersionFn: () => 'v-ssh-1',
    env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: portFile },
    WebSocketImpl: MockCdpWebSocket,
    getLocalHubPortsFn: () => ({
      allPorts: new Set([61000, 61001]),
      httpPorts: new Set([61000]),
      httpsPorts: new Set([61001]),
      csrfTokens: new Set(['local-hub-csrf']),
    }),
  });

  try {
    // 1. Even in sidebar-only mode, SSH endpoint is classified & registered before early return
    const sidebarSync = await controller.syncAllWindows();
    assert.equal(sidebarSync.enabled, false);

    // 2. Enable overlay mode -> injects both windows with separate endpointIds & initialTelemetry
    overlayEnabled = true;
    const dualSync = await controller.syncAllWindows();
    assert.equal(dualSync.ok, true);
    assert.equal(dualSync.injected, 2);

    const localBridge = localWinObj[WINDOW_BRIDGE_KEY];
    const sshBridge = sshWinObj[WINDOW_BRIDGE_KEY];
    assert.equal(localBridge[WINDOW_BRIDGE_ENDPOINT_KEY], LOCAL_ENDPOINT_ID);
    assert.equal(localBridge.isRemoteEndpoint, false);
    assert.equal(localBridge.initialTelemetry.endpoint.id, LOCAL_ENDPOINT_ID);

    assert.match(sshBridge[WINDOW_BRIDGE_ENDPOINT_KEY], /^remote:ssh-fuxi-office-4090-test-/);
    assert.equal(sshBridge.isRemoteEndpoint, true);
    assert.equal(sshBridge.endpointLabel, 'fuxi-office-4090-test');
    assert.equal(sshBridge.initialTelemetry.endpoint.id, sshBridge[WINDOW_BRIDGE_ENDPOINT_KEY]);
    assert.ok(getRegisteredRemoteEndpoint(sshBridge[WINDOW_BRIDGE_ENDPOINT_KEY]));

    // 3. HTTP bridge routes X-Usage-Monitor-Endpoint header to the remote endpoint
    const { port, token } = controller.getBridgeInfo();
    const httpRes = await fetch(`http://127.0.0.1:${port}/api/telemetry?range=today`, {
      headers: {
        Origin: 'https://127.0.0.1:62001',
        'X-Usage-Monitor-Token': token,
        [WINDOW_BRIDGE_ENDPOINT_HEADER]: sshBridge[WINDOW_BRIDGE_ENDPOINT_KEY],
      },
    });
    assert.equal(httpRes.status, 200);
    const body = await httpRes.json();
    assert.equal(body.endpoint.id, sshBridge[WINDOW_BRIDGE_ENDPOINT_KEY]);
    assert.equal(body.endpoint.isRemote, true);
  } finally {
    await controller.stop();
    clearRemoteEndpointRegistry();
    cdpHttpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('httpClient attaches X-Usage-Monitor-Endpoint and does NOT downgrade to CDP on HTTP 503 retryable responses', async () => {
  const { callSidecarApi } = await import('../src/core/httpClient.js');
  const prevWindow = globalThis.window;
  const seenHeaders = [];
  const mockBridge = {
    port: 18765,
    token: 'tok-123',
    [WINDOW_BRIDGE_ENDPOINT_KEY]: 'remote:ssh-gpu-1234567890ab',
    transportMode: 'http',
  };
  globalThis.window = {
    [WINDOW_BRIDGE_KEY]: mockBridge,
    fetch: async (_url, init) => {
      seenHeaders.push(init.headers);
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'Remote endpoint initializing', retryable: true }),
      };
    },
  };
  try {
    await assert.rejects(
      () => callSidecarApi('/api/telemetry?range=today', { abortKey: 'test-503' }),
      (err) => err.httpStatus === 503 && err.retryable === true
    );
    assert.equal(mockBridge.transportMode, 'http'); // Must NOT flip to slow CDP mode!
    assert.equal(seenHeaders[0][WINDOW_BRIDGE_ENDPOINT_HEADER], 'remote:ssh-gpu-1234567890ab');
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('Remote executeModelContextWindowAction & executeAccountCredentialAction enforce strict endpoint boundaries', async () => {
  const carbon = 'MODEL_PLACEHOLDER_M427';
  const h = backendHarness({
    availableModels: {
      'gemini-4-carbon-high': { model: carbon, maxTokens: 1048576, maxOutputTokens: 262144 },
    },
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Carbon (High)',
            modelId: 'gemini-4-carbon-high',
            modelOrAlias: { model: carbon },
            contextWindowOptions: [{ name: '256K' }, { name: '900K' }],
          },
        ],
      },
    },
  });

  const ep = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:56101',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/ssh-ctx',
    label: 'strict-remote',
    stableHostKey: 'strict-remote',
  });

  let remoteShouldThrow = false;
  h.setRemoteWindowRpcInvoker(async (_endpoint, method) => {
    if (remoteShouldThrow) throw new Error('remote offline');
    if (method === 'GetUserStatus') {
      return {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 4 Carbon (High)',
                modelId: 'gemini-4-carbon-high',
                modelOrAlias: { model: carbon },
                contextWindowOptions: [{ name: '256K' }], // Remote does NOT allow 900K!
              },
            ],
          },
        },
      };
    }
    if (method === 'GetAvailableModels') return { response: { models: {} } };
    return {};
  });

  // 1. Remote accepts supported 256K
  const okRes = await h.executeModelContextWindowAction(
    { modelId: 'model:gemini-4-carbon', option: '256K' },
    { endpointId: ep.id }
  );
  assert.equal(okRes.status, 200);

  // 2. Remote rejects 900K -> MUST return 400 and NEVER fall back to more permissive local config
  const rejectedRes = await h.executeModelContextWindowAction(
    { modelId: 'model:gemini-4-carbon', option: '900K' },
    { endpointId: ep.id }
  );
  assert.equal(rejectedRes.status, 400);

  // 3. When remote RPC fails/throws, falls back safely to local validation
  remoteShouldThrow = true;
  const fallbackRes = await h.executeModelContextWindowAction(
    { modelId: 'model:gemini-4-carbon', option: '900K' },
    { endpointId: ep.id }
  );
  assert.equal(fallbackRes.status, 200);

  // 4. Unregistered / invalid endpoints on modelContextWindow and account credentials -> 503 / 400 (zero local leak)
  const pendingCtx = await h.executeModelContextWindowAction(
    { modelId: 'model:gemini-4-carbon', option: '256K' },
    { endpointId: 'remote:ssh-missing-1111' }
  );
  assert.equal(pendingCtx.status, 503);

  const remoteAcct = await h.executeAccountCredentialAction(undefined, { endpointId: ep.id });
  assert.equal(remoteAcct.status, 200);
  assert.equal(JSON.parse(remoteAcct.body).supported, false);

  const pendingAcct = await h.executeAccountCredentialAction(undefined, {
    endpointId: 'remote:ssh-missing-1111',
  });
  assert.equal(pendingAcct.status, 503);

  const invalidAcct = await h.executeAccountCredentialAction(undefined, {
    endpointId: 'remote:../bad',
  });
  assert.equal(invalidAcct.status, 400);

  // 5. Authoritative 'local' in opts cannot be spoofed by body/query endpointId
  const spoofedRes = await h.dispatchBridgeApiRequest(
    '/api/telemetry',
    'GET',
    { endpointId: ep.id, range: 'today' },
    { endpointId: LOCAL_ENDPOINT_ID }
  );
  assert.equal(spoofedRes.status, 200);
  assert.equal(JSON.parse(spoofedRes.body).endpoint.id, LOCAL_ENDPOINT_ID);
});

test('Multi-window same-SSH-host preserves Tier-2 circuit breaker, clears stale CSRF on port change, fails over across live wsUrls, and guards pruning during inFlightCount > 0', async () => {
  const h = backendHarness({});
  const ep1 = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:57101',
    baseUrl: 'https://127.0.0.1:57101',
    csrfToken: 'tok-a',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/w1',
    label: 'shared-ssh',
    stableHostKey: 'shared-ssh',
  });
  const ep2 = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:57102',
    baseUrl: 'https://127.0.0.1:57102',
    csrfToken: 'tok-b',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/w2',
    label: 'shared-ssh',
    stableHostKey: 'shared-ssh',
  });
  assert.equal(ep1.id, ep2.id);
  assert.equal(ep1.targets.size, 2);

  // Tripping circuit breaker stays tripped across repeated polls alternating between the two known windows
  h.markRemoteEndpointPreferTier2(ep1, 60_000);
  assert.equal(h.shouldRemoteEndpointPreferTier2(ep1), true);
  h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:57101',
    baseUrl: 'https://127.0.0.1:57101',
    csrfToken: 'tok-a',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/w1',
    label: 'shared-ssh',
    stableHostKey: 'shared-ssh',
  });
  h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:57102',
    baseUrl: 'https://127.0.0.1:57102',
    csrfToken: 'tok-b',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/w2',
    label: 'shared-ssh',
    stableHostKey: 'shared-ssh',
  });
  assert.equal(h.shouldRemoteEndpointPreferTier2(ep1), true);

  // Reconnecting to a brand new port without CSRF clears stale csrfToken
  h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:57999',
    baseUrl: 'https://127.0.0.1:57999',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/w1',
    label: 'shared-ssh',
    stableHostKey: 'shared-ssh',
  });
  assert.equal(ep1.csrfToken, '');

  // inFlightCount > 0 blocks pruning even when TTL=0; dropping to 0 allows clean prune
  h.trackEndpointRequestStart(ep1);
  ep1.lastSeenMs = Date.now() - 120_000;
  h.pruneStaleRemoteEndpoints(new Set(), 1000);
  assert.ok(h.getRegisteredRemoteEndpoint(ep1.id));
  h.trackEndpointRequestEnd(ep1);
  h.pruneStaleRemoteEndpoints(new Set(), 1000);
  assert.equal(h.getRegisteredRemoteEndpoint(ep1.id), null);
});

test('ls-rpc security & transport guards: rejects non-allowlisted remote RPC, non-loopback HTTPS, oversized Tier-1 responses, and avoids circuit-breaking on GetCascadeTrajectory 404', async () => {
  const h = backendHarness({});
  const ep = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:58101',
    baseUrl: 'https://127.0.0.1:58101',
    csrfToken: 'tok-sec',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/sec',
    label: 'sec-host',
    stableHostKey: 'sec-host',
  });

  // 1. Disallowed mutating RPC method rejected immediately
  await assert.rejects(
    () => h.callLsRpc('SendUserCascadeMessage', {}, 1000, ep),
    /not allowed on remote endpoints/i
  );

  // 2. GetCascadeTrajectory 404 does NOT trip Tier-2 circuit breaker
  let tier2Invoked = false;
  h.setRemoteWindowRpcInvoker(async () => {
    tier2Invoked = true;
    return {};
  });
  h.setLoopbackHttpsRequester((_opts, cb) => ({
    setTimeout() {},
    on() {},
    write() {},
    end() {
      const resListeners = {};
      cb({ statusCode: 404, on(ev, fn) { resListeners[ev] = fn; } });
      resListeners.data?.(Buffer.from('not found'));
      resListeners.end?.();
    },
    destroy() {},
  }));
  await assert.rejects(
    () => h.callLsRpc('GetCascadeTrajectory', { cascadeId: 'missing' }, 1000, ep),
    /failed \(404\)/i
  );
  assert.equal(tier2Invoked, false);
  assert.equal(h.shouldRemoteEndpointPreferTier2(ep), false);

  // 3. Oversized Tier-1 response (>32MB) rejects cleanly without resolving truncated body
  h.setRemoteWindowRpcInvoker(null);
  h.setLoopbackHttpsRequester((_opts, cb) => ({
    setTimeout() {},
    on() {},
    write() {},
    end() {
      const resListeners = {};
      cb({ statusCode: 200, on(ev, fn) { resListeners[ev] = fn; } });
      resListeners.data?.(Buffer.alloc(33 * 1024 * 1024));
      resListeners.end?.();
    },
    destroy() {},
  }));
  await assert.rejects(
    () => h.callLsRpc('GetUserStatus', {}, 1000, ep),
    /exceeded size limit/i
  );
});

test('Multi-window Tier-2 failover switches from a dead wsUrl to a live wsUrl on the same SSH host', async () => {
  clearRemoteEndpointRegistry();
  const ep = registerRemoteEndpoint({
    origin: 'https://127.0.0.1:59101',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/dead-win',
    label: 'failover-ssh',
    stableHostKey: 'failover-ssh',
  });
  // Register second live window slightly later (or higher lastSeenMs); simulate first attempt failing
  registerRemoteEndpoint({
    origin: 'https://127.0.0.1:59101',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/live-win',
    label: 'failover-ssh',
    stableHostKey: 'failover-ssh',
  });
  ep.targets.get('ws://127.0.0.1:9222/devtools/page/dead-win').lastSeenMs = Date.now() + 1000;

  const attemptedTargets = [];
  class FailoverMockWS {
    constructor(url) {
      this.url = url;
      this.targetId = url.split('/').pop();
      this.listeners = new Map();
      attemptedTargets.push(this.targetId);
      queueMicrotask(() => {
        if (this.targetId === 'dead-win') {
          this._emit('error', new Error('target closed'));
        } else {
          this._emit('open', {});
        }
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({
            id: msg.id,
            result: {
              result: { value: { ok: true, status: 200, data: { userStatus: { email: 'live@ssh' } } } },
            },
          }),
        })
      );
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const controller = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async () => '',
    WebSocketImpl: FailoverMockWS,
  });
  try {
    const out = await controller.invokeRemoteWindowRpc(ep, 'GetUserStatus', {}, 1500);
    assert.deepEqual(attemptedTargets, ['dead-win', 'live-win']);
    assert.equal(out.userStatus.email, 'live@ssh');
  } finally {
    await controller.stop();
    clearRemoteEndpointRegistry();
  }
});

test('Multi-file atomic cache writes preserve independent local and remote_caches files without clobbering byte reuse', async () => {
  const { writeTrajectoryCacheFile } = await import('../backend/trajectory-cache-file.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-multicache-'));
  const localFile = path.join(tmpDir, 'trajectory_usage_cache.json');
  const remoteFile = path.join(tmpDir, 'ssh-gpu-abcdef123456.json');
  try {
    const localSteps = [{ stepIndex: 1, inputTokens: 111, outputTokens: 22 }];
    const remoteSteps = [{ stepIndex: 1, inputTokens: 999, outputTokens: 88 }];
    writeTrajectoryCacheFile(localFile, { c1: { title: 'local', steps: localSteps } });
    writeTrajectoryCacheFile(remoteFile, { r1: { title: 'remote', steps: remoteSteps } });
    // Interleaved second writes keep exact data integrity in both files
    writeTrajectoryCacheFile(localFile, { c1: { title: 'local-v2', steps: localSteps } });
    writeTrajectoryCacheFile(remoteFile, { r1: { title: 'remote-v2', steps: remoteSteps } });

    const parsedLocal = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    const parsedRemote = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
    assert.equal(parsedLocal.c1.title, 'local-v2');
    assert.equal(parsedLocal.c1.steps[0].inputTokens, 111);
    assert.equal(parsedRemote.r1.title, 'remote-v2');
    assert.equal(parsedRemote.r1.steps[0].inputTokens, 999);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WindowOverlayShell updateBridge rejects stale CDP rpcQueue on endpoint switch and TopSessionHeader renders SSH badge', async () => {
  const { createMockDom } = await import('./mock-dom.mjs');
  const bundleCode = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const { document } = createMockDom();
  let fetchSeq = 0;
  let staleRejected = false;
  const staleRpcPending = new Map([
    ['old-req-1', { resolve: () => {}, reject: () => { staleRejected = true; } }],
  ]);
  const mockWin = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: '/c/11111111-2222-3333-4444-555555555555', search: '' },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'flex', flexDirection: 'row' }),
    [WINDOW_BRIDGE_KEY]: {
      port: 19001,
      token: 'tok-overlay',
      bundleVersion: 'v-ui-1',
      mountMode: 'dual',
      [WINDOW_BRIDGE_ENDPOINT_KEY]: LOCAL_ENDPOINT_ID,
      isRemoteEndpoint: false,
      endpointLabel: '',
      stylesCss: ':host{}',
      rpcQueue: [{ id: 'old-req-1', path: '/api/telemetry', method: 'GET' }],
      rpcPending: staleRpcPending,
    },
    fetch: async (_url, init) => {
      const seq = ++fetchSeq;
      const epHeader = init?.headers?.[WINDOW_BRIDGE_ENDPOINT_HEADER] || LOCAL_ENDPOINT_ID;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          endpoint: {
            id: epHeader,
            isRemote: epHeader !== LOCAL_ENDPOINT_ID,
            label: epHeader !== LOCAL_ENDPOINT_ID ? 'gpu-4090' : '',
          },
          account: { status: 'signedIn', email: `${epHeader}@example.com` },
          conversations: [],
          runningConversations: [],
          activeConversation: { cascadeId: `conv-${seq}`, title: `Title-${epHeader}`, steps: [], agents: [] },
          quotas: { pools: [], meta: {} },
          consumption: { selectedRange: { key: 'today' }, session: {}, account: {}, presets: {}, trendSeries: [], sourcesBreakdown: [], monthlySeries: [] },
          settings: { language: 'zh-CN', windowMountMode: 'dual', enableWindowOverlay: true },
        }),
      };
    },
  };

  const sandbox = vm.createContext({
    window: mockWin,
    document,
    navigator: { language: 'zh-CN' },
    globalThis: mockWin,
    console,
    URL,
    URLSearchParams,
    AbortController,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    Date,
    Math,
    JSON,
    Map,
    Set,
    WeakMap,
    Promise,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
  });
  vm.runInContext(bundleCode, sandbox);
  const overlay = mockWin.__AGUsageMonitorOverlay;
  assert.ok(overlay);

  // Switch endpoint from local -> SSH remote via updateBridge
  overlay.updateBridge({
    port: 19001,
    token: 'tok-overlay',
    [WINDOW_BRIDGE_ENDPOINT_KEY]: 'remote:ssh-gpu-4090-1234567890ab',
    isRemoteEndpoint: true,
    endpointLabel: 'gpu-4090',
  });
  assert.equal(staleRejected, true);
  assert.equal(mockWin[WINDOW_BRIDGE_KEY].rpcQueue.length, 0);
  assert.equal(mockWin[WINDOW_BRIDGE_KEY].rpcPending.size, 0);

  // Allow force fetch to resolve and verify SSH badge renders in TopSessionHeader
  await new Promise((r) => setTimeout(r, 260));
  overlay.open();
  await new Promise((r) => setTimeout(r, 30));
  const portalHost = document.getElementById('ag-usage-monitor-portal');
  const sshBadge = portalHost?.shadowRoot?.querySelector?.('.endpoint-ssh-badge');
  assert.ok(sshBadge, 'Expected .endpoint-ssh-badge inside mounted portal');
  assert.equal(sshBadge.getAttribute('hidden'), null);
  assert.equal(sshBadge.getAttribute('title'), 'SSH · gpu-4090');

  overlay.dispose();
});

test('window-bridge does NOT leak localFallbackRules into SSH window when remote host verifies its models and rejects the override', async () => {
  clearRemoteEndpointRegistry();
  const { setRemoteWindowRpcInvoker } = await import('../backend/endpoint-registry.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-ssh-ctx-iso-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');
  const carbon = 'MODEL_PLACEHOLDER_M427';

  const sshWinObj = {
    location: new URL('https://127.0.0.1:63001/c/cccccccc-cccc-cccc-cccc-cccccccccccc'),
    __APP_CONFIG__: { isRemoteControl: true, sshHost: 'small-tier-ssh' },
    fetch: async (_u, init) => init,
    WebSocket: class { constructor(u) { this.url = u; } send(d) { return d; } },
    URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  };
  sshWinObj.window = sshWinObj;
  sshWinObj.globalThis = sshWinObj;
  const sshCtx = vm.createContext(sshWinObj);

  class MockWS {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const value = vm.runInContext(msg.params.expression, sshCtx);
      Promise.resolve(value).then((result) =>
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { value: result } } }),
        })
      );
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const cdpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const p = cdpServer.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'ssh-small',
            type: 'page',
            url: 'https://127.0.0.1:63001/c/cccccccc-cccc-cccc-cccc-cccccccccccc',
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/ssh-small`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => cdpServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(portFile, `${cdpServer.address().port}\n/devtools/browser/mock`, 'utf8');

  // Remote host returns valid configs that do NOT include 900K option -> verified empty rules {}
  setRemoteWindowRpcInvoker(async (_ep, method) => {
    if (method === 'GetUserStatus') {
      return {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 4 Carbon (High)',
                modelId: 'gemini-4-carbon-high',
                modelOrAlias: { model: carbon },
                contextWindowOptions: [{ name: '256K' }],
              },
            ],
          },
        },
      };
    }
    return { response: { models: {} } };
  });

  const controller = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async () => '',
    getSettingsFn: () => ({
      enableWindowOverlay: false,
      windowMountMode: 'sidebar',
      modelContextWindows: { 'model:gemini-4-carbon': '900K' },
    }),
    getBundleVersionFn: () => 'v-iso',
    env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: portFile },
    WebSocketImpl: MockWS,
  });

  try {
    await controller.syncAllWindows();
    // Because remote verified its models and rejected 900K, fallbackRules is {} and no override is attached
    assert.equal(sshWinObj.__AGUsageMonitorContextWindows, undefined);
  } finally {
    setRemoteWindowRpcInvoker(null);
    await controller.stop();
    clearRemoteEndpointRegistry();
    cdpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SSH remote endpoints isolate v1.5.2 fast paths (scope=consumption, consumption-presets cold/warm, conversation) and local Swarm manifests/transcripts', async () => {
  const nowIso = new Date().toISOString();
  const sharedCid = 'eeeeeeee-1111-2222-3333-444444444444';
  const remoteCid2 = 'ffffffff-1111-2222-3333-444444444444';

  const makeStep = (inputTokens, outputTokens) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: nowIso,
      generatorModel: 'MODEL_PLACEHOLDER_M37',
      modelUsage: {
        model: 'gemini-2.5-pro',
        inputTokens: String(inputTokens),
        outputTokens: String(outputTokens),
        cacheReadTokens: '0',
      },
    },
    plannerResponse: { response: 'ok' },
  });

  const h = backendHarness({
    userStatus: { email: 'shared@example.com', name: 'Shared User' },
    summaries: {
      [sharedCid]: {
        summary: 'Local Session With Same ID',
        stepCount: 1,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: nowIso,
      },
    },
    trajectories: {
      [sharedCid]: { trajectory: { steps: [makeStep(9000, 1000)] } },
    },
    swarmMembers: {
      [sharedCid]: {
        title: 'Local Swarm Should Not Leak To SSH',
        coordinator: { cascadeId: sharedCid, killed: false },
        members: {
          w1: { cascadeId: '11111111-2222-3333-4444-555555555555', memberName: 'local-bee' },
        },
      },
    },
    transcripts: {
      [sharedCid]: [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          content: 'local transcript should not leak',
          created_at: nowIso,
        },
      ],
    },
  });

  const ep = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:64101',
    baseUrl: 'https://127.0.0.1:64101',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/fast',
    label: 'gpu-fast',
    stableHostKey: 'gpu-fast',
  });

  let remoteRpcCount = 0;
  h.setRemoteWindowRpcInvoker(async (_ep, method, body) => {
    remoteRpcCount += 1;
    if (method === 'GetUserStatus') {
      return { userStatus: { email: 'shared@example.com', name: 'Shared User' } };
    }
    if (method === 'RetrieveUserQuotaSummary') {
      return { response: { groups: [] } };
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [sharedCid]: {
            summary: 'Remote Primary Session',
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: nowIso,
          },
          [remoteCid2]: {
            summary: 'Remote Secondary Session',
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: nowIso,
          },
        },
      };
    }
    if (method === 'GetCascadeTrajectory') {
      if (body?.cascadeId === sharedCid) {
        return { trajectory: { steps: [makeStep(200, 50)] } };
      }
      if (body?.cascadeId === remoteCid2) {
        return { trajectory: { steps: [makeStep(500, 100)] } };
      }
    }
    return {};
  });

  // 1. Populate local fast snapshot first (10,000 tokens + local swarm title)
  const localFullRes = await h.executeTelemetryAction(
    { conversationId: sharedCid, range: 'today' },
    { endpointId: LOCAL_ENDPOINT_ID }
  );
  assert.equal(localFullRes.status, 200);
  const localFull = JSON.parse(localFullRes.body);
  assert.equal(localFull.consumption.account.totalTokens, 10000);
  assert.equal(localFull.activeConversation.swarmTitle, 'Local Swarm Should Not Leak To SSH');

  // 2. Cold scope=consumption-presets on remote endpoint MUST build remote snapshot (850 tokens, SSH source), NOT read local snapshot!
  const remoteColdPresetsRes = await h.executeTelemetryAction(
    { scope: 'consumption-presets', conversationId: sharedCid },
    { endpointId: ep.id }
  );
  assert.equal(remoteColdPresetsRes.status, 200);
  const remoteColdPresets = JSON.parse(remoteColdPresetsRes.body);
  assert.equal(remoteColdPresets.scope, 'consumption-presets');
  assert.equal(remoteColdPresets.endpoint.id, ep.id);
  assert.equal(remoteColdPresets.ranges.today.account.totalTokens, 850);
  assert.equal(remoteColdPresets.ranges.today.sourcesBreakdown.length, 1);
  assert.equal(remoteColdPresets.ranges.today.sourcesBreakdown[0].name, 'Antigravity SSH');

  // 3. Warm scope=consumption on remote endpoint returns ONLY remote tokens (850), local still returns 10000
  const remoteConsRes = await h.executeTelemetryAction(
    { scope: 'consumption', range: '7d' },
    { endpointId: ep.id }
  );
  const remoteCons = JSON.parse(remoteConsRes.body);
  assert.equal(remoteCons.scope, 'consumption');
  assert.equal(remoteCons.endpoint.id, ep.id);
  assert.equal(remoteCons.consumption.account.totalTokens, 850);
  assert.equal(remoteCons.consumption.sourcesBreakdown[0].name, 'Antigravity SSH');

  const localConsRes = await h.executeTelemetryAction(
    { scope: 'consumption', range: '7d' },
    { endpointId: LOCAL_ENDPOINT_ID }
  );
  const localCons = JSON.parse(localConsRes.body);
  assert.equal(localCons.consumption.account.totalTokens, 10000);

  // 4. Remote scope=conversation switches to remoteCid2 with ZERO remote LS RPCs and NO local swarmTitle leakage
  const rpcBeforeConvSwitch = remoteRpcCount;
  const remoteConvRes = await h.executeTelemetryAction(
    { scope: 'conversation', conversationId: remoteCid2, range: 'today' },
    { endpointId: ep.id }
  );
  assert.equal(remoteConvRes.status, 200);
  const remoteConv = JSON.parse(remoteConvRes.body);
  assert.equal(remoteConv.scope, 'conversation');
  assert.equal(remoteConv.endpoint.id, ep.id);
  assert.equal(remoteConv.activeCascadeId, remoteCid2);
  assert.equal(remoteConv.activeConversation.title, 'Remote Secondary Session');
  assert.equal(remoteConv.activeConversation.totalTokens, 600);
  assert.equal(remoteConv.consumption.session.totalTokens, 600);
  assert.equal(remoteRpcCount, rpcBeforeConvSwitch);

  // 5. Remote scope=conversation for sharedCid does NOT inherit local swarmTitle or local 10000 tokens
  const remoteSharedConvRes = await h.executeTelemetryAction(
    { scope: 'conversation', conversationId: sharedCid, range: 'today' },
    { endpointId: ep.id }
  );
  const remoteSharedConv = JSON.parse(remoteSharedConvRes.body);
  assert.equal(remoteSharedConv.activeConversation.title, 'Remote Primary Session');
  assert.equal(remoteSharedConv.activeConversation.swarmTitle, undefined);
  assert.equal(remoteSharedConv.activeConversation.totalTokens, 250);
});

test('Frontend resetTelemetryForEndpointSwitch clears consumption/conversation caches and discards late in-flight fast-scope responses', async () => {
  const {
    telemetryStore,
    resetTelemetryForEndpointSwitch,
    prefetchConsumptionPresets,
    selectConsumptionTimeRange,
    fetchTelemetry,
  } = await import('../src/store/telemetryStore.js');

  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let resolveLatePresets;
  let apiCalls = 0;

  globalThis.window = {
    location: { pathname: '/' },
    fetch: async (url) => {
      apiCalls += 1;
      const u = String(url);
      if (u.includes('scope=consumption-presets')) {
        return new Promise((resolve) => {
          resolveLatePresets = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                scope: 'consumption-presets',
                usageRevision: 9,
                ranges: {
                  '7d': {
                    selectedRange: { key: '7d', label: '7天' },
                    account: { totalTokens: 999999 },
                    session: { totalTokens: 999999 },
                    trendSeries: [],
                    sourcesBreakdown: [{ name: 'Stale Local' }],
                    modelBreakdown: [],
                  },
                },
              }),
            });
        });
      }
      if (u.includes('scope=consumption')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            scope: 'consumption',
            usageRevision: 2,
            consumption: {
              revision: 2,
              selectedRange: { key: '7d', label: '7天' },
              account: { totalTokens: 42 },
              session: { totalTokens: 42 },
              trendSeries: [],
              sourcesBreakdown: [{ name: 'Antigravity SSH' }],
            },
            modelBreakdown: [],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          endpoint: { id: 'remote:ssh-clean', isRemote: true, label: 'ssh-clean' },
          account: { status: 'signedIn', email: 'u@example.com' },
          settings: { weeklyLimitMode: 'official' },
          activeConversation: { cascadeId: 'c1', recentSteps: [], agents: [] },
          consumption: {
            revision: 2,
            selectedRange: { key: 'today', label: '今天' },
            account: { totalTokens: 42 },
            session: { totalTokens: 42 },
            trendSeries: [],
            sourcesBreakdown: [{ name: 'Antigravity SSH' }],
          },
          modelBreakdown: [],
        }),
      };
    },
  };
  globalThis.fetch = globalThis.window.fetch;

  try {
    resetTelemetryForEndpointSwitch();
    const latePrefetchPromise = prefetchConsumptionPresets();
    // Switch endpoints BEFORE the previous endpoint's presets prefetch resolves
    resetTelemetryForEndpointSwitch();
    resolveLatePresets?.();
    const prefetchRes = await latePrefetchPromise;
    assert.equal(prefetchRes, false);

    // Load fresh remote endpoint telemetry, then switch to '7d' — MUST NOT hit stale 999999 cache!
    await fetchTelemetry({ force: false });
    const callsBeforeRangeSwitch = apiCalls;
    await selectConsumptionTimeRange('7d');
    assert.ok(apiCalls > callsBeforeRangeSwitch);
    assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 42);
  } finally {
    resetTelemetryForEndpointSwitch();
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('httpClient does NOT replay rejected or timed-out CDP requests over HTTP after bridge endpoint switch', async () => {
  const { callSidecarApi } = await import('../src/core/httpClient.js');
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let httpReplays = 0;

  const bridge = {
    port: 49901,
    token: 'tok-cdp-switch',
    transportMode: 'cdp',
    [WINDOW_BRIDGE_ENDPOINT_KEY]: 'remote:ssh-old',
    rpcQueue: [],
    rpcPending: new Map(),
  };

  globalThis.window = {
    [WINDOW_BRIDGE_KEY]: bridge,
    fetch: async () => {
      httpReplays += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  };
  globalThis.fetch = globalThis.window.fetch;

  try {
    // Case 1: Mutating POST with NO abortKey rejected by updateBridge switch -> must NOT replay over HTTP to new endpoint
    const postPromise = callSidecarApi('/api/cache/rebuild', {
      method: 'POST',
      body: {},
      cdpTimeoutMs: 500,
    });
    assert.equal(bridge.rpcQueue.length, 1);
    bridge[WINDOW_BRIDGE_ENDPOINT_KEY] = 'remote:ssh-new';
    for (const pending of bridge.rpcPending.values()) {
      const err = new Error('Bridge endpoint switched');
      err.name = 'AbortError';
      pending.reject(err);
    }
    bridge.rpcPending.clear();
    bridge.rpcQueue.length = 0;
    await assert.rejects(() => postPromise, (err) => err?.name === 'AbortError');
    assert.equal(httpReplays, 0);

    // Case 2: Even if a CDP request times out (plain Error) after endpoint changed, fallbackViaCdpWithRecovery must NOT replay over HTTP
    bridge.transportMode = 'cdp';
    bridge[WINDOW_BRIDGE_ENDPOINT_KEY] = 'remote:ssh-old-2';
    const timeoutPromise = callSidecarApi('/api/context-window', {
      method: 'POST',
      body: { modelId: 'm1', option: '500K' },
      cdpTimeoutMs: 30,
    });
    bridge[WINDOW_BRIDGE_ENDPOINT_KEY] = LOCAL_ENDPOINT_ID;
    await assert.rejects(() => timeoutPromise, (err) => err?.name === 'AbortError');
    assert.equal(httpReplays, 0);
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('Fast snapshot invalidates when a remote endpoint is pruned and re-registered on the same baseUrl', async () => {
  const nowIso = new Date().toISOString();
  const cid = 'abababab-1111-2222-3333-444444444444';
  let currentRemoteTokens = 250;

  const h = backendHarness({
    userStatus: { email: 'u@example.com' },
  });

  const makeRemoteStep = (total) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: nowIso,
      generatorModel: 'MODEL_PLACEHOLDER_M37',
      modelUsage: {
        model: 'gemini-2.5-pro',
        inputTokens: String(total - 50),
        outputTokens: '50',
        cacheReadTokens: '0',
      },
    },
    plannerResponse: { response: 'ok' },
  });

  h.setRemoteWindowRpcInvoker(async (_ep, method) => {
    if (method === 'GetUserStatus') return { userStatus: { email: 'u@example.com' } };
    if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [cid]: {
            summary: 'Static Forward SSH',
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: nowIso,
          },
        },
      };
    }
    if (method === 'GetCascadeTrajectory') {
      return { trajectory: { steps: [makeRemoteStep(currentRemoteTokens)] } };
    }
    return {};
  });

  const ep1 = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:64201',
    baseUrl: 'https://127.0.0.1:64201',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/static1',
    label: 'static-ssh',
    stableHostKey: 'static-ssh',
  });

  const firstRes = await h.executeTelemetryAction(
    { conversationId: cid, range: 'today' },
    { endpointId: ep1.id }
  );
  assert.equal(JSON.parse(firstRes.body).consumption.account.totalTokens, 250);

  // Prune endpoint, change remote data, and re-register on the exact same baseUrl
  ep1.lastSeenMs = Date.now() - 120_000;
  h.pruneStaleRemoteEndpoints(new Set(), 1000);
  assert.equal(h.getRegisteredRemoteEndpoint(ep1.id), null);

  currentRemoteTokens = 900;
  const ep2 = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:64201',
    baseUrl: 'https://127.0.0.1:64201',
    csrfToken: '',
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/static2',
    label: 'static-ssh',
    stableHostKey: 'static-ssh',
  });
  assert.equal(ep2.id, ep1.id);
  assert.notEqual(ep2.instanceId, ep1.instanceId);

  // Fast-path scope=consumption MUST NOT serve stale 250-token snapshot from ep1!
  const afterReRegRes = await h.executeTelemetryAction(
    { scope: 'consumption', range: 'today' },
    { endpointId: ep2.id }
  );
  const afterReReg = JSON.parse(afterReRegRes.body);
  assert.equal(afterReReg.consumption.account.totalTokens, 900);
});


