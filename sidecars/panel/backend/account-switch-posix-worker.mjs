#!/usr/bin/env node
/**
 * @fileoverview Detached out-of-session POSIX/WSL2 account switch orchestrator.
 *
 * Receives the one-time switch payload over `stdin` (never touching disk in plaintext
 * and never exposing tokens in `ps` arguments), gracefully stops running Antigravity
 * Desktop / IDE & `language_server` / `agy --hub` processes so stale in-memory
 * `TokenSource` instances cannot clobber the keyring, writes the new credential +
 * `app_storage.json` onboarding state, cleans up stale `DevToolsActivePort` files,
 * and relaunches the stopped client(s).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendWslBridgeEnv,
  isWslEnvironment,
  runPosixCredentialStore,
  writeSwitchStatusFile,
} from './account-keyring-store.mjs';
import {
  REMOTE_DEBUG_LAUNCH_FLAG,
  buildSanitizedDesktopRelaunchEnv,
  resolveDesktopHostExecutable,
} from './desktop-launcher-config.mjs';
import { resolveDevToolsPortCandidates } from './window-bridge.mjs';

process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdinJson(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => {
      reject(new Error('switchStartFailed'));
    }, timeoutMs);
    timer.unref?.();

    process.stdin.on('data', (chunk) => {
      total += chunk.length;
      if (total > 65536) {
        clearTimeout(timer);
        reject(new Error('credentialTooLarge'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } finally {
        buf.fill(0);
      }
    });
  });
}

const DARWIN_HELPER_OR_NODE_CMD_RE =
  /(?:^|\s)(?:--type|--import|--inspect|--inspect-brk|--ms-enable-electron-run-as-node)(?:=|\s)/;

export function inspectAndStopDarwinClients(
  homeDir,
  env,
  {
    runSpawn = spawnSync,
    myUid = typeof process.getuid === 'function' ? process.getuid() : null,
    selfPid = process.pid,
    resolveFallbackFn = resolveDesktopHostExecutable,
  } = {}
) {
  const psRes = runSpawn('/bin/ps', ['-axo', 'pid=,uid=,command='], {
    encoding: 'utf8',
    timeout: 4000,
    env,
  });
  const lines = String(psRes?.stdout || '').split(/\r?\n/);
  const bundlesToRestart = new Map();
  const rootPids = new Set();
  const hubPids = new Set();

  for (const rawLine of lines) {
    const m = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const uid = Number(m[2]);
    const cmd = m[3];
    if (!pid || pid === selfPid) continue;
    if (typeof myUid === 'number' && Number.isInteger(uid) && uid !== myUid) continue;
    if (cmd.includes('account-switch-posix-worker.mjs')) continue;

    const bundleMatch = cmd.match(/^(\/[^\r\n]*?\/Antigravity(?:\s+IDE)?\.app)\/Contents\/MacOS\/([^\s]+)/i);
    if (bundleMatch) {
      const bundlePath = bundleMatch[1];
      const isHelperOrNode =
        /helper/i.test(cmd) ||
        /\(monitor\)\.app\/Contents\/MacOS\//i.test(cmd) ||
        DARWIN_HELPER_OR_NODE_CMD_RE.test(cmd) ||
        cmd.includes('sidecar_sdk/register_loader.js');
      if (!isHelperOrNode) {
        const hasDebug = /--remote-debugging-port(?:=|\s)/.test(cmd);
        const prev = bundlesToRestart.get(bundlePath);
        bundlesToRestart.set(bundlePath, {
          bundlePath,
          useDebugPort: Boolean(prev?.useDebugPort || hasDebug),
        });
        rootPids.add(pid);
      }
    }
    if (
      /\/language_server(?:_macos_[a-z0-9_]+)?(?:\s|$)/i.test(cmd) ||
      /\/agy(?:\s+.*)?\s--hub(?:\s|$)/.test(cmd)
    ) {
      hubPids.add(pid);
    }
  }

  if (bundlesToRestart.size === 0) {
    const fallback = resolveFallbackFn({ platform: 'darwin', env, homeDir });
    if (fallback?.found && fallback.appBundlePath) {
      bundlesToRestart.set(fallback.appBundlePath, {
        bundlePath: fallback.appBundlePath,
        useDebugPort: true,
      });
    }
  }

  for (const { bundlePath } of bundlesToRestart.values()) {
    runSpawn(
      '/usr/bin/osascript',
      ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', '--', bundlePath],
      { stdio: 'ignore', timeout: 3000, env }
    );
  }
  return { bundles: [...bundlesToRestart.values()], rootPids: [...rootPids], hubPids: [...hubPids] };
}

function isOwnedPosixPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH' && err?.code !== 'EPERM';
  }
}

async function waitAndForceClosePosixPids(targetPids) {
  const uniquePids = [...new Set(targetPids)].filter((p) => p > 0 && p !== process.pid);
  for (let i = 0; i < 15; i += 1) {
    if (uniquePids.every((p) => !isOwnedPosixPidAlive(p))) return true;
    await sleep(200);
  }
  for (const pid of uniquePids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore already exited
    }
  }
  for (let i = 0; i < 15; i += 1) {
    if (uniquePids.every((p) => !isOwnedPosixPidAlive(p))) return true;
    await sleep(200);
  }
  for (const pid of uniquePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore already exited
    }
  }
  for (let i = 0; i < 10; i += 1) {
    if (uniquePids.every((p) => !isOwnedPosixPidAlive(p))) return true;
    await sleep(150);
  }
  return uniquePids.every((p) => !isOwnedPosixPidAlive(p));
}

const LINUX_AG_CLIENT_LEAF_RE =
  /^(?:google[-_])?antigravity(?:[-_.\s]*ide)?(?:$|[-_.]v?\d[\w.-]*$|[-_][\w.-]*\.appimage$|\.appimage$)/i;
const LINUX_NON_CLIENT_LEAF_RE =
  /(?:^|[-_.])(?:cli|server|helper|sandbox|crashpad|updater|tunnel|daemon|monitor)(?:$|[-_.])/i;

export function classifyLinuxProcCandidate({ exePath = '', argv = [], rawEnviron = '' } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const cmdJoined = argv.join(' ');
  if (cmdJoined.includes('account-switch-posix-worker.mjs')) return null;

  let appImagePath = '';
  let hasRunAsNodeEnv = false;
  if (rawEnviron) {
    for (const kv of String(rawEnviron).split('\0')) {
      if (kv.startsWith('APPIMAGE=')) {
        appImagePath = kv.slice('APPIMAGE='.length).trim();
      } else if (kv === 'ELECTRON_RUN_AS_NODE=1') {
        hasRunAsNodeEnv = true;
      }
    }
  }

  const exeLeaf = basename(exePath || argv[0] || '').toLowerCase();
  if (/^(?:language_server.*|agy)$/i.test(exeLeaf)) {
    if (exeLeaf.startsWith('language_server') || argv.includes('--hub')) {
      return { role: 'hub', restartExe: '', useDebugPort: false };
    }
    return null;
  }

  const isDirectClientLeaf =
    LINUX_AG_CLIENT_LEAF_RE.test(exeLeaf) && !LINUX_NON_CLIENT_LEAF_RE.test(exeLeaf);
  const appImageLeaf = basename(appImagePath).toLowerCase();
  const isMountedAppImageClient =
    !isDirectClientLeaf &&
    Boolean(appImagePath) &&
    String(exePath).includes('/.mount_') &&
    LINUX_AG_CLIENT_LEAF_RE.test(appImageLeaf) &&
    !LINUX_NON_CLIENT_LEAF_RE.test(appImageLeaf) &&
    /^(?:antigravity|antigravity-ide|apprun|electron)$/i.test(exeLeaf);

  if (!isDirectClientLeaf && !isMountedAppImageClient) {
    return null;
  }

  const isHelperOrNode =
    hasRunAsNodeEnv ||
    argv.some(
      (a) =>
        a.startsWith('--type=') ||
        a.startsWith('--import=') ||
        a.startsWith('--ms-enable-electron-run-as-node') ||
        a.includes('sidecar_sdk/register_loader.js')
    );

  if (isHelperOrNode) {
    return { role: 'client-helper', restartExe: '', useDebugPort: false };
  }

  const launchExe =
    appImagePath && (String(exePath).includes('/.mount_') || isDirectClientLeaf)
      ? appImagePath
      : exePath;
  const restartExe = launchExe && !launchExe.includes('/.mount_') ? launchExe : '';
  const useDebugPort = argv.some((a) => a.startsWith('--remote-debugging-port'));
  return { role: 'client-root', restartExe, useDebugPort };
}

function inspectLinuxClients(homeDir, env) {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const exesToRestart = new Map();
  const rootPids = new Set();
  const clientPids = new Set();
  const hubPids = new Set();

  if (existsSync('/proc')) {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!pid || pid === process.pid) continue;
      const procDir = `/proc/${pid}`;
      try {
        if (myUid !== null) {
          const st = statSync(procDir);
          if (st.uid !== myUid) continue;
        }
        const rawCmd = readFileSync(`${procDir}/cmdline`).toString('utf8');
        const argv = rawCmd.split('\0').filter(Boolean);
        if (!argv.length) continue;

        let exePath = '';
        try {
          exePath = readlinkSync(`${procDir}/exe`).replace(/ \(deleted\)$/, '');
        } catch {
          exePath = argv[0];
        }
        let rawEnv = '';
        try {
          rawEnv = readFileSync(`${procDir}/environ`).toString('utf8');
        } catch {
          // Ignore unreadable environ
        }

        const classified = classifyLinuxProcCandidate({ exePath, argv, rawEnviron: rawEnv });
        if (!classified) continue;

        if (classified.role === 'hub') {
          hubPids.add(pid);
          continue;
        }

        clientPids.add(pid);
        if (classified.role === 'client-root') {
          rootPids.add(pid);
          if (classified.restartExe) {
            const prev = exesToRestart.get(classified.restartExe);
            exesToRestart.set(classified.restartExe, {
              executablePath: classified.restartExe,
              useDebugPort: Boolean(prev?.useDebugPort || classified.useDebugPort),
            });
          }
        }
      } catch {
        // Process exited mid-scan
      }
    }
  }

  if (exesToRestart.size === 0) {
    const fallback = resolveDesktopHostExecutable({ platform: 'linux', env, homeDir });
    if (fallback.found && fallback.executablePath) {
      exesToRestart.set(fallback.executablePath, {
        executablePath: fallback.executablePath,
        useDebugPort: true,
      });
    }
  }

    return {
      clients: [...exesToRestart.values()],
      rootPids: [...rootPids],
      pids: [...clientPids, ...hubPids],
    };
}

function stopAndRecordWslWindowsClients(env) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sid = (Get-Process -Id $PID).SessionId
$procs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe' OR Name='Antigravity IDE.exe'" | Where-Object { $_.SessionId -eq $sid -and $_.ExecutablePath -and $_.CommandLine -notmatch '--type=' })
$exes = @($procs | Select-Object -ExpandProperty ExecutablePath -Unique)
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) { [void]$gp.CloseMainWindow() }
}
Start-Sleep -Milliseconds 900
Get-Process -Name 'Antigravity','Antigravity IDE','language_server*' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sid } | Stop-Process -Force -ErrorAction SilentlyContinue
ConvertTo-Json -Compress @($exes)
`.trim();
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env }
  );
  try {
    const parsed = JSON.parse(String(res.stdout || '').trim().split(/\r?\n/).at(-1) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

function relaunchWslWindowsClients(winExes, env) {
  for (const exe of winExes) {
    const bridgeEnv = appendWslBridgeEnv({ ...env, UM_WIN_EXE: exe }, ['UM_WIN_EXE']);
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$ErrorActionPreference = "Stop"; $wd = Split-Path -Parent $env:UM_WIN_EXE; Start-Process -FilePath $env:UM_WIN_EXE -ArgumentList "--remote-debugging-port=0" -WorkingDirectory $wd',
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 8000, env: bridgeEnv }
    );
    if (res?.error || res?.status !== 0) {
      throw new Error('clientRestartFailed');
    }
  }
}

function spawnDetachedClientSafely(cmd, args, opts) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, opts);
    } catch (err) {
      rejectPromise(err);
      return;
    }
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.on('error', () => {});
      child.unref?.();
      resolvePromise();
    });
  });
}

function removeStaleDevToolsPortFiles(platform, homeDir, env) {
  try {
    const candidates = resolveDevToolsPortCandidates(env, platform, homeDir);
    for (const item of candidates) {
      const fp = typeof item === 'string' ? item : item?.path;
      if (fp && existsSync(fp)) {
        try {
          unlinkSync(fp);
        } catch {
          // Ignore locked or already deleted port file
        }
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

async function main() {
  let job = null;
  try {
    job = await readStdinJson();
    await sleep(350);

    const platform = job.platform || process.platform;
    const homeDir = job.homeDir || homedir();
    const env = process.env;
    const wslMode = isWslEnvironment({ platform, env });

    let darwinSnap = null;
    let linuxSnap = null;
    let wslWinExes = [];
    let closeFailed = false;

    if (platform === 'darwin') {
      darwinSnap = inspectAndStopDarwinClients(homeDir, env);
      const closed = await waitAndForceClosePosixPids([
        ...darwinSnap.rootPids,
        ...darwinSnap.hubPids,
      ]);
      if (!closed) {
        closeFailed = true;
        writeSwitchStatusFile(job.statusFile, job.email, 'failed', 'clientCloseFailed');
      }
    } else if (platform === 'linux') {
      linuxSnap = inspectLinuxClients(homeDir, env);
      if (linuxSnap.pids.length > 0) {
        for (const pid of linuxSnap.pids) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // Ignore
          }
        }
        const closed = await waitAndForceClosePosixPids(linuxSnap.pids);
        if (!closed) {
          closeFailed = true;
          writeSwitchStatusFile(job.statusFile, job.email, 'failed', 'clientCloseFailed');
        }
      }
      if (!closeFailed && wslMode) {
        wslWinExes = stopAndRecordWslWindowsClients(env);
      }
    }

    let switchRes = null;
    if (!closeFailed) {
      switchRes = await runPosixCredentialStore(
        {
          ...job,
          action: 'switch',
        },
        { platform, env, homeDir, runSpawn: spawnSync }
      );

      if (switchRes?.error) {
        writeSwitchStatusFile(job.statusFile, job.email, 'failed', switchRes.error);
      }
    }

    const guiAlreadyExited =
      platform === 'darwin'
        ? (darwinSnap?.rootPids || []).every((p) => !isOwnedPosixPidAlive(p))
        : (linuxSnap?.rootPids || []).every((p) => !isOwnedPosixPidAlive(p));

    if (!closeFailed || guiAlreadyExited) {
      removeStaleDevToolsPortFiles(platform, homeDir, env);
      const cleanEnv = buildSanitizedDesktopRelaunchEnv(env);

      try {
        if (platform === 'darwin' && darwinSnap?.bundles?.length) {
          for (const item of darwinSnap.bundles) {
            const openArgs = item.useDebugPort
              ? ['-a', item.bundlePath, '--args', REMOTE_DEBUG_LAUNCH_FLAG]
              : ['-a', item.bundlePath];
            await spawnDetachedClientSafely('/usr/bin/open', openArgs, {
              detached: true,
              stdio: 'ignore',
              env: cleanEnv,
            });
          }
        } else if (platform === 'linux') {
          if (linuxSnap?.clients?.length) {
            for (const item of linuxSnap.clients) {
              const args = item.useDebugPort ? [REMOTE_DEBUG_LAUNCH_FLAG] : [];
              await spawnDetachedClientSafely(item.executablePath, args, {
                detached: true,
                stdio: 'ignore',
                cwd: homeDir,
                env: cleanEnv,
              });
            }
          }
          if (wslWinExes.length > 0) {
            relaunchWslWindowsClients(wslWinExes, cleanEnv);
          }
        }
      } catch {
        if (!closeFailed && !switchRes?.error) {
          writeSwitchStatusFile(job.statusFile, job.email, 'failed', 'clientRestartFailed');
        }
      }
    }
  } catch (err) {
    if (job?.statusFile) {
      writeSwitchStatusFile(job.statusFile, job.email, 'failed', err?.message || 'storeFailed');
    }
  }
}

const isWorkerEntryPoint =
  Boolean(process.argv[1]) &&
  (resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    basename(process.argv[1]) === 'account-switch-posix-worker.mjs');

if (isWorkerEntryPoint) {
  void main();
}
