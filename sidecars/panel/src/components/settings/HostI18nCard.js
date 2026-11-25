/**
 * @fileoverview Self-contained Antigravity Host UI Language card (`HostI18nCard.js`).
 *
 * Mounted inside `SettingsGeneralTab` with minimal glue; manages:
 * - Language selection (`off` or any pack listed in repository `manifest.json`),
 * - Conditional Light / Deep translation depth switching (0-network hot switch),
 * - On-demand repository pack download and SemVer-checked updates,
 * - Direct untranslated UI string collection alongside pack actions,
 * - CDP bridge notice when DevTools port is unavailable.
 */

import {
  HOST_I18N_OFF_LOCALE,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
} from '../../../shared/host-i18n-protocol.mjs';
import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { abortSidecarApiKey } from '../../core/httpClient.js';
import {
  copyTextWithFeedback,
  exportTextFileWithFeedback,
} from '../../core/fileExportClient.js';
import {
  collectHostI18nUntranslated,
  fetchHostI18nStatus,
  installOrUpdateHostI18nPack,
  selectHostI18nLanguage,
  updateHostI18nDepth,
} from '../../core/hostI18nClient.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { CustomSelect } from '../ui/CustomSelect.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import { BridgeStatusNotice } from './BridgeStatusNotice.js';

function formatHostI18nBytes(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num < 1024) return `${num} B`;
  return `${(num / 1024).toFixed(1)} KB`;
}

function getHostI18nDepthOptions() {
  return [
    { value: 'light', label: t('settings.hostI18n.depthLight') },
    { value: 'deep', label: t('settings.hostI18n.depthDeep') },
  ];
}

export const HostI18nCard = defineComponent({
  name: 'HostI18nCard',
  setup({ props, onCleanup }) {
    let status = null;
    let draftLocale = HOST_I18N_OFF_LOCALE;
    let draftDepth = 'light';
    let latestWindowBridge = null;
    let latestHostPlatform = 'win32';
    let lastBridgeRenderSig = '';
    let hasLoadedOnce = false;
    let isBusy = false;
    let isCollecting = false;
    let destroyed = false;
    let feedbackTimer = null;
    let lastCollected = null;

    const titleEl = h('span', { text: t('settings.hostI18n.title') });
    const statusMsgEl = h('span', {
      className: 'text-muted host-i18n-status-msg',
      text: '',
    });

    function showFeedback(text, { isError = false, autoClearMs = 2800 } = {}) {
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
      patchText(statusMsgEl, text || '');
      patchClasses(statusMsgEl, { 'is-error': Boolean(isError && text) });
      if (text && autoClearMs > 0) {
        feedbackTimer = setTimeout(() => {
          feedbackTimer = null;
          if (!destroyed) {
            patchText(statusMsgEl, '');
            patchClasses(statusMsgEl, { 'is-error': false });
          }
        }, autoClearMs);
      }
    }

    function getPackList() {
      return Array.isArray(status?.packs) ? status.packs : [];
    }

    function findPackByLocale(locale) {
      return getPackList().find((p) => p.locale === locale) || null;
    }

    function buildLocaleOptions() {
      const opts = [{ value: HOST_I18N_OFF_LOCALE, label: t('settings.hostI18n.langOff') }];
      for (const pack of getPackList()) {
        const displayName =
          pack.nativeName && pack.nativeName !== pack.name
            ? `${pack.nativeName} (${pack.locale})`
            : `${pack.name || pack.locale} (${pack.locale})`;
        const tag = pack.installed
          ? t('settings.hostI18n.optInstalled', { ver: pack.installedVersion || pack.remoteVersion || '1.0.0' })
          : t('settings.hostI18n.optRemote', {
              size: formatHostI18nBytes(pack.remoteBytes) || 'pack',
            });
        opts.push({
          value: pack.locale,
          label: `${displayName} · ${tag}`,
        });
      }
      if (
        draftLocale !== HOST_I18N_OFF_LOCALE &&
        !opts.some((o) => o.value === draftLocale)
      ) {
        opts.push({ value: draftLocale, label: draftLocale });
      }
      return opts;
    }

    const langLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.hostI18n.langLabel'),
    });
    const langSelect = CustomSelect({
      ariaLabel: t('settings.hostI18n.langLabel'),
      icon: 'globe',
      modelValue: draftLocale,
      options: buildLocaleOptions(),
      onUpdateModelValue: async (val) => {
        if (isBusy || destroyed) return;
        const nextLocale = normalizeHostI18nLocale(val);
        const targetPack = findPackByLocale(nextLocale);
        const needsDownload =
          nextLocale !== HOST_I18N_OFF_LOCALE && !targetPack?.installed;
        isBusy = true;
        draftLocale = nextLocale;
        syncControls();
        showFeedback(
          needsDownload
            ? t('settings.hostI18n.downloadingMsg', { locale: nextLocale })
            : t('settings.saving'),
          { autoClearMs: 0 }
        );
        try {
          const res = await selectHostI18nLanguage(nextLocale, draftDepth);
          if (destroyed) return;
          applyStatusPayload(res);
          if (res?.ok === false) {
            showFeedback(res.error || t('settings.hostI18n.actionFailed'), {
              isError: true,
              autoClearMs: 5000,
            });
          } else if (nextLocale === HOST_I18N_OFF_LOCALE) {
            showFeedback(t('settings.hostI18n.disabledMsg'), { autoClearMs: 2500 });
          } else if (res?.downloaded) {
            showFeedback(t('settings.hostI18n.downloadedAndAppliedMsg'), { autoClearMs: 3200 });
          } else {
            showFeedback(t('settings.hostI18n.appliedMsg'), { autoClearMs: 2200 });
          }
        } catch (err) {
          if (!destroyed) {
            if (status) applyStatusPayload(status);
            showFeedback(err?.message || t('settings.hostI18n.actionFailed'), {
              isError: true,
              autoClearMs: 5000,
            });
          }
        } finally {
          isBusy = false;
          if (!destroyed) {
            syncControls();
            props.onLayoutChange?.();
          }
        }
      },
    });

    const langHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.hostI18n.langHint'),
    });

    // --- Conditional Depth Row (visible only when locale !== 'off') ---
    const depthLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.hostI18n.depthLabel'),
    });
    const depthSwitch = SegmentedControl({
      ariaLabel: t('settings.hostI18n.depthLabel'),
      modelValue: draftDepth,
      options: getHostI18nDepthOptions(),
      onUpdateModelValue: async (val) => {
        if (isBusy || destroyed) return;
        const nextDepth = normalizeHostI18nDepth(val);
        if (nextDepth === draftDepth) return;
        isBusy = true;
        draftDepth = nextDepth;
        syncControls();
        showFeedback(t('settings.saving'), { autoClearMs: 0 });
        try {
          const res = await updateHostI18nDepth(nextDepth);
          if (destroyed) return;
          applyStatusPayload(res);
          showFeedback(t('settings.hostI18n.depthSwitchedMsg'), { autoClearMs: 2000 });
        } catch (err) {
          if (!destroyed) {
            if (status) applyStatusPayload(status);
            showFeedback(err?.message || t('settings.saveFailed'), {
              isError: true,
              autoClearMs: 3500,
            });
          }
        } finally {
          isBusy = false;
          if (!destroyed) syncControls();
        }
      },
    });
    const depthHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.hostI18n.depthLightHint'),
    });
    const depthRowEl = h('div', { className: 'form-row', hidden: true }, [
      depthLabelEl,
      depthSwitch.el,
      depthHintEl,
    ]);

    // --- Pack Update & Missing-String Collection Action Bar ---
    const updatePackBtnText = h('span', { text: t('settings.hostI18n.redownloadBtn') });
    const updatePackBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        hidden: true,
        onClick: async () => {
          if (isBusy || destroyed || draftLocale === HOST_I18N_OFF_LOCALE) return;
          const activeBefore = findPackByLocale(draftLocale);
          const hasPendingUpdate = Boolean(activeBefore?.updateAvailable);
          isBusy = true;
          syncControls();
          showFeedback(
            hasPendingUpdate
              ? t('settings.hostI18n.downloadingMsg', { locale: draftLocale })
              : t('settings.hostI18n.checkingUpdateMsg'),
            { autoClearMs: 0 }
          );
          try {
            const res = await installOrUpdateHostI18nPack(draftLocale);
            if (destroyed) return;
            applyStatusPayload(res);
            if (res?.ok === false) {
              showFeedback(res.error || t('settings.hostI18n.actionFailed'), {
                isError: true,
                autoClearMs: 5000,
              });
            } else if (res?.alreadyUpToDate) {
              const ver =
                res.installed?.version ||
                findPackByLocale(draftLocale)?.installedVersion ||
                '';
              showFeedback(
                ver
                  ? t('settings.hostI18n.alreadyLatestVerMsg', { ver })
                  : t('settings.hostI18n.alreadyLatestMsg'),
                { autoClearMs: 2600 }
              );
            } else {
              showFeedback(t('settings.hostI18n.packUpdatedMsg'), { autoClearMs: 3000 });
            }
          } catch (err) {
            if (!destroyed) {
              showFeedback(err?.message || t('settings.hostI18n.actionFailed'), {
                isError: true,
                autoClearMs: 5000,
              });
            }
          } finally {
            isBusy = false;
            if (!destroyed) syncControls();
          }
        },
      },
      [createSvgIcon('download', { size: 12 }), updatePackBtnText]
    );

    const collectBtnText = h('span', { text: t('settings.hostI18n.collectBtn') });
    const collectResultEl = h('span', { className: 'settings-hint-text', text: '' });

    const copyCollectedBtnText = h('span', { text: t('settings.hostI18n.copyJsonBtn') });
    const copyCollectedBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm',
        hidden: true,
        onClick: async () => {
          if (!lastCollected?.template) return;
          await copyTextWithFeedback(JSON.stringify(lastCollected.template, null, 2), {
            onFeedback: (msg) => showFeedback(msg, { autoClearMs: 2400 }),
          });
        },
      },
      [createSvgIcon('copy', { size: 11 }), copyCollectedBtnText]
    );

    const exportCollectedBtnText = h('span', { text: t('settings.hostI18n.exportJsonBtn') });
    const exportCollectedBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm',
        hidden: true,
        onClick: async () => {
          if (!lastCollected?.template) return;
          const fileLocale = draftLocale === HOST_I18N_OFF_LOCALE ? 'en-source' : draftLocale;
          await exportTextFileWithFeedback({
            filename: `host-i18n-missing-${fileLocale}.json`,
            content: JSON.stringify(lastCollected.template, null, 2) + '\n',
            mimeType: 'application/json',
            onFeedback: (msg) => showFeedback(msg, { autoClearMs: 3200 }),
          });
        },
      },
      [createSvgIcon('download', { size: 11 }), exportCollectedBtnText]
    );

    const collectResultActionsEl = h('div', { className: 'host-i18n-collect-actions', hidden: true }, [
      copyCollectedBtn,
      exportCollectedBtn,
    ]);
    const collectResultBoxEl = h('div', { className: 'host-i18n-collect-result', hidden: true }, [
      collectResultEl,
      collectResultActionsEl,
    ]);

    const collectBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isCollecting || destroyed) return;
          isCollecting = true;
          patchAttr(collectBtn, 'disabled', true);
          patchText(collectBtnText, t('settings.hostI18n.collectingBtn'));
          try {
            const res = await collectHostI18nUntranslated();
            if (destroyed) return;
            if (res?.ok) {
              lastCollected = res;
              const hasItems = res.count > 0;
              patchText(
                collectResultEl,
                hasItems
                  ? t('settings.hostI18n.collectedResult', {
                      count: res.count,
                      targets: res.targets || 1,
                    })
                  : t('settings.hostI18n.collectedEmpty')
              );
              patchClasses(collectResultEl, { 'is-error': false });
              patchAttr(collectResultBoxEl, 'hidden', false);
              patchAttr(collectResultActionsEl, 'hidden', !hasItems);
              patchAttr(copyCollectedBtn, 'hidden', !hasItems);
              patchAttr(exportCollectedBtn, 'hidden', !hasItems);
            } else {
              lastCollected = null;
              patchText(collectResultEl, res?.error || t('settings.hostI18n.collectFailed'));
              patchClasses(collectResultEl, { 'is-error': true });
              patchAttr(collectResultBoxEl, 'hidden', false);
              patchAttr(collectResultActionsEl, 'hidden', true);
              patchAttr(copyCollectedBtn, 'hidden', true);
              patchAttr(exportCollectedBtn, 'hidden', true);
            }
          } catch (err) {
            if (!destroyed) {
              lastCollected = null;
              patchText(collectResultEl, err?.message || t('settings.hostI18n.collectFailed'));
              patchClasses(collectResultEl, { 'is-error': true });
              patchAttr(collectResultBoxEl, 'hidden', false);
              patchAttr(collectResultActionsEl, 'hidden', true);
              patchAttr(copyCollectedBtn, 'hidden', true);
              patchAttr(exportCollectedBtn, 'hidden', true);
            }
          } finally {
            isCollecting = false;
            if (!destroyed) {
              patchAttr(collectBtn, 'disabled', false);
              patchText(collectBtnText, t('settings.hostI18n.collectBtn'));
              props.onLayoutChange?.();
            }
          }
        },
      },
      [createSvgIcon('search', { size: 12 }), collectBtnText]
    );

    const packBarEl = h('div', { className: 'host-i18n-pack-bar' }, [
      updatePackBtn,
      collectBtn,
    ]);

    // --- CDP Bridge Diagnostic Notice (shown only when active locale cannot reach CDP) ---
    const bridgeNotice = BridgeStatusNotice({ contextMode: true });

    const rootEl = h('section', { className: 'panel host-i18n-panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('globe', { size: 13 }),
          titleEl,
        ]),
        statusMsgEl,
      ]),
      h('div', { className: 'form-row' }, [
        langLabelEl,
        langSelect.el,
        langHintEl,
      ]),
      depthRowEl,
      packBarEl,
      collectResultBoxEl,
      bridgeNotice.el,
    ]);

    function applyStatusPayload(payload) {
      if (!payload || typeof payload !== 'object') return;
      status = payload;
      draftLocale = normalizeHostI18nLocale(payload.locale);
      draftDepth = normalizeHostI18nDepth(payload.depth);
      if (payload.bridgeStatus) {
        latestWindowBridge = payload.bridgeStatus;
      }
      syncControls();
    }

    function syncControls() {
      const enabled = draftLocale !== HOST_I18N_OFF_LOCALE;
      const activePack = enabled ? findPackByLocale(draftLocale) : null;

      langSelect.setProps({
        modelValue: draftLocale,
        options: buildLocaleOptions(),
        disabled: isBusy,
      });

      patchAttr(depthRowEl, 'hidden', !enabled);
      depthSwitch.setProps({
        modelValue: draftDepth,
        options: getHostI18nDepthOptions(),
      });
      patchText(
        depthHintEl,
        draftDepth === 'deep'
          ? t('settings.hostI18n.depthDeepHint')
          : t('settings.hostI18n.depthLightHint')
      );

      patchAttr(updatePackBtn, 'hidden', !enabled);
      if (enabled) {
        const hasUpdate = Boolean(activePack?.updateAvailable);
        patchText(
          updatePackBtnText,
          hasUpdate
            ? t('settings.hostI18n.updatePackBtn', { ver: activePack.remoteVersion })
            : t('settings.hostI18n.redownloadBtn')
        );
        patchClasses(updatePackBtn, {
          'btn-primary': hasUpdate,
          'btn-secondary': !hasUpdate,
        });
        patchAttr(updatePackBtn, 'disabled', isBusy);
      }

      bridgeNotice.refs.update({
        visible: enabled,
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
        contextMode: true,
      });
    }

    async function load(force = false) {
      if (destroyed) return;
      if (hasLoadedOnce && !force) return;
      hasLoadedOnce = true;
      try {
        const res = await fetchHostI18nStatus();
        if (destroyed) return;
        applyStatusPayload(res);
        props.onLayoutChange?.();
      } catch {
        // 静默兜底
      }
    }

    function renderBridgeStatus(windowBridge, hostPlatform) {
      if (windowBridge) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      const sig = [
        String(latestWindowBridge?.state || ''),
        Boolean(latestWindowBridge?.launcherConfigured),
        Boolean(latestWindowBridge?.argvConfigured),
        Boolean(latestWindowBridge?.argvUpdatedThisBoot),
        Boolean(latestWindowBridge?.hasReadOnlyShortcuts),
        Boolean(latestWindowBridge?.stalePortDetected),
        String(latestWindowBridge?.targetProduct || ''),
        Boolean(latestWindowBridge?.macWrapperExists),
        Boolean(latestWindowBridge?.macDesktopWrapperExists),
        Boolean(latestWindowBridge?.macIdeWrapperExists),
        Boolean(latestWindowBridge?.canRelaunch),
        String(latestHostPlatform || ''),
      ].join('|');
      if (sig === lastBridgeRenderSig) return;
      lastBridgeRenderSig = sig;
      syncControls();
    }

    function refreshLabels() {
      patchText(titleEl, t('settings.hostI18n.title'));
      patchText(langLabelEl, t('settings.hostI18n.langLabel'));
      patchText(langHintEl, t('settings.hostI18n.langHint'));
      patchText(depthLabelEl, t('settings.hostI18n.depthLabel'));
      if (!isCollecting) patchText(collectBtnText, t('settings.hostI18n.collectBtn'));
      patchText(copyCollectedBtnText, t('settings.hostI18n.copyJsonBtn'));
      patchText(exportCollectedBtnText, t('settings.hostI18n.exportJsonBtn'));
      bridgeNotice.refs.refreshLabels();
      syncControls();
    }

    onCleanup(() => {
      destroyed = true;
      abortSidecarApiKey('host-i18n-get');
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
      langSelect.destroy();
      depthSwitch.destroy();
      bridgeNotice.destroy();
    });

    return {
      el: rootEl,
      refs: {
        langSelect,
        depthSwitch,
        load,
        renderBridgeStatus,
        refreshLabels,
      },
    };
  },
});
