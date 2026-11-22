/**
 * @fileoverview 统一文本文件导出及剪贴板复制客户端 (`fileExportClient.js`)。
 * 优先调用本机后端 `/api/export-file` 落盘到用户 Downloads（或插件 `.data/exports`）并返回真实绝对路径，
 * 同时通过全局 Toast 清晰展示保存位置并提供「打开位置」快捷按钮；
 * 当后端不可达或处于远程浏览器访问时，自动平滑降级到 `showSaveFilePicker` 或浏览器 Blob 下载并给出明确提示。
 */

import { t } from '../i18n/index.js';
import { showUiToast } from '../store/uiStore.js';
import { callSidecarApi, isWindowOverlayMode } from './httpClient.js';
import { triggerTextFileDownload } from './settingsBackup.js';
import { copyPlainTextToClipboard } from './stepInspector.js';
import { uint8ArrayToBase64 } from './xlsxBuilder.js';

function isHostEmbeddedWebview() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.sidecar?.fetch) || isWindowOverlayMode();
}

function triggerBinaryFileDownload(filename, bytes, mimeType) {
  try {
    if (
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof document === 'undefined'
    ) {
      return false;
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', String(filename || 'export.xlsx'));
    a.style.display = 'none';
    document.body?.appendChild?.(a);
    a.click?.();
    a.remove?.();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

function getPickerTypesForFilename(filename, mimeType) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || String(mimeType || '').includes('spreadsheetml')) {
    return [
      {
        description: 'Excel Workbook',
        accept: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
        },
      },
    ];
  }
  if (lower.endsWith('.csv') || String(mimeType || '').includes('csv')) {
    return [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }];
  }
  if (lower.endsWith('.md') || String(mimeType || '').includes('markdown')) {
    return [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }];
  }
  return [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];
}

/**
 * 调用本机后端在系统文件管理器中打开并高亮选中已导出的文件。
 * 兼容热更新后常驻父进程 `main.mjs` 尚未注册新路由的场景，自动回退至 `POST /api/settings` 穿透转发至最新 Worker。
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function revealExportedFile(filePath) {
  if (!filePath) return false;
  try {
    const res = await callSidecarApi('/api/reveal-file', {
      method: 'POST',
      body: { filePath },
      cdpTimeoutMs: 4000,
    });
    if (res?.ok) return true;
  } catch (err) {
    if (err?.httpStatus === 403) return false;
  }
  try {
    const fallbackRes = await callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __exportFileAction: 'reveal', payload: { filePath } },
      cdpTimeoutMs: 4000,
    });
    return Boolean(fallbackRes?.ok);
  } catch {
    return false;
  }
}

async function requestLocalBackendExport(payload) {
  let remoteForbidden = false;
  try {
    const res = await callSidecarApi('/api/export-file', {
      method: 'POST',
      body: payload,
      cdpTimeoutMs: 6000,
    });
    if (res && res.ok && res.filePath) {
      return { res, remoteForbidden: false };
    }
    if (res && res.fallbackBrowser) {
      return { res: null, remoteForbidden: true };
    }
  } catch (err) {
    if (err?.httpStatus === 403) {
      remoteForbidden = true;
    }
  }

  if (remoteForbidden) {
    return { res: null, remoteForbidden: true };
  }

  // 兼容热更新后常驻父进程 main.mjs 尚未重注册 /api/export-file 的场景，回退经 POST /api/settings 穿透至最新 Worker
  try {
    const fallbackRes = await callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __exportFileAction: 'save', payload },
      cdpTimeoutMs: 6000,
    });
    if (fallbackRes && fallbackRes.ok && fallbackRes.filePath) {
      return { res: fallbackRes, remoteForbidden: false };
    }
  } catch {
    // 忽略回退异常，交由下方分环境处理
  }
  return { res: null, remoteForbidden: false };
}

/**
 * 统一文本导出入口：优先本机后端落盘（返回精确路径 + 支持一键打开所在目录），
 * 仅在真正独立浏览器上下文（非 Sidecar / 非 Electron 宿主）下降级为浏览器保存，避免宿主静默吞掉 Blob 下载后误报成功。
 *
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType='text/plain;charset=utf-8']
 * @returns {Promise<{ ok: boolean, mode: 'local' | 'picker' | 'browser' | 'cancelled' | 'failed', filePath?: string, fileName?: string }>}
 */
export async function exportTextFileWithFeedback(
  filename,
  content,
  mimeType = 'application/json;charset=utf-8'
) {
  const safeName = String(filename || 'export.txt');
  const text = String(content ?? '');

  // 1. 优先通过本机后端落盘到 Downloads（含 /api/settings 穿透兼容旧常驻 main.mjs）
  const { res: localRes } = await requestLocalBackendExport({
    filename: safeName,
    content: text,
    mimeType,
  });
  if (localRes && localRes.ok && localRes.filePath) {
    const savedPath = String(localRes.filePath);
    const savedName = String(localRes.fileName || safeName);
    showUiToast({
      message: t('export.savedLocal', { file: savedName }),
      detail: savedPath,
      actionLabel: t('export.openFolder'),
      onAction: () => {
        void revealExportedFile(savedPath);
      },
      tone: 'ok',
      durationMs: 7000,
    });
    return { ok: true, mode: 'local', filePath: savedPath, fileName: savedName };
  }

  // 2. 在 Antigravity Sidecar / 双栖 Electron 宿主内，<a download> 会被静默吞掉，绝不误报“已下载到浏览器”
  if (isHostEmbeddedWebview()) {
    showUiToast({
      message: t('export.failed'),
      detail: t('export.hostUnavailable'),
      tone: 'warn',
      durationMs: 5200,
    });
    return { ok: false, mode: 'failed' };
  }

  // 3. 普通独立浏览器原生「另存为」对话框
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: safeName,
        types: getPickerTypesForFilename(safeName, mimeType),
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      const pickedName = handle.name || safeName;
      showUiToast({
        message: t('export.savedPicked', { file: pickedName }),
        tone: 'ok',
        durationMs: 4200,
      });
      return { ok: true, mode: 'picker', fileName: pickedName };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, mode: 'cancelled' };
      }
      // 沙箱/iframe 抛出 SecurityError 等时继续降级到 Blob 下载
    }
  }

  // 4. 独立浏览器标准 Blob 兜底下载
  const ok = triggerTextFileDownload(safeName, text, mimeType);
  if (ok) {
    showUiToast({
      message: t('export.savedBrowser', { file: safeName }),
      detail: t('export.savedBrowserHint'),
      tone: 'info',
      durationMs: 5000,
    });
    return { ok: true, mode: 'browser', fileName: safeName };
  }

  showUiToast({
    message: t('export.failed'),
    tone: 'warn',
    durationMs: 3600,
  });
  return { ok: false, mode: 'failed' };
}

/**
 * 统一二进制文件导出入口（用于原生 `.xlsx` Excel 工作簿）。
 * 优先转 Base64 经本机后端落盘到 Downloads 并展示完整路径 + 「打开位置」直达按钮。
 *
 * @param {string} filename
 * @param {Uint8Array} bytes
 * @param {string} [mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
 * @returns {Promise<{ ok: boolean, mode: 'local' | 'picker' | 'browser' | 'cancelled' | 'failed', filePath?: string, fileName?: string }>}
 */
export async function exportBinaryFileWithFeedback(
  filename,
  bytes,
  mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
) {
  const safeName = String(filename || 'export.xlsx');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    showUiToast({ message: t('export.failed'), tone: 'warn', durationMs: 3600 });
    return { ok: false, mode: 'failed' };
  }

  const base64Content = uint8ArrayToBase64(bytes);
  const { res: localRes } = await requestLocalBackendExport({
    filename: safeName,
    content: base64Content,
    encoding: 'base64',
    mimeType,
  });
  if (localRes && localRes.ok && localRes.filePath) {
    const savedPath = String(localRes.filePath);
    const savedName = String(localRes.fileName || safeName);
    showUiToast({
      message: t('export.savedLocal', { file: savedName }),
      detail: savedPath,
      actionLabel: t('export.openFolder'),
      onAction: () => {
        void revealExportedFile(savedPath);
      },
      tone: 'ok',
      durationMs: 7000,
    });
    return { ok: true, mode: 'local', filePath: savedPath, fileName: savedName };
  }

  if (isHostEmbeddedWebview()) {
    showUiToast({
      message: t('export.failed'),
      detail: t('export.hostUnavailable'),
      tone: 'warn',
      durationMs: 5200,
    });
    return { ok: false, mode: 'failed' };
  }

  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: safeName,
        types: getPickerTypesForFilename(safeName, mimeType),
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      const pickedName = handle.name || safeName;
      showUiToast({
        message: t('export.savedPicked', { file: pickedName }),
        tone: 'ok',
        durationMs: 4200,
      });
      return { ok: true, mode: 'picker', fileName: pickedName };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, mode: 'cancelled' };
      }
    }
  }

  const ok = triggerBinaryFileDownload(safeName, bytes, mimeType);
  if (ok) {
    showUiToast({
      message: t('export.savedBrowser', { file: safeName }),
      detail: t('export.savedBrowserHint'),
      tone: 'info',
      durationMs: 5000,
    });
    return { ok: true, mode: 'browser', fileName: safeName };
  }

  showUiToast({
    message: t('export.failed'),
    tone: 'warn',
    durationMs: 3600,
  });
  return { ok: false, mode: 'failed' };
}

/**
 * 复制文本到剪贴板并弹出轻量提示条。
 *
 * @param {string} text
 * @param {string} successMessage
 * @returns {Promise<boolean>}
 */
export async function copyTextWithFeedback(text, successMessage) {
  const ok = await copyPlainTextToClipboard(text);
  if (ok) {
    showUiToast({
      message: successMessage || t('export.copied'),
      tone: 'ok',
      durationMs: 2400,
    });
  } else {
    showUiToast({
      message: t('export.copyFailed'),
      tone: 'warn',
      durationMs: 3200,
    });
  }
  return ok;
}
