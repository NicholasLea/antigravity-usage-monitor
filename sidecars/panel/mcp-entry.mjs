/**
 * @fileoverview 零工具开销的轻量 MCP Stdio 宿主保活入口 (`mcp_config.json`)。
 *
 * 设计原因：
 * Antigravity IDE 默认关闭了 UI Sidecar 管理器 (`enable-sidecars = false`)，不会启动 `sidecar.json`。
 * 通过将本文件注册为插件内置的 0 工具 MCP Stdio 服务：
 * 1. `agy --hub` 启动或启用插件时会自动拉起本进程，从而托管启动 `bridge-daemon.mjs` 将胶囊挂载至 IDE 顶栏；
 * 2. `tools/list` 返回空数组 `[]`，不注入任何工具定义，消耗 0 个上下文 Token；
 * 3. 用户在 Customizations 中关闭插件开关或退出 IDE 时，`agy --hub` 关闭 `stdin`，
 *    本进程立即通知 `bridge-daemon.mjs` 卸载窗口顶栏组件并干净退出。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(dirname(PANEL_DIR)), 'plugin.json');
const DAEMON_SCRIPT_PATH = join(PANEL_DIR, 'bridge-daemon.mjs');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

export function readMcpServerVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略清单读取失败
  }
  return '1.4.4';
}

/**
 * 纯函数处理单条 MCP JSON-RPC 2.0 消息；通知类消息（无 `id`）返回 `null`。
 *
 * @param {object} msg
 * @param {string} [serverVersion='1.4.4']
 * @returns {object|null}
 */
export function handleMcpJsonRpcMessage(msg, serverVersion = '1.4.4') {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) {
    return null;
  }
  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'usage-monitor-host',
          version: serverVersion,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

/**
 * 判断父进程（或包裹外壳的祖父进程）命令行是否属于一次性无头 `agy` CLI 调用
 * （如 `agy -p ... --output-format json`）。
 * 此类短命 CLI 子进程无需派生独立的 `bridge-daemon.mjs`，避免争抢桌面端顶栏租约或在退出时卸载桌面胶囊。
 *
 * @param {string} cmdLine
 * @returns {boolean}
 */
export function isOneShotCliParentCommand(cmdLine) {
  const cmd = String(cmdLine || '').trim();
  if (!cmd) return false;
  const isAgyCli = /(?:^|[\s/\\"'])(?:agy|antigravity-cli)(?:\.exe)?(?:["'\s]|$)/i.test(cmd);
  if (!isAgyCli) return false;
  if (/(?:^|\s)(?:--hub\b|remote-control\b)/i.test(cmd)) return false;
  return /(?:^|\s)(?:-p\b|--print\b|--print-timeout\b|--output-format\b)/.test(cmd);
}

function isShellWrapperCommand(cmdLine) {
  return /(?:^|[\s/\\"'])(?:cmd|powershell|pwsh|sh|bash|zsh|dash|env|node)(?:\.exe)?(?:["'\s]|$)/i.test(
    String(cmdLine || '')
  );
}

function execFileStdoutAsync(execFileFn, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFileFn(file, args, options, (err, stdout) => {
        if (err) {
          resolve('');
          return;
        }
        resolve(String(stdout || '').trim());
      });
    } catch {
      resolve('');
    }
  });
}

function parseLinuxProcParentPid(statText) {
  const s = String(statText || '');
  const rp = s.lastIndexOf(')');
  if (rp < 0) return 0;
  const fields = s
    .slice(rp + 1)
    .trim()
    .split(/\s+/);
  // `/proc/<pid>/stat` 右括号后的第 1 项是 state，第 2 项是 ppid
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid > 1 ? ppid : 0;
}

async function readAncestorCommandLinesAsync(
  ppid,
  {
    platform = process.platform,
    execFileFn = execFile,
    readFileSyncFn = readFileSync,
    existsSyncFn = existsSync,
  } = {}
) {
  const pid = Number(ppid);
  if (!Number.isInteger(pid) || pid <= 1) return [];
  try {
    if (platform === 'linux' && existsSyncFn('/proc')) {
      const cmds = [];
      const parentCmdPath = `/proc/${pid}/cmdline`;
      let parentCmd = '';
      if (existsSyncFn(parentCmdPath)) {
        parentCmd = String(readFileSyncFn(parentCmdPath, 'utf8') || '')
          .replace(/\0+/g, ' ')
          .trim();
        if (parentCmd) cmds.push(parentCmd);
      }
      if (!isOneShotCliParentCommand(parentCmd) && (!parentCmd || isShellWrapperCommand(parentCmd))) {
        const statPath = `/proc/${pid}/stat`;
        if (existsSyncFn(statPath)) {
          const grandPid = parseLinuxProcParentPid(readFileSyncFn(statPath, 'utf8'));
          const grandCmdPath = grandPid > 1 ? `/proc/${grandPid}/cmdline` : '';
          if (grandCmdPath && existsSyncFn(grandCmdPath)) {
            const grandCmd = String(readFileSyncFn(grandCmdPath, 'utf8') || '')
              .replace(/\0+/g, ' ')
              .trim();
            if (grandCmd) cmds.push(grandCmd);
          }
        }
      }
      return cmds;
    }

    if (platform === 'win32') {
      const psScript =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        `if ($p) { $out = @(); if ($p.CommandLine) { $out += [string]$p.CommandLine }; ` +
        `if ($p.ParentProcessId -gt 1) { $g = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); ` +
        `if ($g -and $g.CommandLine) { $out += [string]$g.CommandLine } }; ` +
        `if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress } }`;
      const raw = await execFileStdoutAsync(
        execFileFn,
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        {
          encoding: 'utf8',
          timeout: 1500,
          windowsHide: true,
        }
      );
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }

    const firstOut = await execFileStdoutAsync(
      execFileFn,
      'ps',
      ['-o', 'ppid=,command=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 500 }
    );
    const match = firstOut.match(/^(\d+)\s+(.+)$/);
    if (!match) return firstOut ? [firstOut] : [];
    const grandPid = Number(match[1]);
    const parentCmd = match[2].trim();
    const cmds = parentCmd ? [parentCmd] : [];
    if (
      grandPid > 1 &&
      !isOneShotCliParentCommand(parentCmd) &&
      (!parentCmd || isShellWrapperCommand(parentCmd))
    ) {
      const grandCmd = await execFileStdoutAsync(
        execFileFn,
        'ps',
        ['-o', 'command=', '-p', String(grandPid)],
        { encoding: 'utf8', timeout: 500 }
      );
      if (grandCmd) cmds.push(grandCmd);
    }
    return cmds;
  } catch {
    return [];
  }
}

/**
 * 异步检测父进程（及单层外壳祖父进程）是否属于一次性无头 `agy` CLI。
 * 保持完全异步，确保 Windows 上 `powershell.exe` 探测不会阻塞 MCP Stdio `initialize` 握手。
 *
 * @param {number} [ppid=process.ppid]
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function shouldSkipDaemonForParentProcess(ppid = process.ppid, options = {}) {
  const cmdLines = await readAncestorCommandLinesAsync(ppid, options);
  return cmdLines.some((cmd) => isOneShotCliParentCommand(cmd));
}

function startMcpHostSupervisor() {
  const serverVersion = readMcpServerVersion();
  let shuttingDown = false;
  let daemonChild = null;
  let respawnTimer = null;
  let rapidCrashCount = 0;
  let lastSpawnMs = 0;

  function spawnDaemon() {
    if (shuttingDown) return;
    lastSpawnMs = Date.now();
    const child = spawn(process.execPath, [DAEMON_SCRIPT_PATH], {
      cwd: PANEL_DIR,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        USAGE_MONITOR_HOST_PPID: `${process.ppid || 0},${process.pid || 0}`,
      },
    });
    daemonChild = child;

    child.stderr?.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // 忽略日志转发异常
      }
    });

    child.on('exit', (code) => {
      if (daemonChild === child) {
        daemonChild = null;
      }
      if (shuttingDown) return;

      const ranDurationMs = Date.now() - lastSpawnMs;
      let delayMs = code === 0 ? 120 : 350;
      if (code !== 0 && ranDurationMs < 10_000) {
        rapidCrashCount += 1;
        delayMs = Math.min(30_000, 1000 * 2 ** Math.min(rapidCrashCount - 1, 5));
      } else {
        rapidCrashCount = 0;
      }

      if (respawnTimer) clearTimeout(respawnTimer);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        spawnDaemon();
      }, delayMs);
    });

    child.on('error', () => {
      // 交由 exit 回调或退避重试统一处理
    });
  }

  function shutdownSupervisor() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    const child = daemonChild;
    if (!child) {
      process.exit(0);
      return;
    }
    const forceExitTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略强杀异常
      }
      process.exit(0);
    }, 1800);
    forceExitTimer.unref?.();

    child.once('exit', () => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });

    try {
      child.stdin?.write('SHUTDOWN_DISPOSE\n');
      child.stdin?.end();
    } catch {
      try {
        child.kill();
      } catch {
        // 忽略异常
      }
      process.exit(0);
    }
  }

  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  function writeJsonRpcResponse(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  function dispatchParsedPayload(parsed, mode) {
    if (Array.isArray(parsed)) {
      const batchOut = parsed
        .map((item) => handleMcpJsonRpcMessage(item, serverVersion))
        .filter(Boolean);
      if (batchOut.length > 0) {
        writeJsonRpcResponse(batchOut, mode);
      }
      return;
    }
    const response = handleMcpJsonRpcMessage(parsed, serverVersion);
    if (response) {
      writeJsonRpcResponse(response, mode);
    }
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch {
          // 忽略损坏帧
        }
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });

  process.stdin.on('end', shutdownSupervisor);
  process.stdin.on('close', shutdownSupervisor);
  process.on('SIGTERM', shutdownSupervisor);
  process.on('SIGINT', shutdownSupervisor);
  process.stdin.resume();

  void shouldSkipDaemonForParentProcess(process.ppid, { platform: process.platform })
    .then((skipDaemon) => {
      if (!shuttingDown && !skipDaemon) {
        spawnDaemon();
      }
    })
    .catch(() => {
      if (!shuttingDown) {
        spawnDaemon();
      }
    });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startMcpHostSupervisor();
}

