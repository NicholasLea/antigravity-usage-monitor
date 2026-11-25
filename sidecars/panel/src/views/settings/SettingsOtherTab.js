/**
 * @fileoverview Preferences Tab 3: `SettingsOtherTab.js` ("其他").
 * Houses Model Identifier Formatting, Per-Model Context Windows,
 * Local Trajectory Cache Rebuild, and Two-Step Factory Preference Reset.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { setI18nLanguage, t } from '../../i18n/index.js';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../../core/settingsBackup.js';
import {
  copyTextWithFeedback,
  exportTextFileWithFeedback,
} from '../../core/fileExportClient.js';
import {
  fetchQuotaReservationLog,
  normalizeClientExperimentalQuotaReservation,
  normalizeClientModelDisplayMode,
  rebuildTrajectoryCache,
  resetAllSettings,
  saveModelContextWindow,
  saveSettingsPatch,
} from '../../store/telemetryStore.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js';
import { BridgeStatusNotice } from '../../components/settings/BridgeStatusNotice.js';

function formatQuotaReservationLogForClipboard(snapshot) {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const buckets = Array.isArray(safe.buckets) ? safe.buckets : [];
  const events = Array.isArray(safe.events) ? safe.events : [];
  const bucketLines = buckets.map((b) => `    ${JSON.stringify(b)}`).join(',\n');
  const eventLines = events.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return [
    '{',
    `  "generatedAt": ${JSON.stringify(safe.generatedAt || new Date().toISOString())},`,
    `  "count": ${events.length},`,
    `  "buckets": [${bucketLines ? `\n${bucketLines}\n  ` : ''}],`,
    `  "events": [${eventLines ? `\n${eventLines}\n  ` : ''}]`,
    '}',
  ].join('\n');
}

function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

export const SettingsOtherTab = defineComponent({
  name: 'SettingsOtherTab',
  setup({ onCleanup, getProps }) {
    let draftModelDisplayMode = 'short';
    let draftExperimentalQuotaReservation = true;
    let draftContextRiskAccepted = false;
    let acceptingContextRisk = false;
    let draftContextMainEnabled = true;
    let draftContextSwarmEnabled = false;
    let savingContextScope = false;
    let latestSettings = null;
    let latestWindowBridge = null;
    let latestCloudCodeProxy = null;
    let latestHostPlatform = 'win32';
    let contextWindowModels = [];
    let contextModelId = '';
    let savingContextWindow = false;
    let contextFeedback = '';
    let modelTimer = null;
    let expTimer = null;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const modelStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const expStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted settings-panel-status',
      text: '',
    });

    function showExpFeedback(text, autoClearMs = 1500) {
      if (expTimer) {
        clearTimeout(expTimer);
        expTimer = null;
      }
      patchText(expStatusText, text);
      if (text && autoClearMs > 0) {
        expTimer = setTimeout(() => {
          expTimer = null;
          patchText(expStatusText, '');
        }, autoClearMs);
      }
    }

    function showModelFeedback(text, autoClearMs = 1500) {
      if (modelTimer) {
        clearTimeout(modelTimer);
        modelTimer = null;
      }
      patchText(modelStatusText, text);
      if (text && autoClearMs > 0) {
        modelTimer = setTimeout(() => {
          modelTimer = null;
          patchText(modelStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      patchAttr(maintStatusText, 'title', text || null);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
          patchAttr(maintStatusText, 'title', null);
        }, autoClearMs);
      }
    }

    // --- Card 1: 模型标识显示 ---
    const modelCardTitleEl = h('span', { text: t('settings.oth.modelTitle') });

    const stepModelSelect = CustomSelect({
      ariaLabel: t('settings.oth.modelTitle'),
      modelValue: 'short',
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            modelDisplayMode: nextMode,
            showUpstreamModel: nextMode !== 'short',
          });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const modelPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          modelCardTitleEl,
        ]),
        modelStatusText,
      ]),
      stepModelSelect.el,
    ]);

    // --- Card 2: 试验性功能 ---
    const expTitleEl = h('span', { text: t('settings.oth.expTitle') });
    const quotaReserveLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.quotaReserveLabel'),
    });
    const quotaReserveBadgeEl = h('span', {
      className: 'settings-experimental-badge',
      text: t('settings.oth.expBadge'),
    });
    const quotaReserveDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.quotaReserveDesc'),
    });
    const quotaReserveLogLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.quotaReserveLogLabel'),
    });
    const quotaReserveLogDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.quotaReserveLogDesc'),
    });
    const exportReserveLogBtnText = h('span', {
      text: t('settings.oth.exportReserveLogBtn'),
    });
    let isExportingReserveLog = false;

    const exportReserveLogBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isExportingReserveLog) return;
          isExportingReserveLog = true;
          patchAttr(exportReserveLogBtn, 'disabled', true);
          try {
            const snapshot = await fetchQuotaReservationLog();
            const text = formatQuotaReservationLogForClipboard(snapshot);
            const count = Array.isArray(snapshot?.events) ? snapshot.events.length : 0;
            const successMsg =
              count > 0
                ? t('settings.oth.exportReserveLogCopied', { count })
                : t('settings.oth.exportReserveLogEmpty');
            const ok = await copyTextWithFeedback(text, successMsg);
            showExpFeedback(ok ? successMsg : t('settings.oth.exportReserveLogFailed'), 2800);
          } catch {
            showExpFeedback(t('settings.oth.exportReserveLogFailed'), 2800);
          } finally {
            isExportingReserveLog = false;
            patchAttr(exportReserveLogBtn, 'disabled', false);
          }
        },
      },
      [createSvgIcon('copy', { size: 12 }), exportReserveLogBtnText]
    );

    const quotaReserveToggle = ToggleSwitch({
      modelValue: 'on',
      ariaLabelKey: 'settings.oth.quotaReserveLabel',
      preset: 'enable',
      onUpdateModelValue: async (val) => {
        const nextEnabled = val === 'on';
        draftExperimentalQuotaReservation = nextEnabled;
        quotaReserveToggle.setProps({
          modelValue: nextEnabled ? 'on' : 'off',
        });
        showExpFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ experimentalQuotaReservation: nextEnabled });
          showExpFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showExpFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const experimentalPanel = h('section', { className: 'panel', hidden: true }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          expTitleEl,
        ]),
        expStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [
          h('div', { className: 'settings-experimental-label-group' }, [
            quotaReserveLabelEl,
            quotaReserveBadgeEl,
          ]),
          quotaReserveDescEl,
        ]),
        quotaReserveToggle.el,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [
          quotaReserveLogLabelEl,
          quotaReserveLogDescEl,
        ]),
        exportReserveLogBtn,
      ]),
    ]);

    // --- Card 2: 按模型设置上下文窗口 ---
    const baselineTitleEl = h('span', { text: t('settings.oth.baselineTitle') });
    const ctxModelLabel = h('span', { className: 'form-label' });
    const ctxWindowLabel = h('span', { className: 'form-label' });
    const ctxHint = h('span', { className: 'settings-hint-text' });
    const ctxStatus = h('span', {
      className: 'text-muted settings-panel-status',
      role: 'status',
    });
    const ctxModelSelect = CustomSelect({
      className: 'settings-context-model',
      searchable: true,
      searchThreshold: 8,
      options: [],
      onUpdateModelValue: (id) => {
        if (!draftContextRiskAccepted || savingContextWindow) return;
        contextModelId = id;
        contextFeedback = '';
        renderContextWindows();
      },
    });
    const ctxWindowSelect = CustomSelect({
      options: [],
      onUpdateModelValue: async (value) => {
        if (!draftContextRiskAccepted || savingContextWindow || !contextModelId) return;
        savingContextWindow = true;
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          const modelContextWindows = await saveModelContextWindow(contextModelId, value || null);
          latestSettings = { ...latestSettings, modelContextWindows };
          contextFeedback = 'settings.saved';
        } catch {
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextWindow = false;
          renderContextWindows();
        }
      },
    });
    const ctxBridgeNotice = BridgeStatusNotice({ contextMode: true });
    const ctxMainLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.ctxMainLabel'),
    });
    const ctxMainToggle = ToggleSwitch({
      modelValue: 'on',
      ariaLabelKey: 'settings.oth.ctxMainLabel',
      preset: 'enable',
      onUpdateModelValue: async (val) => {
        if (!draftContextRiskAccepted || savingContextScope) return;
        const nextEnabled = val === 'on';
        const prevEnabled = draftContextMainEnabled;
        savingContextScope = true;
        draftContextMainEnabled = nextEnabled;
        latestSettings = { ...(latestSettings || {}), contextWindowMainEnabled: nextEnabled };
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          await saveSettingsPatch({ contextWindowMainEnabled: nextEnabled });
          contextFeedback = 'settings.saved';
        } catch {
          draftContextMainEnabled = prevEnabled;
          latestSettings = { ...(latestSettings || {}), contextWindowMainEnabled: prevEnabled };
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextScope = false;
          renderContextWindows();
        }
      },
    });
    const ctxSwarmLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.ctxSwarmLabel'),
    });
    const ctxSwarmToggle = ToggleSwitch({
      modelValue: 'off',
      ariaLabelKey: 'settings.oth.ctxSwarmLabel',
      preset: 'enable',
      onUpdateModelValue: async (val) => {
        if (!draftContextRiskAccepted || savingContextScope) return;
        const nextEnabled = val === 'on';
        const prevEnabled = draftContextSwarmEnabled;
        savingContextScope = true;
        draftContextSwarmEnabled = nextEnabled;
        latestSettings = { ...(latestSettings || {}), contextWindowSwarmEnabled: nextEnabled };
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          await saveSettingsPatch({ contextWindowSwarmEnabled: nextEnabled });
          contextFeedback = 'settings.saved';
        } catch {
          draftContextSwarmEnabled = prevEnabled;
          latestSettings = { ...(latestSettings || {}), contextWindowSwarmEnabled: prevEnabled };
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextScope = false;
          renderContextWindows();
        }
      },
    });
    const ctxMainRow = h('div', { className: 'form-row' }, [ctxMainLabelEl, ctxMainToggle.el]);
    const ctxSwarmRow = h('div', { className: 'form-row' }, [ctxSwarmLabelEl, ctxSwarmToggle.el]);
    const ctxSyncStatusEl = h('span', {
      className: 'settings-hint-text ctx-sync-status is-error',
      hidden: true,
    });
    const ctxModelRow = h('div', { className: 'form-row' }, [ctxModelLabel, ctxModelSelect.el]);
    const ctxWindowRow = h('div', { className: 'form-row' }, [ctxWindowLabel, ctxWindowSelect.el]);
    const ctxControlsBody = h('div', { className: 'ctx-controls-body is-locked' }, [
      ctxBridgeNotice.el,
      ctxMainRow,
      ctxSwarmRow,
      ctxSyncStatusEl,
      ctxModelRow,
      ctxWindowRow,
      h('div', { className: 'form-row' }, [ctxHint]),
    ]);

    const ctxRiskTitleEl = h('strong', {
      className: 'ctx-risk-title',
      text: t('settings.oth.ctxRiskTitle'),
    });
    const ctxRiskBodyEl = h('p', {
      className: 'ctx-risk-desc',
      text: t('settings.oth.ctxRiskBody'),
    });
    const ctxRiskAcceptBtnText = h('span', { text: t('settings.oth.ctxRiskAcceptBtn') });
    const ctxRiskAcceptBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary btn-danger-confirm ctx-risk-accept-btn',
        onClick: async () => {
          if (acceptingContextRisk || draftContextRiskAccepted) return;
          acceptingContextRisk = true;
          draftContextRiskAccepted = true;
          latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: true };
          contextFeedback = 'settings.saving';
          renderContextWindows();
          try {
            await saveSettingsPatch({ contextWindowRiskAccepted: true });
            contextFeedback = 'settings.saved';
          } catch {
            draftContextRiskAccepted = false;
            latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: false };
            contextFeedback = 'settings.saveFailed';
          } finally {
            acceptingContextRisk = false;
            renderContextWindows();
          }
        },
      },
      [createSvgIcon('warning', { size: 12 }), ctxRiskAcceptBtnText]
    );
    const ctxRiskMask = h(
      'div',
      {
        className: 'ctx-risk-mask',
        role: 'region',
        'aria-label': t('settings.oth.ctxRiskTitle'),
      },
      [
        h('div', { className: 'ctx-risk-head' }, [
          createSvgIcon('warning', { size: 14, className: 'ctx-risk-icon' }),
          ctxRiskTitleEl,
        ]),
        ctxRiskBodyEl,
        ctxRiskAcceptBtn,
      ]
    );
    const ctxRiskStage = h('div', { className: 'ctx-risk-stage' }, [ctxControlsBody, ctxRiskMask]);

    function renderContextWindows() {
      const unlocked = Boolean(draftContextRiskAccepted);
      if (!unlocked) {
        ctxModelSelect.close();
        ctxWindowSelect.close();
      }
      patchClasses(ctxControlsBody, { 'is-locked': !unlocked });
      patchAttr(ctxControlsBody, 'inert', !unlocked);
      patchAttr(ctxControlsBody, 'aria-hidden', unlocked ? null : 'true');
      patchAttr(ctxRiskMask, 'hidden', unlocked);
      patchAttr(ctxRiskMask, 'aria-label', t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskTitleEl, t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskBodyEl, t('settings.oth.ctxRiskBody'));
      patchText(ctxRiskAcceptBtnText, t('settings.oth.ctxRiskAcceptBtn'));
      patchAttr(ctxRiskAcceptBtn, 'disabled', acceptingContextRisk);

      const saved = latestSettings?.modelContextWindows || {};
      const wbState = String(latestWindowBridge?.state || '').trim();
      const isBridgeMissing = wbState === 'no_devtools_port' || wbState === 'cdp_unreachable';
      const proxyState = String(latestCloudCodeProxy?.state || 'disabled');
      const isProxyActive = Boolean(latestCloudCodeProxy?.active && proxyState === 'active');

      patchText(ctxMainLabelEl, t('settings.oth.ctxMainLabel'));
      ctxMainToggle.setProps({
        modelValue: draftContextMainEnabled ? 'on' : 'off',
      });
      patchText(ctxSwarmLabelEl, t('settings.oth.ctxSwarmLabel'));
      ctxSwarmToggle.setProps({
        modelValue: draftContextSwarmEnabled ? 'on' : 'off',
      });

      const syncErrorText =
        draftContextSwarmEnabled && proxyState === 'error' && latestCloudCodeProxy?.error
          ? t('settings.oth.ctxSwarmError', { error: latestCloudCodeProxy.error })
          : '';
      patchAttr(ctxSyncStatusEl, 'hidden', !syncErrorText);
      patchText(ctxSyncStatusEl, syncErrorText);

      ctxBridgeNotice.refs.update({
        visible: unlocked && draftContextMainEnabled,
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
      });
      const models = new Map(contextWindowModels.map((model) => [model.id, model]));
      const knownIds = new Set(contextWindowModels.flatMap(({ id, members = [] }) => [id, ...members]));
      for (const id of Object.keys(saved)) {
        if (!knownIds.has(id)) models.set(id, { id, label: id.replace(/^model:/, ''), options: [] });
      }
      if (!models.has(contextModelId)) contextModelId = '';
      const mixed = '\u0000mixed';
      const getSelection = ({ id, members = [] }) => {
        const legacy = new Set(members.map((member) => saved[member]).filter(Boolean));
        return saved[id] || (legacy.size > 1 ? mixed : legacy.values().next().value) || '';
      };
      const formatLimit = (value) => /^\d+$/.test(value) ? t('settings.oth.ctxTokens', { count: Number(value).toLocaleString() }) : value;
      const isAvailable = (model, value) => model.options.some(({ name }) => name === value) ||
        (/^[1-9]\d*$/.test(value) && Number(value) <= model.capacity);
      const current = models.get(contextModelId);
      const options = current?.options || [];
      const selected = current ? getSelection(current) : '';
      const choices = [
        { value: '', label: t('settings.oth.ctxDefault') },
        ...options.map(({ name, expensive, tokens }) => ({
          value: name,
          label: tokens ? formatLimit(name) :
            (expensive ? t('settings.oth.ctxExpensive', { name }) : name),
        })),
      ];
      if (selected && !choices.some((item) => item.value === selected)) {
        let label = t('settings.oth.ctxMixed');
        if (selected !== mixed) {
          const name = formatLimit(selected);
          label = isAvailable(current, selected) ? name : t('settings.oth.ctxUnavailable', { name });
        }
        choices.push({ value: selected, label, disabled: true });
      }
      ctxModelSelect.setProps({
        modelValue: contextModelId,
        options: [
          { value: '', label: t('settings.oth.ctxChooseModel') },
          ...[...models.values()].map((model) => {
            const value = getSelection(model);
            let meta = t('settings.oth.ctxDefault');
            if (value === mixed) meta = t('settings.oth.ctxMixed');
            else if (value) {
              const name = formatLimit(value);
              if (!isAvailable(model, value)) meta = t('settings.oth.ctxUnavailable', { name });
              else if (
                isBridgeMissing &&
                draftContextMainEnabled &&
                !(draftContextSwarmEnabled && isProxyActive)
              ) {
                meta = t('settings.oth.ctxPendingBridge', { name });
              }
              else if (/^\d+$/.test(value) && model.reportedLimitTokens && Number(value) !== model.reportedLimitTokens) {
                meta = t('settings.oth.ctxConfiguredReported', {
                  name,
                  reported: formatLimit(String(model.reportedLimitTokens)),
                });
              } else meta = t('settings.oth.ctxConfigured', { name });
            }
            else if (model.reportedLimitTokens) meta = t('settings.oth.ctxDefaultReported', { name: formatLimit(String(model.reportedLimitTokens)) });
            return { value: model.id, label: model.label, meta };
          }),
        ],
      });
      ctxWindowSelect.setProps({ modelValue: selected, options: choices });
      patchAttr(ctxModelSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow);
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow || (!options.length && !selected));
      patchAttr(ctxModelSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxModel'));
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxBaselineLabel'));
      patchAttr(ctxModelRow, 'hidden', !models.size);
      patchAttr(ctxWindowRow, 'hidden', !contextModelId);
      patchText(ctxModelLabel, t('settings.oth.ctxModel'));
      patchText(ctxWindowLabel, t('settings.oth.ctxBaselineLabel'));
      const hint = !models.size ? 'ctxNoModels' : selected === mixed ? 'ctxMixedHint' :
        contextModelId && !options.length ? 'ctxNoOptions' : 'ctxBaselineHint';
      const reported = current?.reportedLimitTokens;
      patchText(ctxHint, [t(`settings.oth.${hint}`), reported &&
        t('settings.oth.ctxReported', { name: formatLimit(String(reported)) })].filter(Boolean).join(' '));
      patchText(ctxStatus, contextFeedback ? t(contextFeedback) : '');
      getProps().onLayoutChange?.();
    }

    const baselinePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header settings-panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          baselineTitleEl,
        ]),
        ctxStatus,
      ]),
      ctxRiskStage,
    ]);
    renderContextWindows();

    // --- Card 3: 缓存与重置 ---
    const maintTitleEl = h('span', { text: t('settings.oth.maintTitle') });
    const cacheLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.cacheLabel'),
    });
    const cacheDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.cacheDesc'),
    });

    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            if (res?.ok !== false) {
              showMaintFeedback(t('settings.oth.rebuildDone'), 2800);
            } else {
              showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
            }
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.resetLabel'),
    });
    const resetDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.resetDesc'),
    });

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });

    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }

          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'auto');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const backupLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.backupLabel'),
    });
    const backupDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.backupDesc'),
    });
    const exportJsonBtnText = h('span', { text: t('settings.oth.exportJsonBtn') });
    const importJsonBtnText = h('span', { text: t('settings.oth.importJsonBtn') });
    let isImportingSettings = false;

    async function applyImportedSettingsText(rawText) {
      const parsed = parseImportedSettingsJson(rawText);
      if (!parsed.ok) {
        showMaintFeedback(t('settings.oth.importInvalid'), 3200);
        return false;
      }
      isImportingSettings = true;
      patchAttr(importJsonBtn, 'disabled', true);
      showMaintFeedback(t('settings.saving'), 0);
      try {
        await saveSettingsPatch(parsed.patch);
        if (parsed.patch.language) {
          setI18nLanguage(parsed.patch.language);
        }
        showMaintFeedback(
          t('settings.oth.importDone', { count: parsed.appliedCount }),
          2800
        );
        return true;
      } catch {
        showMaintFeedback(t('settings.saveFailed'), 2800);
        return false;
      } finally {
        isImportingSettings = false;
        patchAttr(importJsonBtn, 'disabled', false);
      }
    }

    const importFileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      className: 'settings-hidden-file-input',
      hidden: true,
    });
    importFileInput.addEventListener?.('change', async () => {
      const file = importFileInput.files?.[0];
      importFileInput.value = '';
      if (!file || isImportingSettings) return;
      try {
        const text =
          typeof file.text === 'function' ? await file.text() : String(file.content || '');
        await applyImportedSettingsText(text);
      } catch {
        showMaintFeedback(t('settings.oth.importInvalid'), 3200);
      }
    });

    const exportJsonBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          const json = buildExportableSettingsJson(latestSettings || {});
          const res = await exportTextFileWithFeedback(
            'antigravity-usage-monitor-settings.json',
            json,
            'application/json;charset=utf-8'
          );
          if (res?.ok) {
            showMaintFeedback(
              res.filePath ? `${t('settings.oth.exportDone')} · ${res.filePath}` : t('settings.oth.exportDone'),
              4200
            );
          }
        },
      },
      [createSvgIcon('download', { size: 12 }), exportJsonBtnText]
    );

    const importJsonBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: () => {
          if (isImportingSettings) return;
          importFileInput.click?.();
        },
      },
      [createSvgIcon('upload', { size: 12 }), importJsonBtnText]
    );

    const backupActionsWrap = h('div', { className: 'settings-backup-actions' }, [
      exportJsonBtn,
      importJsonBtn,
      importFileInput,
    ]);

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header settings-panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('refresh', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [cacheLabelEl, cacheDescEl]),
        rebuildCacheBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [resetLabelEl, resetDescEl]),
        resetAllBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [backupLabelEl, backupDescEl]),
        backupActionsWrap,
      ]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      modelPanel,
      experimentalPanel,
      baselinePanel,
      maintPanel,
    ]);

    function renderSettings(
      settings,
      models = contextWindowModels,
      windowBridge = latestWindowBridge,
      hostPlatform = latestHostPlatform,
      cloudCodeProxy = latestCloudCodeProxy
    ) {
      if (!settings) return;
      latestSettings = settings;
      contextWindowModels = models;
      if (windowBridge !== undefined) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      if (cloudCodeProxy !== undefined) latestCloudCodeProxy = cloudCodeProxy;
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftExperimentalQuotaReservation = normalizeClientExperimentalQuotaReservation(
        settings.experimentalQuotaReservation
      );
      if (!acceptingContextRisk) {
        draftContextRiskAccepted = Boolean(settings.contextWindowRiskAccepted);
      }
      if (!savingContextScope) {
        draftContextMainEnabled = settings.contextWindowMainEnabled !== false;
        draftContextSwarmEnabled = settings.contextWindowSwarmEnabled === true;
      }
      stepModelSelect.setProps({
        ariaLabel: t('settings.oth.modelTitle'),
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      quotaReserveToggle.setProps({
        modelValue: draftExperimentalQuotaReservation ? 'on' : 'off',
      });
      renderContextWindows();
    }

    function refreshLabels() {
      patchText(modelCardTitleEl, t('settings.oth.modelTitle'));
      patchText(expTitleEl, t('settings.oth.expTitle'));
      patchText(quotaReserveLabelEl, t('settings.oth.quotaReserveLabel'));
      patchText(quotaReserveBadgeEl, t('settings.oth.expBadge'));
      patchText(quotaReserveDescEl, t('settings.oth.quotaReserveDesc'));
      patchText(quotaReserveLogLabelEl, t('settings.oth.quotaReserveLogLabel'));
      patchText(quotaReserveLogDescEl, t('settings.oth.quotaReserveLogDesc'));
      patchText(exportReserveLogBtnText, t('settings.oth.exportReserveLogBtn'));
      quotaReserveToggle.setProps({
        modelValue: draftExperimentalQuotaReservation ? 'on' : 'off',
      });
      patchText(baselineTitleEl, t('settings.oth.baselineTitle'));
      renderContextWindows();
      patchText(maintTitleEl, t('settings.oth.maintTitle'));
      patchText(backupLabelEl, t('settings.oth.backupLabel'));
      patchText(backupDescEl, t('settings.oth.backupDesc'));
      patchText(exportJsonBtnText, t('settings.oth.exportJsonBtn'));
      patchText(importJsonBtnText, t('settings.oth.importJsonBtn'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      patchText(cacheDescEl, t('settings.oth.cacheDesc'));
      patchText(resetLabelEl, t('settings.oth.resetLabel'));
      patchText(resetDescEl, t('settings.oth.resetDesc'));

      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }

      stepModelSelect.setProps({
        ariaLabel: t('settings.oth.modelTitle'),
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
    }

    onCleanup(() => {
      if (modelTimer) clearTimeout(modelTimer);
      if (expTimer) clearTimeout(expTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      stepModelSelect.destroy();
      quotaReserveToggle.destroy();
      ctxBridgeNotice.destroy();
      ctxMainToggle.destroy();
      ctxSwarmToggle.destroy();
      ctxModelSelect.destroy();
      ctxWindowSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepModelSelect,
        quotaReserveToggle,
        exportReserveLogBtn,
        ctxBridgeNotice,
        ctxMainToggle,
        ctxSwarmToggle,
        ctxModelSelect,
        ctxWindowSelect,
        rebuildCacheBtn,
        resetAllBtn,
        exportJsonBtn,
        importJsonBtn,
        importFileInput,
        applyImportedSettingsText,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
