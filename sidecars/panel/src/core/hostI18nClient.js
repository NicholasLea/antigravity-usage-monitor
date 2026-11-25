/**
 * @fileoverview Decoupled HTTP/CDP client for `/api/host-i18n`.
 * Completely independent from `telemetryStore.js`.
 */

import {
  HOST_I18N_API_PATH,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
} from '../../shared/host-i18n-protocol.mjs';
import { callSidecarApi } from './httpClient.js';

export async function fetchHostI18nStatus() {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'GET',
    abortKey: 'host-i18n-get',
    cdpTimeoutMs: 12000,
  });
}

export async function refreshHostI18nManifest() {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: { action: 'refresh_manifest' },
    cdpTimeoutMs: 18000,
  });
}

export async function selectHostI18nLanguage(locale, depth) {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: {
      action: 'select',
      locale: normalizeHostI18nLocale(locale),
      ...(depth !== undefined ? { depth: normalizeHostI18nDepth(depth) } : {}),
    },
    cdpTimeoutMs: 22000,
  });
}

export async function updateHostI18nDepth(depth) {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: {
      action: 'set_depth',
      depth: normalizeHostI18nDepth(depth),
    },
    cdpTimeoutMs: 10000,
  });
}

export async function installOrUpdateHostI18nPack(locale) {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: {
      action: 'update',
      locale: normalizeHostI18nLocale(locale),
    },
    cdpTimeoutMs: 22000,
  });
}

export async function removeHostI18nPack(locale) {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: {
      action: 'remove',
      locale: normalizeHostI18nLocale(locale),
    },
    cdpTimeoutMs: 10000,
  });
}

export async function collectHostI18nUntranslated() {
  return callSidecarApi(HOST_I18N_API_PATH, {
    method: 'POST',
    body: { action: 'collect_untranslated' },
    cdpTimeoutMs: 15000,
  });
}
