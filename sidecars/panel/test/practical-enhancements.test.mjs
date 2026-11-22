import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockDom } from './mock-dom.mjs';
import { CustomSelect, filterSelectOptionsByQuery } from '../src/components/ui/CustomSelect.js';
import { App } from '../src/App.js';
import { sortStepsByColumn } from '../src/registries/stepColumnRegistry.js';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { StepsDetailView } from '../src/views/StepsDetailView.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';
import { SettingsOtherTab } from '../src/views/settings/SettingsOtherTab.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import { backendHarness } from './backend-harness.mjs';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { telemetryStore } from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';

test('Feature 1: CustomSelect searchable mode filters by multi-term query, respects threshold, and handles keyboard flow', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };
  setI18nLanguage('zh-CN');

  let picked = null;
  let comp = null;
  t.after(() => {
    comp?.destroy?.();
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // Pure multi-term matcher
  const opts = [
    { value: '', label: '最新 (主对话)', meta: '12步' },
    { value: 'cid-ssh-1', label: 'SSH 远程部署排查', meta: '主4 · 2蜂 (共18步)' },
    { value: 'cid-ui-2', label: 'Modern UI 光滑动画', meta: '9步' },
    { value: 'cid-bug-3', label: '5h 配额周期对齐', meta: '42步' },
    { value: 'cid-sql-4', label: 'SQLite WAL 性能优化', meta: '31步' },
    { value: 'cid-perf-5', label: 'Carbon 模型测速对比', meta: '19步' },
  ];
  assert.equal(filterSelectOptionsByQuery(opts, 'ssh 蜂').length, 1);
  assert.equal(filterSelectOptionsByQuery(opts, 'cid-bug-3')[0].value, 'cid-bug-3');
  assert.equal(filterSelectOptionsByQuery(opts, 'no-such-session').length, 0);

  comp = CustomSelect({
    modelValue: '',
    searchable: true,
    searchThreshold: 6,
    searchPlaceholder: '搜索会话…',
    options: opts,
    onUpdateModelValue: (val) => {
      picked = val;
    },
  });
  document.body.appendChild(comp.el);

  // Below threshold hides search bar
  comp.setProps({ options: opts.slice(0, 3) });
  comp.open();
  assert.equal(comp.el.querySelector('.select-search-wrap').hasAttribute('hidden'), true);
  comp.close();

  // At/above threshold shows search bar and filters live
  comp.setProps({ options: opts });
  let focusedSearch = false;
  comp.refs.searchInput.focus = () => {
    focusedSearch = true;
  };
  comp.openAndFocusSearch();
  assert.equal(comp.el.classList.contains('is-open'), true);
  assert.equal(comp.el.querySelector('.select-search-wrap').hasAttribute('hidden'), false);
  assert.equal(comp.el.querySelectorAll('.select-option').length, 6);

  // Type query -> filters to 1 match
  comp.refs.searchInput.value = 'sql wal';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  let visibleRows = comp.el.querySelectorAll('.select-option');
  assert.equal(visibleRows.length, 1);
  assert.equal(visibleRows[0].getAttribute('data-value'), 'cid-sql-4');
  assert.equal(comp.el.querySelector('.select-empty').hasAttribute('hidden'), true);

  // Unmatched query -> shows empty hint
  comp.refs.searchInput.value = 'does-not-exist-xyz';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  assert.equal(comp.el.querySelectorAll('.select-option').length, 0);
  assert.equal(comp.el.querySelector('.select-empty').hasAttribute('hidden'), false);

  // First Escape clears query instead of closing dropdown
  comp.refs.searchInput.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    target: comp.refs.searchInput,
    preventDefault() {},
  });
  assert.equal(comp.el.classList.contains('is-open'), true);
  assert.equal(comp.refs.searchInput.value, '');
  assert.equal(comp.el.querySelectorAll('.select-option').length, 6);

  // Filter and press Enter to select
  comp.refs.searchInput.value = 'carbon';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  comp.refs.searchInput.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    target: comp.refs.searchInput,
    preventDefault() {},
  });
  assert.equal(picked, 'cid-perf-5');
  assert.equal(comp.el.classList.contains('is-open'), false);
  return Promise.resolve().then(() => {
    assert.equal(focusedSearch, true);
  });
});

test('Feature 1: App panel keyboard shortcuts switch tabs (1-4), trigger refresh (r), open search (/), and ignore editable inputs', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  let fetchCalled = 0;
  globalThis.window = {
    location: { pathname: '/' },
    innerWidth: 960,
    innerHeight: 720,
    sidecar: {
      fetch: async () => {
        fetchCalled += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  uiStore.setState({ activeView: 'overview', monitorVisible: true }, { sync: true });
  let app = null;
  t.after(() => {
    app?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  app = App();
  document.body.appendChild(app.el);

  // Keys 2, 3, 4, 1 switch activeView
  app.el.dispatchEvent({ type: 'keydown', key: '2', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'consumption');
  app.el.dispatchEvent({ type: 'keydown', key: '3', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'steps');
  app.el.dispatchEvent({ type: 'keydown', key: '4', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'settings');
  app.el.dispatchEvent({ type: 'keydown', key: '1', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'overview');

  // Modifier keys and INPUT targets are ignored
  app.el.dispatchEvent({
    type: 'keydown',
    key: '3',
    ctrlKey: true,
    target: app.el,
    preventDefault() {},
  });
  assert.equal(uiStore.getState().activeView, 'overview');

  const fakeInput = document.createElement('input');
  app.el.dispatchEvent({ type: 'keydown', key: '3', target: fakeInput, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'overview');

  // '/' opens top session picker
  app.el.dispatchEvent({ type: 'keydown', key: '/', target: app.el, preventDefault() {} });
  assert.equal(app.refs.sessionHeader.refs.convSelect.el.classList.contains('is-open'), true);

  // 'r' triggers telemetry refresh
  app.el.dispatchEvent({ type: 'keydown', key: 'r', target: app.el, preventDefault() {} });
  assert.ok(fetchCalled >= 1);
});

test('Feature 3: Step table supports multi-column sorting (with nulls last), anomaly/compaction quick chips, and live subtotal bar', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };
  const prevLocale = i18nStore.getState().locale;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };
  setI18nLanguage('zh-CN');

  let view = null;
  t.after(() => {
    view?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const sampleSteps = [
    {
      stepIndex: 3,
      createdAtMs: 3000,
      modelShort: '4-neon',
      modelLabel: 'Gemini 4 Neon',
      tokPerSec: 30,
      ttftSec: 4.5,
      inputTokens: 10_000,
      cacheReadTokens: 90_000,
      outputTokens: 600,
      thinkingTokens: 400,
      responseTokens: 200,
      contextTokens: 100_600,
      cacheHitPct: 90,
      costUsd: 0.45,
      anomaly: { count: 1, severity: 'warn', primaryKind: 'timeout', kinds: { timeout: 1 } },
      anomalySig: 'timeout:1',
    },
    {
      stepIndex: 2,
      createdAtMs: 2000,
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: null,
      ttftSec: null,
      isCompactionStep: true,
      inputTokens: 50_000,
      cacheReadTokens: 0,
      outputTokens: 1_000,
      thinkingTokens: 0,
      responseTokens: 1_000,
      contextTokens: 51_000,
      cacheHitPct: 0,
      costUsd: 0.12,
    },
    {
      stepIndex: 1,
      createdAtMs: 1000,
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: 60,
      ttftSec: 1.5,
      inputTokens: 5_000,
      cacheReadTokens: 95_000,
      outputTokens: 1_200,
      thinkingTokens: 500,
      responseTokens: 700,
      contextTokens: 101_200,
      cacheHitPct: 95,
      costUsd: 0.08,
    },
  ];

  // Pure sort keeps nulls last in both desc and asc
  const byTpsDesc = sortStepsByColumn(sampleSteps, 'tps', 'desc');
  assert.deepEqual(byTpsDesc.map((s) => s.stepIndex), [1, 3, 2]);
  const byTpsAsc = sortStepsByColumn(sampleSteps, 'tps', 'asc');
  assert.deepEqual(byTpsAsc.map((s) => s.stepIndex), [3, 1, 2]);

  // Full StepsDetailView integration: click header sort cycles desc -> asc -> default (no bottom summary bar)
  uiStore.setState({ activeView: 'steps', stepsSubTab: 'steps', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      telemetry: {
        settings: {
          stepTableColumns: ['step', 'model', 'tps', 'cost'],
          showStepTurnRail: true,
        },
        activeConversation: {
          cascadeId: 'cid-sort-1',
          stepCount: 3,
          recentSteps: sampleSteps,
          modelBreakdown: [],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView();
  document.body.appendChild(view.el);

  assert.equal(view.el.querySelector('.steps-summary-bar'), null);

  // Click '费用' header (index 3) -> desc -> asc -> default
  const ths = view.el.querySelectorAll('thead th');
  assert.equal(ths.length, 4);
  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'descending');
  let rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#3', '#2', '#1']);

  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'ascending');
  rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#1', '#2', '#3']);

  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'none');
  rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#3', '#2', '#1']);
});

test('Feature 5: backend aggregates top costly sessions consistently across full and fast paths', async () => {
  const nowMs = Date.now();
  const h = (hrsAgo) => nowMs - hrsAgo * 3600 * 1000;

  const harn = backendHarness({
    cache: {
      'conv-high-cost': {
        cascadeId: 'conv-high-cost',
        title: 'Expensive Refactor',
        appSource: 'standalone',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 200_000,
            cacheReadTokens: 800_000,
            outputTokens: 40_000,
            thinkingTokens: 15_000,
            responseTokens: 25_000,
            createdAtMs: h(3),
          },
          {
            stepIndex: 2,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 100_000,
            cacheReadTokens: 400_000,
            outputTokens: 20_000,
            thinkingTokens: 8_000,
            responseTokens: 12_000,
            createdAtMs: h(30),
          },
        ],
      },
      'conv-low-cost': {
        cascadeId: 'conv-low-cost',
        title: 'Quick Bugfix',
        appSource: 'ide',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 50_000,
            cacheReadTokens: 200_000,
            outputTokens: 10_000,
            thinkingTokens: 3_000,
            responseTokens: 7_000,
            createdAtMs: h(2),
          },
        ],
      },
    },
    summaries: {
      'conv-high-cost': { summary: 'Expensive Refactor', stepCount: 2, lastModifiedTime: new Date(h(3)).toISOString() },
      'conv-low-cost': { summary: 'Quick Bugfix', stepCount: 1, lastModifiedTime: new Date(h(2)).toISOString() },
    },
  });

  const full24h = await harn.buildTelemetryPayloadInternal('conv-high-cost', false, { range: '24h' });
  const topList = full24h.consumption.topConversations;
  assert.equal(Array.isArray(topList), true);
  assert.equal(topList.length, 2);
  assert.equal(topList[0].cascadeId, 'conv-high-cost');
  assert.equal(topList[0].title, 'Expensive Refactor');
  assert.equal(topList[0].totalTokens, 1_040_000);
  assert.equal(topList[0].cacheHitPct, 80);
  assert.equal(Array.isArray(topList[0].models), true, 'Each top conversation carries per-model breakdown');
  assert.equal(topList[0].models.length, 1);
  assert.equal(topList[0].models[0].totalTokens, 1_040_000);
  assert.equal(topList[1].cascadeId, 'conv-low-cost');
  assert.equal(topList[1].totalTokens, 260_000);
  assert.equal(full24h.consumption.comparison, undefined);

  // Fast consumption slice path matches full path identically
  const fast24h = JSON.parse(
    (await harn.executeTelemetryAction({
      conversationId: 'conv-high-cost',
      range: '24h',
      scope: 'consumption',
    })).body
  );
  assert.equal(fast24h.scope, 'consumption');
  assert.equal(fast24h.consumption.topConversations.length, 2);
  assert.equal(fast24h.consumption.topConversations[0].cascadeId, 'conv-high-cost');
});

test('Feature 5: TrendAreaChart drill-down click and unified Models/Sessions segmented ranking card', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  let view = null;
  let chart = null;
  t.after(() => {
    view?.destroy?.();
    chart?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');

  // 1. TrendAreaChart click drill-down on line curve
  const selectedSlots = [];
  chart = createTrendAreaChart({ onSelectSlot: (slot) => selectedSlots.push(slot) });
  const day1Start = new Date(2026, 9, 10, 0, 0, 0, 0).getTime();
  const day1End = new Date(2026, 9, 10, 23, 59, 59, 999).getTime();
  const day2Start = new Date(2026, 9, 11, 0, 0, 0, 0).getTime();
  const day2End = new Date(2026, 9, 11, 23, 59, 59, 999).getTime();
  chart.update([
    { label: '10/10', fullLabel: '2026-10-10', startMs: day1Start, endMs: day1End, tokens: 100_000, calls: 2, costUsd: 0.2 },
    { label: '10/11', fullLabel: '2026-10-11', startMs: day2Start, endMs: day2End, tokens: 300_000, calls: 4, costUsd: 0.6 },
  ]);
  const svgEl = chart.el.querySelector('svg');
  svgEl.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 184 });
  const stageEl = chart.el.querySelector('.trend-plot-stage');
  stageEl.dispatchEvent({ type: 'click', clientX: 390 });
  assert.equal(selectedSlots.length, 1);
  assert.equal(selectedSlots[0].label, '10/11');

  // 2. ConsumptionView renders delta pills, top sessions sorting & click-to-jump, and month bar drill-down
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      customStartMs: 0,
      customEndMs: 0,
      telemetry: {
        settings: {},
        consumption: {
          revision: 7,
          selectedRange: { key: '7d', label: '近7天', startMs: day1Start, endMs: day2End },
          account: {
            totalTokens: 1_500_000,
            inputTokens: 200_000,
            cacheReadTokens: 1_200_000,
            outputTokens: 100_000,
            responseTokens: 60_000,
            thinkingTokens: 40_000,
            costUsd: 2.5,
            savedCostUsd: 1.8,
            cacheHitPct: 85.7,
            calls: 15,
          },
          comparison: {
            prevTotalTokens: 1_000_000,
            prevCostUsd: 5.0,
            prevCalls: 10,
            tokensDeltaPct: 50,
            costDeltaPct: -50,
          },
          topConversations: [
            {
              cascadeId: 'cid-costly',
              title: 'Costly Session',
              sourceName: 'Antigravity',
              calls: 6,
              inputTokens: 150_000,
              cacheReadTokens: 300_000,
              responseTokens: 40_000,
              thinkingTokens: 10_000,
              totalTokens: 500_000,
              costUsd: 1.8,
              cacheHitPct: 66.7,
              canJump: true,
              models: [
                { label: '4-neon', shortName: '4-neon', calls: 4, totalTokens: 400_000, costUsd: 1.5 },
                { label: '4-carbon', shortName: '4-carbon', calls: 2, totalTokens: 100_000, costUsd: 0.3 },
              ],
            },
            {
              cascadeId: 'cid-heavy-tok',
              title: 'Heavy Cache Session',
              sourceName: 'IDE',
              calls: 9,
              inputTokens: 50_000,
              cacheReadTokens: 900_000,
              responseTokens: 20_000,
              thinkingTokens: 30_000,
              totalTokens: 1_000_000,
              costUsd: 0.7,
              cacheHitPct: 94.7,
              canJump: true,
              models: [
                { label: '4-carbon', shortName: '4-carbon', calls: 9, totalTokens: 1_000_000, costUsd: 0.7 },
              ],
            },
          ],
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: Array.from({ length: 12 }, (_, idx) =>
            idx === 4
              ? { month: 5, totalTokens: 800_000, costUsd: 1.4, calls: 12, models: [] }
              : { month: idx + 1, totalTokens: 0, costUsd: 0, calls: 0, models: [] }
          ),
        },
        modelBreakdown: [],
      },
    },
    { sync: true }
  );

  view = ConsumptionView();
  document.body.appendChild(view.el);

  // Period delta pills removed
  assert.equal(view.el.querySelectorAll('.cons-delta-pill').length, 0);

  // Unified ranking panel starts on Models tab and hides Sessions list
  const rankingPanel = view.el.querySelector('.cons-ranking-panel');
  const rankingTabBtns = rankingPanel.querySelector('.cons-ranking-head > .segmented').querySelectorAll('.seg-btn');
  assert.equal(rankingTabBtns.length, 2);
  assert.match(rankingTabBtns[0].textContent, /模型排行/);
  assert.match(rankingTabBtns[1].textContent, /会话排行 \(2\)/);

  const listContainers = rankingPanel.querySelectorAll('.cons-item-list');
  assert.equal(listContainers[0].hasAttribute('hidden'), false, 'Models list visible by default');
  assert.equal(listContainers[1].hasAttribute('hidden'), true, 'Sessions list hidden by default');

  // Switch ranking tab to Sessions -> models list hides, sessions list reveals
  rankingTabBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  assert.equal(listContainers[0].hasAttribute('hidden'), true);
  assert.equal(listContainers[1].hasAttribute('hidden'), false);

  // Top sessions default sorted by cost: Costly Session first with cost-share % and multi-model bar
  let convRows = view.el.querySelectorAll('.cons-top-conv-row');
  assert.equal(convRows.length, 2);
  assert.equal(convRows[0].querySelector('.cons-row-title-text').textContent, 'Costly Session');
  assert.equal(convRows[0].querySelector('.cons-share-pill').textContent, '72.0%');
  assert.equal(convRows[0].querySelectorAll('.cons-model-seg').length, 2, 'Session bar splits by model colors');
  assert.equal(convRows[0].querySelectorAll('.cons-source-top-item').length, 2, 'Session footer shows top models');
  assert.equal(convRows[0].querySelector('.cons-source-top-name').textContent, '4-neon');

  // Switch sessions sort to Tokens: Heavy Cache Session moves to first and share switches to token % (66.7%)
  const sortSwitches = rankingPanel.querySelectorAll('.cons-ranking-sort-wrap > .segmented');
  assert.equal(sortSwitches[0].hasAttribute('hidden'), true, 'Models sort switch hidden on Sessions tab');
  assert.equal(sortSwitches[1].hasAttribute('hidden'), false, 'Sessions sort switch visible on Sessions tab');
  const topConvSortBtns = sortSwitches[1].querySelectorAll('.seg-btn');
  topConvSortBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  convRows = view.el.querySelectorAll('.cons-top-conv-row');
  assert.equal(convRows[0].querySelector('.cons-row-title-text').textContent, 'Heavy Cache Session');
  assert.equal(convRows[0].querySelector('.cons-share-pill').textContent, '66.7%');

  // Click a monthly bar (May, index 4) to drill down to May 2026 custom range
  const monthCols = view.el.querySelectorAll('.month-col');
  monthCols[4].dispatchEvent({ type: 'click' });
  assert.equal(telemetryStore.getState().selectedTimeRange, 'custom');
  assert.equal(new Date(telemetryStore.getState().customStartMs).getMonth(), 4);
  assert.equal(new Date(telemetryStore.getState().customEndMs).getMonth(), 4);

  // Click top session row to jump to steps view with that conversation selected
  convRows[0].dispatchEvent({ type: 'click' });
  assert.equal(uiStore.getState().activeView, 'steps');
  assert.equal(telemetryStore.getState().selectedConversationId, 'cid-heavy-tok');
});

test('Feature 6: model ranking multi-metric sort with efficiency footer & validated settings JSON backup/restore', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  let savedPatches = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/settings') && opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      savedPatches.push(body);
      return { ok: true, json: async () => ({ ok: true, settings: body }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  let consView = null;
  let otherTab = null;
  t.after(() => {
    consView?.destroy?.();
    otherTab?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');

  // 1. Model ranking sort & efficiency footer (TPS / TTFT / Cache / Anomaly / $/1M)
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      telemetry: {
        settings: {},
        consumption: {
          revision: 9,
          selectedRange: { key: '7d', label: '近7天', startMs: 1, endMs: 2 },
          account: { totalTokens: 3_000_000, costUsd: 5.0, calls: 30 },
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: [],
        },
        modelBreakdown: [
          {
            label: 'model-high-tok',
            shortName: 'model-high-tok',
            calls: 10,
            inputTokens: 100_000,
            cacheReadTokens: 1_800_000,
            outputTokens: 100_000,
            thinkingTokens: 40_000,
            responseTokens: 60_000,
            totalTokens: 2_000_000,
            costUsd: 1.5,
            avgTokPerSec: 32.5,
            avgTtftSec: 2.1,
            cacheHitPct: 94.7,
            anomalyCount: 2,
          },
          {
            label: 'model-fast-costly',
            shortName: 'model-fast-costly',
            calls: 20,
            inputTokens: 300_000,
            cacheReadTokens: 600_000,
            outputTokens: 100_000,
            thinkingTokens: 30_000,
            responseTokens: 70_000,
            totalTokens: 1_000_000,
            costUsd: 3.5,
            avgTokPerSec: 88.4,
            avgTtftSec: 0.8,
            cacheHitPct: 66.7,
            anomalyCount: 0,
          },
        ],
      },
    },
    { sync: true }
  );

  consView = ConsumptionView();
  document.body.appendChild(consView.el);

  // Default sorted by Tokens -> model-high-tok first with Token share (66.7%) & full info
  let rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-high-tok');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '66.7%');
  const perfFoot = rows[0].querySelector('.cons-model-perf-foot');
  assert.equal(perfFoot.hasAttribute('hidden'), false);
  assert.match(perfFoot.querySelector('.cons-model-perf-main').textContent, /32\.5 tok\/s/);
  assert.match(perfFoot.querySelector('.cons-model-perf-main').textContent, /2\.1s/);
  assert.equal(perfFoot.querySelector('.cons-model-anom-tag'), null);
  assert.match(perfFoot.querySelector('.cons-model-unit-cost').textContent, /\$0\.75\/1M/);
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), true);

  // Switch model ranking sort to Speed -> model-fast-costly first, pct becomes relative speed (100%), focuses on speed
  const modelsHeaderBtns = consView.el
    .querySelector('.cons-ranking-sort-wrap > .segmented')
    .querySelectorAll('.seg-btn');
  assert.equal(modelsHeaderBtns.length, 4);
  modelsHeaderBtns[2].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '100%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '88.4 tok/s');
  assert.equal(rows[0].querySelector('.cons-model-perf-foot').hasAttribute('hidden'), true);
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), false);
  assert.equal(rows[1].querySelector('.cons-share-pill').textContent, '37%');

  // Switch to Cost -> model-fast-costly ($3.50 / $5.00 = 70.0%), focuses on cost
  modelsHeaderBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '70.0%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '$3.50');
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), false);

  // Switch to Calls -> model-fast-costly (20 / 30 = 66.7%), focuses on calls
  modelsHeaderBtns[3].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '66.7%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '20 次');

  // 2. Settings JSON Export & Safe Validated Import
  const exportedJson = buildExportableSettingsJson({
    language: 'en-US',
    themeAccent: 'emerald',
    fontScale: 'lg',
    modernUi: true,
    stepTableColumns: ['step', 'model', 'cost'],
    contextWindowRiskAccepted: true,
    modelContextWindows: { 'model:foo': '1000000' },
  });
  const parsedRaw = JSON.parse(exportedJson);
  assert.equal(parsedRaw.schema, 'antigravity-usage-monitor.settings');
  assert.equal(parsedRaw.settings.themeAccent, 'emerald');
  assert.equal(parsedRaw.settings.contextWindowRiskAccepted, undefined, 'Risk flag must not be exported');
  assert.equal(parsedRaw.settings.modelContextWindows, undefined, 'Context overrides must not be exported');

  // Import strips unknown/dangerous keys and normalizes valid keys
  const imported = parseImportedSettingsJson(
    JSON.stringify({
      schema: 'antigravity-usage-monitor.settings',
      settings: {
        language: 'en-US',
        themeAccent: 'violet',
        fontScale: 'INVALID_SCALE',
        popoverWidth: 99999,
        contextWindowRiskAccepted: true,
        unknownSecret: 'nope',
      },
    })
  );
  assert.equal(imported.ok, true);
  assert.equal(imported.patch.language, 'en-US');
  assert.equal(imported.patch.themeAccent, 'violet');
  assert.equal(imported.patch.fontScale, 'md', 'Invalid scale normalizes safely');
  assert.equal(imported.patch.popoverWidth, 1080, 'Oversized popover width clamps safely');
  assert.equal(imported.patch.contextWindowRiskAccepted, undefined);
  assert.equal(imported.patch.unknownSecret, undefined);

  // Rejects bad JSON and foreign schema
  assert.equal(parseImportedSettingsJson('{bad json').ok, false);
  assert.equal(parseImportedSettingsJson(JSON.stringify({ schema: 'other.app', settings: {} })).ok, false);

  // SettingsOtherTab wires import end-to-end
  otherTab = SettingsOtherTab();
  otherTab.refs.renderSettings({ language: 'zh-CN', themeAccent: 'host' }, []);
  const applied = await otherTab.refs.applyImportedSettingsText(exportedJson);
  assert.equal(applied, true);
  assert.equal(savedPatches.length, 1);
  assert.equal(savedPatches[0].themeAccent, 'emerald');
  assert.equal(i18nStore.getState().locale, 'en-US');
});

test('Feature 7: telemetry exposes all local conversations beyond 30 and recovers missing/hex titles from turn prompts', async () => {
  const baseMs = Date.parse('2026-11-21T03:00:00.000Z');
  const summaries = {};
  const trajectories = {};
  for (let i = 0; i < 36; i++) {
    const hex = String(i + 1).padStart(8, '0');
    const cid = `${hex}-1111-4111-8111-111111111111`;
    const tsIso = new Date(baseMs - i * 60_000).toISOString();
    const isUntitled = i === 34;
    summaries[cid] = {
      summary: isUntitled ? '' : `Session #${i + 1}`,
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 2,
      createdTime: tsIso,
      lastModifiedTime: tsIso,
    };
    trajectories[cid] = {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE',
            userInput: {
              userResponse: isUntitled ? '排查热力图悬浮提示抖动问题' : `Prompt #${i + 1}`,
            },
            metadata: { createdAt: tsIso },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              createdAt: tsIso,
              completedAt: new Date(baseMs - i * 60_000 + 2000).toISOString(),
              sourceTrajectoryStepInfo: { stepIndex: 1 },
              modelUsage: {
                model: 'MODEL_PLACEHOLDER_M429',
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                inputTokens: '1000',
                cacheReadTokens: '2000',
                outputTokens: '500',
              },
            },
          },
        ],
      },
    };
  }

  const harness = backendHarness({
    clock: () => baseMs + 5_000,
    summaries,
    trajectories,
  });

  const payload = await harness.buildTelemetryPayloadInternal();
  assert.equal(payload.conversations.length, 36, 'All 36 local conversations should be exposed without 30-item truncation');
  assert.equal(payload.account.totalConversations, 36);
  assert.ok(payload.conversations[0].sessionCostUsd !== undefined, 'Recent conversations keep quick stats');
  assert.equal(payload.conversations[35].sessionCostUsd, undefined, 'Older historical conversations omit heavy quick stats');

  const recoveredConv = payload.conversations.find((c) => c.cascadeId.startsWith('00000035-'));
  assert.ok(recoveredConv);
  assert.equal(recoveredConv.title, '排查热力图悬浮提示抖动问题');
});

test('Feature 8: StepsDetailView model summary cards align with Model Ranking (proportional 4-seg bar + left-aligned perf sub-row + unit cost)', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let view = null;
  t.after(() => {
    if (view) view.destroy();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState(
    { monitorVisible: true, activeView: 'steps', stepsSubTab: 'models', selectedAgentScope: 'all' },
    { sync: true }
  );
  telemetryStore.setState(
    {
      telemetry: {
        settings: { language: 'zh-CN', modelDisplayMode: 'upstream', showUpstreamModel: true },
        activeConversation: {
          cascadeId: 'steps-summary-align',
          stepCount: 10,
          recentSteps: [],
          modelBreakdown: [
            {
              label: '4-neon',
              shortName: '4-neon',
              upstreamName: '4-neon',
              calls: 8,
              inputTokens: 100_000,
              cacheReadTokens: 600_000,
              thinkingTokens: 50_000,
              responseTokens: 50_000,
              outputTokens: 100_000,
              totalTokens: 800_000,
              costUsd: 2.4,
              avgTokPerSec: 45.2,
              avgTtftSec: 12.1,
              cacheHitPct: 85.7,
            },
            {
              label: '4-carbon',
              shortName: '4-carbon',
              upstreamName: '4-carbon',
              calls: 2,
              inputTokens: 40_000,
              cacheReadTokens: 140_000,
              thinkingTokens: 10_000,
              responseTokens: 10_000,
              outputTokens: 20_000,
              totalTokens: 200_000,
              costUsd: 0.4,
              avgTokPerSec: 22.0,
              avgTtftSec: 18.4,
              cacheHitPct: 77.8,
            },
          ],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView();
  document.body.appendChild(view.el);

  const cards = view.el.querySelectorAll('.smodel-card');
  assert.equal(cards.length, 2);
  const sumBarPct = (card) =>
    card
      .querySelectorAll('.progress-seg')
      .reduce((acc, el) => acc + (Number.parseFloat(el.style.getPropertyValue('--seg-w')) || 0), 0);

  assert.ok(Math.abs(sumBarPct(cards[0]) - 80) < 0.2, `Expected 80% bar width for 4-neon, got ${sumBarPct(cards[0])}`);
  assert.ok(Math.abs(sumBarPct(cards[1]) - 20) < 0.2, `Expected 20% bar width for 4-carbon, got ${sumBarPct(cards[1])}`);
  assert.ok(cards[0].querySelector('.smodel-perf-foot > .smodel-perf'), 'Perf metrics live in dedicated left-aligned sub-row');
  assert.match(cards[0].querySelector('.smodel-unit-cost')?.textContent || '', /均价 \$3\.00\/1M/);
});

test('Feature 9: workspace/project cost aggregation (full + fast paths) and Projects ranking tab in ConsumptionView', async (t) => {
  const { normalizeWorkspaceBucket } = await import('../backend/usage-aggregator.mjs');

  // 1. URI / Windows / POSIX workspace path normalization
  const winNorm = normalizeWorkspaceBucket('file:///F%3A/ppt/1111/antigravity-usage-monitor/');
  assert.equal(winNorm.label, 'antigravity-usage-monitor');
  assert.equal(winNorm.workspacePath, 'F:/ppt/1111/antigravity-usage-monitor');
  assert.equal(winNorm.workspaceKey, 'f:/ppt/1111/antigravity-usage-monitor');

  const winBackslash = normalizeWorkspaceBucket('f:\\ppt\\1111\\antigravity-usage-monitor\\');
  assert.equal(winBackslash.workspaceKey, winNorm.workspaceKey);

  const posixNorm = normalizeWorkspaceBucket('file:///Users/dev/my-service/');
  assert.equal(posixNorm.label, 'my-service');
  assert.equal(posixNorm.workspacePath, '/Users/dev/my-service');

  // 2. End-to-end backend aggregation across multiple sessions sharing a workspace (including backfill from summaries.workspaces)
  const now = Date.now();
  const harn = backendHarness({
    cache: {
      'ws-conv-a1': {
        cascadeId: 'ws-conv-a1',
        title: 'Monitor work 1',
        appSource: 'standalone',
        workspaceUri: 'file:///F%3A/ppt/usage-monitor',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 120_000,
            cacheReadTokens: 180_000,
            outputTokens: 8_000,
            thinkingTokens: 3_000,
            responseTokens: 5_000,
            createdAtMs: now - 120_000,
          },
        ],
      },
      'ws-conv-a2': {
        cascadeId: 'ws-conv-a2',
        title: 'Monitor work 2',
        appSource: 'cli',
        // Intentionally omit workspaceUri on cache entry to verify backfill from summaries.workspaces
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 80_000,
            cacheReadTokens: 120_000,
            outputTokens: 4_000,
            thinkingTokens: 1_000,
            responseTokens: 3_000,
            createdAtMs: now - 60_000,
          },
        ],
      },
      'ws-conv-b1': {
        cascadeId: 'ws-conv-b1',
        title: 'Docs site',
        appSource: 'ide',
        workspaceUri: 'file:///F%3A/ppt/docs-site',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 20_000,
            cacheReadTokens: 30_000,
            outputTokens: 1_000,
            thinkingTokens: 400,
            responseTokens: 600,
            createdAtMs: now - 90_000,
          },
        ],
      },
    },
    summaries: {
      'ws-conv-a1': {
        summary: 'Monitor work 1',
        stepCount: 1,
        lastModifiedTime: new Date(now - 120_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///F%3A/ppt/usage-monitor' }],
      },
      'ws-conv-a2': {
        summary: 'Monitor work 2',
        stepCount: 1,
        lastModifiedTime: new Date(now - 60_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///f:/ppt/usage-monitor/' }],
      },
      'ws-conv-b1': {
        summary: 'Docs site',
        stepCount: 1,
        lastModifiedTime: new Date(now - 90_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///F%3A/ppt/docs-site' }],
      },
    },
  });

  const fullPayload = await harn.buildTelemetryPayloadInternal('ws-conv-a2', false, { range: '24h' });
  const topWs = fullPayload.consumption?.topWorkspaces || [];
  assert.equal(topWs.length, 2);
  assert.equal(topWs[0].label, 'usage-monitor');
  assert.equal(topWs[0].sessionCount, 2);
  assert.equal(topWs[0].calls, 2);
  assert.equal(topWs[0].totalTokens, 512_000);
  assert.equal(topWs[0].latestCascadeId, 'ws-conv-a2');
  assert.equal(topWs[0].canJump, true);
  assert.equal(topWs[1].label, 'docs-site');
  assert.equal(topWs[1].sessionCount, 1);

  const fastPayload = JSON.parse(
    (await harn.executeTelemetryAction({
      conversationId: 'ws-conv-a2',
      range: '24h',
      scope: 'consumption',
    })).body
  );
  assert.equal(fastPayload.consumption.topWorkspaces.length, 2);
  assert.equal(fastPayload.consumption.topWorkspaces[0].label, 'usage-monitor');
  assert.equal(fastPayload.consumption.topWorkspaces[0].totalTokens, topWs[0].totalTokens);

  // 3. Frontend ConsumptionView Projects tab rendering, sorting, and click-to-jump
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  let view = null;
  t.after(() => {
    view?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      customStartMs: 0,
      customEndMs: 0,
      telemetry: {
        settings: {},
        consumption: {
          revision: 11,
          selectedRange: { key: '7d', label: '近7天', startMs: now - 86_400_000, endMs: now },
          account: {
            totalTokens: 1_000_000,
            inputTokens: 200_000,
            cacheReadTokens: 700_000,
            outputTokens: 100_000,
            responseTokens: 60_000,
            thinkingTokens: 40_000,
            costUsd: 3.0,
            savedCostUsd: 1.0,
            cacheHitPct: 77.8,
            calls: 10,
          },
          topConversations: [],
          topWorkspaces: [
            {
              workspaceKey: 'f:/ppt/usage-monitor',
              label: 'usage-monitor',
              workspacePath: 'F:/ppt/usage-monitor',
              isUnbound: false,
              sessionCount: 4,
              calls: 6,
              inputTokens: 150_000,
              cacheReadTokens: 200_000,
              responseTokens: 30_000,
              thinkingTokens: 20_000,
              totalTokens: 400_000,
              costUsd: 2.1,
              cacheHitPct: 57.1,
              latestCascadeId: 'ws-conv-a2',
              canJump: true,
              models: [{ label: '4-neon', shortName: '4-neon', calls: 6, totalTokens: 400_000, costUsd: 2.1 }],
            },
            {
              workspaceKey: 'f:/ppt/docs-site',
              label: 'docs-site',
              workspacePath: 'F:/ppt/docs-site',
              isUnbound: false,
              sessionCount: 2,
              calls: 4,
              inputTokens: 50_000,
              cacheReadTokens: 500_000,
              responseTokens: 30_000,
              thinkingTokens: 20_000,
              totalTokens: 600_000,
              costUsd: 0.9,
              cacheHitPct: 90.9,
              latestCascadeId: 'ws-conv-b1',
              canJump: true,
              models: [{ label: '4-carbon', shortName: '4-carbon', calls: 4, totalTokens: 600_000, costUsd: 0.9 }],
            },
          ],
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: [],
        },
        modelBreakdown: [],
      },
    },
    { sync: true }
  );

  view = ConsumptionView();
  document.body.appendChild(view.el);

  const rankingPanel = view.el.querySelector('.cons-ranking-panel');
  const rankingTabBtns = rankingPanel.querySelector('.cons-ranking-head > .segmented').querySelectorAll('.seg-btn');
  assert.equal(rankingTabBtns.length, 3);
  assert.match(rankingTabBtns[1].textContent, /项目排行 \(2\)/);

  // Switch to Projects tab
  rankingTabBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  const wsRows = view.el.querySelectorAll('.cons-workspace-row');
  assert.equal(wsRows.length, 2);
  assert.equal(wsRows[0].querySelector('.cons-row-title-text').textContent, 'usage-monitor');
  assert.equal(wsRows[0].querySelector('.cons-ws-sessions-tag').textContent, '4 会话');

  // Switch sort to Tokens -> docs-site (600k) moves first
  const sortSwitches = rankingPanel.querySelectorAll('.cons-ranking-sort-wrap > .segmented');
  sortSwitches[1].querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  const wsRowsAfterSort = view.el.querySelectorAll('.cons-workspace-row');
  assert.equal(wsRowsAfterSort[0].querySelector('.cons-row-title-text').textContent, 'docs-site');

  // Click workspace row jumps to its latest conversation in steps view
  wsRowsAfterSort[0].dispatchEvent({ type: 'click' });
  assert.equal(uiStore.getState().activeView, 'steps');
  assert.equal(telemetryStore.getState().selectedConversationId, 'ws-conv-b1');
});

test('Feature 13: TopSessionHeader exposes project/workspace tags on sessions and filters by workspace name', async (t) => {
  const { TopSessionHeader } = await import('../src/components/layout/TopSessionHeader.js');
  const now = Date.now();
  const harn = backendHarness({
    cache: {
      'proj-conv-1': {
        cascadeId: 'proj-conv-1',
        title: 'Fix auth bug',
        workspaceUri: 'file:///F%3A/repos/billing-service',
        steps: [{ stepIndex: 1, modelKey: 'MODEL_PLACEHOLDER_M18', inputTokens: 1000, outputTokens: 100, createdAtMs: now - 5000 }],
      },
      'proj-conv-2': {
        cascadeId: 'proj-conv-2',
        title: 'Fix auth bug',
        workspaceUri: 'file:///F%3A/repos/web-dashboard',
        steps: [{ stepIndex: 1, modelKey: 'MODEL_PLACEHOLDER_M18', inputTokens: 1000, outputTokens: 100, createdAtMs: now - 10000 }],
      },
    },
    summaries: {
      'proj-conv-1': { summary: 'Fix auth bug', stepCount: 1, lastModifiedTime: new Date(now - 5000).toISOString() },
      'proj-conv-2': { summary: 'Fix auth bug', stepCount: 1, lastModifiedTime: new Date(now - 10000).toISOString() },
    },
  });

  const payload = await harn.buildTelemetryPayloadInternal('proj-conv-1');
  const convById = new Map((payload.conversations || []).map((c) => [c.cascadeId, c]));
  assert.equal(convById.get('proj-conv-1')?.workspaceName, 'billing-service');
  assert.equal(convById.get('proj-conv-2')?.workspaceName, 'web-dashboard');

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };

  let header = null;
  t.after(() => {
    header?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState({ activeView: 'overview', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedConversationId: '',
      telemetry: {
        ...payload,
        conversations: [
          ...payload.conversations,
          ...Array.from({ length: 6 }, (_, i) => ({
            cascadeId: `pad-${i}`,
            title: `Other session ${i}`,
            stepCount: 2,
            workspaceName: 'misc-repo',
          })),
        ],
      },
    },
    { sync: true }
  );

  header = TopSessionHeader();
  document.body.appendChild(header.el);
  header.refs.convSelect.open();

  const optionEls = header.refs.convSelect.el.querySelectorAll('.select-option');
  const billingOpt = optionEls.find((el) => (el.textContent || '').includes('billing-service'));
  assert.ok(billingOpt, 'Session dropdown option displays workspaceName tag');

  const searchInput = header.refs.convSelect.el.querySelector('.select-search-input');
  assert.ok(searchInput, 'Search input present for >6 sessions');
  searchInput.value = 'web-dashboard';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  const visibleOpts = header.refs.convSelect.el
    .querySelectorAll('.select-option')
    .filter((el) => !el.hasAttribute('hidden'));
  assert.equal(visibleOpts.length, 1);
  assert.match(visibleOpts[0].textContent, /web-dashboard/);
});
