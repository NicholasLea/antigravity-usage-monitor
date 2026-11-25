/**
 * @fileoverview Control Center Tab 3: `SettingsSessionsTab.js` ("会话").
 * Hosts cross-client session migration (`SessionMigrationCard`) and displays a
 * clean status fallback when the host only has a single Antigravity client installed.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { SessionMigrationCard } from '../../components/settings/SessionMigrationCard.js';

export const SettingsSessionsTab = defineComponent({
  name: 'SettingsSessionsTab',
  setup({ getProps, onCleanup }) {
    let migrationStatus = 'loading';

    const emptyTitleEl = h('span', { text: t('settings.oth.migTitle') });
    const emptyDescEl = h('p', {
      className: 'settings-hint-text',
      text: t('settings.sessions.loading'),
    });
    const rescanBtnTextEl = h('span', { text: t('settings.sessions.rescanBtn') });
    const rescanBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm',
        hidden: true,
        onClick: () => {
          void sessionMigrationCard.refs.reload();
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rescanBtnTextEl]
    );

    const emptyPanel = h('section', { className: 'panel sessions-empty-panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          emptyTitleEl,
        ]),
        rescanBtn,
      ]),
      emptyDescEl,
    ]);

    function syncEmptyFallback() {
      const showFallback = migrationStatus !== 'available';
      patchAttr(emptyPanel, 'hidden', !showFallback);
      if (!showFallback) return;
      const isLoading = migrationStatus === 'loading';
      patchText(
        emptyDescEl,
        isLoading ? t('settings.sessions.loading') : t('settings.sessions.unavailableDesc')
      );
      patchAttr(rescanBtn, 'hidden', isLoading);
    }

    const sessionMigrationCard = SessionMigrationCard({
      onLayoutChange: () => {
        getProps()?.onLayoutChange?.();
      },
      onStateChange: (next) => {
        const status = String(next?.status || '').trim();
        if (!status) return;
        migrationStatus = status;
        syncEmptyFallback();
        getProps()?.onLayoutChange?.();
      },
    });

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      sessionMigrationCard.el,
      emptyPanel,
    ]);

    syncEmptyFallback();

    function refreshLabels() {
      patchText(emptyTitleEl, t('settings.oth.migTitle'));
      patchText(rescanBtnTextEl, t('settings.sessions.rescanBtn'));
      syncEmptyFallback();
      sessionMigrationCard.refs.refreshLabels();
    }

    onCleanup(() => {
      sessionMigrationCard.destroy();
    });

    return {
      el: rootEl,
      refs: {
        sessionMigrationCard,
        emptyPanel,
        rescanBtn,
        ensureLoaded: () => sessionMigrationCard.refs.ensureLoaded(),
        reload: () => sessionMigrationCard.refs.reload(),
        refreshLabels,
      },
    };
  },
});
