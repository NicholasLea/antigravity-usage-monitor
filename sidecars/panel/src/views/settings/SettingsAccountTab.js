/** @fileoverview Unified multi-account switcher, passphrase vault UI, and per-pool quota cards. */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatCountdown } from '../../core/formatters.js';
import { callSidecarApi } from '../../core/httpClient.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { formatAccountTierBadge } from '../../components/widgets/QuotaPoolsWidget.js';
import {
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  normalizeAccountQuotaRefreshMinutes,
} from '../../../shared/settings-normalization.mjs';
import { saveSettingsPatch, telemetryStore } from '../../store/telemetryStore.js';

const key = (name) => `settings.account.${name}`;
const fmtPct = (v) => String(+Number(v).toFixed(1));

let warmAccountCache = null;

const errors = new Set([
  'unsupported', 'invalidEmail', 'invalidCredential', 'credentialTooLarge', 'notFound',
  'noCurrentCredential', 'busy', 'storeFailed', 'rollbackFailed', 'credentialAccessDenied',
  'credentialChanged', 'credentialRejected', 'identityMismatch', 'oauthClientUnavailable',
  'oauthUnavailable', 'quotaUnavailable',
  'switchStartFailed', 'clientCloseFailed', 'clientRestartFailed',
  'loginStartFailed', 'loginExchangeFailed', 'loginExpired', 'loginDenied',
  'vaultLocked', 'wrongPassword', 'invalidPassword', 'passwordMismatch',
  'passwordRateLimited', 'vaultDecryptFailed', 'invalidActionNonce',
]);

const okToastKeys = new Set([
  'saved', 'removed', 'switched',
  'pwdEnabledToast', 'pwdChangedToast', 'pwdDisabledToast',
  'vaultUnlockedToast', 'vaultLockedToast', 'vaultResetToast',
]);

function getAccountRefreshOptions() {
  return [
    { value: 10, label: t(key('refresh10m')) },
    { value: 30, label: t(key('refresh30m')) },
    { value: 60, label: t(key('refresh1h')) },
    { value: 180, label: t(key('refresh3h')) },
    { value: 360, label: t(key('refresh6h')) },
    { value: 720, label: t(key('refresh12h')) },
    { value: 1440, label: t(key('refresh24h')) },
  ];
}

function formatValidCountdown(isoTime) {
  if (!isoTime) return '';
  const ms = Date.parse(isoTime);
  if (!Number.isFinite(ms) || ms <= Date.now()) return '';
  return formatCountdown(isoTime);
}

function syncRemainingMeter(wrapEl, quotaLabelEl, resetEl, fillEl, hasData, labelText, remVal, resetTime) {
  patchAttr(wrapEl, 'hidden', !hasData);
  if (!hasData) return;
  const clamped = Math.max(0, Math.min(100, Number(remVal) || 0));
  patchText(quotaLabelEl, labelText);
  const cd = formatValidCountdown(resetTime);
  patchText(resetEl, cd);
  patchAttr(resetEl, 'hidden', !cd);
  patchStyleVar(fillEl, '--fill-w', `${+clamped.toFixed(1)}%`);
  patchClasses(fillEl, {
    'tone-warn': clamped > 15 && clamped <= 30,
    'tone-danger': clamped <= 15,
  });
}

function renderQuotaRows(container, quotaPools) {
  const locale = getEffectiveLocale();
  const pools = (Array.isArray(quotaPools) ? quotaPools : []).filter(
    (pool) => Number.isFinite(pool?.remainingPct) || Number.isFinite(pool?.weeklyRemainingPct)
  );
  patchKeyedList(container, pools, {
    keyFn: (pool) => pool.poolKey || pool.poolLabel,
    sigFn: (pool) =>
      JSON.stringify([
        locale,
        pool.poolLabel,
        pool.remainingPct,
        pool.weeklyRemainingPct,
        pool.resetTime,
        pool.weeklyResetTime,
      ]),
    createRow: () => {
      const poolTitle = h('div', { className: 'account-pool-name' });

      const label5h = h('span', { className: 'settings-account-quota text-mono' });
      const reset5h = h('span', { className: 'account-meter-reset text-mono', hidden: true });
      const fill5h = h('div', { className: 'progress-fill' });
      const meter5h = h('div', { className: 'account-meter-col' }, [
        h('div', { className: 'account-meter-head' }, [label5h, reset5h]),
        h('div', { className: 'progress-track account-progress-track' }, [fill5h]),
      ]);

      const labelWk = h('span', { className: 'settings-account-quota text-mono' });
      const resetWk = h('span', { className: 'account-meter-reset text-mono', hidden: true });
      const fillWk = h('div', { className: 'progress-fill' });
      const meterWk = h('div', { className: 'account-meter-col' }, [
        h('div', { className: 'account-meter-head' }, [labelWk, resetWk]),
        h('div', { className: 'progress-track account-progress-track' }, [fillWk]),
      ]);

      const gridEl = h('div', { className: 'account-pool-meters' }, [meter5h, meterWk]);
      const el = h('div', { className: 'account-pool-group' }, [poolTitle, gridEl]);
      return {
        el,
        refs: { poolTitle, gridEl, meter5h, label5h, reset5h, fill5h, meterWk, labelWk, resetWk, fillWk },
      };
    },
    updateRow: (refs, pool) => {
      patchText(refs.poolTitle, pool.poolLabel || pool.poolKey);
      const has5h = Number.isFinite(pool.remainingPct);
      const hasWk = Number.isFinite(pool.weeklyRemainingPct);
      patchClasses(refs.gridEl, { 'is-single': (has5h ? 1 : 0) + (hasWk ? 1 : 0) <= 1 });

      syncRemainingMeter(
        refs.meter5h,
        refs.label5h,
        refs.reset5h,
        refs.fill5h,
        has5h,
        has5h ? t(key('quota5h'), { percent: fmtPct(pool.remainingPct) }) : '',
        pool.remainingPct,
        pool.resetTime
      );
      syncRemainingMeter(
        refs.meterWk,
        refs.labelWk,
        refs.resetWk,
        refs.fillWk,
        hasWk,
        hasWk ? t(key('quotaWeekly'), { percent: fmtPct(pool.weeklyRemainingPct) }) : '',
        pool.weeklyRemainingPct,
        pool.weeklyResetTime
      );
    },
  });
  patchAttr(container, 'hidden', pools.length === 0);
  return pools.length;
}

function needsLegacyUltraTierRefresh(cached) {
  if (!cached || cached.tierId || cached.tierMultiplier) return false;
  const name = String(cached.tierName || '');
  return /\bultra\b/i.test(name) && !/\b(?:5x|20x)\b/i.test(name);
}

function isValidVaultPassphrase(raw) {
  return typeof raw === 'string' && raw.length >= 4 && raw.length <= 128 && Boolean(raw.trim());
}

export const SettingsAccountTab = defineComponent({
  name: 'SettingsAccountTab',
  setup({ props, onCleanup }) {
    let account = null;
    let quotas = null;
    let refreshMinutes = normalizeAccountQuotaRefreshMinutes(
      telemetryStore.getState().telemetry?.settings?.accountQuotaRefreshMinutes ??
        DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES
    );
    let accounts = warmAccountCache ? [...warmAccountCache.accounts] : [];
    let selectedEmail = warmAccountCache ? warmAccountCache.selectedEmail : '';
    let supported = warmAccountCache ? warmAccountCache.supported : null;
    let vaultSecurity = warmAccountCache?.vaultSecurity
      ? { ...warmAccountCache.vaultSecurity }
      : { enabled: false, unlocked: true };
    let actionNonce = warmAccountCache?.actionNonce || '';
    let operation = '';
    let status = '';
    let statusClearTimer = null;
    let confirmTarget = null;
    let confirmClearTimer = null;
    let switchState = null;
    let importOpen = false;
    let pwdDrawerOpen = false;
    let pwdManageMode = 'change';
    let forgotResetOpen = false;
    let refreshingSavedQuotas = false;
    let disposed = false;
    let loginSession = null;
    let loginTimer;
    let loginGeneration = 0;
    let loginRefreshEmail = '';
    const savedQuotas = new Map(warmAccountCache ? warmAccountCache.savedQuotasEntries : []);
    const quotaInFlight = new Set();
    const quotaVisibleLoading = new Set();
    const quotaErrors = new Map();

    function isVaultLocked() {
      return Boolean(vaultSecurity?.enabled && !vaultSecurity?.unlocked);
    }

    function syncWarmCache() {
      if (supported !== true) return;
      warmAccountCache = {
        supported,
        accounts: [...accounts],
        selectedEmail,
        savedQuotasEntries: [...savedQuotas.entries()],
        vaultSecurity: { ...vaultSecurity },
        actionNonce,
      };
    }

    function clearConfirmTarget(shouldRender = false) {
      if (confirmClearTimer) {
        clearTimeout(confirmClearTimer);
        confirmClearTimer = null;
      }
      if (!confirmTarget) return;
      confirmTarget = null;
      if (shouldRender && !disposed) render();
    }

    function armOrRunConfirm(type, targetKey, runFn) {
      if (confirmTarget && confirmTarget.type === type && confirmTarget.key === targetKey) {
        clearConfirmTarget(false);
        runFn();
        return;
      }
      if (confirmClearTimer) clearTimeout(confirmClearTimer);
      confirmTarget = { type, key: targetKey };
      confirmClearTimer = setTimeout(() => clearConfirmTarget(true), 4500);
      render();
    }

    function setTransientStatus(nextStatus, autoClearMs = 0) {
      if (statusClearTimer) {
        clearTimeout(statusClearTimer);
        statusClearTimer = null;
      }
      status = nextStatus;
      if (nextStatus && autoClearMs > 0) {
        statusClearTimer = setTimeout(() => {
          statusClearTimer = null;
          if (!disposed && status === nextStatus) {
            status = '';
            render();
          }
        }, autoClearMs);
      }
    }

    function clearPasswordInputs() {
      unlockInput.value = '';
      pwdCurrentInput.value = '';
      pwdNewInput.value = '';
      pwdConfirmInput.value = '';
    }

    const loginBtnLabel = h('span');
    const loginButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary settings-account-login account-toolbar-btn',
        onClick: () => {
          clearConfirmTarget(false);
          void request('loginStart', { language: getEffectiveLocale() });
        },
      },
      [createSvgIcon('plus', { size: 12 }), loginBtnLabel]
    );
    const cancelLogin = h('button', {
      type: 'button',
      className: 'btn-secondary settings-account-login-cancel account-toolbar-btn',
      hidden: true,
      onClick: () => request('loginCancel', { id: loginSession?.id }),
    });
    const importToggleLabel = h('span');
    const importToggleBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary account-toolbar-btn',
        onClick: () => {
          clearConfirmTarget(false);
          importOpen = !importOpen;
          if (importOpen) {
            pwdDrawerOpen = false;
            clearPasswordInputs();
          }
          render();
          if (importOpen) credential.focus?.();
        },
      },
      [importToggleLabel]
    );

    const pwdToggleIcon = createSvgIcon('lock', { size: 12 });
    const pwdToggleLabel = h('span');
    const pwdToggleBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary account-toolbar-btn settings-account-pwd-toggle',
        onClick: () => {
          clearConfirmTarget(false);
          pwdDrawerOpen = !pwdDrawerOpen;
          if (pwdDrawerOpen) {
            importOpen = false;
            pwdManageMode = 'change';
          }
          clearPasswordInputs();
          render();
          if (pwdDrawerOpen) {
            (vaultSecurity.enabled ? pwdCurrentInput : pwdNewInput).focus?.();
          }
        },
      },
      [pwdToggleIcon, pwdToggleLabel]
    );

    const lockNowLabel = h('span');
    const lockNowBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary account-toolbar-btn settings-account-lock-now',
        hidden: true,
        onClick: () => {
          clearConfirmTarget(false);
          pwdDrawerOpen = false;
          importOpen = false;
          clearPasswordInputs();
          void request('lockVault');
        },
      },
      [createSvgIcon('lock', { size: 12 }), lockNowLabel]
    );

    const feedback = h('span', {
      className: 'settings-action-desc account-status-inline',
      role: 'status',
      hidden: true,
    });
    const refreshIntervalSelect = CustomSelect({
      className: 'account-refresh-select',
      icon: 'clock',
      modelValue: refreshMinutes,
      options: getAccountRefreshOptions(),
      onUpdateModelValue: async (nextVal) => {
        const nextMins = normalizeAccountQuotaRefreshMinutes(nextVal);
        refreshMinutes = nextMins;
        refreshIntervalSelect.setValue(nextMins);
        void refreshSavedQuotas();
        try {
          await saveSettingsPatch({ accountQuotaRefreshMinutes: nextMins });
        } catch {
          // Keep selected interval locally if save fails transiently
        }
      },
    });
    patchAttr(refreshIntervalSelect.refs.triggerBtn, 'aria-label', t(key('refreshFreqAria')));
    patchAttr(refreshIntervalSelect.refs.triggerBtn, 'title', t(key('refreshFreqAria')));

    const reload = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn account-reload-btn',
        onClick: () => request('list'),
      },
      [createSvgIcon('refresh', { size: 13 })]
    );

    // --- Locked Vault Unlock Strip ---
    const unlockHintLabel = h('span');
    const forgotToggleBtn = h('button', {
      type: 'button',
      className: 'account-link-btn settings-account-forgot-btn',
      onClick: () => {
        forgotResetOpen = !forgotResetOpen;
        clearConfirmTarget(false);
        render();
      },
    });
    const unlockInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-unlock-input',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const unlockSubmitBtn = h('button', {
      type: 'submit',
      className: 'btn-primary account-toolbar-btn settings-account-unlock-submit',
    });
    const unlockForm = h(
      'form',
      {
        className: 'account-import-row',
        autocomplete: 'off',
        onSubmit: submitUnlock,
      },
      [unlockInput, unlockSubmitBtn]
    );
    const resetHintEl = h('span', { className: 'settings-action-desc' });
    const resetVaultBtn = h('button', {
      type: 'button',
      className: 'btn-secondary account-card-btn account-confirm-danger-btn settings-account-reset-vault',
      onClick: () => {
        armOrRunConfirm('resetVault', 'vault', () => {
          void request('resetVault', { confirmReset: 'RESET' });
        });
      },
    });
    const resetRow = h('div', { className: 'account-reset-row', hidden: true }, [
      resetHintEl,
      resetVaultBtn,
    ]);
    const unlockBox = h('div', { className: 'account-unlock-box settings-account-unlock-box', hidden: true }, [
      h('div', { className: 'account-unlock-head' }, [
        h('span', { className: 'account-unlock-title' }, [
          createSvgIcon('lock', { size: 13 }),
          unlockHintLabel,
        ]),
        forgotToggleBtn,
      ]),
      unlockForm,
      resetRow,
    ]);

    // --- Passphrase Setup / Manage Drawer ---
    const pwdTabChangeBtn = h('button', {
      type: 'button',
      className: 'account-pwd-tab',
      onClick: () => {
        pwdManageMode = 'change';
        clearPasswordInputs();
        render();
      },
    });
    const pwdTabDisableBtn = h('button', {
      type: 'button',
      className: 'account-pwd-tab',
      onClick: () => {
        pwdManageMode = 'disable';
        clearPasswordInputs();
        render();
      },
    });
    const pwdTabsWrap = h('div', { className: 'account-pwd-tabs', hidden: true }, [
      pwdTabChangeBtn,
      pwdTabDisableBtn,
    ]);
    const pwdCurrentInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-current',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
      hidden: true,
    });
    const pwdNewInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-new',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const pwdConfirmInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-confirm',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const pwdSubmitBtn = h('button', {
      type: 'submit',
      className: 'btn-primary account-toolbar-btn settings-account-pwd-submit',
    });
    const pwdHint = h('div', { className: 'settings-action-desc account-import-hint' });
    const pwdForm = h(
      'form',
      {
        className: 'account-import-drawer settings-account-pwd-form',
        autocomplete: 'off',
        hidden: true,
        onSubmit: submitPasswordDrawer,
      },
      [
        pwdTabsWrap,
        h('div', { className: 'account-import-row' }, [
          pwdCurrentInput,
          pwdNewInput,
          pwdConfirmInput,
          pwdSubmitBtn,
        ]),
        pwdHint,
      ]
    );

    // --- Credential Import Drawer ---
    const credential = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input',
      required: true,
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 16384,
    });
    const save = h('button', {
      type: 'submit',
      className: 'btn-primary account-toolbar-btn',
    });
    const importHint = h('div', { className: 'settings-action-desc account-import-hint' });
    const form = h(
      'form',
      {
        className: 'settings-account-form account-import-drawer',
        autocomplete: 'off',
        hidden: true,
        onSubmit: importCredential,
      },
      [
        h('div', { className: 'account-import-row' }, [credential, save]),
        importHint,
      ]
    );

    const loginMessage = h('div', {
      className: 'settings-action-desc account-flow-msg',
      role: 'status',
      hidden: true,
    });
    const loginLink = h('a', {
      className: 'account-flow-link',
      target: '_blank',
      rel: 'noopener noreferrer',
      hidden: true,
    });
    const loginStrip = h('div', { className: 'account-flow-strip', hidden: true }, [
      loginMessage,
      loginLink,
    ]);
    const pending = h('div', {
      className: 'settings-action-desc account-flow-strip is-warn',
      role: 'status',
      hidden: true,
    });

    const toolbarPanel = h('section', { className: 'panel account-toolbar-panel' }, [
      h('div', { className: 'account-toolbar-row' }, [
        h('div', { className: 'account-toolbar-left' }, [
          loginButton,
          cancelLogin,
          importToggleBtn,
          pwdToggleBtn,
          lockNowBtn,
        ]),
        h('div', { className: 'account-toolbar-right' }, [
          feedback,
          refreshIntervalSelect.el,
          reload,
        ]),
      ]),
      unlockBox,
      pwdForm,
      form,
      loginStrip,
      pending,
    ]);

    const cardsHost = h('div', { className: 'account-cards-stack' });
    const emptyPanel = h('section', { className: 'panel account-empty-panel', hidden: true }, [
      h('div', { className: 'settings-action-desc account-empty-text' }),
    ]);
    const emptyTextEl = emptyPanel.firstChild;

    function resolveActiveEmail() {
      return account?.status === 'signedIn' ? (account.email || '').trim().toLowerCase() : '';
    }

    function buildUnifiedAccountEntries(activeEmail) {
      const entries = [];
      if (activeEmail) {
        entries.push({
          email: activeEmail,
          isActive: true,
          isSaved: accounts.includes(activeEmail),
        });
      }
      for (let i = 0; i < accounts.length; i++) {
        const addr = accounts[i];
        if (addr && addr !== activeEmail) {
          entries.push({
            email: addr,
            isActive: false,
            isSaved: true,
          });
        }
      }
      return entries;
    }

    function render() {
      const signedIn = account?.status === 'signedIn';
      const activeEmail = resolveActiveEmail();
      if (activeEmail && selectedEmail === activeEmail && switchState?.state !== 'starting') {
        selectedEmail = '';
      }
      const vaultLocked = isVaultLocked();
      const canOperateVault =
        supported === true &&
        !operation &&
        status !== 'restarting' &&
        switchState?.state !== 'starting';
      const canWrite = canOperateVault && !vaultLocked;
      const locale = getEffectiveLocale();
      const activeTierBadge =
        signedIn && (account?.tierName || account?.planName)
          ? formatAccountTierBadge(account)
          : '';

      const loginActive = ['waiting', 'exchanging', 'saving'].includes(loginSession?.status);
      patchText(loginBtnLabel, t(key('googleLogin')));
      patchAttr(loginButton, 'disabled', !canWrite || loginActive);
      patchText(cancelLogin, t(key('cancelLogin')));
      patchAttr(cancelLogin, 'hidden', !loginActive);
      patchAttr(cancelLogin, 'disabled', Boolean(operation) || loginSession?.status === 'saving');

      patchText(importToggleLabel, t(key('importExisting')));
      patchClasses(importToggleBtn, { 'is-open': importOpen });
      patchAttr(importToggleBtn, 'hidden', supported === false);
      patchAttr(importToggleBtn, 'disabled', !canWrite);

      patchSvgIcon(pwdToggleIcon, vaultSecurity.enabled ? 'unlock' : 'lock');
      patchText(pwdToggleLabel, t(key(vaultSecurity.enabled ? 'pwdBtnManage' : 'pwdBtnSet')));
      patchClasses(pwdToggleBtn, { 'is-open': pwdDrawerOpen });
      patchAttr(pwdToggleBtn, 'hidden', supported === false || vaultLocked);
      patchAttr(pwdToggleBtn, 'disabled', !canOperateVault);

      patchText(lockNowLabel, t(key('lockNow')));
      patchAttr(lockNowBtn, 'title', t(key('lockNowTip')));
      patchAttr(lockNowBtn, 'hidden', !vaultSecurity.enabled || vaultLocked || supported === false);
      patchAttr(lockNowBtn, 'disabled', !canOperateVault);

      // Unlock strip (only when passphrase enabled & locked)
      patchAttr(unlockBox, 'hidden', supported !== true || !vaultLocked);
      patchText(unlockHintLabel, t(key('vaultLockedHint')));
      patchText(forgotToggleBtn, t(key('forgotPwdToggle')));
      patchAttr(unlockInput, 'placeholder', t(key('unlockPlaceholder')));
      patchAttr(unlockInput, 'disabled', !canOperateVault);
      patchText(unlockSubmitBtn, t(key('unlockBtn')));
      patchAttr(unlockSubmitBtn, 'disabled', !canOperateVault);
      patchAttr(resetRow, 'hidden', !forgotResetOpen || !vaultLocked);
      patchText(resetHintEl, t(key('resetVaultHint')));
      const armedVaultReset =
        confirmTarget?.type === 'resetVault' && confirmTarget.key === 'vault';
      patchText(resetVaultBtn, t(key(armedVaultReset ? 'resetVaultConfirm' : 'resetVaultBtn')));
      patchAttr(resetVaultBtn, 'disabled', !canOperateVault);

      // Passphrase setup / manage drawer
      const showPwdDrawer = pwdDrawerOpen && !vaultLocked && supported === true;
      patchAttr(pwdForm, 'hidden', !showPwdDrawer);
      if (showPwdDrawer) {
        const isSetNew = !vaultSecurity.enabled;
        const isDisableMode = !isSetNew && pwdManageMode === 'disable';
        patchAttr(pwdTabsWrap, 'hidden', isSetNew);
        patchText(pwdTabChangeBtn, t(key('pwdTabChange')));
        patchClasses(pwdTabChangeBtn, { 'is-active': pwdManageMode === 'change' });
        patchText(pwdTabDisableBtn, t(key('pwdTabDisable')));
        patchClasses(pwdTabDisableBtn, { 'is-active': isDisableMode });

        patchAttr(pwdCurrentInput, 'hidden', isSetNew);
        patchAttr(pwdCurrentInput, 'placeholder', t(key('pwdCurrentPlaceholder')));
        patchAttr(pwdCurrentInput, 'disabled', !canOperateVault);

        patchAttr(pwdNewInput, 'hidden', isDisableMode);
        patchAttr(pwdNewInput, 'placeholder', t(key('pwdNewPlaceholder')));
        patchAttr(pwdNewInput, 'disabled', !canOperateVault);

        patchAttr(pwdConfirmInput, 'hidden', isDisableMode);
        patchAttr(pwdConfirmInput, 'placeholder', t(key('pwdConfirmPlaceholder')));
        patchAttr(pwdConfirmInput, 'disabled', !canOperateVault);

        patchText(
          pwdSubmitBtn,
          t(key(isSetNew ? 'pwdEnableSubmit' : isDisableMode ? 'pwdDisableSubmit' : 'pwdChangeSubmit'))
        );
        patchClasses(pwdSubmitBtn, {
          'btn-primary': !isDisableMode,
          'btn-secondary': isDisableMode,
          'account-confirm-danger-btn': isDisableMode,
        });
        patchAttr(pwdSubmitBtn, 'disabled', !canOperateVault);
        patchText(pwdHint, t(key(isSetNew ? 'pwdSetHint' : 'pwdManageHint')));
      }

      refreshIntervalSelect.setProps({
        modelValue: refreshMinutes,
        options: getAccountRefreshOptions(),
      });
      patchAttr(refreshIntervalSelect.refs.triggerBtn, 'aria-label', t(key('refreshFreqAria')));
      patchAttr(refreshIntervalSelect.refs.triggerBtn, 'title', t(key('refreshFreqAria')));
      patchAttr(refreshIntervalSelect.el, 'hidden', supported === false);

      patchAttr(reload, 'title', t(key('reload')));
      patchAttr(reload, 'aria-label', t(key('reload')));
      patchAttr(reload, 'disabled', Boolean(operation));
      patchClasses(reload, { 'is-spinning': operation === 'list' });

      patchAttr(form, 'hidden', !importOpen || vaultLocked || supported === false);
      patchAttr(credential, 'placeholder', t(key('credentialPlaceholder')));
      patchAttr(credential, 'disabled', !canWrite);
      patchText(save, t(key('save')));
      patchAttr(save, 'disabled', !canWrite);
      patchText(importHint, t(key('importHint')));

      const loginStatusKeys = {
        waiting: 'loginWaiting',
        exchanging: 'loginFinishing',
        saving: 'loginFinishing',
        success: 'loginSuccess',
        cancelled: 'loginCancelled',
        expired: 'loginExpired',
      };
      const hasLoginSession = Boolean(loginSession?.status);
      const loginIsError =
        loginSession?.status === 'error' ||
        loginSession?.status === 'expired' ||
        loginSession?.error === 'loginDenied';
      const loginMessageKey =
        loginSession?.status === 'error'
          ? errors.has(loginSession.error)
            ? loginSession.error
            : 'loginExchangeFailed'
          : loginSession?.error === 'loginDenied'
            ? 'loginDenied'
            : loginStatusKeys[loginSession?.status] || '';
      patchText(loginMessage, loginMessageKey ? t(key(loginMessageKey)) : '');
      patchAttr(loginMessage, 'hidden', !loginMessageKey);

      const authUrl =
        loginSession?.status === 'waiting' &&
        loginSession.url?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')
          ? loginSession.url
          : '';
      patchText(loginLink, t(key('openLoginPage')));
      patchAttr(loginLink, 'href', authUrl || null);
      patchAttr(loginLink, 'hidden', !authUrl);
      patchClasses(loginStrip, {
        'is-error': loginIsError,
        'is-ok': loginSession?.status === 'success',
        'is-info': loginActive,
      });
      patchAttr(loginStrip, 'hidden', !hasLoginSession || !loginMessageKey);

      const failedSwitch =
        switchState?.state === 'failed' && errors.has(switchState.error) ? switchState.error : '';
      const message =
        status ||
        failedSwitch ||
        (operation === 'switch'
          ? 'switching'
          : operation === 'save' || operation === 'capture'
            ? 'verifying'
            : '');
      const isFeedbackError = Boolean(errors.has(message));
      const isFeedbackOk = okToastKeys.has(message);
      patchText(feedback, message ? t(key(message)) : '');
      patchAttr(feedback, 'title', message ? t(key(message)) : null);
      patchClasses(feedback, {
        'is-error': isFeedbackError,
        'is-ok': isFeedbackOk,
        'is-info': !isFeedbackError && !isFeedbackOk && Boolean(message),
      });
      patchAttr(feedback, 'hidden', !message);

      const waiting =
        Boolean(selectedEmail) &&
        activeEmail !== selectedEmail &&
        switchState?.state === 'written' &&
        status !== 'restarting';
      patchText(pending, waiting ? t(key('pending'), { email: selectedEmail }) : '');
      patchAttr(pending, 'hidden', !waiting);

      const entries = buildUnifiedAccountEntries(activeEmail);
      patchAttr(cardsHost, 'hidden', entries.length === 0);
      patchText(
        emptyTextEl,
        t(
          key(
            supported === null
              ? 'loading'
              : account?.status === 'signedOut'
                ? 'signedOut'
                : 'empty'
          )
        )
      );
      patchAttr(emptyPanel, 'hidden', entries.length > 0);

      patchKeyedList(cardsHost, entries, {
        keyFn: (entry) => entry.email,
        sigFn: (entry) =>
          JSON.stringify([
            locale,
            entry.isActive,
            entry.isSaved,
            selectedEmail,
            switchState?.state || '',
            canWrite,
            confirmTarget?.key === entry.email ? confirmTarget.type : '',
            entry.isActive ? null : savedQuotas.get(entry.email),
            quotaVisibleLoading.has(entry.email),
            entry.isActive ? null : quotaErrors.get(entry.email),
            entry.isActive ? quotas : null,
            entry.isActive ? activeTierBadge : '',
          ]),
        createRow: (entry) => {
          const activeDot = h('span', { className: 'dot-swatch account-active-dot', hidden: true });
          const emailEl = h('span', {
            className: 'settings-account-identity account-card-email',
            text: entry.email,
            title: entry.email,
          });
          const tierPill = h('span', { className: 'account-tag is-tier', hidden: true });
          const statePill = h('span', { className: 'account-tag', hidden: true });

          const captureBtn = h('button', {
            type: 'button',
            className: 'btn-secondary account-card-btn',
            hidden: true,
            onClick: () => {
              clearConfirmTarget(false);
              void request('capture');
            },
          });
          const selectBtn = h('button', {
            type: 'button',
            className: 'btn-secondary account-card-btn',
            hidden: true,
            onClick: () => {
              armOrRunConfirm('switch', entry.email, () => {
                const curActive = resolveActiveEmail();
                void request('switch', {
                  email: entry.email,
                  ...(curActive ? { activeEmail: curActive } : {}),
                });
              });
            },
          });
          const loadQuotaBtn = h(
            'button',
            {
              type: 'button',
              className: 'icon-btn settings-account-load-quota account-icon-btn',
              hidden: true,
              onClick: () => {
                clearConfirmTarget(false);
                void request('quota', { email: entry.email, manual: true });
              },
            },
            [createSvgIcon('refresh', { size: 12 })]
          );
          const removeBtn = h(
            'button',
            {
              type: 'button',
              className: 'icon-btn slot-remove-btn settings-account-remove account-icon-btn',
              hidden: true,
              onClick: () => {
                armOrRunConfirm('remove', entry.email, () => {
                  void request('remove', { email: entry.email });
                });
              },
            },
            [createSvgIcon('close', { size: 12 })]
          );
          const removeConfirmBtn = h('button', {
            type: 'button',
            className:
              'btn-secondary account-card-btn account-confirm-danger-btn settings-account-remove-confirm',
            hidden: true,
            onClick: () => {
              armOrRunConfirm('remove', entry.email, () => {
                void request('remove', { email: entry.email });
              });
            },
          });

          const poolsWrap = h('div', { className: 'account-pools-stack' });
          const noteEl = h('div', { className: 'settings-action-desc account-card-note', hidden: true });

          const cardEl = h('section', { className: 'panel account-card' }, [
            h('div', { className: 'panel-header account-card-head' }, [
              h('div', { className: 'account-card-meta' }, [
                activeDot,
                emailEl,
                tierPill,
                statePill,
              ]),
              h('div', { className: 'account-card-actions' }, [
                captureBtn,
                selectBtn,
                loadQuotaBtn,
                removeBtn,
                removeConfirmBtn,
              ]),
            ]),
            poolsWrap,
            noteEl,
          ]);
          return {
            el: cardEl,
            refs: {
              cardEl,
              activeDot,
              emailEl,
              tierPill,
              statePill,
              captureBtn,
              selectBtn,
              loadQuotaBtn,
              removeBtn,
              removeConfirmBtn,
              poolsWrap,
              noteEl,
            },
          };
        },
        updateRow: (row, entry) => {
          const addr = entry.email;
          const active = entry.isActive;
          const isSaved = entry.isSaved;
          const written = addr === selectedEmail && !active && switchState?.state === 'written';
          const cached = active ? null : savedQuotas.get(addr);
          const tierText = active
            ? activeTierBadge
            : cached?.tierName || cached?.tierId
              ? formatAccountTierBadge({
                  tierId: cached.tierId,
                  tierName: cached.tierName,
                  tierMultiplier: cached.tierMultiplier,
                })
              : '';
          const isSpinning = !active && quotaVisibleLoading.has(addr);
          const canSwitch = !active && isSaved;
          const armedSwitch = confirmTarget?.type === 'switch' && confirmTarget.key === addr;
          const armedRemove = confirmTarget?.type === 'remove' && confirmTarget.key === addr;

          patchClasses(row.cardEl, { 'is-active-account': active });
          patchAttr(row.activeDot, 'hidden', !active);
          patchText(row.emailEl, addr);
          patchAttr(row.emailEl, 'title', addr);

          patchText(row.tierPill, tierText);
          patchAttr(row.tierPill, 'hidden', !tierText);

          patchText(row.statePill, active ? t(key('active')) : written ? t(key('written')) : '');
          patchClasses(row.statePill, { 'is-active': active, 'is-written': written });
          patchAttr(row.statePill, 'hidden', !active && !written);

          patchText(row.captureBtn, t(key('capture')));
          patchAttr(row.captureBtn, 'hidden', !active || isSaved || supported === false);
          patchAttr(row.captureBtn, 'disabled', !canWrite);

          patchText(row.selectBtn, t(key(armedSwitch ? 'switchConfirm' : 'switch')));
          patchAttr(row.selectBtn, 'title', t(key('switchHint')));
          patchClasses(row.selectBtn, {
            'settings-account-switch': canSwitch,
            'is-confirm-warn': armedSwitch,
          });
          patchAttr(row.selectBtn, 'hidden', !canSwitch);
          patchAttr(row.selectBtn, 'disabled', !canWrite);

          patchAttr(row.loadQuotaBtn, 'title', t(key(isSpinning ? 'loadingQuota' : 'loadQuota')));
          patchAttr(row.loadQuotaBtn, 'aria-label', t(key('loadQuota')));
          patchClasses(row.loadQuotaBtn, { 'is-spinning': isSpinning });
          // Active account exclusively uses host telemetry — hide OAuth quota refresh on active card
          patchAttr(row.loadQuotaBtn, 'hidden', active || !isSaved);
          patchAttr(row.loadQuotaBtn, 'disabled', !canWrite || isSpinning);

          patchAttr(row.removeBtn, 'title', t(key('remove')));
          patchAttr(row.removeBtn, 'aria-label', t(key('remove')));
          patchAttr(row.removeBtn, 'hidden', !isSaved || armedRemove);
          patchAttr(row.removeBtn, 'disabled', !canWrite);

          patchText(row.removeConfirmBtn, t(key('removeConfirm')));
          patchAttr(row.removeConfirmBtn, 'hidden', !isSaved || !armedRemove);
          patchAttr(row.removeConfirmBtn, 'disabled', !canWrite);

          const displayedPools = active ? quotas?.pools || [] : cached?.pools || [];
          const poolCount = renderQuotaRows(row.poolsWrap, displayedPools);
          const quotaError = active ? '' : quotaErrors.get(addr);

          let noteText = '';
          if (quotaError) {
            noteText = t(key(quotaError));
          } else if (active && poolCount > 0 && quotas?.meta?.isStale) {
            noteText = t(key('quotaStale'));
          } else if (active && poolCount === 0) {
            noteText = t(key('noQuota'));
          } else if (!active && cached && poolCount === 0) {
            noteText = t(key('emptyCredentialQuota'));
          }
          patchText(row.noteEl, noteText);
          patchClasses(row.noteEl, { 'is-error': Boolean(quotaError) });
          patchAttr(row.noteEl, 'hidden', !noteText);
        },
      });

      props.onLayoutChange?.();
    }

    async function dispatchAccountPost(action, fields) {
      let res = await callSidecarApi('/api/accounts/update', {
        method: 'POST',
        body: {
          action,
          ...fields,
          ...(actionNonce ? { actionNonce } : {}),
        },
        cdpTimeoutMs: 40000,
      });
      if (res?.actionNonce) {
        actionNonce = res.actionNonce;
      }
      if (res?.error === 'invalidActionNonce' && actionNonce) {
        res = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: {
            action,
            ...fields,
            actionNonce,
          },
          cdpTimeoutMs: 40000,
        });
        if (res?.actionNonce) {
          actionNonce = res.actionNonce;
        }
      }
      return res;
    }

    async function request(action, fields = {}) {
      if (action === 'quota') return refreshQuota(fields.email, Boolean(fields.manual));
      if (operation) return;
      operation = action;
      if (action === 'loginStart' || action === 'loginCancel') {
        clearTimeout(loginTimer);
        loginGeneration += 1;
      }
      setTransientStatus('');
      render();
      try {
        const result =
          action === 'list'
            ? await callSidecarApi('/api/accounts')
            : await dispatchAccountPost(action, fields);
        if (disposed) return;
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result?.error) {
          if (result.error === 'unsupported') supported = false;
          if (result.error === 'vaultLocked') {
            vaultSecurity = { enabled: true, unlocked: false };
            syncWarmCache();
          }
          setTransientStatus(errors.has(result.error) ? result.error : 'storeFailed', 3600);
          return;
        }
        if (action === 'loginStart' || action === 'loginCancel') {
          applyLogin(result.login);
          if (result.login?.status === 'success') loginRefreshEmail = result.login.email;
          return;
        }
        supported = result?.supported === true;
        accounts = result?.accounts || [];
        selectedEmail = result?.selectedEmail || '';
        switchState = result?.switchState || null;
        if (result?.security) {
          vaultSecurity = {
            enabled: Boolean(result.security.enabled),
            unlocked: result.security.unlocked !== false,
          };
        } else {
          vaultSecurity = { enabled: false, unlocked: true };
        }
        if (result.login) applyLogin(result.login);
        if (action === 'resetVault') {
          savedQuotas.clear();
          quotaErrors.clear();
        }
        for (const [addr, snapshot] of Object.entries(result?.quotas || {})) {
          savedQuotas.set(addr, snapshot);
        }
        syncWarmCache();
        if (action !== 'switch' && !isVaultLocked()) {
          void refreshSavedQuotas();
        }
        if (action === 'save' || action === 'capture') {
          importOpen = false;
          setTransientStatus('saved', 2600);
        } else if (action === 'remove') {
          savedQuotas.delete(fields.email);
          quotaErrors.delete(fields.email);
          syncWarmCache();
          setTransientStatus('removed', 2600);
        } else if (action === 'switch') {
          setTransientStatus(result.restarting ? 'restarting' : 'switchStartFailed');
        } else if (action === 'setPassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdEnabledToast', 2600);
        } else if (action === 'changePassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdChangedToast', 2600);
        } else if (action === 'disablePassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdDisabledToast', 2600);
        } else if (action === 'unlockVault') {
          forgotResetOpen = false;
          quotaErrors.clear();
          setTransientStatus('vaultUnlockedToast', 2200);
        } else if (action === 'lockVault') {
          pwdDrawerOpen = false;
          importOpen = false;
          setTransientStatus('vaultLockedToast', 2200);
        } else if (action === 'resetVault') {
          forgotResetOpen = false;
          setTransientStatus('vaultResetToast', 2600);
        }
      } catch {
        setTransientStatus('storeFailed', 3200);
      } finally {
        operation = '';
        if (!disposed) {
          render();
          if (loginRefreshEmail) {
            const email = loginRefreshEmail;
            loginRefreshEmail = '';
            void refreshLoginAccount(email);
          }
        }
      }
    }

    async function refreshLoginAccount(email) {
      if (disposed || !email) return;
      if (operation) {
        loginRefreshEmail = email;
        return;
      }
      await request('list');
      if (!disposed && !isVaultLocked() && email !== resolveActiveEmail()) {
        void refreshQuota(email, false);
      }
    }

    function applyLogin(session) {
      loginSession = session;
      clearTimeout(loginTimer);
      if (['waiting', 'exchanging', 'saving'].includes(session?.status)) {
        loginTimer = setTimeout(() => pollLogin(session.id, loginGeneration), 1000);
      }
    }

    async function pollLogin(id, generation) {
      try {
        const result = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: { action: 'loginStatus', id, ...(actionNonce ? { actionNonce } : {}) },
          cdpTimeoutMs: 10000,
        });
        if (disposed || generation !== loginGeneration) return;
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result.error) throw new Error(result.error);
        applyLogin(result.login);
        if (loginSession?.status === 'success') await refreshLoginAccount(loginSession.email);
      } catch {
        if (disposed || generation !== loginGeneration) return;
        loginSession = { id, status: 'error', error: 'loginStartFailed' };
      }
      if (!disposed) render();
    }

    async function refreshSavedQuotas() {
      if (refreshingSavedQuotas || isVaultLocked()) return;
      refreshingSavedQuotas = true;
      try {
        const activeEmail = resolveActiveEmail();
        const ttlMs = refreshMinutes * 60_000;
        const staleTargets = accounts.filter((addr) => {
          // Active account exclusively uses host telemetry — never poll via OAuth
          if (!addr || addr === activeEmail) return false;
          const cached = savedQuotas.get(addr);
          if (needsLegacyUltraTierRefresh(cached)) return true;
          return Date.now() - (cached?.fetchedAt || 0) >= ttlMs;
        });
        const BATCH_SIZE = 3;
        for (let i = 0; i < staleTargets.length; i += BATCH_SIZE) {
          if (disposed || operation === 'switch' || isVaultLocked()) break;
          const batch = staleTargets.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map((addr) => refreshQuota(addr, false)));
        }
      } finally {
        refreshingSavedQuotas = false;
      }
    }

    async function refreshQuota(addr, manual = false) {
      const activeEmail = resolveActiveEmail();
      if (!addr || addr === activeEmail || isVaultLocked() || quotaInFlight.has(addr) || disposed) {
        return;
      }
      const hasCachedPools = Boolean(savedQuotas.get(addr)?.pools?.length);
      const showSpinner = manual || !hasCachedPools;
      quotaInFlight.add(addr);
      if (showSpinner) quotaVisibleLoading.add(addr);
      quotaErrors.delete(addr);
      if (showSpinner || quotaErrors.size > 0) render();
      try {
        const result = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: { action: 'quota', email: addr, ...(actionNonce ? { actionNonce } : {}) },
          cdpTimeoutMs: 40000,
        });
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result?.error === 'vaultLocked') {
          vaultSecurity = { enabled: true, unlocked: false };
          syncWarmCache();
          return;
        }
        if (result?.error) {
          if (manual || !hasCachedPools) {
            quotaErrors.set(addr, errors.has(result.error) ? result.error : 'quotaUnavailable');
          }
        } else {
          const prev = savedQuotas.get(addr) || {};
          const nextTierId = result.tierId || prev.tierId || '';
          const nextTierName = result.tierName || prev.tierName || '';
          const nextTierMult = result.tierMultiplier || prev.tierMultiplier || '';
          savedQuotas.set(addr, {
            pools: result.pools,
            fetchedAt: result.fetchedAt || Date.now(),
            ...(nextTierId ? { tierId: nextTierId } : {}),
            ...(nextTierName ? { tierName: nextTierName } : {}),
            ...(nextTierMult ? { tierMultiplier: nextTierMult } : {}),
          });
          syncWarmCache();
        }
      } catch {
        if (manual || !hasCachedPools) {
          quotaErrors.set(addr, 'quotaUnavailable');
        }
      } finally {
        quotaInFlight.delete(addr);
        quotaVisibleLoading.delete(addr);
        if (!disposed) render();
      }
    }

    function submitUnlock(event) {
      event.preventDefault();
      if (operation) return;
      const pwd = unlockInput.value;
      unlockInput.value = '';
      if (!isValidVaultPassphrase(pwd)) {
        setTransientStatus('wrongPassword', 3000);
        render();
        return;
      }
      void request('unlockVault', { password: pwd });
    }

    function submitPasswordDrawer(event) {
      event.preventDefault();
      if (operation) return;
      const curPwd = pwdCurrentInput.value;
      const nextPwd = pwdNewInput.value;
      const confirmPwd = pwdConfirmInput.value;
      clearPasswordInputs();

      if (!vaultSecurity.enabled) {
        if (!isValidVaultPassphrase(nextPwd)) {
          setTransientStatus('invalidPassword', 3200);
          render();
          return;
        }
        if (nextPwd !== confirmPwd) {
          setTransientStatus('passwordMismatch', 3200);
          render();
          return;
        }
        void request('setPassword', { newPassword: nextPwd });
        return;
      }

      if (!isValidVaultPassphrase(curPwd)) {
        setTransientStatus('wrongPassword', 3000);
        render();
        return;
      }
      if (pwdManageMode === 'disable') {
        void request('disablePassword', { currentPassword: curPwd });
        return;
      }
      if (!isValidVaultPassphrase(nextPwd)) {
        setTransientStatus('invalidPassword', 3200);
        render();
        return;
      }
      if (nextPwd !== confirmPwd) {
        setTransientStatus('passwordMismatch', 3200);
        render();
        return;
      }
      void request('changePassword', { currentPassword: curPwd, newPassword: nextPwd });
    }

    function importCredential(event) {
      event.preventDefault();
      if (operation) return;
      const input = credential.value;
      credential.value = '';
      void request('save', { credential: input });
    }

    function renderAccount(value, quotaData, settingsData) {
      const nextRefreshMins =
        settingsData?.accountQuotaRefreshMinutes !== undefined
          ? normalizeAccountQuotaRefreshMinutes(settingsData.accountQuotaRefreshMinutes)
          : refreshMinutes;
      if (account === value && quotas === quotaData && refreshMinutes === nextRefreshMins) return;
      account = value;
      quotas = quotaData;
      refreshMinutes = nextRefreshMins;
      render();
    }

    const quotaScheduleTimer = setInterval(() => {
      if (!disposed && accounts.length > 0 && !operation && !isVaultLocked()) {
        void refreshSavedQuotas();
      }
    }, 60_000);
    quotaScheduleTimer.unref?.();

    const root = h('div', { className: 'settings-tab-stack settings-account-root' }, [
      toolbarPanel,
      cardsHost,
      emptyPanel,
    ]);
    render();
    onCleanup(() => {
      disposed = true;
      clearTimeout(loginTimer);
      clearInterval(quotaScheduleTimer);
      if (statusClearTimer) clearTimeout(statusClearTimer);
      if (confirmClearTimer) clearTimeout(confirmClearTimer);
      refreshIntervalSelect.destroy();
      loginGeneration += 1;
      credential.value = '';
      clearPasswordInputs();
    });
    return {
      el: root,
      refs: {
        renderAccount,
        refreshLabels: render,
        preload: () => (supported === null ? request('list') : Promise.resolve()),
        load: () => (supported === null ? request('list') : refreshSavedQuotas()),
      },
    };
  },
});
