import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyDevToolsPortProduct,
  createDevToolsPortProber,
  parseDevToolsActivePortDescriptor,
  verifyDevToolsBrowserIdentity,
} from '../backend/devtools-port-probe.mjs';
import {
  MACOS_MANAGED_WRAPPER_KEY,
  buildWindowsRelaunchInnerScript,
  createMacOsLaunchWrapper,
  inspectMacOsLaunchWrapperStatus,
  inspectWindowsLnkBuffer,
  patchLinuxDesktopEntryText,
  patchWindowsRunRegistryCommand,
  patchWindowsShellOpenCommand,
  removeMacOsLaunchWrapper,
  resolveDesktopHostExecutable,
  triggerDesktopHostRelaunch,
} from '../backend/desktop-launcher-config.mjs';
import {
  createWindowBridgeController,
  ensureRemoteDebuggingInArgvText,
} from '../backend/window-bridge.mjs';
import { executeBridgeRelaunchAction } from '../backend/api-actions.mjs';
import { createMockDom } from './mock-dom.mjs';

test('DevToolsActivePort dual-line parser, browserWsPath collision guard, and bounded negative cache', async () => {
  assert.equal(parseDevToolsActivePortDescriptor(''), null);
  assert.equal(parseDevToolsActivePortDescriptor('abc\n/devtools/browser/1'), null);
  assert.equal(parseDevToolsActivePortDescriptor('70000\n/devtools/browser/1'), null);

  assert.deepEqual(
    parseDevToolsActivePortDescriptor('51234\r\n/devtools/browser/9f8e-11aa\r\n'),
    { port: 51234, browserWsPath: '/devtools/browser/9f8e-11aa' }
  );
  assert.deepEqual(parseDevToolsActivePortDescriptor('49152'), {
    port: 49152,
    browserWsPath: '',
  });

  assert.equal(
    classifyDevToolsPortProduct('C:\\Users\\dev\\AppData\\Roaming\\Antigravity IDE\\DevToolsActivePort'),
    'ide'
  );
  assert.equal(
    classifyDevToolsPortProduct('/Users/dev/Library/Application Support/Antigravity/DevToolsActivePort'),
    'desktop'
  );

  // Browser identity & port-reuse collision protection
  assert.equal(
    verifyDevToolsBrowserIdentity(
      {
        Browser: 'Chrome/132.0.0.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/browser/9f8e-11aa',
      },
      '/devtools/browser/9f8e-11aa'
    ).valid,
    true
  );
  assert.equal(
    verifyDevToolsBrowserIdentity(
      {
        Browser: 'Chrome/132.0.0.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/browser/DIFFERENT-INSTANCE',
      },
      '/devtools/browser/9f8e-11aa'
    ).reason,
    'browser_ws_path_mismatch'
  );
  assert.equal(
    verifyDevToolsBrowserIdentity({ status: 'vite-dev-server' }, '').reason,
    'not_devtools_endpoint'
  );

  // Negative cache skips dead port files in 0 network calls until file metadata changes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-port-probe-'));
  try {
    const idePortFile = path.join(tmpDir, 'Antigravity IDE', 'DevToolsActivePort');
    const desktopPortFile = path.join(tmpDir, 'Antigravity', 'DevToolsActivePort');
    fs.mkdirSync(path.dirname(idePortFile), { recursive: true });
    fs.mkdirSync(path.dirname(desktopPortFile), { recursive: true });
    fs.writeFileSync(idePortFile, '54321\n/devtools/browser/stale-ide\n', 'utf8');
    fs.writeFileSync(desktopPortFile, '54322\n/devtools/browser/live-desktop\n', 'utf8');

    const probedPorts = [];
    const prober = createDevToolsPortProber({
      maxNegativeCacheEntries: 8,
      fetchVersionFn: async (port) => {
        probedPorts.push(port);
        if (port === 54322) {
          return {
            Browser: 'Electron',
            webSocketDebuggerUrl: 'ws://127.0.0.1:54322/devtools/browser/live-desktop',
          };
        }
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });

    const first = await prober.probeActiveDevToolsPorts({
      candidateFiles: [idePortFile, desktopPortFile],
    });
    assert.deepEqual(first.livePorts, [54322]);
    assert.deepEqual(first.liveProducts, ['desktop']);
    assert.equal(first.stalePortDetected, true);
    assert.deepEqual(first.staleProducts, ['ide']);
    assert.deepEqual(probedPorts, [54321, 54322]);
    assert.equal(prober.getNegativeCacheSize(), 1);

    // Second pass with unchanged stale file -> dead port 54321 is NOT probed over TCP again!
    probedPorts.length = 0;
    const second = await prober.probeActiveDevToolsPorts({
      candidateFiles: [idePortFile, desktopPortFile],
    });
    assert.deepEqual(second.livePorts, [54322]);
    assert.equal(second.stalePortDetected, true);
    assert.deepEqual(probedPorts, [54322], 'Stale port skipped via negative cache');

    // Once IDE restarts and rewrites DevToolsActivePort with a new live port -> cache invalidates automatically
    fs.writeFileSync(idePortFile, '54399\n/devtools/browser/new-ide\n', 'utf8');
    const proberLiveIde = createDevToolsPortProber({
      fetchVersionFn: async (port) => ({
        Browser: 'Electron',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${port === 54399 ? 'new-ide' : 'live-desktop'}`,
      }),
    });
    const third = await proberLiveIde.probeActiveDevToolsPorts({
      candidateFiles: [idePortFile, desktopPortFile],
    });
    assert.deepEqual(third.livePorts, [54399, 54322]);
    assert.equal(third.stalePortDetected, false);

    // Transient PROBE_TIMEOUT negative cache expires after TTL so a briefly busy live host recovers automatically
    let fakeProbeNow = 10_000;
    let transientCalls = 0;
    const ttlProber = createDevToolsPortProber({
      timeoutNegativeTtlMs: 15_000,
      nowFn: () => fakeProbeNow,
      fetchVersionFn: async (port) => {
        transientCalls += 1;
        if (transientCalls === 1) throw new Error('PROBE_TIMEOUT');
        return {
          Browser: 'Electron',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/live-desktop`,
        };
      },
    });
    const t1 = await ttlProber.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
    assert.deepEqual(t1.livePorts, []);
    assert.equal(t1.stalePortDetected, true);
    assert.equal(transientCalls, 1);

    // Within 15s TTL -> still skipped
    fakeProbeNow += 5_000;
    const t2 = await ttlProber.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
    assert.deepEqual(t2.livePorts, []);
    assert.equal(transientCalls, 1);

    // After 15s TTL -> re-probed and recovered without needing file mtime change
    fakeProbeNow += 11_000;
    const t3 = await ttlProber.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
    assert.deepEqual(t3.livePorts, [54322]);
    assert.equal(t3.stalePortDetected, false);
    assert.equal(transientCalls, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Desktop vs IDE launcher strict mutual exclusion, targeted relaunch, and macOS managed .app wrapper', async () => {
  // 1. Windows Run / ShellOpen / .lnk binary inspection strictly separates Antigravity.exe and Antigravity IDE.exe
  const ideRunCmd = '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe"';
  const deskRunCmd = '"C:\\Program Files\\Antigravity\\Antigravity.exe"';

  assert.equal(patchWindowsRunRegistryCommand(ideRunCmd, { product: 'desktop' }).matched, false);
  const patchedIdeRun = patchWindowsRunRegistryCommand(ideRunCmd, { product: 'ide' });
  assert.equal(patchedIdeRun.matched, true);
  assert.equal(patchedIdeRun.changed, true);
  assert.match(patchedIdeRun.value, /--remote-debugging-port=0$/);

  assert.equal(patchWindowsShellOpenCommand(`${deskRunCmd} "%1"`, { product: 'ide' }).matched, false);
  const patchedIdeOpen = patchWindowsShellOpenCommand(`${ideRunCmd} "%1"`, { product: 'ide' });
  assert.equal(patchedIdeOpen.matched, true);
  assert.equal(
    patchedIdeOpen.value,
    '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe" --remote-debugging-port=0 "%1"'
  );

  const fakeIdeLnk = Buffer.concat([
    Buffer.alloc(40),
    Buffer.from('C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe --remote-debugging-port=0', 'utf16le'),
  ]);
  assert.equal(inspectWindowsLnkBuffer(fakeIdeLnk, { product: 'desktop' }).matched, false);
  assert.deepEqual(inspectWindowsLnkBuffer(fakeIdeLnk, { product: 'ide' }), {
    matched: true,
    hasDebugPort: true,
  });

  // 2. Linux .desktop patching strictly separates antigravity vs antigravity-ide
  const ideDesktopText = '[Desktop Entry]\nName=Antigravity IDE\nExec=/usr/share/antigravity-ide/antigravity-ide %F\n';
  assert.equal(patchLinuxDesktopEntryText(ideDesktopText, { product: 'desktop' }).matched, false);
  const patchedLinuxIde = patchLinuxDesktopEntryText(ideDesktopText, { product: 'ide' });
  assert.equal(patchedLinuxIde.matched, true);
  assert.equal(
    patchedLinuxIde.text,
    '[Desktop Entry]\nName=Antigravity IDE\nExec=/usr/share/antigravity-ide/antigravity-ide --remote-debugging-port=0 %F\n'
  );

  // 3. Dual-host coexistence targeted relaunch only restarts IDE and only deletes IDE stale port files
  const macHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mac-wrap-'));
  try {
    const fakeAppsRoot = path.join(macHome, 'Applications');
    const desktopApp = path.join(fakeAppsRoot, 'Antigravity.app');
    const ideApp = path.join(fakeAppsRoot, 'Antigravity IDE.app');
    fs.mkdirSync(path.join(desktopApp, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(ideApp, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(ideApp, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(desktopApp, 'Contents', 'MacOS', 'Antigravity'), '', 'utf8');
    fs.writeFileSync(path.join(ideApp, 'Contents', 'MacOS', 'Antigravity IDE'), '', 'utf8');
    fs.writeFileSync(
      path.join(ideApp, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleIconFile</key><string>code.icns</string></dict></plist>',
      'utf8'
    );
    fs.writeFileSync(path.join(ideApp, 'Contents', 'Resources', 'code.icns'), 'ICNS_BYTES', 'utf8');

    const resolvedIde = resolveDesktopHostExecutable({
      platform: 'darwin',
      homeDir: macHome,
      preferredProduct: 'ide',
    });
    assert.equal(resolvedIde.found, true);
    assert.equal(resolvedIde.kind, 'ide');
    assert.equal(resolvedIde.appBundlePath, ideApp);

    let spawnedEnv = null;
    const relaunchRes = await triggerDesktopHostRelaunch({
      platform: 'darwin',
      homeDir: macHome,
      preferredProduct: 'ide',
      stalePortFiles: [
        '/Users/dev/Library/Application Support/Antigravity/DevToolsActivePort',
        '/Users/dev/Library/Application Support/Antigravity IDE/DevToolsActivePort',
      ],
      spawnFn: async (_cmd, _args, opts) => {
        spawnedEnv = opts.env;
        return { pid: 999 };
      },
      allowInTest: true,
    });
    assert.equal(relaunchRes.ok, true);
    assert.equal(relaunchRes.product, 'ide');
    assert.equal(spawnedEnv.AGY_RELAUNCH_APP, ideApp);
    assert.equal(
      spawnedEnv.AGY_STALE_PORT_FILES,
      '/Users/dev/Library/Application Support/Antigravity IDE/DevToolsActivePort',
      'Must never delete live Desktop DevToolsActivePort when relaunching IDE'
    );

    // 4. macOS on-demand wrapper creation (LSUIElement=true + icon + managed marker) & safe removal
    assert.equal(inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: macHome }).exists, false);

    const created = await createMacOsLaunchWrapper({
      product: 'ide',
      platform: 'darwin',
      homeDir: macHome,
      execFileFn: async () => '',
      allowInTest: true,
    });
    assert.equal(created.ok, true);
    assert.ok(created.wrapperPath.endsWith('Antigravity IDE (Monitor).app'));

    const plistContent = fs.readFileSync(path.join(created.wrapperPath, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plistContent, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.ok(plistContent.includes(`<key>${MACOS_MANAGED_WRAPPER_KEY}</key>`));
    assert.equal(
      fs.readFileSync(path.join(created.wrapperPath, 'Contents', 'Resources', 'launcher.icns'), 'utf8'),
      'ICNS_BYTES'
    );
    const launcherSh = fs.readFileSync(path.join(created.wrapperPath, 'Contents', 'MacOS', 'launcher'), 'utf8');
    assert.match(launcherSh, /--args --remote-debugging-port=0/);

    const statusAfterCreate = inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: macHome });
    assert.equal(statusAfterCreate.exists, true);
    assert.equal(statusAfterCreate.ideExists, true);
    assert.equal(statusAfterCreate.desktopExists, false);

    // Unmanaged .app at Desktop wrapper path MUST NOT be deleted by removeMacOsLaunchWrapper
    const unmanagedApp = path.join(fakeAppsRoot, 'Antigravity (Monitor).app');
    fs.mkdirSync(path.join(unmanagedApp, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(unmanagedApp, 'Contents', 'Info.plist'), '<plist><dict></dict></plist>', 'utf8');

    const removed = removeMacOsLaunchWrapper({
      product: 'both',
      platform: 'darwin',
      homeDir: macHome,
      allowInTest: true,
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.removedPaths, [created.wrapperPath]);
    assert.equal(fs.existsSync(created.wrapperPath), false, 'Managed wrapper deleted');
    assert.equal(fs.existsSync(unmanagedApp), true, 'Unmanaged user .app strictly preserved');
  } finally {
    fs.rmSync(macHome, { recursive: true, force: true });
  }
});

test('Multi-host lease coordination prevents Follower start() from clobbering active Leader lease, and macOS UI surfaces wrapper controls', async () => {
  const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lease-guard-'));
  const leaseFile = path.join(leaseDir, 'window-bridge-lease.json');

  // Simulate another live process (ppid or current pid? Use a mock lease by spawning a tiny sleep node child)
  const { spawn } = await import('node:child_process');
  const dummyLeader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  dummyLeader.unref?.();

  let followerCtrl = null;
  try {
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({
        pid: dummyLeader.pid,
        bundleVersion: '500',
        bridgePort: 59123,
        bridgeToken: 'a'.repeat(64),
        syncState: 'active',
        aliveCount: 1,
        targets: 1,
        updatedAtMs: Date.now(),
      }),
      'utf8'
    );

    followerCtrl = createWindowBridgeController({
      leaseFilePath: leaseFile,
      getSettingsFn: () => ({ enableWindowOverlay: true, windowMountMode: 'dual' }),
      getBundleVersionFn: () => '500',
      readAssetFn: async () => '',
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      env: { USERPROFILE: leaseDir, APPDATA: leaseDir, LOCALAPPDATA: leaseDir },
      homeDir: leaseDir,
    });

    // start() must NOT start bridge server or overwrite dummyLeader's lease!
    followerCtrl.start();
    const syncOut = await followerCtrl.syncAllWindows();
    assert.equal(syncOut.reason, 'follower_yield');
    assert.equal(followerCtrl.getBridgeInfo().running, false);

    const leaseOnDisk = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    assert.equal(leaseOnDisk.pid, dummyLeader.pid, 'Leader PID preserved without clobbering');
    assert.equal(leaseOnDisk.bridgePort, 59123);
  } finally {
    if (followerCtrl) await followerCtrl.stop();
    try {
      dummyLeader.kill();
    } catch {}
    fs.rmSync(leaseDir, { recursive: true, force: true });
  }

  // Verify BridgeStatusNotice shows macOS wrapper button ONLY on darwin, and SettingsOtherTab shows cleanup row
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    const { BridgeStatusNotice } = await import('../src/components/settings/BridgeStatusNotice.js');
    const { SettingsOtherTab } = await import('../src/views/settings/SettingsOtherTab.js');

    const notice = BridgeStatusNotice({});
    notice.refs.update({
      visible: true,
      hostPlatform: 'win32',
      windowBridge: { state: 'no_devtools_port', canRelaunch: true, targetProduct: 'ide' },
    });
    assert.equal(notice.refs.macWrapperBtnEl.hasAttribute('hidden'), true, 'Hidden on Windows');
    assert.match(notice.refs.relaunchBtnEl.textContent, /IDE/);

    notice.refs.update({
      visible: true,
      hostPlatform: 'darwin',
      windowBridge: {
        state: 'no_devtools_port',
        canRelaunch: true,
        macWrapperExists: false,
        targetProduct: 'desktop',
      },
    });
    assert.equal(notice.refs.macWrapperBtnEl.hasAttribute('hidden'), false, 'Shown on macOS when unmounted');
    assert.match(notice.refs.macWrapperBtnEl.textContent, /~\/Applications/);
    notice.destroy();

    const otherTab = SettingsOtherTab({});
    otherTab.refs.renderSettings(
      { autoConfigureLaunch: true, enableRemoteSshTelemetry: true },
      [],
      { state: 'active', macWrapperExists: true },
      'darwin'
    );
    assert.equal(
      otherTab.refs.macWrapperRemoveBtn.parentNode.hasAttribute('hidden'),
      false,
      'SettingsOtherTab exposes macOS wrapper removal row even when mounted'
    );
    otherTab.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('Adversarial audit regressions: HTTP_404 non-CDP negative caching, dual-host auto relaunch, symlink/unmanaged .app guards, and JSONC argv strip', async () => {
  const http = await import('node:http');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-adv-probe-'));

  // 1. [MEDIUM-4] Express/static server returning 404 on both /json/version and /json/list MUST be negative-cached,
  // while a minimal CDP server returning 404 on /json/version and valid target Array on /json/list is accepted.
  let expressHits = 0;
  const expressSrv = http.createServer((_req, res) => {
    expressHits += 1;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Cannot GET');
  });
  const minimalCdpSrv = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'p1',
            type: 'page',
            url: 'https://127.0.0.1:9000/',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9000/devtools/page/p1',
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await Promise.all([
    new Promise((r) => expressSrv.listen(0, '127.0.0.1', r)),
    new Promise((r) => minimalCdpSrv.listen(0, '127.0.0.1', r)),
  ]);

  try {
    const expressPort = expressSrv.address().port;
    const cdpPort = minimalCdpSrv.address().port;
    const stalePortFile = path.join(tmpDir, 'Antigravity IDE', 'DevToolsActivePort');
    const livePortFile = path.join(tmpDir, 'Antigravity', 'DevToolsActivePort');
    fs.mkdirSync(path.dirname(stalePortFile), { recursive: true });
    fs.mkdirSync(path.dirname(livePortFile), { recursive: true });
    fs.writeFileSync(stalePortFile, `${expressPort}\n/devtools/browser/reused\n`, 'utf8');
    fs.writeFileSync(livePortFile, `${cdpPort}\n/devtools/browser/minimal\n`, 'utf8');

    const realProber = createDevToolsPortProber({ timeoutMs: 300 });
    const pass1 = await realProber.probeActiveDevToolsPorts({
      candidateFiles: [stalePortFile, livePortFile],
    });
    assert.deepEqual(pass1.livePorts, [cdpPort]);
    assert.equal(pass1.stalePortDetected, true);
    assert.equal(pass1.staleFiles[0].reason, 'not_devtools_endpoint');
    assert.equal(expressHits, 2, 'First pass checks /json/version then /json/list once');

    expressHits = 0;
    const pass2 = await realProber.probeActiveDevToolsPorts({
      candidateFiles: [stalePortFile, livePortFile],
    });
    assert.deepEqual(pass2.livePorts, [cdpPort]);
    assert.equal(expressHits, 0, 'Second pass skips non-DevTools HTTP server via negative cache');

    // 2. [HIGH-3] Dual-host auto relaunch prefers running Antigravity IDE over closed Desktop install
    const winDeskExe = path.join(tmpDir, 'Programs', 'Antigravity', 'Antigravity.exe');
    const winIdeExe = path.join(tmpDir, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe');
    fs.mkdirSync(path.dirname(winDeskExe), { recursive: true });
    fs.mkdirSync(path.dirname(winIdeExe), { recursive: true });
    fs.writeFileSync(winDeskExe, '', 'utf8');
    fs.writeFileSync(winIdeExe, '', 'utf8');

    const autoRelaunchWin = await triggerDesktopHostRelaunch({
      platform: 'win32',
      env: { LOCALAPPDATA: tmpDir, TEMP: tmpDir },
      homeDir: tmpDir,
      preferredProduct: 'auto',
      execFileFn: async (_cmd, args) => {
        const joined = args.join(' ');
        if (joined.includes('Get-Process')) {
          return JSON.stringify({ path: winIdeExe, name: 'Antigravity IDE' });
        }
        return '{"ok":true}';
      },
      allowInTest: true,
    });
    assert.equal(autoRelaunchWin.ok, true);
    assert.equal(autoRelaunchWin.product, 'ide', 'Auto relaunch targets running IDE instead of closed Desktop');
    assert.equal(autoRelaunchWin.executablePath, winIdeExe);

    // 3. [MEDIUM-5] Elevated UAC .lnk patch block verifies TargetPath exe leaf per product
    const ideInnerPs = buildWindowsRelaunchInnerScript(winIdeExe, [], 'ide', {
      readOnlyShortcutPaths: ['C:\\Users\\Public\\Desktop\\Antigravity IDE.lnk'],
    });
    assert.match(ideInnerPs, /GetFileName\(\$lnkTarget\) -ieq 'Antigravity IDE\.exe'/);
    assert.doesNotMatch(ideInnerPs, /GetFileName\(\$lnkTarget\) -ieq 'Antigravity\.exe'/);

    // 4. [HIGH-5] Symlink & unmanaged .app overwrite protection + per-product macOS wrapper status in UI
    const macAppsDir = path.join(tmpDir, 'Applications');
    const srcApp = path.join(macAppsDir, 'Antigravity.app');
    const unmanagedWrapper = path.join(macAppsDir, 'Antigravity (Monitor).app');
    fs.mkdirSync(path.join(srcApp, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(srcApp, 'Contents', 'MacOS', 'Antigravity'), '', 'utf8');
    fs.mkdirSync(path.join(unmanagedWrapper, 'Contents'), { recursive: true });
    fs.writeFileSync(
      path.join(unmanagedWrapper, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleName</key><string>UserCustomApp</string></dict></plist>',
      'utf8'
    );

    const overwriteAttempt = await createMacOsLaunchWrapper({
      product: 'desktop',
      platform: 'darwin',
      homeDir: tmpDir,
      execFileFn: async () => '',
      allowInTest: true,
    });
    assert.equal(overwriteAttempt.ok, false);
    assert.equal(overwriteAttempt.status, 409, 'Must refuse overwriting unmanaged .app bundle');

    const symlinkAttempt = await createMacOsLaunchWrapper({
      product: 'ide',
      platform: 'darwin',
      homeDir: tmpDir,
      execFileFn: async () => '',
      fsOps: {
        existsFn: (p) => p === srcApp || p.includes('Antigravity IDE.app'),
        lstatFn: (p) => ({
          isSymbolicLink: () => String(p).endsWith('Antigravity IDE (Monitor).app'),
        }),
      },
      allowInTest: true,
    });
    assert.equal(symlinkAttempt.ok, false);
    assert.equal(symlinkAttempt.status, 409, 'Must refuse operating on symbolic link wrapper path');

    // 5. [MEDIUM-3] ensureRemoteDebuggingInArgvText({ enabled: false }) strips managed "0" while preserving comments & custom port
    const jsoncWithManagedZero = [
      '{',
      '\t// Keep user comment intact',
      '\t"enable-crash-reporter": true,',
      '\t"remote-debugging-port": "0"',
      '}',
      '',
    ].join('\n');
    const strippedArgv = ensureRemoteDebuggingInArgvText(jsoncWithManagedZero, { enabled: false });
    assert.equal(strippedArgv.valid, true);
    assert.equal(strippedArgv.changed, true);
    assert.equal(strippedArgv.removed, true);
    assert.match(strippedArgv.text, /\/\/ Keep user comment intact/);
    assert.doesNotMatch(strippedArgv.text, /remote-debugging-port/);

    const customPortArgv = '{\n\t"remote-debugging-port": "9229"\n}\n';
    const preservedCustom = ensureRemoteDebuggingInArgvText(customPortArgv, { enabled: false });
    assert.equal(preservedCustom.changed, false);
    assert.equal(preservedCustom.alreadyConfigured, true);
    assert.match(preservedCustom.text, /"9229"/);

    // Numeric custom port must also report alreadyConfigured=true on enabled:false
    const numericCustomPort = ensureRemoteDebuggingInArgvText('{\n\t"remote-debugging-port": 9229\n}\n', {
      enabled: false,
    });
    assert.equal(numericCustomPort.changed, false);
    assert.equal(numericCustomPort.alreadyConfigured, true);

    // 6. Toggling autoConfigureLaunch off runs single-flight cleanup ONCE (never 2 concurrent PowerShell runs,
    //    and never loops on subsequent polls when user has a custom port in argv.json)
    const cleanupHome = path.join(tmpDir, 'cleanup-home');
    const ideCfgDir = path.join(cleanupHome, '.antigravity-ide');
    fs.mkdirSync(ideCfgDir, { recursive: true });
    fs.writeFileSync(path.join(ideCfgDir, 'argv.json'), '{\n  "remote-debugging-port": 9229\n}\n', 'utf8');
    let autoLaunchFlag = true;
    let activeCleanup = 0;
    let maxCleanupConc = 0;
    let cleanupCalls = 0;
    const cleanupCtrl = createWindowBridgeController({
      env: { APPDATA: cleanupHome, LOCALAPPDATA: cleanupHome, USERPROFILE: cleanupHome },
      platform: 'win32',
      homeDir: cleanupHome,
      autoConfigureIdeArgv: true,
      allowDesktopLauncherInTest: true,
      getSettingsFn: () => ({
        enableWindowOverlay: true,
        windowMountMode: 'dual',
        autoConfigureLaunch: autoLaunchFlag,
      }),
      getBundleVersionFn: () => '200',
      readAssetFn: async () => '',
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      launcherExecFileFn: async () => {
        cleanupCalls += 1;
        activeCleanup += 1;
        maxCleanupConc = Math.max(maxCleanupConc, activeCleanup);
        await new Promise((r) => setTimeout(r, 60));
        activeCleanup -= 1;
        return JSON.stringify({ updatedPaths: [], configuredPaths: ['C:\\x.lnk'], readOnlyPaths: [] });
      },
    });
    try {
      await cleanupCtrl.syncAllWindows();
      cleanupCalls = 0;
      activeCleanup = 0;
      maxCleanupConc = 0;
      autoLaunchFlag = false;
      await cleanupCtrl.notifySettingChanged(true);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(cleanupCalls, 1, 'Exactly one launcher cleanup pass when toggling autoConfigureLaunch off');
      assert.equal(maxCleanupConc, 1, 'Never spawns two concurrent cleanup passes');

      // Subsequent poll with custom port in argv.json must NOT re-trigger cleanup
      await cleanupCtrl.syncAllWindows();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(cleanupCalls, 1, 'Custom port in argv.json must not cause repeated cleanup loops');
    } finally {
      await cleanupCtrl.stop();
    }

    // 7. Follower yield trusts Leader lease stalePortDetected=false instead of staying stuck at prior local true
    const stickyHome = path.join(tmpDir, 'sticky-home');
    fs.mkdirSync(path.join(stickyHome, 'Antigravity'), { recursive: true });
    fs.writeFileSync(
      path.join(stickyHome, 'Antigravity', 'DevToolsActivePort'),
      '59998\n/devtools/browser/dead\n',
      'utf8'
    );
    const stickyLease = path.join(stickyHome, 'lease.json');
    const stickyCtrl = createWindowBridgeController({
      leaseFilePath: stickyLease,
      env: { APPDATA: stickyHome, LOCALAPPDATA: stickyHome, USERPROFILE: stickyHome },
      platform: 'win32',
      homeDir: stickyHome,
      getSettingsFn: () => ({ enableWindowOverlay: true, windowMountMode: 'dual', autoConfigureLaunch: false }),
      getBundleVersionFn: () => '300',
      readAssetFn: async () => '',
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      portProberOptions: {
        fetchVersionFn: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const { spawn } = await import('node:child_process');
    const liveLeader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    liveLeader.unref?.();
    try {
      await stickyCtrl.syncAllWindows();
      assert.equal(stickyCtrl.getBridgeStatus().stalePortDetected, true);
      fs.writeFileSync(
        stickyLease,
        JSON.stringify({
          pid: liveLeader.pid,
          bundleVersion: '300',
          syncState: 'active',
          aliveCount: 1,
          targets: 1,
          stalePortDetected: false,
          hasReadOnlyShortcuts: false,
          updatedAtMs: Date.now(),
        }),
        'utf8'
      );
      await stickyCtrl.syncAllWindows();
      assert.equal(stickyCtrl.getBridgeStatus().state, 'active');
      assert.equal(
        stickyCtrl.getBridgeStatus().stalePortDetected,
        false,
        'Follower clears prior local stalePortDetected when healthy Leader lease reports false'
      );
    } finally {
      try {
        liveLeader.kill();
      } catch {}
      await stickyCtrl.stop();
    }

    // 8. executeBridgeRelaunchAction({ product: 'desktop' }) must NOT touch ~/.antigravity-ide/argv.json
    const deskOnlyHome = path.join(tmpDir, 'desk-only-home');
    const deskOnlyIdeDir = path.join(deskOnlyHome, '.antigravity-ide');
    fs.mkdirSync(deskOnlyIdeDir, { recursive: true });
    const deskOnlyIdeArgv = path.join(deskOnlyIdeDir, 'argv.json');
    const origArgv = '{\n  "enable-crash-reporter": true\n}\n';
    fs.writeFileSync(deskOnlyIdeArgv, origArgv, 'utf8');
    const prevUp = process.env.USERPROFILE;
    const prevHm = process.env.HOME;
    process.env.USERPROFILE = deskOnlyHome;
    process.env.HOME = deskOnlyHome;
    try {
      await executeBridgeRelaunchAction({ product: 'desktop' });
      assert.equal(
        fs.readFileSync(deskOnlyIdeArgv, 'utf8'),
        origArgv,
        'Desktop-only relaunch must not mutate IDE argv.json'
      );
    } finally {
      if (prevUp === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUp;
      if (prevHm === undefined) delete process.env.HOME;
      else process.env.HOME = prevHm;
    }
  } finally {
    await Promise.all([
      new Promise((r) => expressSrv.close(r)),
      new Promise((r) => minimalCdpSrv.close(r)),
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Verified live DevTools port is not 15s-banned on transient PROBE_TIMEOUT and active bridge avoids false cdp_unreachable alarms', async () => {
  const http = await import('node:http');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-transient-cdp-'));
  const desktopPortFile = path.join(tmpDir, 'Antigravity', 'DevToolsActivePort');
  fs.mkdirSync(path.dirname(desktopPortFile), { recursive: true });

  // 1. Unit check on createDevToolsPortProber: previously-verified live port hitting PROBE_TIMEOUT is NOT negative-cached
  fs.writeFileSync(desktopPortFile, '54552\n/devtools/browser/live-abc\n', 'utf8');
  let mode = 'live'; // 'live' | 'timeout' | 'refused'
  let probeCalls = 0;
  const prober = createDevToolsPortProber({
    timeoutNegativeTtlMs: 15_000,
    fetchVersionFn: async (port) => {
      probeCalls += 1;
      if (mode === 'timeout') throw new Error('PROBE_TIMEOUT');
      if (mode === 'refused') {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return {
        Browser: 'Chrome/152.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/live-abc`,
      };
    },
  });

  const p1 = await prober.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
  assert.deepEqual(p1.livePorts, [54552]);
  assert.equal(p1.hasTransientTimeout, false);
  assert.equal(probeCalls, 1);

  // Busy UI hiccup -> PROBE_TIMEOUT does NOT enter 15s negative cache
  mode = 'timeout';
  const p2 = await prober.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
  assert.deepEqual(p2.livePorts, []);
  assert.equal(p2.hasTransientTimeout, true);
  assert.equal(p2.stalePortDetected, false);
  assert.equal(prober.getNegativeCacheSize(), 0, 'Previously verified live port must not be negative-cached on PROBE_TIMEOUT');

  // Very next poll immediately re-probes and recovers without waiting 15s!
  mode = 'live';
  const p3 = await prober.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
  assert.deepEqual(p3.livePorts, [54552]);
  assert.equal(p3.hasTransientTimeout, false);
  assert.equal(probeCalls, 3);

  // Genuine host exit (ECONNREFUSED) evicts verifiedLiveFiles and enters negativeCache immediately
  mode = 'refused';
  const p4 = await prober.probeActiveDevToolsPorts({ candidateFiles: [desktopPortFile] });
  assert.deepEqual(p4.livePorts, []);
  assert.equal(p4.hasTransientTimeout, false);
  assert.equal(p4.stalePortDetected, true);
  assert.equal(prober.getNegativeCacheSize(), 1);

  // 2. End-to-end WindowBridgeController: active bridge holds 'active' across transient PROBE_TIMEOUT & live HTTP heartbeat,
  //    then transitions cleanly to 'cdp_unreachable' on genuine ECONNREFUSED or sustained outage without heartbeat.
  let cdpVersionMode = 'live'; // 'live' | 'timeout' | 'refused'
  let cdpSrvPort = 0;
  const cdpSrv = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'main-1',
            type: 'page',
            title: 'Antigravity',
            url: 'https://127.0.0.1:9000/c/11111111-2222-3333-4444-555555555555',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpSrvPort}/devtools/page/main-1`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  class FakeWs {
    constructor() {
      this._listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (list) this._listeners.set(type, list.filter((x) => x !== fn));
    }
    _emit(type, ev) {
      for (const fn of this._listeners.get(type) || []) fn(ev);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      queueMicrotask(() => {
        this._emit('message', {
          data: JSON.stringify({
            id: msg.id,
            result: {
              result: {
                value: {
                  alive: true,
                  visible: true,
                  dockKind: 'flow',
                  bundleVersion: 'v-transient-1',
                  bridgePort: 0,
                  bridgeToken: '',
                  mountMode: 'dual',
                },
              },
            },
          }),
        });
      });
    }
    close() {}
  }

  let ctrl = null;
  try {
    await new Promise((resolve) => cdpSrv.listen(0, '127.0.0.1', resolve));
    cdpSrvPort = cdpSrv.address().port;

    const appDataDir = path.join(tmpDir, 'AppData', 'Roaming');
    const portFile = path.join(appDataDir, 'Antigravity', 'DevToolsActivePort');
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, `${cdpSrvPort}\n/devtools/browser/bridge-live\n`, 'utf8');

    ctrl = createWindowBridgeController({
      env: { USERPROFILE: tmpDir, APPDATA: appDataDir, LOCALAPPDATA: path.join(tmpDir, 'AppData', 'Local') },
      platform: 'win32',
      homeDir: tmpDir,
      autoConfigureIdeArgv: false,
      activeTransientMissTolerance: 2,
      overlayHeartbeatGraceMs: 15_000,
      WebSocketImpl: FakeWs,
      portProberOptions: {
        fetchVersionFn: async (port) => {
          if (cdpVersionMode === 'timeout') throw new Error('PROBE_TIMEOUT');
          if (cdpVersionMode === 'refused') {
            const err = new Error('connect ECONNREFUSED');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          return {
            Browser: 'Chrome/152.0',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/bridge-live`,
          };
        },
      },
      getSettingsFn: () => ({ enableWindowOverlay: true, windowMountMode: 'dual' }),
      getBundleVersionFn: () => 'v-transient-1',
      readAssetFn: async () => '',
      handleApiRequest: async () => ({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    });

    // Initial sync establishes active bridge
    const s1 = await ctrl.syncAllWindows();
    assert.equal(s1.ok, true);
    assert.equal(ctrl.getBridgeStatus().state, 'active');

    // Transient busy timeouts (miss 1 & miss 2) MUST hold state='active' (no false restart banner)
    cdpVersionMode = 'timeout';
    const s2 = await ctrl.syncAllWindows();
    assert.equal(s2.reason, 'cdp_transient_busy');
    assert.equal(ctrl.getBridgeStatus().state, 'active', 'Miss #1 must hold active');

    const s3 = await ctrl.syncAllWindows();
    assert.equal(s3.reason, 'cdp_transient_busy');
    assert.equal(ctrl.getBridgeStatus().state, 'active', 'Miss #2 within tolerance must hold active');

    // Active overlay HTTP heartbeat keeps bridge 'active' even past miss #3
    const info = ctrl.getBridgeInfo();
    const hbRes = await fetch(`http://127.0.0.1:${info.port}/api/telemetry`, {
      headers: {
        Origin: 'https://127.0.0.1:9000',
        'X-Usage-Monitor-Token': info.token,
      },
    });
    assert.equal(hbRes.status, 200);
    const s4 = await ctrl.syncAllWindows();
    assert.equal(s4.reason, 'cdp_transient_busy');
    assert.equal(ctrl.getBridgeStatus().state, 'active', 'Recent authenticated overlay heartbeat suppresses false cdp_unreachable');

    // Recovery resets miss counter cleanly
    cdpVersionMode = 'live';
    const s5 = await ctrl.syncAllWindows();
    assert.equal(s5.ok, true);
    assert.equal(ctrl.getBridgeStatus().state, 'active');

    // Genuine host exit (ECONNREFUSED) transitions to 'cdp_unreachable' immediately even after recent heartbeat
    cdpVersionMode = 'refused';
    const s6 = await ctrl.syncAllWindows();
    assert.equal(s6.reason, 'cdp_unreachable');
    assert.equal(ctrl.getBridgeStatus().state, 'cdp_unreachable', 'Hard ECONNREFUSED surfaces cdp_unreachable immediately');
  } finally {
    if (ctrl) await ctrl.stop();
    await new Promise((r) => cdpSrv.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
