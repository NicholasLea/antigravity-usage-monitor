/**
 * @fileoverview Per-account quota remaining-% trajectory chart (`AccountQuotaTrendCard.js`).
 * Full-bleed edge-to-edge plot (`x = 1 .. viewW - 1`), X-axis clamped to earliest recorded
 * sample when history is shorter than the selected preset, and adaptive integer Y-scale so
 * real quota movements never compress into a tiny corner with wasted whitespace.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatDateSpanBadge } from '../../core/formatters.js';
import { SVG_NS, createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { CustomDateTimePicker } from '../ui/CustomDateTimePicker.js';
import { CustomSelect } from '../ui/CustomSelect.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

const POOL_COLORS = Object.freeze({
  Gemini: 'var(--accent-primary)',
  'Claude & GPT': 'var(--metric-ok)',
  Argon: 'var(--ctx-thinking)',
  Carbon: 'var(--metric-warn)',
});

const POOL_ORDER = ['Gemini', 'Argon', 'Carbon', 'Claude & GPT'];

let quotaChartUid = 0;

function floorMinute(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(0, 0);
  return d.getTime();
}

function ceilMinute(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(59, 999);
  return d.getTime();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatAxisTickTime(ms, spanMs) {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanMs <= 36 * 3600_000) {
    return hm;
  }
  const md = `${d.getMonth() + 1}/${pad2(d.getDate())}`;
  if (spanMs <= 7 * 86400_000) {
    return `${md} ${pad2(d.getHours())}h`;
  }
  return md;
}

function formatHoverTimestamp(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function buildHorizontalTangentSpline(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const dx = (p1.x - p0.x) * 0.38;
    d += ` C ${(p0.x + dx).toFixed(1)} ${p0.y.toFixed(1)}, ${(p1.x - dx).toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Computes tight, integer-aligned `[yMin, yMid, yMax]` bounds (`0..100%`) around
 * observed `[dataMin, dataMax]` so small-to-moderate quota changes use the full
 * vertical canvas instead of leaving 80%+ empty bottom space.
 */
function computeAdaptiveQuotaScale(dataMin, dataMax) {
  const lo = Math.max(0, Math.min(100, Number.isFinite(dataMin) ? dataMin : 0));
  const hi = Math.max(lo, Math.min(100, Number.isFinite(dataMax) ? dataMax : 100));
  const rawSpan = hi - lo;
  const pad = Math.max(1.5, rawSpan * 0.14);

  let yMax = hi >= 98.5 ? 100 : Math.min(100, Math.ceil((hi + pad) / 10) * 10);
  let yMin = lo <= 2 ? 0 : Math.max(0, Math.floor((lo - pad) / 10) * 10);

  if (yMax - yMin < 10) {
    if (yMax >= 100) {
      yMax = 100;
      yMin = 90;
    } else if (yMin <= 0) {
      yMin = 0;
      yMax = 10;
    } else {
      yMin = Math.max(0, yMax - 10);
    }
  }
  // Ensure `(yMax - yMin)` is even so midpoint tick is always an exact integer
  if ((yMax - yMin) % 2 !== 0) {
    if (yMin > 0) yMin -= 1;
    else if (yMax < 100) yMax += 1;
  }
  const yMid = Math.round((yMin + yMax) / 2);
  return { yMin, yMid, yMax, span: Math.max(1, yMax - yMin) };
}

const IMPULSE_GLITCH_MAX_SPAN_MS = 20 * 60_000;
const IMPULSE_GLITCH_MIN_JUMP_PCT = 3;
const IMPULSE_GLITCH_MAX_NEIGHBOR_DIFF_PCT = 1.2;
const CYCLE_RESET_JUMP_MIN_PCT = 3.5;

function stripIsolatedImpulseSpikes(pts) {
  if (pts.length < 3) return pts;
  const out = pts.slice();
  let i = 1;
  while (i < out.length - 1) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];
    const spanMs = next.ts - prev.ts;
    if (
      spanMs >= 0 &&
      spanMs <= IMPULSE_GLITCH_MAX_SPAN_MS &&
      cur.val - prev.val >= IMPULSE_GLITCH_MIN_JUMP_PCT &&
      cur.val - next.val >= IMPULSE_GLITCH_MIN_JUMP_PCT &&
      Math.abs(next.val - prev.val) <= IMPULSE_GLITCH_MAX_NEIGHBOR_DIFF_PCT
    ) {
      out.splice(i, 1);
      if (i > 1) i -= 1;
      continue;
    }
    i += 1;
  }
  return out;
}

export function resolveQuotaWindowBounds({
  pools,
  selectedRange,
  selectedWin,
  selectedPool,
  customStartMs = 0,
  customEndMs = 0,
  nowMs = Date.now(),
}) {
  if (selectedRange === 'custom') {
    return {
      startMs: Math.min(customStartMs, customEndMs),
      endMs: Math.max(customStartMs, customEndMs),
    };
  }
  if (selectedRange === 'today') {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return { startMs: d.getTime(), endMs: nowMs };
  }
  if (selectedRange === '24h') return { startMs: nowMs - 24 * 3600_000, endMs: nowMs };
  if (selectedRange === '7d') return { startMs: nowMs - 7 * 86400_000, endMs: nowMs };
  if (selectedRange === '14d') return { startMs: nowMs - 14 * 86400_000, endMs: nowMs };
  if (selectedRange === '30d') return { startMs: nowMs - 30 * 86400_000, endMs: nowMs };
  if (selectedRange === 'all') {
    let minTs = Infinity;
    for (const p of pools) {
      for (const pt of p.points) {
        if (pt[0] > 0 && pt[0] < minTs) minTs = pt[0];
      }
    }
    const safeStart =
      Number.isFinite(minTs) && minTs < nowMs - 60_000 ? minTs : nowMs - 5 * 3600_000;
    return { startMs: safeStart, endMs: nowMs };
  }

  const targetPools =
    selectedPool !== 'all' ? pools.filter((p) => p.poolKey === selectedPool) : pools;
  const refPools = targetPools.length ? targetPools : pools;
  const isWeekly = selectedWin === 'weekly';
  const winDurationMs = isWeekly ? 7 * 86400_000 : 5 * 3600_000;

  let activeMinResetMs = Infinity;
  let anyMinResetMs = Infinity;
  for (const p of refPools) {
    const rMs = isWeekly ? p.resetWeeklyMs : p.reset5hMs;
    const liveVal = isWeekly ? p.liveWk : p.live5h;
    if (!(rMs > nowMs)) continue;
    if (rMs < anyMinResetMs) anyMinResetMs = rMs;
    if (liveVal !== null && liveVal !== undefined && liveVal < 99.95 && rMs < activeMinResetMs) {
      activeMinResetMs = rMs;
    }
  }
  const chosenResetMs = Number.isFinite(activeMinResetMs)
    ? activeMinResetMs
    : Number.isFinite(anyMinResetMs)
      ? anyMinResetMs
      : 0;
  const startMs = chosenResetMs > nowMs ? chosenResetMs - winDurationMs : nowMs - winDurationMs;
  return { startMs: Math.min(startMs, nowMs - 60_000), endMs: nowMs };
}

/**
 * Extracts per-pool trajectories for the requested window, ensuring `'cycle'` mode
 * strictly excludes pre-reset points from any previous expired cycle (eliminating
 * artificial `84% -> 100%` vertical reset spikes at cycle start).
 */
export function buildQuotaWindowSeries({
  visiblePools,
  rawBounds,
  selectedRange,
  selectedWin,
  nowMs = Date.now(),
}) {
  const isCycleMode = selectedRange === 'cycle';
  const isWeekly = selectedWin === 'weekly';
  const valIdx = isWeekly ? 2 : 1;
  const winDurationMs = isWeekly ? 7 * 86400_000 : 5 * 3600_000;

  const staged = [];
  let hasStartAnchor = false;
  let earliestInWinTs = Infinity;

  for (const p of visiblePools) {
    const cleanedAll = [];
    for (let i = 0; i < p.points.length; i++) {
      const pt = p.points[i];
      const v = pt[valIdx];
      if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
      cleanedAll.push({
        ts: pt[0],
        val: Math.max(0, Math.min(100, Number(v))),
      });
    }
    const sanitized = stripIsolatedImpulseSpikes(cleanedAll);
    if (sanitized.length === 0) continue;

    const pResetMs = isWeekly ? p.resetWeeklyMs : p.reset5hMs;
    const pLiveVal = isWeekly ? p.liveWk : p.live5h;
    const poolCutoffMs =
      isCycleMode && pResetMs > nowMs && pLiveVal !== null && pLiveVal < 99.95
        ? Math.max(rawBounds.startMs, pResetMs - winDurationMs)
        : rawBounds.startMs;

    let carryBefore = null;
    let inWinPts = [];
    for (let i = 0; i < sanitized.length; i++) {
      const sp = sanitized[i];
      if (sp.ts <= poolCutoffMs) {
        carryBefore = sp;
      } else if (sp.ts <= rawBounds.endMs) {
        inWinPts.push(sp);
      }
    }

    // In `'cycle'` mode, `< 99.95%` observations at or before `poolCutoffMs` belong
    // to the previous expired cycle and must never carry forward into the new cycle.
    if (isCycleMode && carryBefore && carryBefore.val < 99.95) {
      carryBefore = null;
    }

    let hadResetInWindow = false;
    if (isCycleMode && inWinPts.length >= 2) {
      let lastResetIdx = 0;
      for (let k = 1; k < inWinPts.length; k++) {
        const prev = inWinPts[k - 1].val;
        const cur = inWinPts[k].val;
        if (cur - prev >= CYCLE_RESET_JUMP_MIN_PCT || (cur >= 99.5 && prev <= 98.5)) {
          lastResetIdx = k;
        }
      }
      if (lastResetIdx > 0) {
        inWinPts = inWinPts.slice(lastResetIdx);
        carryBefore = null;
        hadResetInWindow = true;
      }
    }

    const isMidWindowReset = hadResetInWindow && inWinPts[0].ts - poolCutoffMs > 5 * 60_000;
    const anchorsCycleOrigin =
      isCycleMode &&
      !isMidWindowReset &&
      !carryBefore &&
      inWinPts.length > 0 &&
      inWinPts[0].ts - poolCutoffMs <= 3 * 60_000;

    if (carryBefore || (anchorsCycleOrigin && poolCutoffMs <= rawBounds.startMs + 5000)) {
      hasStartAnchor = true;
    }
    if (inWinPts.length > 0 && inWinPts[0].ts < earliestInWinTs) {
      earliestInWinTs = inWinPts[0].ts;
    }

    staged.push({
      pool: p,
      poolCutoffMs,
      carryBefore,
      inWinPts,
      isMidWindowReset,
      anchorsCycleOrigin,
    });
  }

  let plottedStartMs = rawBounds.startMs;
  if (
    !hasStartAnchor &&
    selectedRange !== 'custom' &&
    Number.isFinite(earliestInWinTs) &&
    earliestInWinTs > rawBounds.startMs
  ) {
    plottedStartMs =
      rawBounds.endMs - earliestInWinTs >= 60_000
        ? earliestInWinTs
        : Math.max(rawBounds.startMs, rawBounds.endMs - 5 * 60_000);
  }
  const plottedEndMs = Math.max(plottedStartMs + 60_000, rawBounds.endMs);

  const rawBuilt = [];
  let dataMin = Infinity;
  let dataMax = -Infinity;

  for (const item of staged) {
    const { pool, poolCutoffMs, carryBefore, inWinPts, isMidWindowReset, anchorsCycleOrigin } = item;
    const seriesPts = [];
    const anchorStartTs = Math.max(plottedStartMs, poolCutoffMs);

    if (carryBefore) {
      seriesPts.push({ ts: anchorStartTs, val: carryBefore.val });
    } else if (anchorsCycleOrigin) {
      const originVal = Math.max(100, inWinPts[0].val);
      if (inWinPts[0].ts > anchorStartTs) {
        seriesPts.push({ ts: anchorStartTs, val: Math.min(100, originVal) });
      }
    } else if (
      !isMidWindowReset &&
      inWinPts.length > 0 &&
      inWinPts[0].ts > plottedStartMs &&
      (inWinPts.length === 1 || inWinPts[0].val >= 99.95)
    ) {
      seriesPts.push({ ts: plottedStartMs, val: inWinPts[0].val });
    }

    for (let i = 0; i < inWinPts.length; i++) {
      const vp = inWinPts[i];
      if (vp.ts >= plottedStartMs) {
        seriesPts.push(vp);
      }
    }

    if (seriesPts.length > 0 && plottedEndMs <= nowMs + 60_000) {
      const tail = seriesPts[seriesPts.length - 1];
      const tailEnd = Math.min(plottedEndMs, nowMs);
      if (tailEnd > tail.ts + 1000) {
        seriesPts.push({ ts: tailEnd, val: tail.val });
      }
    }
    if (seriesPts.length === 0) continue;

    for (let i = 0; i < seriesPts.length; i++) {
      const v = seriesPts[i].val;
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
    rawBuilt.push({
      poolKey: pool.poolKey,
      label: pool.label,
      color: POOL_COLORS[pool.poolKey] || 'var(--accent-primary)',
      rawPoints: seriesPts,
      latestVal: seriesPts[seriesPts.length - 1].val,
    });
  }

  return {
    plottedStartMs,
    plottedEndMs,
    rawBuilt,
    yScale: rawBuilt.length > 0 ? computeAdaptiveQuotaScale(dataMin, dataMax) : null,
  };
}

function getTimeRangeOptions() {
  return [
    { value: 'cycle', label: t('cons.rangeCycle') },
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

function getQuotaWindowOptions() {
  return [
    { value: '5h', label: t('settings.account.win5h') },
    { value: 'weekly', label: t('settings.account.winWeekly') },
  ];
}

export const AccountQuotaTrendCard = defineComponent({
  name: 'AccountQuotaTrendCard',
  setup({ onCleanup }) {
    const VIEW_H = 184;
    const TOP_Y = 18;
    const BOTTOM_Y = 166;
    const SPAN_Y = BOTTOM_Y - TOP_Y;
    const LEFT_X = 1;
    const RIGHT_PAD = 1;

    let viewW = 460;
    let selectedRange = 'cycle';
    let selectedWin = '5h';
    let selectedPool = 'all';
    let selectedAccountEmail = '';

    const initNow = Date.now();
    let customStartMs = floorMinute(initNow - 24 * 3600_000);
    let customEndMs = ceilMinute(initNow);
    let draftStartMs = customStartMs;
    let draftEndMs = customEndMs;

    let latestState = {
      activeEmail: '',
      activePools: [],
      riskAccepted: false,
      accounts: [],
      savedQuotas: new Map(),
      quotaHistory: {},
    };

    let plottedSeries = [];
    let plottedStartMs = 0;
    let plottedEndMs = 0;
    let plottedYScale = { yMin: 0, yMid: 50, yMax: 100, span: 100 };

    const cardTitleText = h('span', { text: t('settings.account.trendTitle') });
    const spanBadgeEl = h('span', { className: 'cons-badge text-mono', text: '' });

    const accountSelect = CustomSelect({
      className: 'cons-cycle-pool-select account-trend-email-select',
      modelValue: '',
      options: [],
      onUpdateModelValue: (val) => {
        selectedAccountEmail = String(val || '').trim().toLowerCase();
        renderChart();
      },
    });
    patchAttr(accountSelect.el, 'hidden', true);

    const poolSelect = CustomSelect({
      className: 'cons-cycle-pool-select',
      modelValue: 'all',
      options: [{ value: 'all', label: t('cons.cyclePoolAll') }],
      onUpdateModelValue: (val) => {
        selectedPool = val || 'all';
        renderChart();
      },
    });

    const winSwitch = SegmentedControl({
      ariaLabel: t('settings.account.trendWinAria'),
      modelValue: selectedWin,
      options: getQuotaWindowOptions(),
      onUpdateModelValue: (val) => {
        selectedWin = val === 'weekly' ? 'weekly' : '5h';
        winSwitch.setProps({ modelValue: selectedWin, options: getQuotaWindowOptions() });
        renderChart();
      },
    });

    const rangeSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: selectedRange,
      options: getTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        selectedRange = nextRange || 'cycle';
        if (selectedRange === 'custom') {
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        }
        rangeSwitch.setProps({ modelValue: selectedRange, options: getTimeRangeOptions() });
        renderChart();
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        startPicker.setValue(ms);
      },
    });
    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        endPicker.setValue(ms);
      },
    });
    const applyCustomLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        onClick: () => {
          const s = Number(draftStartMs || 0);
          const e = Number(draftEndMs || 0);
          const lo = floorMinute(s > 0 && e > 0 ? Math.min(s, e) : s);
          const hi = ceilMinute(s > 0 && e > 0 ? Math.max(s, e) : e);
          if (lo > 0 && hi > lo) {
            customStartMs = lo;
            customEndMs = hi;
            draftStartMs = lo;
            draftEndMs = hi;
            startPicker.setValue(lo);
            endPicker.setValue(hi);
            renderChart();
          }
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomLabel]
    );
    const rangeToEl = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h('div', { className: 'cons-custom-range-bar', hidden: true }, [
      startPicker.el,
      rangeToEl,
      endPicker.el,
      applyCustomBtn,
    ]);

    // --- Full-Bleed Edge-to-Edge 184px SVG Stage (reusing TrendAreaChart `.trend-svg`) ---
    const uid = ++quotaChartUid;
    const gradId = `acct-quota-grad-${uid}`;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
    svg.setAttribute('class', 'trend-svg');
    svg.setAttribute('aria-hidden', 'true');

    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    const stopTop = document.createElementNS(SVG_NS, 'stop');
    stopTop.setAttribute('offset', '0%');
    stopTop.setAttribute('stop-color', 'var(--accent-primary)');
    stopTop.setAttribute('stop-opacity', '0.24');
    const stopBot = document.createElementNS(SVG_NS, 'stop');
    stopBot.setAttribute('offset', '100%');
    stopBot.setAttribute('stop-color', 'var(--accent-primary)');
    stopBot.setAttribute('stop-opacity', '0.0');
    grad.appendChild(stopTop);
    grad.appendChild(stopBot);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const gridGroup = document.createElementNS(SVG_NS, 'g');
    gridGroup.setAttribute('class', 'trend-grid');
    const gridRowSpecs = [
      { y: TOP_Y, dy: 3, labeled: true },
      { y: Math.round(TOP_Y + SPAN_Y * 0.25), dy: 0, labeled: false },
      { y: Math.round(TOP_Y + SPAN_Y * 0.5), dy: 3, labeled: true },
      { y: Math.round(TOP_Y + SPAN_Y * 0.75), dy: 0, labeled: false },
      { y: BOTTOM_Y, dy: -3, labeled: true },
    ];
    const gridLines = [];
    const yLabels = [];
    for (const row of gridRowSpecs) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(row.y));
      line.setAttribute('x2', String(viewW));
      line.setAttribute('y2', String(row.y));
      gridGroup.appendChild(line);
      gridLines.push(line);

      if (row.labeled) {
        const lbl = document.createElementNS(SVG_NS, 'text');
        lbl.setAttribute('class', 'sstep-axis-label is-y-inline');
        lbl.setAttribute('x', '3');
        lbl.setAttribute('y', String(row.y + row.dy));
        lbl.setAttribute('text-anchor', 'start');
        yLabels.push(lbl);
      }
    }
    svg.appendChild(gridGroup);

    const seriesGroup = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(seriesGroup);

    // Append inline Y labels above series fills so halo stroke keeps text crisp
    const yLabelOverlay = document.createElementNS(SVG_NS, 'g');
    for (const lbl of yLabels) {
      yLabelOverlay.appendChild(lbl);
    }
    svg.appendChild(yLabelOverlay);

    const hoverLine = document.createElementNS(SVG_NS, 'line');
    hoverLine.setAttribute('class', 'trend-hover-line');
    hoverLine.setAttribute('y1', String(TOP_Y));
    hoverLine.setAttribute('y2', String(BOTTOM_Y));
    hoverLine.setAttribute('hidden', '');
    svg.appendChild(hoverLine);

    const hoverDotsGroup = document.createElementNS(SVG_NS, 'g');
    hoverDotsGroup.setAttribute('hidden', '');
    svg.appendChild(hoverDotsGroup);

    const tipTimeEl = h('span', { className: 'trend-tip-time text-mono' });
    const tipWinEl = h('span', { className: 'trend-tip-calls' });
    const tipRowsHost = h('div', { className: 'account-trend-tip-rows' });
    const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
      h('div', { className: 'trend-tip-head' }, [tipTimeEl, tipWinEl]),
      tipRowsHost,
    ]);

    const xAxisEl = h('div', { className: 'trend-x-axis' });
    const legendRowEl = h('div', { className: 'account-trend-legend' });
    const emptyStateEl = h('div', { className: 'smodel-empty settings-action-desc', hidden: true });

    const plotStage = h(
      'div',
      {
        className: 'trend-plot-stage',
        onPointermove: handlePointerMove,
        onPointerleave: hideHover,
      },
      [svg, tooltipEl]
    );
    const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
      plotStage,
      xAxisEl,
      legendRowEl,
    ]);

    const rootEl = h('section', { className: 'panel account-quota-trend-panel' }, [
      h('div', { className: 'panel-header account-trend-toprow' }, [
        h('span', { className: 'panel-title cons-overview-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          cardTitleText,
          accountSelect.el,
          poolSelect.el,
        ]),
        winSwitch.el,
      ]),
      h('div', { className: 'panel-header cons-overview-head account-trend-subbar' }, [
        spanBadgeEl,
        h('div', { className: 'cons-overview-controls' }, [rangeSwitch.el]),
      ]),
      customRangeBar,
      chartWrap,
      emptyStateEl,
    ]);

    function valueToSvgY(val) {
      const clamped = Math.max(plottedYScale.yMin, Math.min(plottedYScale.yMax, val));
      return BOTTOM_Y - ((clamped - plottedYScale.yMin) / plottedYScale.span) * SPAN_Y;
    }

    function hideHover() {
      hoverLine.setAttribute('hidden', '');
      hoverDotsGroup.setAttribute('hidden', '');
      patchAttr(tooltipEl, 'hidden', true);
    }

    function sampleSeriesValueAt(points, targetMs) {
      if (!points.length) return null;
      if (targetMs < points[0].ts - 1000) return null;
      if (targetMs <= points[0].ts) return points[0].val;
      const last = points[points.length - 1];
      if (targetMs > last.ts + 60_000) return null;
      if (targetMs >= last.ts) return last.val;
      let lo = 0;
      let hi = points.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].ts <= targetMs) lo = mid;
        else hi = mid;
      }
      const a = points[lo];
      const b = points[hi];
      const span = b.ts - a.ts;
      if (span <= 0) return b.val;
      return a.val + (b.val - a.val) * ((targetMs - a.ts) / span);
    }

    function handlePointerMove(ev) {
      if (!plottedSeries.length || !(plottedEndMs > plottedStartMs)) {
        hideHover();
        return;
      }
      const rect = svg.getBoundingClientRect?.();
      const widthPx = Number(rect?.width || viewW);
      if (!(widthPx > 0)) return;
      const offsetX = Number(ev.clientX || 0) - Number(rect?.left || 0);
      const svgX = (offsetX / widthPx) * viewW;
      const plotW = Math.max(20, viewW - LEFT_X - RIGHT_PAD);
      const u = Math.max(0, Math.min(1, (svgX - LEFT_X) / plotW));
      const clampedX = LEFT_X + u * plotW;
      const targetMs = Math.round(plottedStartMs + u * (plottedEndMs - plottedStartMs));

      hoverLine.setAttribute('x1', clampedX.toFixed(1));
      hoverLine.setAttribute('x2', clampedX.toFixed(1));

      while (hoverDotsGroup.firstChild) hoverDotsGroup.removeChild(hoverDotsGroup.firstChild);
      const tipItems = [];
      for (let i = 0; i < plottedSeries.length; i++) {
        const s = plottedSeries[i];
        const val = sampleSeriesValueAt(s.rawPoints, targetMs);
        if (val === null) continue;
        const y = valueToSvgY(val);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', clampedX.toFixed(1));
        dot.setAttribute('cy', y.toFixed(1));
        dot.setAttribute('r', '3.2');
        dot.setAttribute('fill', 'var(--surface-panel)');
        dot.setAttribute('stroke', s.color);
        dot.setAttribute('stroke-width', '1.8');
        hoverDotsGroup.appendChild(dot);
        tipItems.push({ key: s.poolKey, label: s.label, color: s.color, val });
      }
      if (tipItems.length === 0) {
        hideHover();
        return;
      }
      hoverLine.removeAttribute('hidden');
      hoverDotsGroup.removeAttribute('hidden');

      patchText(tipTimeEl, formatHoverTimestamp(targetMs));
      patchText(tipWinEl, t(selectedWin === 'weekly' ? 'settings.account.winWeekly' : 'settings.account.win5h'));
      patchKeyedList(tipRowsHost, tipItems, {
        keyFn: (it) => it.key,
        sigFn: (it) => `${it.label}:${it.val.toFixed(1)}`,
        createRow: () => {
          const sw = h('span', { className: 'dot-swatch' });
          const nm = h('span', { className: 'account-trend-tip-name' });
          const vl = h('strong', { className: 'text-mono' });
          const row = h('div', { className: 'account-trend-tip-row' }, [
            h('span', { className: 'legend-left' }, [sw, nm]),
            vl,
          ]);
          return { el: row, refs: { sw, nm, vl } };
        },
        updateRow: (r, it) => {
          r.sw.style.background = it.color;
          patchText(r.nm, it.label);
          patchText(r.vl, `${+it.val.toFixed(1)}%`);
        },
      });

      const pctX = (clampedX / viewW) * 100;
      const shift = pctX < 24 ? '0%' : pctX > 76 ? '-100%' : '-50%';
      patchStyleVar(tooltipEl, '--tip-x', `${pctX.toFixed(1)}%`);
      patchStyleVar(tooltipEl, '--tip-shift', shift);
      patchAttr(tooltipEl, 'hidden', false);
    }

    function resolveTargetAccountEmail() {
      const { activeEmail, riskAccepted, accounts } = latestState;
      if (!riskAccepted) {
        return activeEmail || '';
      }
      const candidates = [];
      if (activeEmail) candidates.push(activeEmail);
      for (const addr of accounts) {
        if (addr && !candidates.includes(addr)) candidates.push(addr);
      }
      if (selectedAccountEmail && candidates.includes(selectedAccountEmail)) {
        return selectedAccountEmail;
      }
      selectedAccountEmail = candidates[0] || '';
      return selectedAccountEmail;
    }

    function buildMergedPoolsForEmail(email, nowMs) {
      const histPools = latestState.quotaHistory?.[email]?.pools || {};
      const livePools =
        email && email === latestState.activeEmail
          ? latestState.activePools || []
          : latestState.savedQuotas.get(email)?.pools || [];

      const merged = new Map();
      for (const [pk, hEntry] of Object.entries(histPools)) {
        merged.set(pk, {
          poolKey: pk,
          label: hEntry.label || pk,
          reset5hMs: Number(hEntry.reset5hMs) || 0,
          resetWeeklyMs: Number(hEntry.resetWeeklyMs) || 0,
          points: Array.isArray(hEntry.points) ? hEntry.points.slice() : [],
          live5h: null,
          liveWk: null,
        });
      }

      for (const lp of livePools) {
        const pk = String(lp?.poolKey || lp?.family || lp?.poolLabel || '').trim();
        if (!pk || pk === 'Unknown') continue;
        let item = merged.get(pk);
        if (!item) {
          item = {
            poolKey: pk,
            label: String(lp?.poolLabel || pk),
            reset5hMs: 0,
            resetWeeklyMs: 0,
            points: [],
            live5h: null,
            liveWk: null,
          };
          merged.set(pk, item);
        }
        if (lp?.poolLabel) item.label = String(lp.poolLabel);
        const r5Ms = Date.parse(lp?.resetTime || '');
        const rWMs = Date.parse(lp?.weeklyResetTime || '');
        if (Number.isFinite(r5Ms) && r5Ms > 0) item.reset5hMs = r5Ms;
        if (Number.isFinite(rWMs) && rWMs > 0) item.resetWeeklyMs = rWMs;
        if (Number.isFinite(lp?.remainingPct)) item.live5h = +Number(lp.remainingPct).toFixed(1);
        if (Number.isFinite(lp?.weeklyRemainingPct)) {
          item.liveWk = +Number(lp.weeklyRemainingPct).toFixed(1);
        }
        if (item.live5h !== null || item.liveWk !== null) {
          const last = item.points[item.points.length - 1];
          if (!last || nowMs >= last[0]) {
            item.points.push([
              nowMs,
              item.live5h ?? (last ? last[1] : null),
              item.liveWk ?? (last ? last[2] : null),
            ]);
          }
        }
      }

      return Array.from(merged.values()).sort(
        (a, b) =>
          (POOL_ORDER.indexOf(a.poolKey) === -1 ? 99 : POOL_ORDER.indexOf(a.poolKey)) -
          (POOL_ORDER.indexOf(b.poolKey) === -1 ? 99 : POOL_ORDER.indexOf(b.poolKey))
      );
    }

    function renderChart() {
      hideHover();
      const nowMs = Date.now();
      void getEffectiveLocale();

      patchText(cardTitleText, t('settings.account.trendTitle'));
      patchText(rangeToEl, t('cons.rangeTo'));
      patchText(applyCustomLabel, t('cons.applyFilter'));
      winSwitch.setProps({ modelValue: selectedWin, options: getQuotaWindowOptions() });
      rangeSwitch.setProps({ modelValue: selectedRange, options: getTimeRangeOptions() });
      patchAttr(customRangeBar, 'hidden', selectedRange !== 'custom');

      const targetEmail = resolveTargetAccountEmail();
      const candidateEmails = [];
      if (latestState.activeEmail) candidateEmails.push(latestState.activeEmail);
      if (latestState.riskAccepted) {
        for (const addr of latestState.accounts) {
          if (addr && !candidateEmails.includes(addr)) candidateEmails.push(addr);
        }
      }
      const showAccountPicker = latestState.riskAccepted && candidateEmails.length > 1;
      patchAttr(accountSelect.el, 'hidden', !showAccountPicker);
      if (showAccountPicker) {
        accountSelect.setProps({
          modelValue: targetEmail,
          options: candidateEmails.map((addr) => ({
            value: addr,
            label: addr.split('@')[0] || addr,
            title: addr,
          })),
        });
      }

      const mergedPools = targetEmail ? buildMergedPoolsForEmail(targetEmail, nowMs) : [];
      if (selectedPool !== 'all' && !mergedPools.some((p) => p.poolKey === selectedPool)) {
        selectedPool = 'all';
      }
      const poolOpts = [
        {
          value: 'all',
          label: t('cons.cyclePoolAll'),
        },
        ...mergedPools.map((p) => ({
          value: p.poolKey,
          label: p.poolKey === 'Claude & GPT' ? 'Claude/GPT' : p.label,
          title: p.label,
        })),
      ];
      poolSelect.setProps({ modelValue: selectedPool, options: poolOpts });
      patchAttr(poolSelect.el, 'hidden', mergedPools.length <= 1);

      const rawBounds = resolveQuotaWindowBounds({
        pools: mergedPools,
        selectedRange,
        selectedWin,
        selectedPool,
        customStartMs,
        customEndMs,
        nowMs,
      });
      const visiblePools =
        selectedPool === 'all'
          ? mergedPools
          : mergedPools.filter((p) => p.poolKey === selectedPool);

      const built = buildQuotaWindowSeries({
        visiblePools,
        rawBounds,
        selectedRange,
        selectedWin,
        nowMs,
      });
      plottedStartMs = built.plottedStartMs;
      plottedEndMs = built.plottedEndMs;
      const spanMs = plottedEndMs - plottedStartMs;
      patchText(spanBadgeEl, formatDateSpanBadge(plottedStartMs, plottedEndMs));

      const rawBuilt = built.rawBuilt;
      const hasPlot = rawBuilt.length > 0;
      patchAttr(chartWrap, 'hidden', !hasPlot);
      patchAttr(emptyStateEl, 'hidden', hasPlot);
      if (!hasPlot) {
        plottedSeries = [];
        patchText(emptyStateEl, t('settings.account.trendEmpty'));
        return;
      }

      plottedYScale = built.yScale;
      yLabels[0].textContent = `${plottedYScale.yMax}%`;
      yLabels[1].textContent = `${plottedYScale.yMid}%`;
      yLabels[2].textContent = `${plottedYScale.yMin}%`;

      const plotW = Math.max(20, viewW - LEFT_X - RIGHT_PAD);
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const gl of gridLines) {
        gl.setAttribute('x2', String(viewW));
      }

      plottedSeries = rawBuilt.map((rb) => ({
        ...rb,
        svgPts: rb.rawPoints.map((sp) => {
          const u = Math.max(0, Math.min(1, (sp.ts - plottedStartMs) / spanMs));
          return {
            x: LEFT_X + u * plotW,
            y: valueToSvgY(sp.val),
            val: sp.val,
            ts: sp.ts,
          };
        }),
      }));

      while (seriesGroup.firstChild) seriesGroup.removeChild(seriesGroup.firstChild);
      for (let i = 0; i < plottedSeries.length; i++) {
        const s = plottedSeries[i];
        const lineD = buildHorizontalTangentSpline(s.svgPts);
        if (s.svgPts.length >= 2) {
          const first = s.svgPts[0];
          const last = s.svgPts[s.svgPts.length - 1];
          const areaEl = document.createElementNS(SVG_NS, 'path');
          areaEl.setAttribute(
            'd',
            `${lineD} L ${last.x.toFixed(1)} ${BOTTOM_Y} L ${first.x.toFixed(1)} ${BOTTOM_Y} Z`
          );
          if (plottedSeries.length === 1) {
            stopTop.setAttribute('stop-color', s.color);
            stopBot.setAttribute('stop-color', s.color);
            areaEl.setAttribute('fill', `url(#${gradId})`);
          } else {
            areaEl.setAttribute('class', 'sstep-multi-area');
            areaEl.style.setProperty('--sstep-series-color', s.color);
          }
          seriesGroup.appendChild(areaEl);
        }
        const pathEl = document.createElementNS(SVG_NS, 'path');
        pathEl.setAttribute('d', lineD);
        pathEl.setAttribute('fill', 'none');
        pathEl.setAttribute('stroke', s.color);
        pathEl.setAttribute('stroke-width', '1.9');
        pathEl.setAttribute('stroke-linecap', 'round');
        seriesGroup.appendChild(pathEl);

        const endPt = s.svgPts[s.svgPts.length - 1];
        const endDot = document.createElementNS(SVG_NS, 'circle');
        endDot.setAttribute('cx', endPt.x.toFixed(1));
        endDot.setAttribute('cy', endPt.y.toFixed(1));
        endDot.setAttribute('r', '2.7');
        endDot.setAttribute('fill', s.color);
        seriesGroup.appendChild(endDot);
      }

      // Edge-to-edge X-axis ticks (`0% .. 100%`)
      const tickCount = 5;
      const ticks = [];
      for (let k = 0; k < tickCount; k++) {
        const ratio = k / (tickCount - 1);
        const tickMs = Math.round(plottedStartMs + ratio * spanMs);
        const leftPct = ratio * 100;
        ticks.push({
          idx: k,
          leftPct,
          label: formatAxisTickTime(tickMs, spanMs),
          edge: k === 0 ? 'start' : k === tickCount - 1 ? 'end' : '',
        });
      }
      patchKeyedList(xAxisEl, ticks, {
        keyFn: (tk) => tk.idx,
        sigFn: (tk) => `${tk.leftPct.toFixed(1)}:${tk.label}:${tk.edge}`,
        createRow: () => {
          const el = h('span', { className: 'trend-x-tick text-mono' });
          return { el, refs: { el } };
        },
        updateRow: (r, tk) => {
          patchText(r.el, tk.label);
          patchStyleVar(r.el, '--tick-x', `${tk.leftPct.toFixed(2)}%`);
          patchClasses(r.el, {
            'is-start': tk.edge === 'start',
            'is-end': tk.edge === 'end',
          });
        },
      });

      patchKeyedList(legendRowEl, plottedSeries, {
        keyFn: (s) => s.poolKey,
        sigFn: (s) => `${s.label}:${s.latestVal.toFixed(1)}:${s.color}`,
        createRow: () => {
          const sw = h('span', { className: 'dot-swatch' });
          const nm = h('span', { className: 'account-trend-leg-name' });
          const vl = h('strong', { className: 'text-mono' });
          const el = h('span', { className: 'account-trend-leg-item' }, [sw, nm, vl]);
          return { el, refs: { sw, nm, vl } };
        },
        updateRow: (r, s) => {
          r.sw.style.background = s.color;
          patchText(r.nm, s.label);
          patchText(r.vl, `${+s.latestVal.toFixed(1)}%`);
        },
      });
    }

    let resizeObs = null;
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver((entries) => {
        const w = Math.floor(Number(entries?.[0]?.contentRect?.width || 0));
        if (w >= 180 && Math.abs(w - viewW) >= 2) {
          viewW = w;
          renderChart();
        }
      });
      resizeObs.observe(plotStage);
    }

    onCleanup(() => {
      resizeObs?.disconnect();
      accountSelect.destroy();
      poolSelect.destroy();
      winSwitch.destroy();
      rangeSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
    });

    function update(nextState) {
      latestState = { ...latestState, ...nextState };
      renderChart();
    }

    renderChart();
    return {
      el: rootEl,
      refs: { update, refreshLabels: renderChart },
    };
  },
});
