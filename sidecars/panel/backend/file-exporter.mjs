/**
 * @fileoverview 本机安全文件导出及系统文件管理器定位模块 (`file-exporter.mjs`)。
 * 仅允许导出受控白名单扩展名（.json / .csv / .md / .txt / .xlsx，含 UTF-8 文本和 Base64 二进制工作簿），
 * 严格清洗文件名防止路径穿越，并仅对本次进程实际导出的文件路径开放系统文件管理器定位能力。
 */

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { decodeWorkspaceFileUriToPath } from '../shared/workspace-uri.mjs';
import { isPathInsideRoot, resolveNoFollowPath } from './session-store.mjs';

export const MAX_EXPORT_FILE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_EXPORT_EXTENSIONS = Object.freeze(['.json', '.csv', '.md', '.txt', '.xlsx']);
const ALLOWED_EXT_SET = new Set(ALLOWED_EXPORT_EXTENSIONS);
const MAX_RECENT_EXPORT_TRACK = 64;

const recentExportedPaths = new Set();

function recordExportedPath(absPath) {
  const normalized = path.resolve(String(absPath || ''));
  if (!normalized) return;
  if (recentExportedPaths.has(normalized)) {
    recentExportedPaths.delete(normalized);
  }
  recentExportedPaths.add(normalized);
  while (recentExportedPaths.size > MAX_RECENT_EXPORT_TRACK) {
    const oldest = recentExportedPaths.values().next().value;
    if (!oldest) break;
    recentExportedPaths.delete(oldest);
  }
}

export function isAuthorizedExportPath(filePath) {
  const normalized = path.resolve(String(filePath || ''));
  return Boolean(normalized && recentExportedPaths.has(normalized));
}

function inferExtensionFromMime(mimeType) {
  const lower = String(mimeType || '').toLowerCase();
  if (lower.includes('spreadsheetml') || lower.includes('xlsx')) return '.xlsx';
  if (lower.includes('csv')) return '.csv';
  if (lower.includes('markdown')) return '.md';
  if (lower.includes('plain')) return '.txt';
  return '.json';
}

/**
 * 严格净化导出文件名：剥离目录段、过滤系统非法字符，并强制收敛到允许的文本扩展名白名单。
 *
 * @param {string} rawFilename
 * @param {string} [mimeType]
 * @returns {{ fileName: string, baseName: string, ext: string }}
 */
export function sanitizeLocalExportFilename(rawFilename, mimeType = '') {
  const leaf = path.basename(String(rawFilename || '').replace(/\\/g, '/')).trim();
  const parsedExt = path.extname(leaf).toLowerCase();
  const ext = ALLOWED_EXT_SET.has(parsedExt) ? parsedExt : inferExtensionFromMime(mimeType);
  const rawBase = ALLOWED_EXT_SET.has(parsedExt) ? leaf.slice(0, -parsedExt.length) : leaf;
  const cleanedBase = rawBase
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '')
    .slice(0, 80);
  const baseName = cleanedBase || 'export';
  return {
    fileName: `${baseName}${ext}`,
    baseName,
    ext,
  };
}

/**
 * 解析本机导出目录：优先使用用户系统 Downloads 目录，不存在时自动回退到插件 `.data/exports`。
 *
 * @param {{ overrideDir?: string, homeDir?: string, fallbackDataDir?: string }} [options]
 * @returns {{ dirPath: string, source: 'override' | 'downloads' | 'data_exports' }}
 */
export function resolveExportDirectory({
  overrideDir = '',
  homeDir = os.homedir(),
  fallbackDataDir = DATA_DIR,
} = {}) {
  const custom = String(overrideDir || '').trim();
  if (custom) {
    const resolved = path.resolve(custom);
    mkdirSync(resolved, { recursive: true });
    return { dirPath: resolved, source: 'override' };
  }

  const downloadsDir = homeDir ? path.join(homeDir, 'Downloads') : '';
  if (downloadsDir) {
    try {
      if (existsSync(downloadsDir) && statSync(downloadsDir).isDirectory()) {
        return { dirPath: path.resolve(downloadsDir), source: 'downloads' };
      }
    } catch {
      // ignore stat errors and fall back cleanly
    }
  }

  const exportsDir = path.resolve(path.join(fallbackDataDir || DATA_DIR, 'exports'));
  mkdirSync(exportsDir, { recursive: true });
  return { dirPath: exportsDir, source: 'data_exports' };
}

/**
 * 将文本导出内容安全落盘到本机目录，遇同名文件自动追加 `(1)`、`(2)` 避免覆盖已有导出。
 *
 * @param {{ filename?: string, content?: string, mimeType?: string }} payload
 * @param {{ overrideDir?: string, homeDir?: string, fallbackDataDir?: string }} [options]
 * @returns {{ ok: boolean, status: number, filePath?: string, dirPath?: string, fileName?: string, bytes?: number, source?: string, error?: string }}
 */
export function writeLocalExportFile(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 400, error: 'Invalid export payload' };
  }
  if (typeof payload.content !== 'string') {
    return { ok: false, status: 400, error: 'Export content must be a string' };
  }
  const isBase64 = payload.encoding === 'base64';
  const { baseName, ext } = sanitizeLocalExportFilename(payload.filename, payload.mimeType);

  let writeData;
  let byteLen = 0;
  if (isBase64) {
    const cleanB64 = payload.content.replace(/\s+/g, '');
    if (!cleanB64 || !/^[A-Za-z0-9+/=]+$/.test(cleanB64)) {
      return { ok: false, status: 400, error: 'Invalid base64 export payload' };
    }
    const buf = Buffer.from(cleanB64, 'base64');
    byteLen = buf.length;
    if (byteLen > MAX_EXPORT_FILE_BYTES) {
      return { ok: false, status: 413, error: 'Export file exceeds size limit' };
    }
    if (ext === '.xlsx' && (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b)) {
      return { ok: false, status: 400, error: 'Invalid xlsx archive header' };
    }
    writeData = buf;
  } else {
    byteLen = Buffer.byteLength(payload.content, 'utf8');
    if (byteLen > MAX_EXPORT_FILE_BYTES) {
      return { ok: false, status: 413, error: 'Export file exceeds size limit' };
    }
    writeData = payload.content;
  }

  const { dirPath, source } = resolveExportDirectory(options);

  let targetPath = '';
  let finalFileName = '';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidateName = attempt === 0 ? `${baseName}${ext}` : `${baseName} (${attempt})${ext}`;
    const candidatePath = path.join(dirPath, candidateName);
    try {
      if (isBase64) {
        writeFileSync(candidatePath, writeData, { flag: 'wx' });
      } else {
        writeFileSync(candidatePath, writeData, { encoding: 'utf8', flag: 'wx' });
      }
      targetPath = path.resolve(candidatePath);
      finalFileName = candidateName;
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      return {
        ok: false,
        status: 500,
        error: err?.message || 'Failed to write export file',
      };
    }
  }

  if (!targetPath) {
    const fallbackName = `${baseName}-${Date.now()}${ext}`;
    const fallbackPath = path.join(dirPath, fallbackName);
    try {
      if (isBase64) {
        writeFileSync(fallbackPath, writeData, { flag: 'wx' });
      } else {
        writeFileSync(fallbackPath, writeData, { encoding: 'utf8', flag: 'wx' });
      }
      targetPath = path.resolve(fallbackPath);
      finalFileName = fallbackName;
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: err?.message || 'Failed to write export file',
      };
    }
  }

  recordExportedPath(targetPath);
  return {
    ok: true,
    status: 200,
    filePath: targetPath,
    dirPath,
    fileName: finalFileName,
    bytes: byteLen,
    source,
  };
}

/**
 * 在系统文件管理器中定位并高亮选中由本进程刚导出的受控文件。
 *
 * @param {string} filePath
 * @param {{ platform?: string, spawnFn?: typeof spawn }} [options]
 * @returns {{ ok: boolean, status: number, filePath?: string, error?: string }}
 */
export function revealLocalExportFile(
  filePath,
  { platform = process.platform, spawnFn = spawn } = {}
) {
  const raw = String(filePath || '').trim();
  if (!raw || /[\r\n"]/.test(raw)) {
    return { ok: false, status: 400, error: 'Invalid file path' };
  }
  const resolved = path.resolve(raw);
  if (!isAuthorizedExportPath(resolved)) {
    return { ok: false, status: 403, error: 'Path is not an authorized export file' };
  }
  if (!existsSync(resolved)) {
    return { ok: false, status: 404, error: 'Exported file no longer exists' };
  }

  try {
    let child = null;
    if (platform === 'win32') {
      child = spawnFn('explorer.exe', [`/select,"${resolved}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
        windowsHide: false,
      });
    } else if (platform === 'darwin') {
      child = spawnFn('open', ['-R', resolved], {
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawnFn('xdg-open', [path.dirname(resolved)], {
        detached: true,
        stdio: 'ignore',
      });
    }
    child?.on?.('error', () => {});
    child?.unref?.();
    return { ok: true, status: 200, filePath: resolved };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.message || 'Failed to open file manager',
    };
  }
}

function isExplicitAbsolutePath(rawPath, platform = process.platform) {
  const str = String(rawPath || '').trim();
  if (!str) return false;
  if (str.startsWith('//') || str.startsWith('\\\\')) {
    return false;
  }
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str) &&
    !/^[a-zA-Z]:[\\/]/.test(str)
  ) {
    return false;
  }
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(str);
  }
  return str.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(str);
}

function normalizeRevealComparePath(targetPath, platform = process.platform) {
  const abs = path.resolve(String(targetPath || ''));
  return platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * 在系统文件管理器中受控定位会话产物文件、已扫描项目目录或当前阅读消息中提取的本地文件路径。
 * 严格校验白名单边界与非符号链接，杜绝任意路径探测与命令参数注入。
 *
 * @param {string} rawPath
 * @param {{
 *   allowedRoots?: string[],
 *   allowedPaths?: Iterable<string>,
 *   platform?: string,
 *   spawnFn?: typeof spawn,
 * }} [options={}]
 * @returns {{ ok: boolean, status: number, filePath?: string, isDirectory?: boolean, error?: string }}
 */
export function revealLocalSessionPath(
  rawPath,
  { allowedRoots = [], allowedPaths = [], platform = process.platform, spawnFn = spawn } = {}
) {
  const clean = String(rawPath || '').trim();
  if (!clean || /[\r\n"\0]/.test(clean)) {
    return { ok: false, status: 400, error: 'Invalid session path' };
  }

  let candidate = clean;
  if (/^file:\/\//i.test(candidate)) {
    const hashIdx = candidate.indexOf('#');
    if (hashIdx >= 0) {
      candidate = candidate.slice(0, hashIdx);
    }
    candidate = decodeWorkspaceFileUriToPath(candidate);
  }
  if (!isExplicitAbsolutePath(candidate, platform)) {
    return { ok: false, status: 400, error: 'Invalid session path' };
  }
  const resolved = path.resolve(candidate);

  // 1. 校验是否在受控存储根目录内（逐级无符号链接）或命中精确授权路径白名单
  let authorized = false;
  for (const root of allowedRoots || []) {
    if (!root) continue;
    const absRoot = path.resolve(String(root));
    if (!isPathInsideRoot(resolved, absRoot, platform)) continue;
    const rel = path.relative(absRoot, resolved);
    const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    const check = resolveNoFollowPath(absRoot, segments);
    if (check.ok) {
      authorized = true;
      break;
    }
  }

  if (!authorized) {
    const cmpTarget = normalizeRevealComparePath(resolved, platform);
    for (const allowed of allowedPaths || []) {
      if (!allowed || !isExplicitAbsolutePath(allowed, platform)) continue;
      if (normalizeRevealComparePath(allowed, platform) === cmpTarget) {
        authorized = true;
        break;
      }
    }
  }

  if (!authorized) {
    return { ok: false, status: 403, error: 'Path is outside authorized session scope' };
  }

  let st;
  try {
    st = lstatSync(resolved);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, status: 404, error: 'Target path no longer exists' };
    }
    return { ok: false, status: 500, error: err?.message || 'Failed to inspect target path' };
  }

  if (st.isSymbolicLink()) {
    return { ok: false, status: 403, error: 'Symbolic links are not allowed' };
  }

  const isDirectory = st.isDirectory();
  try {
    let child = null;
    if (platform === 'win32') {
      if (isDirectory) {
        child = spawnFn('explorer.exe', [`"${resolved}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
          windowsHide: false,
        });
      } else {
        child = spawnFn('explorer.exe', [`/select,"${resolved}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
          windowsHide: false,
        });
      }
    } else if (platform === 'darwin') {
      child = spawnFn('open', isDirectory ? [resolved] : ['-R', resolved], {
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawnFn('xdg-open', [isDirectory ? resolved : path.dirname(resolved)], {
        detached: true,
        stdio: 'ignore',
      });
    }
    child?.on?.('error', () => {});
    child?.unref?.();
    return { ok: true, status: 200, filePath: resolved, isDirectory };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.message || 'Failed to open file manager',
    };
  }
}
