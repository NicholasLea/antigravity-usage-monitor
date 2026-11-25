/**
 * @fileoverview Shared CDP / Window Bridge diagnostic & one-click relaunch card (`BridgeStatusNotice.js`).
 * Surfaces automatic shortcut provisioning status, IDE/Desktop targeted host relaunch, and on-demand
 * macOS user-space `.app` launcher creation when running without an active `DevToolsActivePort`.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import {
  copyPlainTextToClipboard,
  createCopiedFeedbackController,
} from '../../core/stepInspector.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { triggerBridgeHostRelaunch } from '../../store/telemetryStore.js';

const LAUNCH_FLAG_TEXT = '--remote-debugging-port=0';

export const BridgeStatusNotice = defineComponent({
  name: 'BridgeStatusNotice',
  setup({ props, onCleanup }) {
    let contextMode = Boolean(props?.contextMode);
    const dismissible = Boolean(props?.dismissible);
    let lastPayload = {
      visible: false,
      windowBridge: null,
      hostPlatform: 'win32',
    };
    let dismissed = false;
    let relaunchState = 'idle'; // 'idle' | 'relaunching' | 'failed'
    let relaunchResetTimer = null;
    let macWrapperBusy = false;
    let macWrapperFeedback = ''; // '' | 'created' | 'removed' | 'failed'
    let macWrapperFeedbackTimer = null;
    let destroyed = false;

    function isTargetMacWrapperPresent(wb) {
      if (!wb || typeof wb !== 'object') return false;
      const isIde = String(wb.targetProduct || '') === 'ide';
      if (isIde && typeof wb.macIdeWrapperExists === 'boolean') {
        return wb.macIdeWrapperExists;
      }
      if (!isIde && typeof wb.macDesktopWrapperExists === 'boolean') {
        return wb.macDesktopWrapperExists;
      }
      return Boolean(wb.macWrapperExists);
    }
    const copyFeedback = createCopiedFeedbackController({
      durationMs: 1800,
      onCleanup,
      onChange: () => {
        if (!destroyed) syncActionButtons();
      },
    });

    const headIconEl = createSvgIcon('warning', { size: 13, className: 'settings-bridge-icon' });
    const titleEl = h('strong', { className: 'settings-bridge-title', text: '' });
    const bodyEl = h('p', { className: 'settings-bridge-desc', text: '' });

    const dismissBtnEl = dismissible
      ? h(
          'button',
          {
            type: 'button',
            className: 'btn-ghost-sm settings-bridge-dismiss-btn',
            'aria-label': t('settings.bridge.dismissAria'),
            title: t('settings.bridge.dismissAria'),
            onClick: () => {
              dismissed = true;
              render();
              props?.onDismiss?.();
            },
          },
          [createSvgIcon('close', { size: 11 })]
        )
      : null;

    const relaunchBtnIconEl = createSvgIcon('refresh', { size: 11 });
    const relaunchBtnTextEl = h('span', {
      className: 'settings-bridge-relaunch-text',
      text: t('settings.bridge.relaunchBtn'),
    });
    const relaunchBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'settings-bridge-relaunch-btn',
        onClick: async () => {
          if (relaunchState === 'relaunching' || destroyed) return;
          relaunchState = 'relaunching';
          if (relaunchResetTimer) {
            clearTimeout(relaunchResetTimer);
            relaunchResetTimer = null;
          }
          syncActionButtons();
          try {
            const targetProd = String(lastPayload.windowBridge?.targetProduct || 'auto');
            const res = await triggerBridgeHostRelaunch({ product: targetProd });
            if (destroyed) return;
            if (!res || res.ok === false) {
              relaunchState = 'failed';
              syncActionButtons();
              relaunchResetTimer = setTimeout(() => {
                relaunchResetTimer = null;
                if (destroyed) return;
                relaunchState = 'idle';
                syncActionButtons();
              }, 3500);
              relaunchResetTimer?.unref?.();
              return;
            }
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 9000);
            relaunchResetTimer?.unref?.();
          } catch {
            if (destroyed) return;
            relaunchState = 'failed';
            syncActionButtons();
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 3500);
            relaunchResetTimer?.unref?.();
          }
        },
      },
      [relaunchBtnIconEl, relaunchBtnTextEl]
    );

    const macWrapperBtnIconEl = createSvgIcon('download', { size: 11 });
    const macWrapperBtnTextEl = h('span', {
      className: 'settings-bridge-wrapper-text',
      text: t('settings.bridge.macCreateWrapperBtn'),
    });
    const macWrapperBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm settings-bridge-wrapper-btn',
        hidden: true,
        onClick: async () => {
          if (macWrapperBusy || destroyed) return;
          const existsNow = isTargetMacWrapperPresent(lastPayload.windowBridge);
          const actionProd =
            String(lastPayload.windowBridge?.targetProduct || '') === 'ide' ? 'ide' : 'desktop';
          macWrapperBusy = true;
          if (macWrapperFeedbackTimer) {
            clearTimeout(macWrapperFeedbackTimer);
            macWrapperFeedbackTimer = null;
          }
          syncActionButtons();
          try {
            const res = await triggerBridgeHostRelaunch({
              action: existsNow ? 'remove_macos_wrapper' : 'create_macos_wrapper',
              product: actionProd,
            });
            if (destroyed) return;
            if (res && res.ok !== false) {
              lastPayload = {
                ...lastPayload,
                windowBridge: {
                  ...(lastPayload.windowBridge || {}),
                  macWrapperExists: Boolean(res.macWrapperExists),
                  ...(typeof res.macDesktopWrapperExists === 'boolean'
                    ? { macDesktopWrapperExists: res.macDesktopWrapperExists }
                    : {}),
                  ...(typeof res.macIdeWrapperExists === 'boolean'
                    ? { macIdeWrapperExists: res.macIdeWrapperExists }
                    : {}),
                  macWrapperPaths: Array.isArray(res.macWrapperPaths) ? res.macWrapperPaths : [],
                },
              };
              macWrapperFeedback = existsNow ? 'removed' : 'created';
            } else {
              macWrapperFeedback = 'failed';
            }
          } catch {
            if (destroyed) return;
            macWrapperFeedback = 'failed';
          } finally {
            if (!destroyed) {
              macWrapperBusy = false;
              syncActionButtons();
              macWrapperFeedbackTimer = setTimeout(() => {
                macWrapperFeedbackTimer = null;
                if (destroyed) return;
                macWrapperFeedback = '';
                syncActionButtons();
              }, 2600);
              macWrapperFeedbackTimer?.unref?.();
            }
          }
        },
      },
      [macWrapperBtnIconEl, macWrapperBtnTextEl]
    );

    const copyBtnIconEl = createSvgIcon('copy', { size: 11 });
    const copyBtnTextEl = h('span', {
      className: 'settings-bridge-copy-text',
      text: t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT }),
    });
    const copyBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm settings-bridge-copy-btn',
        onClick: async () => {
          await copyPlainTextToClipboard(LAUNCH_FLAG_TEXT);
          if (destroyed) return;
          copyFeedback.trigger(true);
        },
      },
      [copyBtnIconEl, copyBtnTextEl]
    );

    const headLeftEl = h('div', { className: 'settings-bridge-head-main' }, [headIconEl, titleEl]);
    const headRowEl = h(
      'div',
      { className: 'settings-bridge-head' },
      dismissBtnEl ? [headLeftEl, dismissBtnEl] : [headLeftEl]
    );
    const actionsRowEl = h('div', { className: 'settings-bridge-actions' }, [
      relaunchBtnEl,
      macWrapperBtnEl,
      copyBtnEl,
    ]);

    const rootEl = h(
      'div',
      {
        className: 'settings-bridge-notice',
        role: 'status',
        hidden: true,
      },
      [headRowEl, bodyEl, actionsRowEl]
    );

    function syncActionButtons() {
      const wb = lastPayload.windowBridge;
      const plat = String(lastPayload.hostPlatform || '').trim().toLowerCase();
      const canRelaunch = wb?.canRelaunch !== false;
      const needsAuth = Boolean(wb?.hasReadOnlyShortcuts);
      const isIdeTarget = String(wb?.targetProduct || '') === 'ide';
      patchAttr(relaunchBtnEl, 'hidden', !canRelaunch);
      patchAttr(relaunchBtnEl, 'disabled', relaunchState === 'relaunching');
      patchText(
        relaunchBtnTextEl,
        relaunchState === 'relaunching'
          ? t('settings.bridge.relaunchingBtn')
          : relaunchState === 'failed'
            ? t('settings.bridge.relaunchFailed')
            : needsAuth
              ? t('settings.bridge.relaunchAuthBtn')
              : isIdeTarget
                ? t('settings.bridge.relaunchIdeBtn')
                : t('settings.bridge.relaunchBtn')
      );

      const showMacWrapperBtn = plat === 'darwin';
      const wrapperExists = isTargetMacWrapperPresent(wb);
      patchAttr(macWrapperBtnEl, 'hidden', !showMacWrapperBtn);
      patchAttr(macWrapperBtnEl, 'disabled', macWrapperBusy);
      patchSvgIcon(
        macWrapperBtnIconEl,
        macWrapperFeedback === 'created' || macWrapperFeedback === 'removed'
          ? 'check'
          : wrapperExists
            ? 'close'
            : 'download'
      );
      patchText(
        macWrapperBtnTextEl,
        macWrapperFeedback === 'created'
          ? t('settings.bridge.macWrapperCreatedBtn')
          : macWrapperFeedback === 'removed'
            ? t('settings.bridge.macWrapperRemovedBtn')
            : macWrapperFeedback === 'failed'
              ? t('settings.bridge.macWrapperFailedBtn')
              : wrapperExists
                ? t('settings.bridge.macRemoveWrapperBtn')
                : t('settings.bridge.macCreateWrapperBtn')
      );

      const isCopied = copyFeedback.isCopied(true);
      patchSvgIcon(copyBtnIconEl, isCopied ? 'check' : 'copy');
      patchText(
        copyBtnTextEl,
        isCopied
          ? t('settings.bridge.copiedBtn')
          : t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT })
      );

      if (dismissBtnEl) {
        const aria = t('settings.bridge.dismissAria');
        patchAttr(dismissBtnEl, 'aria-label', aria);
        patchAttr(dismissBtnEl, 'title', aria);
      }
    }

    function render() {
      const wb = lastPayload.windowBridge;
      const state = String(wb?.state || '').trim();
      if (state === 'active') {
        dismissed = false;
      }
      const shouldShow =
        !dismissed &&
        Boolean(lastPayload.visible) &&
        !isWindowOverlayMode() &&
        (state === 'no_devtools_port' || state === 'cdp_unreachable');

      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const plat = String(lastPayload.hostPlatform || '').trim().toLowerCase();
      const hasReadOnlyShortcuts = Boolean(wb?.hasReadOnlyShortcuts);
      const isStalePort = Boolean(wb?.stalePortDetected);
      const isMacDesktop = plat === 'darwin' && !wb?.argvConfigured;
      const isAutoConfigured = Boolean(
        wb?.launcherConfigured || wb?.argvUpdatedThisBoot || wb?.argvConfigured
      );
      const useRestartTheme = !hasReadOnlyShortcuts && (isAutoConfigured || isMacDesktop);

      patchClasses(rootEl, {
        'is-restart': useRestartTheme,
        'is-warn': !useRestartTheme,
      });
      patchSvgIcon(headIconEl, useRestartTheme ? 'refresh' : 'warning');

      let titleText = '';
      let bodyText = '';
      if (hasReadOnlyShortcuts) {
        titleText = contextMode
          ? t('settings.bridge.ctxReadOnlyTitle')
          : t('settings.bridge.readOnlyTitle');
        bodyText = t('settings.bridge.readOnlyBody');
      } else if (isMacDesktop) {
        titleText = contextMode
          ? t('settings.bridge.ctxMacTitle')
          : t('settings.bridge.macTitle');
        bodyText = t('settings.bridge.guideMac');
      } else if (isAutoConfigured) {
        titleText = contextMode
          ? t('settings.bridge.ctxRestartTitle')
          : t('settings.bridge.restartTitle');
        bodyText =
          plat === 'darwin' ? t('settings.bridge.guideMac') : t('settings.bridge.restartBody');
      } else {
        titleText = contextMode
          ? t('settings.bridge.ctxTitle')
          : isStalePort
            ? t('settings.bridge.stalePortTitle')
            : state === 'cdp_unreachable'
              ? t('settings.bridge.unreachableTitle')
              : t('settings.bridge.noPortTitle');
        bodyText =
          plat === 'darwin'
            ? t('settings.bridge.guideMac')
            : plat === 'linux'
              ? t('settings.bridge.guideLinux')
              : t('settings.bridge.guideWin');
      }

      patchText(titleEl, titleText);
      patchText(bodyEl, bodyText);
      syncActionButtons();
    }

    function update(next = {}) {
      if (typeof next.contextMode === 'boolean') {
        contextMode = next.contextMode;
      }
      lastPayload = {
        ...lastPayload,
        ...next,
      };
      render();
    }

    onCleanup(() => {
      destroyed = true;
      if (relaunchResetTimer) {
        clearTimeout(relaunchResetTimer);
        relaunchResetTimer = null;
      }
      if (macWrapperFeedbackTimer) {
        clearTimeout(macWrapperFeedbackTimer);
        macWrapperFeedbackTimer = null;
      }
    });

    return {
      el: rootEl,
      refs: {
        update,
        refreshLabels: render,
        relaunchBtnEl,
        macWrapperBtnEl,
        copyBtnEl,
        dismissBtnEl,
      },
    };
  },
});
