/**
 * @fileoverview Control Center Tab 3: `SettingsSessionsTab.js` ("会话").
 * Unifies the native telemetry-enriched Local Session Hub (`SessionManagerCard`)
 * and cross-client session migration (`SessionMigrationCard`) under a pinned top
 * 3rd-level navigation bar (matching `SettingsStructureTab`) and shares a single
 * local session scan between both modes with zero redundant rescans on tab switch.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { SessionManagerCard } from '../../components/settings/SessionManagerCard.js';
import { SessionMigrationCard } from '../../components/settings/SessionMigrationCard.js';

const SESSIONS_THIRD_TABS = Object.freeze([
  { key: 'manage', icon: 'layers', labelKey: 'settings.sessions.modeManage' },
  { key: 'migrate', icon: 'copy', labelKey: 'settings.sessions.modeMigrate' },
]);

export const SettingsSessionsTab = defineComponent({
  name: 'SettingsSessionsTab',
  setup({ getProps, onCleanup }) {
    let activeMode = 'manage'; // 'manage' | 'migrate'
    let migrationStatus = 'loading';

    // --- 顶部三级子导航栏（与「结构」页保持一致，固定于 SettingsView 顶部不随内容滚动） ---
    const thirdNavBtnMap = new Map();
    const thirdNavBtns = SESSIONS_THIRD_TABS.map((item) => {
      const labelEl = h('span', {
        className: 'structure-thirdnav-label',
        text: t(item.labelKey),
      });
      const btn = h(
        'button',
        {
          type: 'button',
          className: `structure-thirdnav-btn${item.key === activeMode ? ' is-active' : ''}`,
          role: 'tab',
          'aria-selected': item.key === activeMode ? 'true' : 'false',
          'data-sessions-tab': item.key,
          onClick: () => setActiveMode(item.key),
          onKeydown: (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const curIdx = Math.max(
                0,
                SESSIONS_THIRD_TABS.findIndex((it) => it.key === item.key)
              );
              const delta = e.key === 'ArrowRight' ? 1 : -1;
              const nextIdx =
                (curIdx + delta + SESSIONS_THIRD_TABS.length) % SESSIONS_THIRD_TABS.length;
              const nextKey = SESSIONS_THIRD_TABS[nextIdx].key;
              setActiveMode(nextKey);
              thirdNavBtnMap.get(nextKey)?.btn?.focus?.();
            }
          },
        },
        [createSvgIcon(item.icon, { size: 12 }), labelEl]
      );
      thirdNavBtnMap.set(item.key, { btn, labelEl, labelKey: item.labelKey });
      return btn;
    });

    const thirdNavGlider = h('span', { className: 'thirdnav-glider', 'aria-hidden': 'true' });
    const thirdNavBar = h(
      'div',
      {
        className: 'settings-thirdnav-bar sessions-thirdnav-bar',
        role: 'tablist',
        'aria-label': t('settings.sessions.modeAria'),
      },
      [thirdNavGlider, ...thirdNavBtns]
    );
    patchStyleVar(thirdNavBar, '--thirdnav-count', SESSIONS_THIRD_TABS.length);
    patchStyleVar(thirdNavBar, '--active-third-index', 0);

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
          void reloadSharedCatalog();
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
      onRequestRefresh: () => reloadSharedCatalog(),
      onStateChange: (next) => {
        const status = String(next?.status || '').trim();
        if (!status) return;
        migrationStatus = status;
        syncEmptyFallback();
        getProps()?.onLayoutChange?.();
      },
    });

    const sessionManagerCard = SessionManagerCard({
      onLayoutChange: () => {
        getProps()?.onLayoutChange?.();
      },
      onCatalogLoaded: (res) => {
        if (res?.migrationCatalog && typeof res.migrationCatalog === 'object') {
          sessionMigrationCard.refs.applyCatalog(res.migrationCatalog);
        } else if (res?.error === 'unsupported_remote') {
          sessionMigrationCard.refs.applyCatalog({
            available: false,
            sqliteSupported: false,
            clients: [],
            sessionsByClient: {},
            desktopProjects: [],
            error: 'unsupported_remote',
          });
        }
      },
    });

    async function ensureSharedLoaded() {
      if (!sessionManagerCard.refs.isLoaded()) {
        await sessionManagerCard.refs.ensureLoaded();
      }
      if (activeMode === 'migrate' && !sessionMigrationCard.refs.hasCatalog()) {
        await sessionMigrationCard.refs.ensureLoaded();
      }
    }

    async function reloadSharedCatalog() {
      await sessionManagerCard.refs.reload();
      if (activeMode === 'migrate' && !sessionMigrationCard.refs.hasCatalog()) {
        await sessionMigrationCard.refs.reload();
      }
    }

    const migrateWrap = h('div', { className: 'sessions-migrate-wrap', hidden: true }, [
      sessionMigrationCard.el,
      emptyPanel,
    ]);

    function syncModeVisibility() {
      const isManage = activeMode === 'manage';
      const activeIdx = Math.max(
        0,
        SESSIONS_THIRD_TABS.findIndex((it) => it.key === activeMode)
      );
      patchStyleVar(thirdNavBar, '--active-third-index', activeIdx);
      for (const [key, entry] of thirdNavBtnMap.entries()) {
        const isActive = key === activeMode;
        patchClasses(entry.btn, { 'is-active': isActive });
        patchAttr(entry.btn, 'aria-selected', isActive ? 'true' : 'false');
      }
      patchAttr(sessionManagerCard.el, 'hidden', !isManage);
      patchAttr(migrateWrap, 'hidden', isManage);
      if (!isManage) {
        syncEmptyFallback();
      }
    }

    function setActiveMode(nextMode) {
      if ((nextMode !== 'manage' && nextMode !== 'migrate') || nextMode === activeMode) return;
      activeMode = nextMode;
      syncModeVisibility();
      // 复用同一份扫描数据，切换模式时不再重复触发全量扫描；仅在尚未加载过时懒加载一次
      void ensureSharedLoaded();
      getProps()?.onLayoutChange?.();
    }

    const rootEl = h('div', { className: 'settings-tab-stack sessions-hub-stack' }, [
      sessionManagerCard.el,
      migrateWrap,
    ]);

    syncEmptyFallback();
    syncModeVisibility();

    function refreshLabels() {
      patchAttr(thirdNavBar, 'aria-label', t('settings.sessions.modeAria'));
      for (const entry of thirdNavBtnMap.values()) {
        patchText(entry.labelEl, t(entry.labelKey));
      }
      patchText(emptyTitleEl, t('settings.oth.migTitle'));
      patchText(rescanBtnTextEl, t('settings.sessions.rescanBtn'));
      syncEmptyFallback();
      sessionManagerCard.refs.refreshLabels();
      sessionMigrationCard.refs.refreshLabels();
    }

    onCleanup(() => {
      sessionManagerCard.destroy();
      sessionMigrationCard.destroy();
    });

    return {
      el: rootEl,
      refs: {
        thirdNavBar,
        setActiveMode,
        sessionManagerCard,
        sessionMigrationCard,
        emptyPanel,
        rescanBtn,
        ensureLoaded: ensureSharedLoaded,
        reload: reloadSharedCatalog,
        markStale: () => {
          sessionManagerCard.refs.markStale?.();
          sessionMigrationCard.refs.markStale?.();
        },
        refreshLabels,
      },
    };
  },
});
