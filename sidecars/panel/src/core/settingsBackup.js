/**
 * @fileoverview 偏好设置便携 JSON 备份及恢复工具 (`settingsBackup.js`).
 * 仅处理经过白名单归一化的用户界面偏好项，不包含账号凭证及高风险上下文窗口覆盖。
 */

import {
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
} from '../../shared/settings-normalization.mjs';

const SETTINGS_BACKUP_SCHEMA = 'antigravity-usage-monitor.settings';
const MAX_SETTINGS_IMPORT_BYTES = 128 * 1024;

function sanitizePositiveBudgetNum(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 在浏览器端通过内存 Blob 触发文件下载（零本地磁盘外部写入）。
 *
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType]
 * @returns {boolean}
 */
export function triggerTextFileDownload(
  filename,
  content,
  mimeType = 'application/json;charset=utf-8'
) {
  try {
    if (
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof document === 'undefined'
    ) {
      return false;
    }
    const blob = new Blob([String(content ?? '')], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', String(filename || 'export.json'));
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

/**
 * 将当前用户偏好设置序列化为跨设备可迁移的安全 JSON 备份文本（仅包含便携偏好项，不包含凭证或高风险覆盖开关）。
 *
 * @param {object} [settings={}]
 * @returns {string}
 */
export function buildExportableSettingsJson(settings = {}) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const modelDisplayMode = normalizeModelDisplayMode(src.modelDisplayMode, src.showUpstreamModel);
  const modernUi = src.modernUi !== undefined ? normalizeModernUi(src.modernUi) : true;
  const payload = {
    schema: SETTINGS_BACKUP_SCHEMA,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      language: normalizeLanguageSetting(src.language),
      themeAccent: normalizeThemeAccent(src.themeAccent),
      fontScale: normalizeFontScale(src.fontScale),
      modernUi,
      weeklyLimitMode: normalizeWeeklyLimitMode(src.weeklyLimitMode),
      weeklyTokenBudget: sanitizePositiveBudgetNum(src.weeklyTokenBudget) ?? 150000000,
      weeklyCostBudget: sanitizePositiveBudgetNum(src.weeklyCostBudget) ?? 100,
      modelDisplayMode,
      showUpstreamModel: modelDisplayMode !== 'short',
      orchestratorIdMode: normalizeOrchestratorIdMode(src.orchestratorIdMode),
      pluginUpdateMode: normalizePluginUpdateMode(src.pluginUpdateMode, src.autoUpdatePlugin),
      windowMountMode: normalizeWindowMountMode(src.windowMountMode, src.enableWindowOverlay),
      popoverWidthMode: normalizePopoverWidthMode(src.popoverWidthMode),
      popoverWidth: normalizePopoverWidth(src.popoverWidth),
      enableCliStatusLine: src.enableCliStatusLine !== false,
      cliStatusLineSlots: normalizeCliStatusLineSlots(src.cliStatusLineSlots),
      standalonePort: normalizeStandalonePort(src.standalonePort),
      showTopbarMultiSession: src.showTopbarMultiSession !== false,
      contextAgentMode: normalizeContextAgentMode(src.contextAgentMode),
      topbarCapsuleSlots: normalizeTopbarCapsuleSlots(src.topbarCapsuleSlots),
      hoverModules: normalizeHoverModules(src.hoverModules),
      overviewModules: normalizeOverviewModules(src.overviewModules),
      overviewMetrics: normalizeOverviewMetrics(src.overviewMetrics),
      showStepTurnRail: src.showStepTurnRail === true,
      showStepAgentBadge: src.showStepAgentBadge !== false,
      showStepSpeedColor: src.showStepSpeedColor === true,
      showStepFilterToolbar: src.showStepFilterToolbar === true,
      stepTokenComboFormat: normalizeStepTokenComboFormat(src.stepTokenComboFormat),
      stepTableColumns: normalizeStepTableColumns(src.stepTableColumns),
      experimentalQuotaReservation: normalizeExperimentalQuotaReservation(
        src.experimentalQuotaReservation
      ),
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * 校验并解析导入的偏好设置 JSON，仅提取并归一化白名单内的便携配置项。
 *
 * @param {string} rawText
 * @returns {{ ok: true, patch: object, appliedCount: number } | { ok: false, errorCode: string }}
 */
export function parseImportedSettingsJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim() || rawText.length > MAX_SETTINGS_IMPORT_BYTES) {
    return { ok: false, errorCode: 'invalid_json' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, errorCode: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errorCode: 'invalid_json' };
  }

  const hasWrappedSettings =
    parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings);
  if (parsed.schema !== undefined && parsed.schema !== SETTINGS_BACKUP_SCHEMA) {
    return { ok: false, errorCode: 'invalid_schema' };
  }
  const src = hasWrappedSettings ? parsed.settings : parsed;
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const patch = {};

  if (hasKey('language')) patch.language = normalizeLanguageSetting(src.language);
  if (hasKey('themeAccent')) patch.themeAccent = normalizeThemeAccent(src.themeAccent);
  if (hasKey('fontScale')) patch.fontScale = normalizeFontScale(src.fontScale);
  if (hasKey('modernUi')) {
    const val = normalizeModernUi(src.modernUi);
    patch.modernUi = val;
    patch.experimentalModernUi = val;
  }
  if (hasKey('weeklyLimitMode')) {
    patch.weeklyLimitMode = normalizeWeeklyLimitMode(src.weeklyLimitMode);
  }
  if (hasKey('weeklyTokenBudget')) {
    const num = sanitizePositiveBudgetNum(src.weeklyTokenBudget);
    if (num !== null) patch.weeklyTokenBudget = num;
  }
  if (hasKey('weeklyCostBudget')) {
    const num = sanitizePositiveBudgetNum(src.weeklyCostBudget);
    if (num !== null) patch.weeklyCostBudget = num;
  }
  if (hasKey('modelDisplayMode') || hasKey('showUpstreamModel')) {
    const mode = normalizeModelDisplayMode(src.modelDisplayMode, src.showUpstreamModel);
    patch.modelDisplayMode = mode;
    patch.showUpstreamModel = mode !== 'short';
  }
  if (hasKey('orchestratorIdMode')) {
    patch.orchestratorIdMode = normalizeOrchestratorIdMode(src.orchestratorIdMode);
  }
  if (hasKey('pluginUpdateMode') || hasKey('autoUpdatePlugin')) {
    const mode = normalizePluginUpdateMode(src.pluginUpdateMode, src.autoUpdatePlugin);
    patch.pluginUpdateMode = mode;
    patch.autoUpdatePlugin = mode === 'auto';
  }
  if (hasKey('windowMountMode') || hasKey('enableWindowOverlay')) {
    const mode = normalizeWindowMountMode(src.windowMountMode, src.enableWindowOverlay);
    patch.windowMountMode = mode;
    patch.enableWindowOverlay = mode !== 'sidebar';
  }
  if (hasKey('popoverWidthMode')) {
    patch.popoverWidthMode = normalizePopoverWidthMode(src.popoverWidthMode);
  }
  if (hasKey('popoverWidth')) {
    patch.popoverWidth = normalizePopoverWidth(src.popoverWidth);
  }
  if (hasKey('enableCliStatusLine') && typeof src.enableCliStatusLine === 'boolean') {
    patch.enableCliStatusLine = src.enableCliStatusLine;
  }
  if (hasKey('cliStatusLineSlots')) {
    patch.cliStatusLineSlots = normalizeCliStatusLineSlots(src.cliStatusLineSlots);
  }
  if (hasKey('standalonePort')) {
    patch.standalonePort = normalizeStandalonePort(src.standalonePort);
  }
  if (hasKey('showTopbarMultiSession') && typeof src.showTopbarMultiSession === 'boolean') {
    patch.showTopbarMultiSession = src.showTopbarMultiSession;
  }
  if (hasKey('contextAgentMode')) {
    patch.contextAgentMode = normalizeContextAgentMode(src.contextAgentMode);
  }
  if (hasKey('topbarCapsuleSlots') && Array.isArray(src.topbarCapsuleSlots)) {
    patch.topbarCapsuleSlots = normalizeTopbarCapsuleSlots(src.topbarCapsuleSlots);
  }
  if (hasKey('hoverModules') && Array.isArray(src.hoverModules)) {
    patch.hoverModules = normalizeHoverModules(src.hoverModules);
  }
  if (hasKey('overviewModules') && Array.isArray(src.overviewModules)) {
    patch.overviewModules = normalizeOverviewModules(src.overviewModules);
  }
  if (hasKey('overviewMetrics') && Array.isArray(src.overviewMetrics)) {
    patch.overviewMetrics = normalizeOverviewMetrics(src.overviewMetrics);
  }
  if (hasKey('showStepTurnRail') && typeof src.showStepTurnRail === 'boolean') {
    patch.showStepTurnRail = src.showStepTurnRail;
  }
  if (hasKey('showStepAgentBadge') && typeof src.showStepAgentBadge === 'boolean') {
    patch.showStepAgentBadge = src.showStepAgentBadge;
  }
  if (hasKey('showStepSpeedColor') && typeof src.showStepSpeedColor === 'boolean') {
    patch.showStepSpeedColor = src.showStepSpeedColor;
  }
  if (hasKey('showStepFilterToolbar') && typeof src.showStepFilterToolbar === 'boolean') {
    patch.showStepFilterToolbar = src.showStepFilterToolbar;
  }
  if (hasKey('stepTokenComboFormat')) {
    patch.stepTokenComboFormat = normalizeStepTokenComboFormat(src.stepTokenComboFormat);
  }
  if (hasKey('stepTableColumns') && Array.isArray(src.stepTableColumns)) {
    patch.stepTableColumns = normalizeStepTableColumns(src.stepTableColumns);
  }
  if (hasKey('experimentalQuotaReservation')) {
    patch.experimentalQuotaReservation = normalizeExperimentalQuotaReservation(
      src.experimentalQuotaReservation
    );
  }

  const appliedCount = Object.keys(patch).length;
  if (appliedCount === 0) {
    return { ok: false, errorCode: 'empty_patch' };
  }
  return { ok: true, patch, appliedCount };
}
