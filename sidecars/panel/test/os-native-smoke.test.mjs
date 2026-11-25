import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  IDE_SSH_REMOTE_PROBE_SH,
  parseRemoteProbeStdout,
} from '../backend/ide-remote-ssh.mjs';
import {
  createMacOsLaunchWrapper,
  inspectMacOsLaunchWrapperStatus,
  removeMacOsLaunchWrapper,
  triggerDesktopHostRelaunch,
} from '../backend/desktop-launcher-config.mjs';

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  'POSIX native smoke: sh -s stdin probe (and zsh login-shell wrapping) preserves ===UM_DAEMON_JSON=== and parses daemon JSON',
  { skip: process.platform === 'win32' },
  () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-posix-ssh-smoke-'));
    try {
      const daemonDir = path.join(tmpHome, '.gemini', 'antigravity', 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, 'hub_native.json'),
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: 43210,
            httpsPort: 43211,
            csrfToken: 'native-posix-daemon-tok',
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const shStdout = execFileSync('/bin/sh', ['-s'], {
        encoding: 'utf8',
        input: `${IDE_SSH_REMOTE_PROBE_SH}\n`,
        env: { ...process.env, HOME: tmpHome },
      });
      assert.equal(shStdout.includes('===UM_DAEMON_JSON==='), true);
      const parsed = parseRemoteProbeStdout(shStdout);
      assert.ok(
        parsed.some(
          (c) =>
            c.source === 'daemon' &&
            c.csrfToken === 'native-posix-daemon-tok' &&
            c.ports.includes(43210)
        ),
        `Expected real daemon candidate from sh -s, got: ${JSON.stringify(parsed)}`
      );

      // Verify zsh login shell (default on macOS) cleanly executes `sh -s` without glob errors
      if (fs.existsSync('/bin/zsh')) {
        const zshStdout = execFileSync('/bin/zsh', ['-c', 'sh -s'], {
          encoding: 'utf8',
          input: `${IDE_SSH_REMOTE_PROBE_SH}\n`,
          env: { ...process.env, HOME: tmpHome },
        });
        const parsedZsh = parseRemoteProbeStdout(zshStdout);
        assert.ok(
          parsedZsh.some((c) => c.csrfToken === 'native-posix-daemon-tok'),
          'zsh login shell invoking sh -s must extract daemon JSON cleanly'
        );
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }
);

test(
  'macOS native smoke: BSD ps + awk ENVIRON finds bundle PID without self-match and managed .app wrapper round-trips cleanly',
  { skip: process.platform !== 'darwin' },
  async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-darwin-smoke-'));
    let mainChild = null;
    let helperChild = null;
    try {
      const appsDir = path.join(tmpHome, 'Applications');
      const fakeApp = path.join(appsDir, 'Antigravity.app');
      const macOsDir = path.join(fakeApp, 'Contents', 'MacOS');
      const resDir = path.join(fakeApp, 'Contents', 'Resources');
      fs.mkdirSync(macOsDir, { recursive: true });
      fs.mkdirSync(resDir, { recursive: true });

      const mainBin = path.join(macOsDir, 'Antigravity');
      const helperBin = path.join(macOsDir, 'Antigravity Helper');
      fs.symlinkSync(process.execPath, mainBin);
      fs.symlinkSync(process.execPath, helperBin);

      let capturedMac = null;
      const relaunchPlan = await triggerDesktopHostRelaunch({
        platform: 'darwin',
        homeDir: tmpHome,
        preferredProduct: 'desktop',
        allowInTest: true,
        spawnFn: async (_file, args, opts) => {
          capturedMac = { script: args[1], env: opts.env };
          return { pid: 1 };
        },
      });
      assert.equal(relaunchPlan.ok, true);
      assert.ok(capturedMac?.script && capturedMac?.env?.AGY_BUNDLE_MACOS);

      // Extract exact find_main_pids / find_bundle_pids / is_alive definitions from production script
      const fnPrefix = capturedMac.script.split('; if osascript ')[0].replace(/^sleep [^;]+;\s*/, '');

      // Before spawning: is_alive must be false (proves zero self-match on real BSD ps!)
      const beforeOut = execFileSync('/bin/sh', ['-c', `${fnPrefix}; if is_alive; then echo ALIVE; else echo DEAD; fi`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      }).trim();
      assert.equal(beforeOut, 'DEAD', 'is_alive must NOT self-match on real macOS BSD ps');

      // Spawn fake main + helper processes under Contents/MacOS/ (argv[0] preserves bundle path on macOS BSD ps)
      mainChild = spawn(mainBin, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      helperChild = spawn(helperBin, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      await waitMs(180);

      const liveMainPids = execFileSync('/bin/sh', ['-c', `${fnPrefix}; find_main_pids`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(
        liveMainPids.includes(String(mainChild.pid)),
        true,
        `find_main_pids must detect live main PID ${mainChild.pid}, got: ${JSON.stringify(liveMainPids)}`
      );
      assert.equal(
        liveMainPids.includes(String(helperChild.pid)),
        false,
        'find_main_pids must exclude Helper process'
      );

      mainChild.kill('SIGTERM');
      await waitMs(120);

      const afterOut = execFileSync('/bin/sh', ['-c', `${fnPrefix}; if is_alive; then echo ALIVE; else echo DEAD; fi`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      }).trim();
      assert.equal(afterOut, 'DEAD', 'is_alive must immediately turn false after main process exits');

      // Also verify real macOS wrapper creation + lsregister + removal in isolated temp homeDir
      const created = await createMacOsLaunchWrapper({
        product: 'desktop',
        platform: 'darwin',
        homeDir: tmpHome,
        allowInTest: true,
      });
      assert.equal(created.ok, true);
      assert.equal(inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: tmpHome }).desktopExists, true);
      const removed = removeMacOsLaunchWrapper({
        product: 'desktop',
        platform: 'darwin',
        homeDir: tmpHome,
        allowInTest: true,
      });
      assert.equal(removed.ok, true);
      assert.equal(inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: tmpHome }).exists, false);
    } finally {
      try {
        mainChild?.kill('SIGKILL');
      } catch {}
      try {
        helperChild?.kill('SIGKILL');
      } catch {}
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }
);

test(
  'Linux native smoke: collect_pids() resolves symlinked launcher binary against real /proc/<pid>/exe',
  { skip: process.platform !== 'linux' },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-linux-smoke-'));
    let child = null;
    try {
      const sleepTarget = fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep';
      const symlinkBin = path.join(tmpDir, 'antigravity');
      fs.symlinkSync(sleepTarget, symlinkBin);

      let capturedLinux = null;
      const relaunchPlan = await triggerDesktopHostRelaunch({
        platform: 'linux',
        homeDir: tmpDir,
        preferredProduct: 'desktop',
        allowInTest: true,
        existsFn: (p) => p === symlinkBin,
        env: { ...process.env, APPIMAGE: '' },
        execFileFn: async () => `${symlinkBin}\n`,
        spawnFn: async (_file, args, opts) => {
          capturedLinux = { script: args[1], env: opts.env };
          return { pid: 1 };
        },
      });
      assert.equal(relaunchPlan.ok, true);
      assert.equal(capturedLinux?.env?.AGY_RELAUNCH_EXE, symlinkBin);

      child = spawn(symlinkBin, ['30'], { stdio: 'ignore' });
      await waitMs(120);

      const fnPrefix = capturedLinux.script.split('; pids=')[0].replace(/^sleep [^;]+;\s*/, '');
      const foundPids = execFileSync('/bin/sh', ['-c', `${fnPrefix}; collect_pids`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedLinux.env },
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(
        foundPids.includes(String(child.pid)),
        true,
        `collect_pids() must match symlinked process PID ${child.pid} via readlink -f, got: ${JSON.stringify(foundPids)}`
      );
      assert.equal(
        foundPids.includes(String(process.pid)),
        false,
        'collect_pids() must not match unrelated node test runner'
      );
    } finally {
      try {
        child?.kill('SIGKILL');
      } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);
