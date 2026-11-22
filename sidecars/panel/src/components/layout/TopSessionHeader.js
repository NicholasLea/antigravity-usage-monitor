/**
 * @fileoverview Row 1 of the compact top bar:
 * Bespoke CustomSelect for session switching, SVG live status indicator,
 * and async force-refresh button.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { i18nStore, t } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import {
  fetchTelemetry,
  formatAgentBadgeText,
  formatConversationMeta,
  getDefaultCtxInspectorAgentId,
  normalizeClientUpdateMode,
  resolveHostRouteMatch,
  selectConversation,
  telemetryStore,
  triggerPluginUpdate,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';
import { CustomSelect } from '../ui/CustomSelect.js';

function formatConvOptionMeta(c) {
  const base = formatConversationMeta(c);
  const wsName = String(c?.workspaceName || '').trim();
  if (!wsName) return base;
  return base ? `${wsName} · ${base}` : wsName;
}

function formatConvOptionTitle(c) {
  const parts = [];
  const label = String(c?.title || c?.cascadeId?.slice?.(0, 8) || '').trim();
  if (c?.swarmTitle && c.swarmTitle !== c.title) {
    parts.push(`${label} · ${c.swarmTitle}`);
  }
  const wsPath = String(c?.workspacePath || c?.workspaceName || '').trim();
  if (wsPath) {
    parts.push(wsPath);
  }
  return parts.length > 0 ? parts.join(' · ') : '';
}

export const TopSessionHeader = defineComponent({
  name: 'TopSessionHeader',
  setup({ onCleanup }) {
    const convSelect = CustomSelect({
      modelValue: telemetryStore.getState().selectedConversationId,
      placeholder: t('header.followLatest'),
      searchable: true,
      searchThreshold: 6,
      searchPlaceholder: t('header.searchSessionPlaceholder'),
      options: [{ value: '', label: t('header.followLatest') }],
      onUpdateModelValue: (nextConvId) => {
        uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
        void selectConversation(nextConvId);
      },
    });

    const updateBtnIcon = createSvgIcon('arrow-down', { size: 11 });
    const updateBtnText = h('span', { text: t('header.hasUpdate') });
    let isHeaderUpdating = false;
    const updateBtn = h(
      'button',
      {
        type: 'button',
        className: 'update-badge-btn',
        hidden: true,
        'aria-label': t('header.ariaUpdate'),
        onClick: async () => {
          if (isHeaderUpdating) return;
          isHeaderUpdating = true;
          patchText(updateBtnText, t('header.upgrading'));
          patchAttr(updateBtn, 'disabled', true);
          try {
            const res = await triggerPluginUpdate();
            if (!res?.ok) {
              uiStore.setState({ activeView: 'settings' });
            }
          } catch {
            uiStore.setState({ activeView: 'settings' });
          } finally {
            isHeaderUpdating = false;
            patchAttr(updateBtn, 'disabled', false);
            const cs = telemetryStore.getState().telemetry?.cloudStatus;
            patchText(
              updateBtnText,
              cs?.latestPluginVersion
                ? t('header.upgradeToVer', { ver: cs.latestPluginVersion })
                : t('header.hasUpdate')
            );
          }
        },
      },
      [updateBtnIcon, updateBtnText]
    );

    const sshBadge = h('span', {
      className: 'endpoint-ssh-badge',
      hidden: true,
      text: 'SSH',
    });

    const statusIcon = createSvgIcon('pulse', { size: 12 });
    const statusText = h('span', { text: t('header.statusLive') });
    const statusTag = h('span', { className: 'status-tag' }, [statusIcon, statusText]);

    const refreshBtn = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn',
        'aria-label': t('header.ariaRefresh'),
        onClick: () => fetchTelemetry({ force: true }),
      },
      [createSvgIcon('refresh', { size: 13 })]
    );

    const headerRowEl = h('div', { className: 'session-header' }, [
      h('div', { className: 'session-left' }, [convSelect.el]),
      h('div', { className: 'session-right' }, [sshBadge, updateBtn, statusTag, refreshBtn]),
    ]);

    const headerEl = h('header', { className: 'top-session-stack' }, [headerRowEl]);

    let lastActiveCascadeId = '';
    let lastAppliedHostChildRouteId = '';
    let preChildCtxInspectorAgentId = '';

    function syncSessionScopeOnCascadeChange(telemetry, telSlice = telemetryStore.getState()) {
      const currentCascadeId = telemetry?.activeConversation?.cascadeId || '';
      if (!currentCascadeId) return;

      const selectedId = String(telSlice?.selectedConversationId || '').trim();
      const hostRouteId = String(telSlice?.hostRouteConversationId || '').trim();
      const hostRouteLower = hostRouteId.toLowerCase();
      const defaultCtxId = getDefaultCtxInspectorAgentId(telemetry?.settings);

      if (!selectedId && hostRouteLower) {
        const routeMatch = resolveHostRouteMatch(telemetry, hostRouteId);
        if (routeMatch?.isChildRoute && routeMatch.childAgent?.agentId) {
          lastActiveCascadeId = currentCascadeId;
          if (lastAppliedHostChildRouteId !== hostRouteLower) {
            const uiSt = uiStore.getState();
            if (!lastAppliedHostChildRouteId) {
              preChildCtxInspectorAgentId =
                uiSt.ctxInspectorAgentId === 'main' || uiSt.ctxInspectorAgentId === 'auto'
                  ? uiSt.ctxInspectorAgentId
                  : defaultCtxId;
            }
            lastAppliedHostChildRouteId = hostRouteLower;
            const targetAgentId = routeMatch.childAgent.agentId;
            if (
              uiSt.selectedAgentScope !== targetAgentId ||
              uiSt.ctxInspectorAgentId !== targetAgentId
            ) {
              uiStore.setState({
                selectedAgentScope: targetAgentId,
                ctxInspectorAgentId: targetAgentId,
              });
            }
          }
          return;
        }
        if (lastAppliedHostChildRouteId && !routeMatch?.isChildRoute) {
          const restoreCtxId =
            preChildCtxInspectorAgentId === 'main' || preChildCtxInspectorAgentId === 'auto'
              ? preChildCtxInspectorAgentId
              : defaultCtxId;
          lastAppliedHostChildRouteId = '';
          preChildCtxInspectorAgentId = '';
          const uiSt = uiStore.getState();
          if (uiSt.selectedAgentScope !== 'all' || uiSt.ctxInspectorAgentId !== restoreCtxId) {
            uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: restoreCtxId });
          }
          lastActiveCascadeId = currentCascadeId;
          return;
        }
      } else if (lastAppliedHostChildRouteId) {
        lastAppliedHostChildRouteId = '';
        preChildCtxInspectorAgentId = '';
      }

      if (lastActiveCascadeId && currentCascadeId !== lastActiveCascadeId) {
        lastActiveCascadeId = currentCascadeId;
        preChildCtxInspectorAgentId = '';
        const uiSt = uiStore.getState();
        if (uiSt.selectedAgentScope !== 'all' || uiSt.ctxInspectorAgentId !== defaultCtxId) {
          uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: defaultCtxId });
        }
      } else {
        lastActiveCascadeId = currentCascadeId;
      }
    }

    function renderHeaderState() {
      const telSt = telemetryStore.getState();
      const uiSt = uiStore.getState();
      const telemetry = telSt.telemetry;
      if (!uiSt.monitorVisible) return;

      patchAttr(updateBtn, 'aria-label', t('header.ariaUpdate'));
      patchAttr(refreshBtn, 'aria-label', t('header.ariaRefresh'));

      const ep = telemetry?.endpoint;
      const isRemoteEndpoint = Boolean(ep?.isRemote);
      patchAttr(sshBadge, 'hidden', !isRemoteEndpoint);
      if (isRemoteEndpoint) {
        const epLabel = String(ep?.label || 'SSH').trim();
        patchAttr(sshBadge, 'title', epLabel && epLabel !== 'SSH' ? `SSH · ${epLabel}` : 'SSH');
      }

      const actConv = telemetry?.activeConversation;
      const convs = telemetry?.conversations || [];
      const hostRouteId = telSt.hostRouteConversationId || '';
      const routeMatch = hostRouteId ? resolveHostRouteMatch(telemetry, hostRouteId) : null;
      const hostMatchedConv = routeMatch?.rootConv || null;
      const childRouteBadge =
        routeMatch?.isChildRoute && routeMatch.childAgent
          ? formatAgentBadgeText(routeMatch.childAgent)
          : '';
      const hostBaseTitle = hostMatchedConv?.title || hostRouteId.slice(0, 8);
      const hostDisplayTitle = childRouteBadge
        ? `${hostBaseTitle} · ${childRouteBadge}`
        : hostBaseTitle;
      const defaultOptLabel = hostRouteId
        ? t('header.currentWindowNamed', {
            title: hostDisplayTitle,
          })
        : convs[0]?.title
          ? t('header.latestNamed', { title: convs[0].title })
          : t('header.followLatest');
      const defaultOptMeta = hostRouteId
        ? hostMatchedConv
          ? formatConvOptionMeta(hostMatchedConv)
          : ''
        : convs[0]
          ? formatConvOptionMeta(convs[0])
          : '';
      const options = [
        {
          value: '',
          label: defaultOptLabel,
          meta: defaultOptMeta,
          ...(hostMatchedConv?.swarmTitle ? { title: hostMatchedConv.swarmTitle } : {}),
        },
        ...convs.map((c) => {
          const optTitle = formatConvOptionTitle(c);
          return {
            value: c.cascadeId,
            label: c.title || c.cascadeId.slice(0, 8),
            meta: formatConvOptionMeta(c),
            ...(optTitle ? { title: optTitle } : {}),
          };
        }),
      ];
      const lockedId = telSt.selectedConversationId;
      if (lockedId && !convs.some((c) => c.cascadeId === lockedId)) {
        const isLoadedLocked = actConv?.cascadeId === lockedId;
        const lockedTitle =
          isLoadedLocked && actConv?.title
            ? actConv.title
            : t('header.lockedSession', { id: String(lockedId).slice(0, 8) });
        const lockedMeta = isLoadedLocked ? formatConvOptionMeta(actConv) : t('header.lockedMeta');
        options.splice(1, 0, {
          value: lockedId,
          label: lockedTitle,
          meta: lockedMeta,
        });
      }
      convSelect.setProps({
        modelValue: telSt.selectedConversationId,
        placeholder: t('header.followLatest'),
        searchPlaceholder: t('header.searchSessionPlaceholder'),
        options,
      });

      const hasSubagents = Boolean(actConv?.hasSubagents || (actConv?.subagentCount || 0) > 0);
      const aggregated = actConv?.aggregated;

      const cloudStatus = telemetry?.cloudStatus;
      const updateMode = normalizeClientUpdateMode(
        telemetry?.settings?.pluginUpdateMode,
        telemetry?.settings?.autoUpdatePlugin
      );
      const showUpdate = Boolean(cloudStatus?.updateAvailable) && updateMode !== 'off';
      patchAttr(updateBtn, 'hidden', !showUpdate);
      if (showUpdate && !isHeaderUpdating) {
        patchText(
          updateBtnText,
          cloudStatus?.latestPluginVersion
            ? t('header.upgradeToVer', { ver: cloudStatus.latestPluginVersion })
            : t('header.hasUpdate')
        );
      }

      const isSyncing = telSt.syncState === 'syncing';
      const isSynced = telSt.syncState === 'synced';
      const isError = telSt.syncState === 'error';
      const isRunning = Boolean(aggregated?.isRunning || telemetry?.activeConversation?.isRunning);
      const quotaMeta = telemetry?.quotas?.meta;
      const quotaStale = Boolean(quotaMeta?.refreshFailed || quotaMeta?.isStale);

      patchClasses(refreshBtn, { 'is-spinning': isSyncing });
      patchAttr(refreshBtn, 'disabled', isSyncing);

      if (isSyncing) {
        patchSvgIcon(statusIcon, 'refresh');
        patchText(statusText, t('header.statusSyncing'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': true,
          'state-warn': false,
        });
      } else if (isSynced) {
        patchSvgIcon(statusIcon, 'check');
        patchText(statusText, t('header.statusSynced'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': true,
          'state-warn': false,
        });
      } else if (isError) {
        patchSvgIcon(statusIcon, 'warning');
        patchText(statusText, t('header.statusRetrying'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': true,
        });
      } else if (isRunning) {
        const runningAgent = (telemetry?.activeConversation?.agents || []).find((a) => a.isRunning);
        const runSuffix =
          hasSubagents && runningAgent ? ` · ${formatAgentBadgeText(runningAgent)}` : '';
        patchSvgIcon(statusIcon, 'bolt');
        patchText(statusText, t('header.statusGenerating', { suffix: runSuffix }));
        patchClasses(statusTag, {
          'state-running': true,
          'state-synced': false,
          'state-warn': false,
        });
      } else if (quotaStale) {
        patchSvgIcon(statusIcon, 'warning');
        patchText(
          statusText,
          quotaMeta?.hasOfficialData ? t('header.statusQuotaCached') : t('header.statusQuotaOffline')
        );
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': true,
        });
      } else {
        patchSvgIcon(statusIcon, 'pulse');
        patchText(statusText, t('header.statusLive'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': false,
        });
      }
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        selectedConversationId: st.selectedConversationId,
        hostRouteConversationId: st.hostRouteConversationId,
        syncState: st.syncState,
        telemetry: st.telemetry,
      }),
      (slice) => {
        syncSessionScopeOnCascadeChange(slice.telemetry, slice);
        renderHeaderState();
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => renderHeaderState()
    );
    const unsubVisibility = uiStore.subscribe(
      (st) => st.monitorVisible,
      (visible) => {
        if (visible) renderHeaderState();
      },
      { immediate: false }
    );

    onCleanup(() => {
      unsubTelemetry();
      unsubI18n();
      unsubVisibility();
      convSelect.destroy();
    });

    return {
      el: headerEl,
      refs: { convSelect, statusTag, refreshBtn },
    };
  },
});
