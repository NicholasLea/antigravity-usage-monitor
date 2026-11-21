/**
 * @fileoverview Preferences Tab 2: `SettingsStructureTab.js` ("结构").
 * Organizes the 4 structure settings panes under a dedicated 3rd-level menu bar,
 * renders live previews powered by the decoupled real UI components (`CapsuleBarWidget`,
 * `createDynamicWidgetHost` in `hover` / `overview` modes, and `StepTableWidget`)
 * with simulated telemetry, and supports smooth mouse drag-and-drop reordering.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import {
  getCapsuleMetricOptions,
  getOverviewMetricOptions,
} from '../../registries/metricRegistry.js';
import { getStepColumnOptions } from '../../registries/stepColumnRegistry.js';
import {
  createDynamicWidgetHost,
  getOverviewModuleOptions,
} from '../../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_HOVER_MODULES,
  DEFAULT_CLIENT_OVERVIEW_METRICS,
  DEFAULT_CLIENT_OVERVIEW_MODULES,
  DEFAULT_CLIENT_POPOVER_WIDTH,
  DEFAULT_CLIENT_STEP_COLUMNS,
  DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_CLIENT_TOPBAR_SLOTS,
  MAX_CLIENT_POPOVER_WIDTH,
  MIN_CLIENT_POPOVER_WIDTH,
  normalizeClientCliStatusLineSlots,
  normalizeClientHoverModules,
  normalizeClientOverviewMetrics,
  normalizeClientOverviewModules,
  normalizeClientPopoverWidth,
  normalizeClientPopoverWidthMode,
  normalizeClientStepColumns,
  normalizeClientStepTokenComboFormat,
  normalizeClientTopbarSlots,
  normalizeClientWindowMountMode,
  resolveEffectiveClientCliStatusLineSlots,
  saveSettingsPatch,
  triggerCliStatusLineAction,
} from '../../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../../store/uiStore.js';
import { BridgeStatusNotice } from '../../components/settings/BridgeStatusNotice.js';
import { CollapsibleSection } from '../../components/settings/CollapsibleSection.js';
import { EditableSlotList } from '../../components/settings/EditableSlotList.js';
import { buildStructurePreviewTelemetry } from '../../components/settings/structurePreviewMock.js';
import { CustomNumberInput } from '../../components/ui/CustomNumberInput.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';
import { CapsuleBarWidget } from '../../components/widgets/CapsuleBarWidget.js';
import { StepTableWidget } from '../../components/widgets/StepTableWidget.js';

const STRUCTURE_THIRD_TABS = Object.freeze([
  { key: 'mount', icon: 'dock', labelKey: 'settings.str.tabMount' },
  { key: 'hover', icon: 'layers', labelKey: 'settings.str.tabHover' },
  { key: 'overview', icon: 'pulse', labelKey: 'settings.str.tabOverview' },
  { key: 'steps', icon: 'table', labelKey: 'settings.str.tabSteps' },
]);

function normalizeStructureTabKey(raw) {
  const k = String(raw || '').trim();
  return k === 'hover' || k === 'overview' || k === 'steps' ? k : 'mount';
}

function getMountModeOptions() {
  return [
    { value: 'dual', label: t('settings.str.mountDual') },
    { value: 'composer', label: t('settings.str.mountComposer') },
    { value: 'sidebar', label: t('settings.str.mountSidebar') },
  ];
}

function getMultiToggleOptions() {
  return [
    { value: 'show', label: t('settings.str.show') },
    { value: 'hide', label: t('settings.str.hide') },
  ];
}

function getEnableToggleOptions() {
  return [
    { value: 'on', label: t('settings.str.on') },
    { value: 'off', label: t('settings.str.off') },
  ];
}

function getPopoverWidthModeOptions() {
  return [
    { value: 'auto', label: t('settings.str.popoverWidthAuto') },
    { value: 'custom', label: t('settings.str.popoverWidthCustom') },
  ];
}

function isSameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildCliPreviewMiniBar(pct, width = 8, emptyChar = '⢕') {
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped < 95 && filled >= width) filled = Math.max(0, width - 1);
  return {
    barFilled: '█'.repeat(filled),
    barEmpty: emptyChar.repeat(Math.max(0, width - filled)),
  };
}

function formatCliPreviewSlot(slotKey, isEn) {
  switch (slotKey) {
    case 'tps':
      return { prefix: '', barFilled: '', barEmpty: '', text: '68.4 t/s', tone: 'good' };
    case 'avg_tps':
      return {
        prefix: '',
        barFilled: '',
        barEmpty: '',
        text: isEn ? 'avg 54.0' : '均 54.0',
        tone: 'info',
      };
    case 'ttft':
      return { prefix: '', barFilled: '', barEmpty: '', text: '1.1s', tone: 'good' };
    case 'cost':
      return { prefix: '', barFilled: '', barEmpty: '', text: '$0.040', tone: 'normal' };
    case 'session_cost':
      return { prefix: '', barFilled: '', barEmpty: '', text: '$0.42', tone: 'normal' };
    case 'cache_hit':
      return {
        prefix: '',
        barFilled: '',
        barEmpty: '',
        text: isEn ? 'cache 92%' : '缓 92%',
        tone: 'good',
      };
    case 'session_tokens':
      return { prefix: '', barFilled: '', barEmpty: '', text: '142K tok', tone: 'muted' };
    case 'quota_auto':
      return {
        prefix: isEn ? '5h ' : '余 ',
        ...buildCliPreviewMiniBar(64, 8, '⣿'),
        text: ' 64%',
        tone: 'good',
      };
    case 'gemini_5h':
      return {
        prefix: 'G5h ',
        ...buildCliPreviewMiniBar(64, 8, '⣿'),
        text: ' 64%',
        tone: 'good',
      };
    case 'gemini_weekly':
      return {
        prefix: isEn ? 'Gw ' : 'G周 ',
        ...buildCliPreviewMiniBar(88, 8, '⣿'),
        text: ' 88%',
        tone: 'good',
      };
    case 'claude_5h':
      return {
        prefix: 'C5h ',
        ...buildCliPreviewMiniBar(96, 8, '⣿'),
        text: ' 96%',
        tone: 'good',
      };
    case 'claude_weekly':
      return {
        prefix: isEn ? 'Cw ' : 'C周 ',
        ...buildCliPreviewMiniBar(99, 8, '⣿'),
        text: ' 99%',
        tone: 'good',
      };
    case 'context':
    default:
      return {
        prefix: isEn ? 'Ctx ' : '上下文 ',
        ...buildCliPreviewMiniBar(56),
        text: ' 56%',
        tone: 'accent',
      };
  }
}

export const SettingsStructureTab = defineComponent({
  name: 'SettingsStructureTab',
  setup({ props, onCleanup }) {
    let activeThirdTab = normalizeStructureTabKey(uiStore.getState().settingsStructureTab);
    let draftWindowMountMode = 'dual';
    let draftPopoverWidthMode = 'auto';
    let draftPopoverWidth = DEFAULT_CLIENT_POPOVER_WIDTH;
    let draftEnableCliStatusLine = true;
    let draftCliStatusLineSlots = null;
    let draftShowTopbarMulti = true;
    let draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
    let draftHoverModules = [...DEFAULT_CLIENT_HOVER_MODULES];
    let draftOverviewModules = [...DEFAULT_CLIENT_OVERVIEW_MODULES];
    let draftOverviewMetrics = [...DEFAULT_CLIENT_OVERVIEW_METRICS];
    let draftShowStepTurnRail = false;
    let draftShowStepAgentBadge = true;
    let draftShowStepSpeedColor = false;
    let draftStepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
    let rawStepTokenComboText = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
    let draftStepColumns = [...DEFAULT_CLIENT_STEP_COLUMNS];
    let latestSettings = null;
    let latestWindowBridge = null;
    let latestCliStatusLine = null;
    let latestHostPlatform = 'win32';

    function getEffectiveDraftCliSlots() {
      return resolveEffectiveClientCliStatusLineSlots({
        cliStatusLineSlots: draftCliStatusLineSlots,
        topbarCapsuleSlots: draftTopbarSlots,
      });
    }

    function isStructureVisible() {
      const st = uiStore.getState();
      return getVisibleMonitorView(st) === 'settings' && st.settingsSubTab === 'structure';
    }

    function buildDraftTelemetry() {
      return buildStructurePreviewTelemetry(latestSettings, {
        windowMountMode: draftWindowMountMode,
        enableWindowOverlay: draftWindowMountMode !== 'sidebar',
        popoverWidthMode: draftPopoverWidthMode,
        popoverWidth: draftPopoverWidth,
        enableCliStatusLine: draftEnableCliStatusLine,
        showTopbarMultiSession: draftShowTopbarMulti,
        topbarCapsuleSlots: draftTopbarSlots,
        hoverModules: draftHoverModules,
        overviewModules: draftOverviewModules,
        overviewMetrics: draftOverviewMetrics,
        showStepTurnRail: draftShowStepTurnRail,
        showStepAgentBadge: draftShowStepAgentBadge,
        showStepSpeedColor: draftShowStepSpeedColor,
        stepTokenComboFormat: draftStepTokenComboFormat,
        stepTableColumns: draftStepColumns,
      });
    }

    async function persistStructurePatch(sectionComp, patchObj, successKey = 'settings.saved') {
      sectionComp.refs.showStatus(t('settings.saving'), 0);
      try {
        await saveSettingsPatch(patchObj);
        sectionComp.refs.showStatus(t(successKey), 1500);
      } catch {
        if (latestSettings) {
          renderSettings(latestSettings);
        }
        sectionComp.refs.showStatus(t('settings.saveFailed'), 2500);
      }
    }

    // --- 3rd-Level Navigation Bar ---
    const thirdNavBtnMap = new Map();
    const thirdNavBtns = STRUCTURE_THIRD_TABS.map((item) => {
      const labelEl = h('span', {
        className: 'structure-thirdnav-label',
        text: t(item.labelKey),
      });
      const btn = h(
        'button',
        {
          type: 'button',
          className: `structure-thirdnav-btn${item.key === activeThirdTab ? ' is-active' : ''}`,
          role: 'tab',
          'aria-selected': item.key === activeThirdTab ? 'true' : 'false',
          'data-structure-tab': item.key,
          onClick: () => {
            applyActiveThirdTab(item.key);
            if (uiStore.getState().settingsStructureTab !== item.key) {
              uiStore.setState({ settingsStructureTab: item.key });
            }
          },
          onKeydown: (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const curIdx = Math.max(
                0,
                STRUCTURE_THIRD_TABS.findIndex((it) => it.key === item.key)
              );
              const delta = e.key === 'ArrowRight' ? 1 : -1;
              const nextIdx =
                (curIdx + delta + STRUCTURE_THIRD_TABS.length) % STRUCTURE_THIRD_TABS.length;
              const nextItem = STRUCTURE_THIRD_TABS[nextIdx];
              if (nextItem) {
                applyActiveThirdTab(nextItem.key);
                if (uiStore.getState().settingsStructureTab !== nextItem.key) {
                  uiStore.setState({ settingsStructureTab: nextItem.key });
                }
                thirdNavBtnMap.get(nextItem.key)?.btn?.focus?.();
              }
            }
          },
        },
        [createSvgIcon(item.icon, { size: 12 }), labelEl]
      );
      thirdNavBtnMap.set(item.key, { btn, labelEl, labelKey: item.labelKey });
      return btn;
    });

    const thirdNavGlider = h('div', { className: 'thirdnav-glider', 'aria-hidden': 'true' });
    const thirdNavBar = h(
      'div',
      {
        className: 'settings-thirdnav-bar',
        role: 'tablist',
        'aria-label': t('settings.str.thirdTabAria'),
      },
      [thirdNavGlider, ...thirdNavBtns]
    );
    patchStyleVar(
      thirdNavBar,
      '--active-third-index',
      Math.max(
        0,
        STRUCTURE_THIRD_TABS.findIndex((it) => it.key === activeThirdTab)
      )
    );

    // --- Pane 1: 挂载与胶囊栏 (`mount`) ---
    const capsulePreviewWidget = CapsuleBarWidget({});
    const mountPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      capsulePreviewWidget.el,
    ]);

    const mountModeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.mountMode'),
    });
    const popoverWidthLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.popoverWidthLabel'),
    });
    const popoverWidthHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.str.popoverWidthHint'),
    });
    const multiToggleLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.multiToggle'),
    });
    const cliCapsuleLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.cliCapsuleToggle'),
    });
    const cliSlotsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.cliSlotsLabel'),
    });
    const cliStatusHintEl = h('span', {
      className: 'settings-hint-text cli-status-hint',
    });
    let cliActionBusy = false;
    let activeCliStatusAction = '';
    const cliStatusActionBtn = h('button', {
      type: 'button',
      className: 'cli-status-action-btn',
      hidden: true,
      text: t('settings.str.cliRestoreBtn'),
      onClick: async () => {
        if (cliActionBusy || !activeCliStatusAction) return;
        cliActionBusy = true;
        const actionToRun = activeCliStatusAction;
        patchAttr(cliStatusActionBtn, 'disabled', true);
        patchText(cliStatusActionBtn, t('settings.str.cliRestoringBtn'));
        mountSection.refs.showStatus(t('settings.saving'), 0);
        try {
          const res = await triggerCliStatusLineAction(actionToRun);
          if (res?.cliStatusLine) {
            latestCliStatusLine = res.cliStatusLine;
          }
          if (res?.settings && typeof res.settings === 'object') {
            latestSettings = { ...(latestSettings || {}), ...res.settings };
            draftEnableCliStatusLine = latestSettings.enableCliStatusLine !== false;
          }
          mountSection.refs.showStatus(
            res?.ok === false ? t('settings.saveFailed') : t('settings.saved'),
            1800
          );
        } catch {
          mountSection.refs.showStatus(t('settings.saveFailed'), 2500);
        } finally {
          cliActionBusy = false;
          patchAttr(cliStatusActionBtn, 'disabled', false);
          syncMountSectionMeta();
          props.onLayoutChange?.();
        }
      },
    });
    const capsuleSlotsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.capsuleSlotsLabel'),
    });

    const windowMountSelect = CustomSelect({
      modelValue: draftWindowMountMode,
      icon: 'dock',
      options: getMountModeOptions(),
      onUpdateModelValue: (val) => {
        const nextMode = normalizeClientWindowMountMode(val);
        draftWindowMountMode = nextMode;
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          windowMountMode: nextMode,
          enableWindowOverlay: nextMode !== 'sidebar',
        });
      },
    });

    const popoverWidthStepper = CustomNumberInput({
      modelValue: draftPopoverWidth,
      min: MIN_CLIENT_POPOVER_WIDTH,
      max: MAX_CLIENT_POPOVER_WIDTH,
      step: 10,
      ariaLabel: t('settings.str.popoverWidthLabel'),
      onUpdateModelValue: (val) => {
        const nextWidth = normalizeClientPopoverWidth(val);
        draftPopoverWidth = nextWidth;
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          popoverWidthMode: draftPopoverWidthMode,
          popoverWidth: draftPopoverWidth,
        });
      },
    });

    const popoverWidthNumWrap = h(
      'span',
      { className: 'settings-number-wrap', hidden: draftPopoverWidthMode !== 'custom' },
      [popoverWidthStepper.el, h('span', { className: 'settings-number-unit', text: 'px' })]
    );

    const popoverWidthModeToggle = SegmentedControl({
      ariaLabel: t('settings.str.popoverWidthLabel'),
      modelValue: draftPopoverWidthMode,
      options: getPopoverWidthModeOptions(),
      onUpdateModelValue: (val) => {
        draftPopoverWidthMode = normalizeClientPopoverWidthMode(val);
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          popoverWidthMode: draftPopoverWidthMode,
          popoverWidth: draftPopoverWidth,
        });
      },
    });

    const multiSessionToggle = SegmentedControl({
      ariaLabel: t('settings.str.multiToggle'),
      modelValue: 'show',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowTopbarMulti = val !== 'hide';
        syncMountSectionMeta();
        void persistStructurePatch(mountSection, {
          showTopbarMultiSession: draftShowTopbarMulti,
        });
      },
    });

    const cliCapsuleToggle = SegmentedControl({
      ariaLabel: t('settings.str.cliCapsuleToggle'),
      modelValue: 'on',
      options: getEnableToggleOptions(),
      onUpdateModelValue: (val) => {
        draftEnableCliStatusLine = val !== 'off';
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          enableCliStatusLine: draftEnableCliStatusLine,
        });
      },
    });

    const cliPreviewMultiTextEl = h('span', {
      text: t('settings.str.cliPreviewRunning', { count: 2 }),
    });
    const cliPreviewMultiEl = h('span', { className: 'cli-preview-multi' }, [
      h('span', { className: 'cli-preview-dot', 'aria-hidden': 'true', text: '●' }),
      cliPreviewMultiTextEl,
    ]);
    const cliPreviewSlotParts = [];
    const cliPreviewSepEls = [];
    const cliPreviewChildren = [cliPreviewMultiEl];
    for (let i = 0; i < 6; i += 1) {
      if (i > 0) {
        const sepEl = h('span', {
          className: 'cli-preview-sep',
          'aria-hidden': 'true',
          text: '|',
        });
        cliPreviewSepEls.push(sepEl);
        cliPreviewChildren.push(sepEl);
      }
      const prefixEl = h('span', { className: 'cli-preview-prefix' });
      const barFillEl = h('span', { className: 'cli-preview-bar-fill' });
      const barEmptyEl = h('span', { className: 'cli-preview-bar-empty' });
      const valueEl = h('span', { className: 'cli-preview-val' });
      const slotEl = h('span', { className: 'cli-preview-slot' }, [
        prefixEl,
        barFillEl,
        barEmptyEl,
        valueEl,
      ]);
      cliPreviewSlotParts.push({ slotEl, prefixEl, barFillEl, barEmptyEl, valueEl });
      cliPreviewChildren.push(slotEl);
    }
    const cliPreviewEl = h('div', { className: 'cli-status-preview' }, cliPreviewChildren);

    const cliSlotsList = EditableSlotList({
      items: getEffectiveDraftCliSlots(),
      options: getCapsuleMetricOptions(),
      minItems: 1,
      maxItems: 6,
      addBtnTextFn: (count, max) => t('settings.str.addCliSlot', { count, max }),
      onPreview: (previewItems) => {
        draftCliStatusLineSlots = normalizeClientCliStatusLineSlots(previewItems);
        refreshCliPreview();
      },
      onChange: (nextItems) => {
        draftCliStatusLineSlots = normalizeClientCliStatusLineSlots(nextItems);
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          cliStatusLineSlots: draftCliStatusLineSlots,
        });
      },
    });

    const cliStatusFooterEl = h('div', { className: 'cli-status-footer', hidden: true }, [
      cliStatusHintEl,
      cliStatusActionBtn,
    ]);

    const cliStatusDetailEl = h('div', { className: 'cli-statusline-detail' }, [
      cliPreviewEl,
      h('div', { className: 'form-row' }, [cliSlotsLabelEl, cliSlotsList.el]),
      cliStatusFooterEl,
    ]);

    const cliStatusGroupEl = h('div', { className: 'cli-statusline-group', hidden: true }, [
      h('div', { className: 'settings-divider' }),
      h('div', { className: 'settings-inline-row' }, [cliCapsuleLabelEl, cliCapsuleToggle.el]),
      cliStatusDetailEl,
    ]);

    const topbarSlotsList = EditableSlotList({
      items: draftTopbarSlots,
      options: getCapsuleMetricOptions(),
      minItems: 1,
      maxItems: 5,
      addBtnTextFn: (count, max) => t('settings.str.addCapsuleSlot', { count, max }),
      onPreview: (previewItems) => {
        draftTopbarSlots = normalizeClientTopbarSlots(previewItems);
        refreshMountPreview();
      },
      onChange: (nextItems) => {
        draftTopbarSlots = normalizeClientTopbarSlots(nextItems);
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          topbarCapsuleSlots: draftTopbarSlots,
        });
      },
    });

    const mountBridgeNotice = BridgeStatusNotice({});

    const mountSection = CollapsibleSection({
      collapsible: false,
      icon: 'dock',
      title: t('settings.str.mountSection'),
      badgeText: t('settings.str.mountBadge', { count: draftTopbarSlots.length }),
      onReset: () => {
        draftWindowMountMode = 'dual';
        draftPopoverWidthMode = 'auto';
        draftPopoverWidth = DEFAULT_CLIENT_POPOVER_WIDTH;
        popoverWidthStepper.setProps({ modelValue: DEFAULT_CLIENT_POPOVER_WIDTH });
        draftEnableCliStatusLine = true;
        draftCliStatusLineSlots = null;
        draftShowTopbarMulti = true;
        draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          mountSection,
          {
            windowMountMode: 'dual',
            enableWindowOverlay: true,
            popoverWidthMode: 'auto',
            popoverWidth: DEFAULT_CLIENT_POPOVER_WIDTH,
            enableCliStatusLine: true,
            cliStatusLineSlots: null,
            showTopbarMultiSession: true,
            topbarCapsuleSlots: [...DEFAULT_CLIENT_TOPBAR_SLOTS],
          },
          'settings.resetDone'
        );
      },
      children: [
        mountPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [mountModeLabelEl, windowMountSelect.el]),
        mountBridgeNotice.el,
        h('div', { className: 'form-row' }, [
          h('div', { className: 'settings-inline-row' }, [
            popoverWidthLabelEl,
            h('div', { className: 'settings-inline-controls' }, [
              popoverWidthModeToggle.el,
              popoverWidthNumWrap,
            ]),
          ]),
          popoverWidthHintEl,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          multiToggleLabelEl,
          multiSessionToggle.el,
        ]),
        h('div', { className: 'form-row' }, [capsuleSlotsLabelEl, topbarSlotsList.el]),
        cliStatusGroupEl,
      ],
    });

    function refreshCliPreview() {
      const effectiveSlots = getEffectiveDraftCliSlots();
      const isEn = getEffectiveLocale() === 'en-US';
      patchAttr(cliPreviewMultiEl, 'hidden', !draftShowTopbarMulti);
      patchText(cliPreviewMultiTextEl, t('settings.str.cliPreviewRunning', { count: 2 }));
      for (let i = 0; i < cliPreviewSlotParts.length; i += 1) {
        const parts = cliPreviewSlotParts[i];
        const sepEl = i > 0 ? cliPreviewSepEls[i - 1] : null;
        const key = effectiveSlots[i];
        const visible = Boolean(key);
        patchAttr(parts.slotEl, 'hidden', !visible);
        if (sepEl) patchAttr(sepEl, 'hidden', !visible);
        if (visible) {
          const item = formatCliPreviewSlot(key, isEn);
          patchAttr(parts.slotEl, 'data-metric', key);
          patchText(parts.prefixEl, item.prefix || '');
          patchText(parts.barFillEl, item.barFilled || '');
          patchText(parts.barEmptyEl, item.barEmpty || '');
          patchText(parts.valueEl, item.text || '');
          patchClasses(parts.slotEl, {
            'tone-good': item.tone === 'good',
            'tone-info': item.tone === 'info',
            'tone-accent': item.tone === 'accent',
            'tone-muted': item.tone === 'muted',
          });
        }
      }
    }

    function refreshMountPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'mount') return;
      capsulePreviewWidget.refs.update({ data: buildDraftTelemetry() });
      refreshCliPreview();
    }

    function syncMountSectionMeta() {
      windowMountSelect.setProps({
        modelValue: draftWindowMountMode,
        options: getMountModeOptions(),
      });
      mountBridgeNotice.refs.update({
        visible: draftWindowMountMode !== 'sidebar',
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
      });
      popoverWidthModeToggle.setProps({
        modelValue: draftPopoverWidthMode,
        options: getPopoverWidthModeOptions(),
      });
      patchAttr(popoverWidthNumWrap, 'hidden', draftPopoverWidthMode !== 'custom');
      if (document?.activeElement !== popoverWidthStepper.refs.textField) {
        popoverWidthStepper.setProps({
          modelValue: draftPopoverWidth,
          ariaLabel: t('settings.str.popoverWidthLabel'),
        });
      }
      multiSessionToggle.setProps({
        modelValue: draftShowTopbarMulti ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      const cliInstalled = Boolean(latestCliStatusLine?.installed);
      patchAttr(cliStatusGroupEl, 'hidden', !cliInstalled);
      cliCapsuleToggle.setProps({
        modelValue: draftEnableCliStatusLine ? 'on' : 'off',
        options: getEnableToggleOptions(),
      });
      patchAttr(cliStatusDetailEl, 'hidden', !draftEnableCliStatusLine);
      const effectiveCliSlots = getEffectiveDraftCliSlots();
      cliSlotsList.refs.setProps({
        items: effectiveCliSlots,
        options: getCapsuleMetricOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addCliSlot', { count, max }),
      });
      const preservedCustom = Boolean(latestCliStatusLine?.preservedCustom);
      const isConfigured = Boolean(latestCliStatusLine?.configured);
      const hasInlineSlotFlags = /(?:^|\s)--(?:slots|preset)(?:=|\s|$)/i.test(
        String(latestCliStatusLine?.managedFlags || '')
      );
      const isPausedInCli = cliInstalled && !preservedCustom && !isConfigured && draftEnableCliStatusLine;
      const cliHintText = preservedCustom
        ? t('settings.str.cliCustomCmdHint')
        : isPausedInCli
          ? t('settings.str.cliPausedHint')
          : hasInlineSlotFlags
            ? t('settings.str.cliFlagsOverrideHint')
            : '';
      patchAttr(cliStatusFooterEl, 'hidden', !cliHintText);
      patchClasses(cliStatusHintEl, { 'is-warn': preservedCustom || isPausedInCli });
      patchText(cliStatusHintEl, cliHintText);
      activeCliStatusAction = preservedCustom || isPausedInCli
        ? 'force_install'
        : hasInlineSlotFlags
          ? 'clear_flags'
          : '';
      patchAttr(cliStatusActionBtn, 'hidden', !activeCliStatusAction);
      patchClasses(cliStatusActionBtn, { 'is-warn': preservedCustom });
      if (!cliActionBusy && activeCliStatusAction) {
        patchText(
          cliStatusActionBtn,
          preservedCustom
            ? t('settings.str.cliRestoreBtn')
            : isPausedInCli
              ? t('settings.str.cliEnableBtn')
              : t('settings.str.cliClearFlagsBtn')
        );
      }
      refreshCliPreview();
      topbarSlotsList.refs.setProps({
        items: draftTopbarSlots,
        options: getCapsuleMetricOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addCapsuleSlot', { count, max }),
      });
      mountSection.refs.setBadge(
        t('settings.str.mountBadge', { count: draftTopbarSlots.length })
      );
      const isDefault =
        draftWindowMountMode === 'dual' &&
        draftPopoverWidthMode === 'auto' &&
        draftPopoverWidth === DEFAULT_CLIENT_POPOVER_WIDTH &&
        draftEnableCliStatusLine === true &&
        draftCliStatusLineSlots === null &&
        draftShowTopbarMulti === true &&
        isSameList(draftTopbarSlots, DEFAULT_CLIENT_TOPBAR_SLOTS);
      mountSection.refs.setResetDisabled(isDefault);
      refreshMountPreview();
    }

    // --- Pane 2: 鼠标悬浮窗 (`hover`) ---
    const hoverWidgetsContainerEl = h('div', { className: 'wm-hover-widgets' });
    const hoverPreviewTipEl = h('div', { className: 'wm-hover-tip is-preview' }, [
      hoverWidgetsContainerEl,
    ]);
    const hoverPreviewEmptyEl = h('div', {
      className: 'structure-preview-empty',
      hidden: true,
      text: t('settings.str.hoverEmptyHint'),
    });
    const hoverPreviewHost = createDynamicWidgetHost({
      containerEl: hoverWidgetsContainerEl,
      mode: 'hover',
      preview: true,
      isVisibleFn: () => isStructureVisible() && activeThirdTab === 'hover',
      initialModuleKeys: [],
    });
    const hoverPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      hoverPreviewTipEl,
      hoverPreviewEmptyEl,
    ]);

    const hoverModulesLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.hoverModulesLabel'),
    });

    const hoverModulesList = EditableSlotList({
      items: draftHoverModules,
      options: getOverviewModuleOptions(),
      minItems: 0,
      maxItems: 4,
      emptyHintText: t('settings.str.hoverEmptyHint'),
      addBtnTextFn: (count, max) => t('settings.str.addHoverModule', { count, max }),
      onPreview: (previewItems) => {
        draftHoverModules = normalizeClientHoverModules(previewItems);
        refreshHoverPreview();
      },
      onChange: (nextItems) => {
        draftHoverModules = normalizeClientHoverModules(nextItems);
        syncHoverSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(hoverSection, {
          hoverModules: draftHoverModules,
        });
      },
    });

    const hoverSection = CollapsibleSection({
      collapsible: false,
      icon: 'layers',
      title: t('settings.str.hoverSection'),
      badgeText: t('settings.str.hoverBadgeCount', { count: draftHoverModules.length }),
      onReset: () => {
        draftHoverModules = [...DEFAULT_CLIENT_HOVER_MODULES];
        syncHoverSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          hoverSection,
          { hoverModules: [...DEFAULT_CLIENT_HOVER_MODULES] },
          'settings.resetDone'
        );
      },
      children: [
        hoverPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [hoverModulesLabelEl, hoverModulesList.el]),
      ],
    });

    function refreshHoverPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'hover') return;
      const hasModules = draftHoverModules.length > 0;
      patchAttr(hoverPreviewTipEl, 'hidden', !hasModules);
      patchAttr(hoverPreviewEmptyEl, 'hidden', hasModules);
      patchText(hoverPreviewEmptyEl, t('settings.str.hoverEmptyHint'));
      hoverPreviewHost.update({
        moduleKeys: draftHoverModules,
        data: buildDraftTelemetry(),
      });
    }

    function syncHoverSectionMeta() {
      hoverModulesList.refs.setProps({
        items: draftHoverModules,
        options: getOverviewModuleOptions(),
        emptyHintText: t('settings.str.hoverEmptyHint'),
        addBtnTextFn: (count, max) => t('settings.str.addHoverModule', { count, max }),
      });
      hoverSection.refs.setBadge(
        draftHoverModules.length === 0
          ? t('settings.str.hoverBadgeOff')
          : t('settings.str.hoverBadgeCount', { count: draftHoverModules.length })
      );
      hoverSection.refs.setResetDisabled(
        isSameList(draftHoverModules, DEFAULT_CLIENT_HOVER_MODULES)
      );
      refreshHoverPreview();
    }

    // --- Pane 3: 实时监控布局 (`overview`) ---
    const overviewPreviewContainerEl = h('div', { className: 'overview-modules-host is-preview' });
    const overviewPreviewHost = createDynamicWidgetHost({
      containerEl: overviewPreviewContainerEl,
      mode: 'overview',
      preview: true,
      isVisibleFn: () => isStructureVisible() && activeThirdTab === 'overview',
      initialModuleKeys: [],
    });
    const overviewPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      overviewPreviewContainerEl,
    ]);

    const overviewModulesLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.overviewModulesLabel'),
    });
    const overviewMetricsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.overviewMetricsLabel'),
    });
    const overviewMetricsHintEl = h('span', {
      className: 'settings-hint-text',
      hidden: true,
      text: t('settings.str.overviewMetricsInactiveHint'),
    });

    const overviewModulesList = EditableSlotList({
      items: draftOverviewModules,
      options: getOverviewModuleOptions(),
      minItems: 1,
      maxItems: 4,
      addBtnTextFn: (count, max) => t('settings.str.addOverviewModule', { count, max }),
      onPreview: (previewItems) => {
        draftOverviewModules = normalizeClientOverviewModules(previewItems);
        patchAttr(overviewMetricsHintEl, 'hidden', draftOverviewModules.includes('metrics'));
        refreshOverviewPreview();
      },
      onChange: (nextItems) => {
        draftOverviewModules = normalizeClientOverviewModules(nextItems);
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(overviewSection, {
          overviewModules: draftOverviewModules,
        });
      },
    });

    const overviewMetricsList = EditableSlotList({
      items: draftOverviewMetrics,
      options: getOverviewMetricOptions(),
      minItems: 1,
      maxItems: 4,
      addBtnTextFn: (count, max) => t('settings.str.addOverviewMetric', { count, max }),
      onPreview: (previewItems) => {
        draftOverviewMetrics = normalizeClientOverviewMetrics(previewItems);
        refreshOverviewPreview();
      },
      onChange: (nextItems) => {
        draftOverviewMetrics = normalizeClientOverviewMetrics(nextItems);
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(overviewSection, {
          overviewMetrics: draftOverviewMetrics,
        });
      },
    });

    const overviewSection = CollapsibleSection({
      collapsible: false,
      icon: 'pulse',
      title: t('settings.str.overviewSection'),
      badgeText: t('settings.str.overviewBadge', {
        modCount: draftOverviewModules.length,
        metCount: draftOverviewMetrics.length,
      }),
      onReset: () => {
        draftOverviewModules = [...DEFAULT_CLIENT_OVERVIEW_MODULES];
        draftOverviewMetrics = [...DEFAULT_CLIENT_OVERVIEW_METRICS];
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          overviewSection,
          {
            overviewModules: [...DEFAULT_CLIENT_OVERVIEW_MODULES],
            overviewMetrics: [...DEFAULT_CLIENT_OVERVIEW_METRICS],
          },
          'settings.resetDone'
        );
      },
      children: [
        overviewPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [overviewModulesLabelEl, overviewModulesList.el]),
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [
          overviewMetricsLabelEl,
          overviewMetricsHintEl,
          overviewMetricsList.el,
        ]),
      ],
    });

    function refreshOverviewPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'overview') return;
      overviewPreviewHost.update({
        moduleKeys: draftOverviewModules,
        data: buildDraftTelemetry(),
      });
    }

    function syncOverviewSectionMeta() {
      overviewModulesList.refs.setProps({
        items: draftOverviewModules,
        options: getOverviewModuleOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addOverviewModule', { count, max }),
      });
      overviewMetricsList.refs.setProps({
        items: draftOverviewMetrics,
        options: getOverviewMetricOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addOverviewMetric', { count, max }),
      });
      const metricsModuleActive = draftOverviewModules.includes('metrics');
      patchAttr(overviewMetricsHintEl, 'hidden', metricsModuleActive);
      overviewSection.refs.setBadge(
        t('settings.str.overviewBadge', {
          modCount: draftOverviewModules.length,
          metCount: draftOverviewMetrics.length,
        })
      );
      const isDefault =
        isSameList(draftOverviewModules, DEFAULT_CLIENT_OVERVIEW_MODULES) &&
        isSameList(draftOverviewMetrics, DEFAULT_CLIENT_OVERVIEW_METRICS);
      overviewSection.refs.setResetDisabled(isDefault);
      refreshOverviewPreview();
    }

    // --- Pane 4: 调用明细字段 (`steps`) ---
    const stepTablePreview = StepTableWidget({
      standalone: true,
      interactiveBadges: false,
    });
    const stepsPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      stepTablePreview.el,
    ]);

    const stepTurnRailLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepTurnRailToggle'),
    });
    const stepAgentBadgeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepAgentBadgeToggle'),
    });
    const stepSpeedColorLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepSpeedColorToggle'),
    });
    const stepTokenComboLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepTokenComboLabel'),
    });
    const stepTokenComboHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.str.stepTokenComboHint'),
    });
    const stepColsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepsColsLabel'),
    });

    const stepTurnRailToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepTurnRailToggle'),
      modelValue: 'hide',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepTurnRail = val !== 'hide';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepTurnRail: draftShowStepTurnRail,
        });
      },
    });

    const stepAgentBadgeToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepAgentBadgeToggle'),
      modelValue: 'show',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepAgentBadge = val !== 'hide';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepAgentBadge: draftShowStepAgentBadge,
        });
      },
    });

    const stepSpeedColorToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepSpeedColorToggle'),
      modelValue: 'off',
      options: getEnableToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepSpeedColor = val !== 'off';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepSpeedColor: draftShowStepSpeedColor,
        });
      },
    });

    function commitStepTokenComboInput() {
      const rawTrimmed = String(stepTokenComboInput.value || '').trim();
      const normFmt = normalizeClientStepTokenComboFormat(rawTrimmed);
      rawStepTokenComboText = normFmt;
      draftStepTokenComboFormat = normFmt;
      stepTokenComboInput.value = normFmt;
      if (rawTrimmed && !draftStepColumns.includes('tokens_custom')) {
        const comboIdx = draftStepColumns.findIndex(
          (k) => k === 'tokens_combo' || k === 'tokens_io_cache'
        );
        if (comboIdx >= 0) {
          const nextCols = [...draftStepColumns];
          nextCols[comboIdx] = 'tokens_custom';
          draftStepColumns = normalizeClientStepColumns(nextCols);
        } else {
          draftStepColumns = normalizeClientStepColumns([...draftStepColumns, 'tokens_custom']);
        }
      }
      syncStepsSectionMeta();
      props.onLayoutChange?.();
      void persistStructurePatch(stepsSection, {
        stepTokenComboFormat: draftStepTokenComboFormat,
        stepTableColumns: draftStepColumns,
      });
    }

    const stepTokenComboInput = h('input', {
      type: 'text',
      className: 'settings-text-input',
      spellcheck: 'false',
      value: rawStepTokenComboText,
      placeholder: t('settings.str.stepTokenComboPlaceholder'),
      'aria-label': t('settings.str.stepTokenComboLabel'),
      onInput: () => {
        rawStepTokenComboText = stepTokenComboInput.value;
        draftStepTokenComboFormat = normalizeClientStepTokenComboFormat(rawStepTokenComboText);
        stepColumnsList.refs.setProps({
          items: draftStepColumns,
          options: getStepColumnOptions(draftStepTokenComboFormat),
          addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
        });
        refreshStepsPreview();
      },
      onChange: () => {
        commitStepTokenComboInput();
      },
      onKeydown: (e) => {
        if (e?.key === 'Enter') {
          e.preventDefault();
          stepTokenComboInput.blur();
        }
      },
    });

    const stepColumnsList = EditableSlotList({
      items: draftStepColumns,
      options: getStepColumnOptions(draftStepTokenComboFormat),
      minItems: 2,
      maxItems: 14,
      addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
      onPreview: (previewItems) => {
        draftStepColumns = normalizeClientStepColumns(previewItems);
        refreshStepsPreview();
      },
      onChange: (nextItems) => {
        draftStepColumns = normalizeClientStepColumns(nextItems);
        syncStepsSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(stepsSection, {
          stepTableColumns: draftStepColumns,
        });
      },
    });

    const stepsSection = CollapsibleSection({
      collapsible: false,
      icon: 'table',
      title: t('settings.str.stepsSection'),
      badgeText: t('settings.str.stepsBadge', { count: draftStepColumns.length }),
      onReset: () => {
        draftShowStepTurnRail = false;
        draftShowStepAgentBadge = true;
        draftShowStepSpeedColor = false;
        draftStepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        rawStepTokenComboText = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        stepTokenComboInput.value = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        draftStepColumns = [...DEFAULT_CLIENT_STEP_COLUMNS];
        syncStepsSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          stepsSection,
          {
            showStepTurnRail: false,
            showStepAgentBadge: true,
            showStepSpeedColor: false,
            stepTokenComboFormat: DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT,
            stepTableColumns: [...DEFAULT_CLIENT_STEP_COLUMNS],
          },
          'settings.resetDone'
        );
      },
      children: [
        stepsPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'settings-inline-row' }, [
          stepTurnRailLabelEl,
          stepTurnRailToggle.el,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          stepAgentBadgeLabelEl,
          stepAgentBadgeToggle.el,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          stepSpeedColorLabelEl,
          stepSpeedColorToggle.el,
        ]),
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [
          stepTokenComboLabelEl,
          stepTokenComboInput,
          stepTokenComboHintEl,
        ]),
        h('div', { className: 'form-row' }, [stepColsLabelEl, stepColumnsList.el]),
      ],
    });

    function refreshStepsPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'steps') return;
      const mockData = buildDraftTelemetry();
      const mockSteps = mockData.activeConversation?.recentSteps || [];
      const previewCols =
        document?.activeElement === stepTokenComboInput &&
        String(rawStepTokenComboText || '').trim() &&
        !draftStepColumns.includes('tokens_custom')
          ? normalizeClientStepColumns(
              draftStepColumns.some((k) => k === 'tokens_combo' || k === 'tokens_io_cache')
                ? draftStepColumns.map((k) =>
                    k === 'tokens_combo' || k === 'tokens_io_cache' ? 'tokens_custom' : k
                  )
                : [...draftStepColumns, 'tokens_custom']
            )
          : draftStepColumns;
      stepTablePreview.refs.renderStepTable(
        mockSteps,
        'mock-preview-conv',
        previewCols,
        getEffectiveLocale(),
        {
          effectiveScopes: ['all'],
          hasSubagents: true,
          isMergedMultiAgents: true,
          showStepTurnRail: draftShowStepTurnRail,
          showStepAgentBadge: draftShowStepAgentBadge,
          showStepSpeedColor: draftShowStepSpeedColor,
          stepTokenComboFormat: draftStepTokenComboFormat,
          displaySettings: mockData.settings,
        }
      );
    }

    function syncStepsSectionMeta() {
      stepTurnRailToggle.setProps({
        modelValue: draftShowStepTurnRail ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      stepAgentBadgeToggle.setProps({
        modelValue: draftShowStepAgentBadge ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      stepSpeedColorToggle.setProps({
        modelValue: draftShowStepSpeedColor ? 'on' : 'off',
        options: getEnableToggleOptions(),
      });
      if (document?.activeElement !== stepTokenComboInput) {
        stepTokenComboInput.value = rawStepTokenComboText;
      }
      stepColumnsList.refs.setProps({
        items: draftStepColumns,
        options: getStepColumnOptions(draftStepTokenComboFormat),
        addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
      });
      stepsSection.refs.setBadge(t('settings.str.stepsBadge', { count: draftStepColumns.length }));
      const isDefault =
        draftShowStepTurnRail === false &&
        draftShowStepAgentBadge === true &&
        draftShowStepSpeedColor === false &&
        draftStepTokenComboFormat === DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT &&
        isSameList(draftStepColumns, DEFAULT_CLIENT_STEP_COLUMNS);
      stepsSection.refs.setResetDisabled(isDefault);
      refreshStepsPreview();
    }

    function syncPreviewTickers() {
      const visible = isStructureVisible();
      if (visible && activeThirdTab === 'hover') {
        hoverPreviewHost.resumeTickers();
      } else {
        hoverPreviewHost.pauseTickers();
      }
      if (visible && activeThirdTab === 'overview') {
        overviewPreviewHost.resumeTickers();
      } else {
        overviewPreviewHost.pauseTickers();
      }
      if (!visible || activeThirdTab !== 'steps') {
        stepTablePreview.refs.hideTurnTip();
      }
    }

    function refreshActivePreview() {
      if (!isStructureVisible()) return;
      if (activeThirdTab === 'mount') refreshMountPreview();
      else if (activeThirdTab === 'hover') refreshHoverPreview();
      else if (activeThirdTab === 'overview') refreshOverviewPreview();
      else if (activeThirdTab === 'steps') refreshStepsPreview();
    }

    function applyActiveThirdTab(nextRawTab) {
      const nextTab = normalizeStructureTabKey(nextRawTab);
      activeThirdTab = nextTab;
      const activeIdx = Math.max(
        0,
        STRUCTURE_THIRD_TABS.findIndex((it) => it.key === nextTab)
      );
      patchStyleVar(thirdNavBar, '--active-third-index', activeIdx);
      for (const [key, entry] of thirdNavBtnMap.entries()) {
        const isActive = key === nextTab;
        patchClasses(entry.btn, { 'is-active': isActive });
        patchAttr(entry.btn, 'aria-selected', isActive ? 'true' : 'false');
      }
      patchAttr(mountSection.el, 'hidden', nextTab !== 'mount');
      patchAttr(hoverSection.el, 'hidden', nextTab !== 'hover');
      patchAttr(overviewSection.el, 'hidden', nextTab !== 'overview');
      patchAttr(stepsSection.el, 'hidden', nextTab !== 'steps');
      refreshActivePreview();
      syncPreviewTickers();
      props.onLayoutChange?.();
    }

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      mountSection.el,
      hoverSection.el,
      overviewSection.el,
      stepsSection.el,
    ]);

    function renderSettings(
      settings,
      windowBridge = latestWindowBridge,
      hostPlatform = latestHostPlatform,
      cliStatusLine = latestCliStatusLine
    ) {
      if (!settings) return;
      latestSettings = settings;
      if (windowBridge !== undefined) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      if (cliStatusLine !== undefined) latestCliStatusLine = cliStatusLine;
      draftWindowMountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );
      draftPopoverWidthMode = normalizeClientPopoverWidthMode(settings.popoverWidthMode);
      draftPopoverWidth = normalizeClientPopoverWidth(settings.popoverWidth);
      draftEnableCliStatusLine = settings.enableCliStatusLine !== false;
      draftCliStatusLineSlots = normalizeClientCliStatusLineSlots(settings.cliStatusLineSlots);
      draftShowTopbarMulti = settings.showTopbarMultiSession !== false;
      draftTopbarSlots = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);
      draftHoverModules = normalizeClientHoverModules(settings.hoverModules);
      draftOverviewModules = normalizeClientOverviewModules(settings.overviewModules);
      draftOverviewMetrics = normalizeClientOverviewMetrics(settings.overviewMetrics);
      draftShowStepTurnRail = settings.showStepTurnRail === true;
      draftShowStepAgentBadge = settings.showStepAgentBadge !== false;
      draftShowStepSpeedColor = settings.showStepSpeedColor === true;
      draftStepTokenComboFormat = normalizeClientStepTokenComboFormat(
        settings.stepTokenComboFormat
      );
      rawStepTokenComboText = draftStepTokenComboFormat;
      draftStepColumns = normalizeClientStepColumns(settings.stepTableColumns);

      syncMountSectionMeta();
      syncHoverSectionMeta();
      syncOverviewSectionMeta();
      syncStepsSectionMeta();
    }

    function refreshLabels() {
      patchAttr(thirdNavBar, 'aria-label', t('settings.str.thirdTabAria'));
      for (const entry of thirdNavBtnMap.values()) {
        patchText(entry.labelEl, t(entry.labelKey));
      }

      mountSection.refs.setTitle(t('settings.str.mountSection'));
      mountSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(mountModeLabelEl, t('settings.str.mountMode'));
      patchText(popoverWidthLabelEl, t('settings.str.popoverWidthLabel'));
      patchText(popoverWidthHintEl, t('settings.str.popoverWidthHint'));
      popoverWidthStepper.setProps({ ariaLabel: t('settings.str.popoverWidthLabel') });
      patchText(multiToggleLabelEl, t('settings.str.multiToggle'));
      patchText(cliCapsuleLabelEl, t('settings.str.cliCapsuleToggle'));
      patchText(cliSlotsLabelEl, t('settings.str.cliSlotsLabel'));
      patchText(capsuleSlotsLabelEl, t('settings.str.capsuleSlotsLabel'));

      hoverSection.refs.setTitle(t('settings.str.hoverSection'));
      hoverSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(hoverModulesLabelEl, t('settings.str.hoverModulesLabel'));

      overviewSection.refs.setTitle(t('settings.str.overviewSection'));
      overviewSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(overviewModulesLabelEl, t('settings.str.overviewModulesLabel'));
      patchText(overviewMetricsLabelEl, t('settings.str.overviewMetricsLabel'));
      patchText(overviewMetricsHintEl, t('settings.str.overviewMetricsInactiveHint'));

      stepsSection.refs.setTitle(t('settings.str.stepsSection'));
      stepsSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(stepTurnRailLabelEl, t('settings.str.stepTurnRailToggle'));
      patchText(stepAgentBadgeLabelEl, t('settings.str.stepAgentBadgeToggle'));
      patchText(stepSpeedColorLabelEl, t('settings.str.stepSpeedColorToggle'));
      patchText(stepTokenComboLabelEl, t('settings.str.stepTokenComboLabel'));
      patchText(stepTokenComboHintEl, t('settings.str.stepTokenComboHint'));
      patchAttr(stepTokenComboInput, 'placeholder', t('settings.str.stepTokenComboPlaceholder'));
      patchAttr(stepTokenComboInput, 'aria-label', t('settings.str.stepTokenComboLabel'));
      patchText(stepColsLabelEl, t('settings.str.stepsColsLabel'));

      syncMountSectionMeta();
      syncHoverSectionMeta();
      syncOverviewSectionMeta();
      syncStepsSectionMeta();
    }

    let wasStructureVisible = isStructureVisible();
    const unsubUi = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        settingsSubTab: st.settingsSubTab,
        settingsStructureTab: st.settingsStructureTab,
      }),
      (slice) => {
        const nowVisible =
          slice.activeView === 'settings' && slice.settingsSubTab === 'structure';
        const enteredStructure = nowVisible && !wasStructureVisible;
        wasStructureVisible = nowVisible;
        if (normalizeStructureTabKey(slice.settingsStructureTab) !== activeThirdTab) {
          applyActiveThirdTab(slice.settingsStructureTab);
        } else {
          if (enteredStructure) {
            refreshActivePreview();
          }
          syncPreviewTickers();
        }
      }
    );

    syncMountSectionMeta();
    syncHoverSectionMeta();
    syncOverviewSectionMeta();
    syncStepsSectionMeta();
    applyActiveThirdTab(activeThirdTab);

    onCleanup(() => {
      unsubUi();
      mountBridgeNotice.destroy();
      capsulePreviewWidget.destroy();
      hoverPreviewHost.destroy();
      overviewPreviewHost.destroy();
      stepTablePreview.destroy();
      windowMountSelect.destroy();
      popoverWidthStepper.destroy();
      popoverWidthModeToggle.destroy();
      multiSessionToggle.destroy();
      cliCapsuleToggle.destroy();
      cliSlotsList.destroy();
      topbarSlotsList.destroy();
      hoverModulesList.destroy();
      overviewModulesList.destroy();
      overviewMetricsList.destroy();
      stepTurnRailToggle.destroy();
      stepAgentBadgeToggle.destroy();
      stepSpeedColorToggle.destroy();
      stepColumnsList.destroy();
      mountSection.destroy();
      hoverSection.destroy();
      overviewSection.destroy();
      stepsSection.destroy();
    });

    return {
      el: rootEl,
      refs: {
        thirdNavBar,
        capsulePreviewWidget,
        mountBridgeNotice,
        hoverPreviewHost,
        overviewPreviewHost,
        stepTablePreview,
        windowMountSelect,
        multiSessionToggle,
        cliCapsuleToggle,
        cliStatusGroupEl,
        cliStatusDetailEl,
        cliPreviewEl,
        cliSlotsList,
        cliStatusFooterEl,
        cliStatusHintEl,
        cliStatusActionBtn,
        topbarSlotsList,
        hoverModulesList,
        overviewModulesList,
        overviewMetricsList,
        stepTurnRailToggle,
        stepAgentBadgeToggle,
        stepSpeedColorToggle,
        stepColumnsList,
        mountSection,
        hoverSection,
        overviewSection,
        stepsSection,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
