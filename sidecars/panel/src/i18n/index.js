/**
 * @fileoverview Reactive lightweight i18n engine (`zh-CN` / `en-US` / `auto`).
 * Default language is `'zh-CN'` so out-of-the-box UI matches existing behavior 100%.
 */

import { createReactiveStore } from '../core/reactive.js';
import { normalizeLanguageSetting } from '../../shared/settings-normalization.mjs';
import { I18N_MESSAGES_ZH_CN } from './zh-CN.js';
import { I18N_MESSAGES_EN_US } from './en-US.js';

export const I18N_DICTIONARIES = Object.freeze({
  'zh-CN': I18N_MESSAGES_ZH_CN,
  'en-US': I18N_MESSAGES_EN_US,
});

export function normalizeI18nLanguage(raw) {
  return normalizeLanguageSetting(raw);
}

export function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return String(navigator.language).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'zh-CN';
}

export const i18nStore = createReactiveStore({
  language: 'auto',
  locale: detectHostSystemLocale(),
});

export function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

export function getEffectiveLocale() {
  return i18nStore.getState().locale || 'zh-CN';
}

export function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

/**
 * Sync `<html lang>` and `<title>` on the panel / standalone document to the active locale.
 * Uses equality guards so repeated calls avoid redundant DOM mutations on `<head>`.
 *
 * @param {Document | null} [doc]
 * @returns {string}
 */
export function syncDocumentLocale(doc = typeof document !== 'undefined' ? document : null) {
  const locale = getEffectiveLocale();
  if (!doc) return locale;
  try {
    if (doc.documentElement && doc.documentElement.lang !== locale) {
      doc.documentElement.lang = locale;
    }
    const nextTitle = t('app.title');
    if (nextTitle && doc.title !== nextTitle) {
      doc.title = nextTitle;
    }
  } catch {
    // Ignore read-only document environments in constrained webviews/tests
  }
  return locale;
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = undefined) {
  const locale = getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_ZH_CN;
  const template = dict[key] ?? I18N_MESSAGES_ZH_CN[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}
