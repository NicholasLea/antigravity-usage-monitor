import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseIdeRemoteAuthority } from '../shared/workspace-uri.mjs';
import {
  IDE_SSH_REMOTE_PROBE_SH,
  buildSshProbeCommandArgs,
  createIdeRemoteSshCoordinator,
  parseRemoteDaemonJsonObjects,
  parseRemoteProbeStdout,
} from '../backend/ide-remote-ssh.mjs';
import {
  clearRemoteEndpointRegistry,
  getRegisteredRemoteEndpoint,
  getRemoteEndpointTargetWsUrls,
  registerRemoteEndpoint,
  shouldRemoteEndpointPreferTier2,
} from '../backend/endpoint-registry.mjs';
import { callLsRpc } from '../backend/ls-rpc.mjs';
import {
  associateIdeIframeRoutes,
  classifyWindowTargetEndpoint,
  createWindowBridgeController,
} from '../backend/window-bridge.mjs';
import { createMockDom } from './mock-dom.mjs';

test('parseIdeRemoteAuthority handles Plain, Percent-encoded, and Hex-JSON ssh-remote+ authorities while blocking non-SSH & option injection', () => {
  // 1. Plain host
  const plain = parseIdeRemoteAuthority('ssh-remote+prod-gpu-01');
  assert.equal(plain.isSshRemote, true);
  assert.equal(plain.host, 'prod-gpu-01');
  assert.equal(plain.user, '');
  assert.equal(plain.port, 0);
  assert.equal(plain.sshDestination, 'prod-gpu-01');
  assert.equal(plain.stableHostKey, 'prod-gpu-01');

  // 2. Percent-encoded user@host:port & vscode-remote:// URI
  const pct = parseIdeRemoteAuthority('vscode-remote://ssh-remote+ubuntu%4010.0.0.8%3A2222/home/ubuntu/repo');
  assert.equal(pct.isSshRemote, true);
  assert.equal(pct.user, 'ubuntu');
  assert.equal(pct.host, '10.0.0.8');
  assert.equal(pct.port, 2222);
  assert.equal(pct.sshDestination, 'ubuntu@10.0.0.8');
  assert.equal(pct.stableHostKey, 'ubuntu@10.0.0.8:2222');
  assert.equal(pct.displayLabel, 'ubuntu@10.0.0.8:2222');

  // 3. VS Code Hex-encoded JSON authority
  const hexPayload = Buffer.from(
    JSON.stringify({ hostName: 'GPU-Cluster.internal', user: 'Alice', port: 22022 }),
    'utf8'
  ).toString('hex');
  const hexParsed = parseIdeRemoteAuthority(`ssh-remote+${hexPayload}`);
  assert.equal(hexParsed.isSshRemote, true);
  assert.equal(hexParsed.user, 'Alice');
  assert.equal(hexParsed.host, 'GPU-Cluster.internal');
  assert.equal(hexParsed.port, 22022);
  assert.equal(hexParsed.sshDestination, 'Alice@GPU-Cluster.internal');
  assert.equal(hexParsed.stableHostKey, 'alice@gpu-cluster.internal:22022');

  // 4. Webview CDN resource authority (including -002d / -0040 / -003a hex escapes)
  const cdnParsed = parseIdeRemoteAuthority(
    'https://vscode-remote+ssh-002dremote+ubuntu-0040dev-002dbox-003a2222.vscode-resource.vscode-cdn.net/main.js'
  );
  assert.equal(cdnParsed.isSshRemote, true);
  assert.equal(cdnParsed.user, 'ubuntu');
  assert.equal(cdnParsed.host, 'dev-box');
  assert.equal(cdnParsed.port, 2222);

  // 4b. Hex-encoded JSON with bare IPv6 hostName: sshDestination strips brackets for OpenSSH CLI
  const ipv6Hex = Buffer.from(
    JSON.stringify({ hostName: '2001:db8::42', user: 'ops', port: 2222 }),
    'utf8'
  ).toString('hex');
  const ipv6Parsed = parseIdeRemoteAuthority(`ssh-remote+${ipv6Hex}`);
  assert.equal(ipv6Parsed.isSshRemote, true);
  assert.equal(ipv6Parsed.host, '[2001:db8::42]');
  assert.equal(ipv6Parsed.sshDestination, 'ops@2001:db8::42');
  assert.equal(ipv6Parsed.stableHostKey, 'ops@[2001:db8::42]:2222');

  // 5. Reject non-SSH authorities & SSH option-injection attempts
  for (const rejected of [
    '',
    'wsl+Ubuntu-24.04',
    'vscode-remote://dev-container+7b2270617468223a222f617070227d/workspace',
    'codespaces+my-org-repo',
    'tunnel+my-laptop',
    'ssh-remote+-oProxyCommand=calc.exe',
    'ssh-remote+root@-evil-flag',
    'ssh-remote+user@host with spaces',
    `ssh-remote+${Buffer.from(JSON.stringify({ hostName: '-oLocalCommand=bad' })).toString('hex')}`,
  ]) {
    assert.equal(
      parseIdeRemoteAuthority(rejected).isSshRemote,
      false,
      `Must reject non-SSH or unsafe authority: ${rejected}`
    );
  }

  // Verify buildSshProbeCommandArgs enforces BatchMode=yes, '--' separator, and shell-safe 'sh -s' stdin delivery
  const sshArgs = buildSshProbeCommandArgs(pct, 5);
  assert.ok(Array.isArray(sshArgs));
  assert.ok(sshArgs.includes('BatchMode=yes'));
  assert.equal(sshArgs.includes('-n'), false, 'stdin remains open for sh -s probe script delivery');
  assert.deepEqual(sshArgs.slice(sshArgs.indexOf('-p'), sshArgs.indexOf('-p') + 4), [
    '-p',
    '2222',
    '--',
    'ubuntu@10.0.0.8',
  ]);
  assert.deepEqual(sshArgs.slice(-2), ['sh', '-s']);
  assert.match(IDE_SSH_REMOTE_PROBE_SH, /===UM_DAEMON_JSON===/);
});

test('parseRemoteDaemonJsonObjects & createIdeRemoteSshCoordinator support multi-line daemon JSON, forwarded port pairing, tunnel fallback, and auth backoff', async () => {
  // Multi-line + concatenated agy 2.35+ daemon JSON blocks + dead PID filtering
  const probeOutput = [
    '===UM_DAEMON_JSON===',
    '{',
    '  "pid": 4010,',
    '  "httpPort": 43111,',
    '  "httpsPort": 43112,',
    '  "csrfToken": "remote-csrf-live"',
    '}',
    '{"pid": 9999, "httpPort": 49999, "csrfToken": "dead-pid-token"}',
    '===UM_PS===',
    '4010 /home/dev/.antigravity-ide-server/bin/agy --hub',
    '4025 /home/dev/.antigravity-ide-server/bin/language_server_linux_x64 --csrf_token proc-csrf-2',
    '===UM_SS===',
    'LISTEN 0 128 127.0.0.1:44500 0.0.0.0:* users:(("language_server",pid=4025,fd=9))',
  ].join('\n');

  const daemonObjs = parseRemoteDaemonJsonObjects(probeOutput);
  assert.equal(daemonObjs.length, 2);
  assert.equal(daemonObjs[0].csrfToken, 'remote-csrf-live');

  const candidates = parseRemoteProbeStdout(probeOutput);
  assert.equal(candidates.length, 2, 'Dead PID 9999 filtered out by live ps table');
  assert.equal(candidates[0].csrfToken, 'remote-csrf-live');
  assert.deepEqual(candidates[0].ports, [43111, 43112]);
  assert.equal(candidates[1].csrfToken, 'proc-csrf-2');
  assert.deepEqual(candidates[1].ports, [44500]);

  // Tier 1a: Forwarded port handshake pairing (zero tunnels opened)
  let tunnelCount = 0;
  const auth = parseIdeRemoteAuthority('ssh-remote+dev@gpu-node');
  const coordForwarded = createIdeRemoteSshCoordinator({
    execSshProbeFn: async () => probeOutput,
    handshakeFn: async (baseUrl, token) =>
      baseUrl === 'http://127.0.0.1:52100' && token === 'remote-csrf-live',
    openTunnelFn: async () => {
      tunnelCount += 1;
      throw new Error('Should not open tunnel when forwarded port matches');
    },
  });
  const res1a = await coordForwarded.resolveEndpointConnection({
    parsedAuthority: auth,
    forwardedOrigins: ['http://127.0.0.1:52100'],
  });
  assert.equal(res1a.ok, true);
  assert.equal(res1a.mode, 'forwarded');
  assert.equal(res1a.baseUrl, 'http://127.0.0.1:52100');
  assert.equal(res1a.csrfToken, 'remote-csrf-live');
  assert.equal(tunnelCount, 0);

  // Tier 1b: Tunnel fallback + deterministic disposal
  let tunnelClosed = false;
  const coordTunnel = createIdeRemoteSshCoordinator({
    execSshProbeFn: async () => probeOutput,
    handshakeFn: async (baseUrl, token) =>
      baseUrl === 'http://127.0.0.1:61055' && token === 'remote-csrf-live',
    openTunnelFn: async ({ remotePort }) => {
      assert.equal(remotePort, 43111);
      return {
        localPort: 61055,
        remotePort,
        isAlive: () => !tunnelClosed,
        close: () => {
          tunnelClosed = true;
        },
      };
    },
  });
  const res1b = await coordTunnel.resolveEndpointConnection({
    parsedAuthority: auth,
    forwardedOrigins: [],
  });
  assert.equal(res1b.ok, true);
  assert.equal(res1b.mode, 'tunnel');
  assert.equal(res1b.baseUrl, 'http://127.0.0.1:61055');
  coordTunnel.disposeHost(auth.stableHostKey);
  assert.equal(tunnelClosed, true, 'Managed SSH tunnel closed on host disposal');

  // Password / 2FA host failure exponential backoff (30s -> 120s -> 300s)
  let sshCalls = 0;
  let fakeNow = 1_000_000;
  const coordBackoff = createIdeRemoteSshCoordinator({
    nowFn: () => fakeNow,
    execSshProbeFn: async () => {
      sshCalls += 1;
      throw new Error('Permission denied (publickey,password)');
    },
  });
  const fail1 = await coordBackoff.resolveEndpointConnection({ parsedAuthority: auth });
  assert.equal(fail1.ok, false);
  assert.equal(fail1.reason, 'ssh_probe_failed');
  assert.equal(sshCalls, 1);

  fakeNow += 5_000; // Still inside 30s backoff window
  const failCached = await coordBackoff.resolveEndpointConnection({ parsedAuthority: auth });
  assert.equal(failCached.reason, 'backoff');
  assert.equal(sshCalls, 1, 'Must not re-invoke ssh during backoff window');

  fakeNow += 30_000; // Past first 30s window -> retries once, then backs off for 120s
  await coordBackoff.resolveEndpointConnection({ parsedAuthority: auth });
  assert.equal(sshCalls, 2);
  fakeNow += 60_000;
  assert.equal(
    (await coordBackoff.resolveEndpointConnection({ parsedAuthority: auth })).reason,
    'backoff',
    'Second failure escalates backoff to 120s'
  );
});

test('IDE Remote-SSH multi-window integration: Simple Browser exclusion, workbench + chat dual inheritance, and Tier-2 rpcTargets isolation', async () => {
  clearRemoteEndpointRegistry();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ide-ssh-e2e-'));
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  // 1. Verify Simple Browser preview iframe is strictly excluded even if URL looks like /c/<uuid>
  const rawTargets = [
    {
      id: 'WB-SSH',
      type: 'page',
      url: `vscode-file://vscode-app/c:/Antigravity%20IDE/workbench.html?config=${encodeURIComponent(
        JSON.stringify({ remoteAuthority: 'ssh-remote+dev@10.20.30.40' })
      )}`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/WB-SSH',
    },
    {
      id: 'WV-SIMPLE',
      parentId: 'WB-SSH',
      type: 'iframe',
      url: 'vscode-webview://1234/index.html?extensionId=vscode.simple-browser',
    },
    {
      id: 'USER-PREVIEW',
      parentId: 'WV-SIMPLE',
      type: 'iframe',
      url: 'http://127.0.0.1:3000/c/11111111-2222-3333-4444-555555555555',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/USER-PREVIEW',
    },
    {
      id: 'WV-CHAT',
      parentId: 'WB-SSH',
      type: 'iframe',
      url: 'vscode-webview://5678/index.html?purpose=webviewView',
    },
    {
      id: 'CHAT-SSH',
      parentId: 'WV-CHAT',
      type: 'iframe',
      url: 'http://127.0.0.1:54111/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/CHAT-SSH',
    },
  ];

  const associated = associateIdeIframeRoutes(rawTargets, [rawTargets[0]], { cdpPort: 9222 });
  assert.equal(associated[0].ideChatTargets.length, 1, 'Simple Browser subframe strictly excluded');
  assert.equal(associated[0].ideChatTargets[0].id, 'CHAT-SSH');

  // Verify WSL authority is classified as local, while ssh-remote+ is classified as remote
  const wslCls = classifyWindowTargetEndpoint({
    target: {
      isIdeWorkbench: true,
      url: `vscode-file://vscode-app/c:/Antigravity%20IDE/workbench.html?config=${encodeURIComponent(
        JSON.stringify({ remoteAuthority: 'wsl+Ubuntu' })
      )}`,
    },
  });
  assert.equal(wslCls.isRemote, false);

  // 2. Full WindowBridge E2E with WB-LOCAL + WB-SSH + CHAT-SSH
  const makePageVm = (originUrl, isIdeTitlebar = false) => {
    const { document } = createMockDom();
    if (isIdeTitlebar) {
      const tb = document.createElement('div');
      tb.className = 'part titlebar';
      const right = document.createElement('div');
      right.className = 'titlebar-right';
      tb.appendChild(right);
      document.body.appendChild(tb);
    } else {
      const comp = document.createElement('div');
      comp.setAttribute('contenteditable', 'true');
      comp.setAttribute('role', 'textbox');
      const box = document.createElement('div');
      box.appendChild(comp);
      document.body.appendChild(box);
    }
    const win = {
      document,
      location: new URL(originUrl),
      innerWidth: 1280,
      innerHeight: 800,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1' }),
      requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
      addEventListener() {},
      removeEventListener() {},
      fetch: async (url) => {
        if (String(url).endsWith('/GetUserStatus')) {
          return { ok: true, status: 200, json: async () => ({ userStatus: { email: 'ssh@remote.dev' } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      ShadowRoot: function ShadowRoot() {},
      HTMLElement: document.body.constructor,
      Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
      CSS: { supports: () => true },
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval() {},
      performance: { now: () => Date.now() },
    };
    win.window = win;
    win.globalThis = win;
    document.defaultView = win;
    return vm.createContext(win);
  };

  const wbLocalCtx = makePageVm('vscode-file://vscode-app/out/workbench.html', true);
  const wbSshCtx = makePageVm('vscode-file://vscode-app/out/workbench.html', true);
  const chatSshCtx = makePageVm(
    'http://127.0.0.1:54111/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true',
    false
  );
  const ctxByPath = new Map([
    ['/devtools/page/WB-LOCAL', wbLocalCtx],
    ['/devtools/page/WB-SSH', wbSshCtx],
    ['/devtools/page/CHAT-SSH', chatSshCtx],
  ]);

  const cdpServer = http.createServer((req, res) => {
    const port = cdpServer.address().port;
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          Browser: 'Electron',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/ide-main`,
        })
      );
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'WB-LOCAL',
            type: 'page',
            url: 'vscode-file://vscode-app/c:/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/WB-LOCAL`,
          },
          {
            id: 'WB-SSH',
            type: 'page',
            url: `vscode-file://vscode-app/c:/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html?config=${encodeURIComponent(
              JSON.stringify({ remoteAuthority: 'ssh-remote+dev@10.20.30.40' })
            )}`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/WB-SSH`,
          },
          {
            id: 'CHAT-SSH',
            parentId: 'WB-SSH',
            type: 'iframe',
            url: 'http://127.0.0.1:54111/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/CHAT-SSH`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => cdpServer.listen(0, '127.0.0.1', r));
  const cdpPort = cdpServer.address().port;
  const idePortDir = path.join(tmpDir, 'Antigravity IDE');
  fs.mkdirSync(idePortDir, { recursive: true });
  fs.writeFileSync(
    path.join(idePortDir, 'DevToolsActivePort'),
    `${cdpPort}\n/devtools/browser/ide-main\n`,
    'utf8'
  );

  class MockCdpWs {
    constructor(wsUrl) {
      this.pathname = new URL(wsUrl).pathname;
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    removeEventListener() {}
    emit(ev, payload) {
      for (const fn of this.listeners.get(ev) || []) fn(payload);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const vmCtx = ctxByPath.get(this.pathname);
      Promise.resolve()
        .then(() => vm.runInContext(msg.params.expression, vmCtx))
        .then((val) => {
          this.emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value: val } } }),
          });
        })
        .catch((err) => {
          this.emit('message', {
            data: JSON.stringify({
              id: msg.id,
              result: { exceptionDetails: { text: err.message } },
            }),
          });
        });
    }
    close() {}
  }

  let curMountMode = 'dual';
  let curEnableRemoteSsh = true;
  let disposedHostKey = '';
  const ctrl = createWindowBridgeController({
    env: { APPDATA: tmpDir, LOCALAPPDATA: tmpDir },
    platform: 'win32',
    homeDir: tmpDir,
    WebSocketImpl: MockCdpWs,
    getSettingsFn: () => ({
      enableWindowOverlay: true,
      windowMountMode: curMountMode,
      enableRemoteSshTelemetry: curEnableRemoteSsh,
    }),
    getBundleVersionFn: () => 'v-ide-ssh-1',
    readAssetFn: async (name) => (name === 'styles.css' ? stylesCss : appJs),
    handleApiRequest: async (_p, _m, _d, reqCtx) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ endpointEcho: reqCtx?.endpointId || 'local' }),
    }),
    ideRemoteSshOptions: {
      allowInTest: true,
      execSshProbeFn: async () =>
        '===UM_DAEMON_JSON===\n{"pid":101,"httpPort":41000,"csrfToken":"ssh-tok-1"}\n',
      handshakeFn: async (origin, tok) =>
        origin === 'http://127.0.0.1:54111' && tok === 'ssh-tok-1',
    },
  });

  try {
    const syncDual = await ctrl.syncAllWindows();
    assert.equal(syncDual.ok, true);

    // WB-LOCAL gets 'local', WB-SSH gets isolated 'remote:ssh-dev-10.20.30.40-...' + route UUID!
    const localBridgeCfg = wbLocalCtx.__AGUsageMonitorBridge;
    const sshBridgeCfg = wbSshCtx.__AGUsageMonitorBridge;
    assert.equal(localBridgeCfg.endpointId, 'local');
    assert.equal(sshBridgeCfg.isRemoteEndpoint, true);
    assert.match(sshBridgeCfg.endpointId, /^remote:ssh-dev-10\.20\.30\.40-/);
    assert.equal(sshBridgeCfg.endpointLabel, 'dev@10.20.30.40');
    assert.equal(sshBridgeCfg.hostRouteCascadeId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    // Tier-2 rpcTargets must ONLY contain loopback CHAT-SSH (never vscode-file:// WB-SSH!)
    const epObj = getRegisteredRemoteEndpoint(sshBridgeCfg.endpointId);
    assert.ok(epObj);
    assert.equal(epObj.csrfToken, 'ssh-tok-1');
    const rpcUrls = getRemoteEndpointTargetWsUrls(epObj);
    assert.equal(rpcUrls.length, 1);
    assert.match(rpcUrls[0], /\/devtools\/page\/CHAT-SSH$/);

    const rpcData = await ctrl.invokeRemoteWindowRpc(epObj, 'GetUserStatus', {});
    assert.equal(rpcData?.userStatus?.email, 'ssh@remote.dev');

    // Switch to 'composer' mode -> CHAT-SSH inherits exact same remote endpointId & cascadeId!
    curMountMode = 'composer';
    await ctrl.syncAllWindows();
    const chatBridgeCfg = chatSshCtx.__AGUsageMonitorBridge;
    assert.equal(chatBridgeCfg.endpointId, sshBridgeCfg.endpointId);
    assert.equal(chatBridgeCfg.isRemoteEndpoint, true);
    assert.equal(chatBridgeCfg.endpointLabel, 'dev@10.20.30.40');

    // Turning off enableRemoteSshTelemetry rebinds back to 'local'
    curEnableRemoteSsh = false;
    epObj.disposeCallbacks.set('test-spy', () => {
      disposedHostKey = epObj.stableHostKey;
    });
    await ctrl.syncAllWindows();
    assert.equal(chatSshCtx.__AGUsageMonitorBridge.endpointId, 'local');
    clearRemoteEndpointRegistry();
    assert.equal(disposedHostKey, 'dev@10.20.30.40');

    // Bounded syncWaitBudgetMs: slow SSH probe does not block syncAllWindows() and auto-refreshes once ready
    let releaseSlowSsh = null;
    const ctrlSlow = createWindowBridgeController({
      env: { APPDATA: tmpDir, LOCALAPPDATA: tmpDir },
      platform: 'win32',
      homeDir: tmpDir,
      WebSocketImpl: MockCdpWs,
      getSettingsFn: () => ({
        enableWindowOverlay: true,
        windowMountMode: 'dual',
        enableRemoteSshTelemetry: true,
      }),
      getBundleVersionFn: () => 'v-ide-ssh-slow-1',
      readAssetFn: async (name) => (name === 'styles.css' ? stylesCss : appJs),
      handleApiRequest: async () => ({ status: 200, contentType: 'application/json', body: '{}' }),
      ideRemoteSshOptions: {
        allowInTest: true,
        syncWaitBudgetMs: 120,
        execSshProbeFn: () =>
          new Promise((resolve) => {
            releaseSlowSsh = () =>
              resolve('===UM_DAEMON_JSON===\n{"pid":102,"httpPort":41002,"csrfToken":"slow-ssh-tok"}\n');
          }),
        handshakeFn: async (origin, tok) =>
          origin === 'http://127.0.0.1:54111' && tok === 'slow-ssh-tok',
      },
    });
    try {
      const tSlowStart = Date.now();
      await ctrlSlow.syncAllWindows();
      const tSlowElapsed = Date.now() - tSlowStart;
      assert.ok(
        tSlowElapsed < 800,
        `Slow SSH probe must not stall syncAllWindows indefinitely (took ${tSlowElapsed}ms)`
      );
      const pendingEpId = wbSshCtx.__AGUsageMonitorBridge.endpointId;
      assert.equal(getRegisteredRemoteEndpoint(pendingEpId)?.csrfToken, '');
      releaseSlowSsh?.();
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(
        getRegisteredRemoteEndpoint(pendingEpId)?.csrfToken,
        'slow-ssh-tok',
        'Background SSH completion automatically upgrades registered endpoint'
      );
    } finally {
      releaseSlowSsh?.();
      await ctrlSlow.stop();
    }
  } finally {
    await ctrl.stop();
    await new Promise((r) => cdpServer.close(r));
    clearRemoteEndpointRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial audit regressions: 3rd-party extension webview isolation, slow SSH tunnel readiness, disposeCallbacks dedupe, and Tier-1 blackout guard', async () => {
  clearRemoteEndpointRegistry();
  const net = await import('node:net');

  // 1. [CRITICAL-1] Third-party extension webviews (Live Server, Markdown, etc.), top-level 'page' targets,
  // and unanchored bare /c/<uuid> iframes MUST be rejected; official Antigravity extensionId is allowed.
  const wbMain = {
    id: 'WB-1',
    type: 'page',
    url: 'vscode-file://vscode-app/c:/Antigravity%20IDE/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/WB-1',
  };
  const advTargets = [
    wbMain,
    {
      id: 'WV-LIVESERVER',
      parentId: 'WB-1',
      type: 'iframe',
      url: 'vscode-webview://9999/index.html?extensionId=ms-vscode.live-server&purpose=webviewView',
    },
    {
      id: 'DEV-APP-IFRAME',
      parentId: 'WV-LIVESERVER',
      type: 'iframe',
      url: 'http://127.0.0.1:3000/c/11111111-2222-3333-4444-555555555555',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/DEV-APP-IFRAME',
    },
    {
      id: 'TOP-LEVEL-PAGE',
      parentId: 'WB-1',
      type: 'page',
      url: 'http://127.0.0.1:3000/c/22222222-3333-4444-5555-666666666666',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/TOP-LEVEL-PAGE',
    },
    {
      id: 'UNANCHORED-WEAK',
      type: 'iframe',
      url: 'http://127.0.0.1:3000/c/33333333-4444-5555-6666-777777777777',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/UNANCHORED-WEAK',
    },
    {
      id: 'WV-AGY',
      parentId: 'WB-1',
      type: 'iframe',
      url: 'vscode-webview://8888/index.html?extensionId=google.antigravity-chat&purpose=webviewView',
    },
    {
      id: 'REAL-AGY-CHAT',
      parentId: 'WV-AGY',
      type: 'iframe',
      url: 'http://127.0.0.1:42100/c/44444444-5555-6666-7777-888888888888?extensionView=true',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/REAL-AGY-CHAT',
    },
  ];
  const assocRes = associateIdeIframeRoutes(advTargets, [wbMain], { cdpPort: 9222 });
  assert.equal(assocRes[0].ideChatTargets.length, 1, 'Only official Antigravity extension webview allowed');
  assert.equal(assocRes[0].ideChatTargets[0].id, 'REAL-AGY-CHAT');

  // 2. [HIGH-1] Repeated registerRemoteEndpoint calls with onDisposeKey must NOT accumulate closures
  let ep = null;
  for (let i = 0; i < 25; i += 1) {
    ep = registerRemoteEndpoint({
      origin: 'http://127.0.0.1:54111',
      baseUrl: 'http://127.0.0.1:54111',
      csrfToken: 'tok',
      wsUrl: 'ws://127.0.0.1:9222/devtools/page/WB-SSH',
      canInvokeRpc: false,
      rpcWsUrls: [],
      tier1Verified: true,
      onDisposeKey: 'ide-ssh',
      onDispose: () => {},
      label: 'gpu-box',
      stableHostKey: 'gpu-box',
    });
  }
  assert.equal(ep.disposeCallbacks.size, 1, 'onDisposeKey deduplicates callback per subsystem');

  // 3. [HIGH-4] Transient Tier-1 failure when rpcTargets is empty (tunnel mode) must NOT trigger 60s Tier-2 blackout
  await assert.rejects(
    () => callLsRpc('GetUserStatus', {}, 250, ep),
    /fetch|ECONNREFUSED|Remote LS|abort/i
  );
  assert.equal(
    shouldRemoteEndpointPreferTier2(ep),
    false,
    'Must not mark preferTier2UntilMs when endpoint has 0 Tier-2 rpcTargets'
  );

  // 4. [CRITICAL-2] In-flight disposeHost closes tunnel opened after await (zero orphaned tunnels),
  // and delayed WAN tunnel (>350ms bind) succeeds cleanly
  let orphanTunnelClosed = false;
  let releaseProbe = null;
  const auth = parseIdeRemoteAuthority('ssh-remote+wan-host');
  const raceCoord = createIdeRemoteSshCoordinator({
    execSshProbeFn: () =>
      new Promise((resolve) => {
        releaseProbe = () =>
          resolve('===UM_DAEMON_JSON===\n{"pid":1,"httpPort":41000,"csrfToken":"wan-tok"}\n');
      }),
    openTunnelFn: async ({ remotePort }) => {
      await new Promise((r) => setTimeout(r, 320));
      return {
        localPort: 62111,
        remotePort,
        isAlive: () => !orphanTunnelClosed,
        close: () => {
          orphanTunnelClosed = true;
        },
      };
    },
    handshakeFn: async () => true,
  });

  const pendingResolve = raceCoord.resolveEndpointConnection({ parsedAuthority: auth });
  await new Promise((r) => setTimeout(r, 20));
  raceCoord.disposeHost(auth.stableHostKey);
  releaseProbe();
  const cancelledRes = await pendingResolve;
  assert.equal(cancelledRes.ok, false);
  assert.equal(cancelledRes.reason, 'disposed');
  assert.equal(orphanTunnelClosed, false, 'Aborted before opening tunnel after disposeHost');

  // Also test real delayed TCP listener readiness (>300ms bind delay)
  const delayedServer = net.createServer((sock) => sock.end());
  const freePortProbe = net.createServer();
  await new Promise((r) => freePortProbe.listen(0, '127.0.0.1', r));
  const targetPort = freePortProbe.address().port;
  await new Promise((r) => freePortProbe.close(r));

  setTimeout(() => {
    delayedServer.listen(targetPort, '127.0.0.1');
  }, 320);

  try {
    let connected = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !connected) {
      connected = await new Promise((resolve) => {
        const s = net.createConnection({ host: '127.0.0.1', port: targetPort });
        s.once('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.once('error', () => {
          s.destroy();
          resolve(false);
        });
      });
      if (!connected) await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(connected, true, 'Delayed TCP listener becomes ready after >300ms');

    // 5. Tier 1b deduplicates (remotePort, csrfToken) across daemon+proc and caps tunnel attempts
    const fanoutProbe = [
      '===UM_DAEMON_JSON===',
      JSON.stringify({ pid: 500, httpPort: 41001, httpsPort: 41002, csrfToken: 'dup-tok' }),
      '===UM_PS===',
      '500 /home/dev/language_server --hub_port 41001 --csrf_token dup-tok',
      '===UM_SS===',
      'LISTEN 0 128 127.0.0.1:41001 0.0.0.0:* users:(("language_server",pid=500,fd=5))',
      'LISTEN 0 128 127.0.0.1:41002 0.0.0.0:* users:(("language_server",pid=500,fd=6))',
      'LISTEN 0 128 127.0.0.1:41003 0.0.0.0:* users:(("language_server",pid=500,fd=7))',
      'LISTEN 0 128 127.0.0.1:41004 0.0.0.0:* users:(("language_server",pid=500,fd=8))',
      'LISTEN 0 128 127.0.0.1:41005 0.0.0.0:* users:(("language_server",pid=500,fd=9))',
    ].join('\n');
    const openedPorts = [];
    const dedupCoord = createIdeRemoteSshCoordinator({
      execSshProbeFn: async () => fanoutProbe,
      openTunnelFn: async ({ remotePort }) => {
        openedPorts.push(remotePort);
        return { localPort: 63000 + openedPorts.length, remotePort, isAlive: () => true, close() {} };
      },
      handshakeFn: async () => false,
    });
    const fanoutRes = await dedupCoord.resolveEndpointConnection({
      parsedAuthority: parseIdeRemoteAuthority('ssh-remote+dev@fanout-box'),
      forwardedOrigins: [],
    });
    assert.equal(fanoutRes.ok, false);
    assert.deepEqual(
      openedPorts,
      [41001, 41002, 41003, 41004],
      'Deduplicates daemon/proc overlap and caps Tier 1b tunnel attempts at 4 ports'
    );
  } finally {
    await new Promise((r) => delayedServer.close(() => r()));
    clearRemoteEndpointRegistry();
  }
});
