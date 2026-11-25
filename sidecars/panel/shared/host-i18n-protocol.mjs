/**
 * @fileoverview Zero-dependency shared protocol constants and normalizers
 * for the decoupled Antigravity Host I18n subsystem.
 */

export const HOST_I18N_GLOBAL_KEY = '__AGUsageMonitorHostI18n';
export const HOST_I18N_API_PATH = '/api/host-i18n';
export const HOST_I18N_SCHEMA_VERSION = 1;
export const HOST_I18N_OFF_LOCALE = 'off';
export const HOST_I18N_DEFAULT_DEPTH = 'light';
export const HOST_I18N_DEPTHS = Object.freeze(['light', 'deep']);
export const HOST_I18N_LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Normalizes a host translation locale identifier (`'off'` or canonical BCP-47 tag).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHostI18nLocale(value) {
  const raw = String(value || '').trim();
  if (!raw) return HOST_I18N_OFF_LOCALE;
  const lower = raw.toLowerCase();
  if (
    lower === 'off' ||
    lower === 'none' ||
    lower === 'disabled' ||
    lower === 'original' ||
    lower === 'default'
  ) {
    return HOST_I18N_OFF_LOCALE;
  }
  const normalized = raw.replace(/_/g, '-');
  if (!HOST_I18N_LOCALE_RE.test(normalized)) {
    return HOST_I18N_OFF_LOCALE;
  }
  const parts = normalized.split('-');
  return parts
    .map((part, idx) => {
      if (idx === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part;
    })
    .join('-');
}

/**
 * Normalizes translation depth (`'light'` or `'deep'`).
 *
 * @param {unknown} value
 * @returns {'light'|'deep'}
 */
export function normalizeHostI18nDepth(value) {
  const lower = String(value || '').trim().toLowerCase();
  if (lower === 'deep' || lower === 'full') return 'deep';
  return HOST_I18N_DEFAULT_DEPTH;
}
