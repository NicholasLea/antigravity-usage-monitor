/**
 * @fileoverview Async entry point for Antigravity Usage & Speed Monitor.
 * Automatically branches between Auxiliary Sidebar Webview mode (`#app-root`)
 * and Main Window Dual-Mount Overlay mode (`window.__AGUsageMonitorBridge`).
 */

import {
  HOST_THEME_FALLBACK_STYLE_ID,
  getHostThemeSignature,
} from '../shared/host-theme.mjs';
import { App } from './App.js';
import { mountWindowOverlay } from './components/layout/WindowOverlayShell.js';
import { applyAppearanceToRoot, syncHostThemeFallback } from './core/appearance.js';
import { callSidecarApi, isWindowOverlayMode } from './core/httpClient.js';
import { setI18nLanguage } from './i18n/index.js';
import { startAsyncTelemetryLoop, telemetryStore } from './store/telemetryStore.js';

function isFallbackStyleMutation(record) {
  if (!record) return false;
  if (record.target?.id === HOST_THEME_FALLBACK_STYLE_ID) return true;
  if (record.target?.parentNode?.id === HOST_THEME_FALLBACK_STYLE_ID) return true;
  if (record.type === 'childList') {
    const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    if (nodes.length > 0 && nodes.every((n) => n?.id === HOST_THEME_FALLBACK_STYLE_ID)) {
      return true;
    }
  }
  return false;
}

async function bootstrapApp(mountTarget = document.getElementById('app-root')) {
  if (!mountTarget) return null;
  const appInstance = App();
  mountTarget.appendChild(appInstance.el);

  let syncingAppearance = false;
  let lastReportedNativeThemeSig = '';
  let nativeReportTimer = null;

  const scheduleNativeHostThemeCache = (snapshot) => {
    const sig = getHostThemeSignature(snapshot);
    if (!sig || sig === lastReportedNativeThemeSig) return;
    if (typeof window === 'undefined' || !window.sidecar?.fetch) return;
    if (nativeReportTimer) {
      clearTimeout(nativeReportTimer);
    }
    nativeReportTimer = setTimeout(() => {
      nativeReportTimer = null;
      if (sig === lastReportedNativeThemeSig) return;
      lastReportedNativeThemeSig = sig;
      void callSidecarApi('/api/settings', {
        method: 'POST',
        body: { __hostThemeAction: 'cache', payload: snapshot },
      }).catch(() => {});
    }, 250);
  };

  const syncDocAppearance = (settings, hostTheme = telemetryStore.getState().telemetry?.hostTheme) => {
    if (syncingAppearance) return;
    syncingAppearance = true;
    try {
      setI18nLanguage(settings?.language);
      if (typeof document !== 'undefined' && document.documentElement) {
        const isStandalone = document.documentElement.getAttribute?.('data-standalone') === 'true';
        const telemetryLoaded = Boolean(telemetryStore.getState().telemetry);
        const fallbackRes = syncHostThemeFallback(hostTheme, {
          doc: document,
          win: typeof window !== 'undefined' ? window : null,
          isStandalone,
          telemetryLoaded,
        });
        applyAppearanceToRoot(document.documentElement, settings, {
          includeFontScale: true,
          fallbackHostTheme: hostTheme || null,
        });
        if (fallbackRes.mode === 'native' && fallbackRes.snapshot && !isStandalone) {
          scheduleNativeHostThemeCache(fallbackRes.snapshot);
        }
      }
    } finally {
      syncingAppearance = false;
    }
  };

  const initialTel = telemetryStore.getState().telemetry;
  syncDocAppearance(initialTel?.settings, initialTel?.hostTheme);

  const unsubAppearance = telemetryStore.subscribe(
    (st) => st.telemetry?.settings,
    (settings) => syncDocAppearance(settings, telemetryStore.getState().telemetry?.hostTheme)
  );
  const unsubHostTheme = telemetryStore.subscribe(
    (st) => st.telemetry?.hostTheme,
    (hostTheme) => syncDocAppearance(telemetryStore.getState().telemetry?.settings, hostTheme)
  );

  let hostThemeObserver = null;
  let colorSchemeMql = null;
  const onHostThemeChange = (records) => {
    if (Array.isArray(records) && records.length > 0 && records.every(isFallbackStyleMutation)) {
      return;
    }
    const tel = telemetryStore.getState().telemetry;
    syncDocAppearance(tel?.settings, tel?.hostTheme);
  };
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      hostThemeObserver = new MutationObserver(onHostThemeChange);
      if (document.documentElement) {
        hostThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        hostThemeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.head) {
        hostThemeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      colorSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
      colorSchemeMql?.addEventListener?.('change', () => onHostThemeChange(null));
    }
  } catch {
    // ignore observer setup errors in constrained environments
  }

  const stopPolling = startAsyncTelemetryLoop(2000);
  return {
    appInstance,
    stopPolling: () => {
      if (nativeReportTimer) {
        clearTimeout(nativeReportTimer);
        nativeReportTimer = null;
      }
      hostThemeObserver?.disconnect?.();
      colorSchemeMql?.removeEventListener?.('change', onHostThemeChange);
      unsubAppearance();
      unsubHostTheme();
      stopPolling();
    },
  };
}

function startEntry() {
  if (isWindowOverlayMode()) {
    mountWindowOverlay();
    return;
  }
  if (
    typeof window !== 'undefined' &&
    !window.sidecar?.fetch &&
    typeof document !== 'undefined' &&
    document.documentElement
  ) {
    document.documentElement.setAttribute('data-standalone', 'true');
  }
  bootstrapApp();
}

function init() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      startEntry();
    });
  } else {
    startEntry();
  }
}

init();
