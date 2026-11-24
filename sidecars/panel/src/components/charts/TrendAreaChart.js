/**
 * @fileoverview 交互式历史用量趋势图组件 (TrendAreaChart).
 * 支持双模式自适应切换：
 * 1. <= 90 天（或整点小时分桶）：渲染三次贝塞尔平滑曲线面积图、峰值气泡与对齐多刻度时间轴；
 * 2. > 90 天（自然日分桶）：自动切换为类 GitHub 贡献日历的小格子热力排列（一格一天，7 行星期 × 周列、月份刻度、分位数 5 档热力色阶与底部图例）；
 * 3. 两种模式共享自适应防溢出的悬浮详情卡片（精确日期/小时区间、Token 拆分、费用与调用次数）。
 */

import {
  h,
  patchAttr,
  patchClasses,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import {
  formatTokensPrecise,
  formatTrendSlotFullLabel,
  formatUsd,
} from '../../core/formatters.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { createConsumptionBreakdownContent } from '../ui/ConsumptionTooltipContent.js';

/** 超过该自然日天数（> 90 天）时，趋势图切换为类 GitHub 每日小格子热力图 */
export const HEATMAP_DAYS_THRESHOLD = 90;

let chartUidCounter = 0;

function safeSlotTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 将二维采样点序列转换为水平张力平滑的三次贝塞尔曲线 SVG 路径 (`M ... C ...`)。
 * 控制点沿 X 轴取相邻点间距的 `0.42` 张力系数，Y 轴与各自端点齐平，
 * 保证曲线在极值点处平缓过渡且不会产生上下过冲 (Overshoot)。
 *
 * @param {Array<{ x: number, y: number }>} points SVG 坐标系下的采样点数组（长度 >= 2）
 * @returns {string} SVG `<path>` 的 `d` 属性字符串
 */
function buildSmoothSplinePath(points) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.42;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.42;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 将采样点数组转为归一化横轴 `u` (`0..1`) 上的精确三次贝塞尔分段链，
 * 控制点严格保持跟 `buildSmoothSplinePath` 一致的 `0.42` 水平张力。
 *
 * @param {Array<{ y: number }>} pts
 * @param {number} bottomY
 * @returns {Array<{ u0: number, y0: number, cu1: number, cy1: number, cu2: number, cy2: number, u3: number, y3: number }>}
 */
function pointsToNormalizedCubicSegs(pts, bottomY) {
  const n = pts.length;
  if (n === 0) {
    return [
      { u0: 0, y0: bottomY, cu1: 0.42, cy1: bottomY, cu2: 0.58, cy2: bottomY, u3: 1, y3: bottomY },
    ];
  }
  if (n === 1) {
    const py = pts[0].y;
    if (Math.abs(py - bottomY) < 0.01) {
      return [
        { u0: 0, y0: bottomY, cu1: 0.42, cy1: bottomY, cu2: 0.58, cy2: bottomY, u3: 1, y3: bottomY },
      ];
    }
    return [
      { u0: 0, y0: bottomY, cu1: 0.21, cy1: bottomY, cu2: 0.29, cy2: py, u3: 0.5, y3: py },
      { u0: 0.5, y0: py, cu1: 0.71, cy1: py, cu2: 0.79, cy2: bottomY, u3: 1, y3: bottomY },
    ];
  }
  const segs = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const u0 = i / (n - 1);
    const u3 = (i + 1) / (n - 1);
    const du = u3 - u0;
    const y0 = pts[i].y;
    const y3 = pts[i + 1].y;
    segs[i] = {
      u0,
      y0,
      cu1: u0 + du * 0.42,
      cy1: y0,
      cu2: u3 - du * 0.42,
      cy2: y3,
      u3,
      y3,
    };
  }
  return segs;
}

function solveCubicParamForU(seg, targetU) {
  if (targetU <= seg.u0) return 0;
  if (targetU >= seg.u3) return 1;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 20; it++) {
    const s = (lo + hi) * 0.5;
    const inv = 1 - s;
    const u =
      inv * inv * inv * seg.u0 +
      3 * inv * inv * s * seg.cu1 +
      3 * inv * s * s * seg.cu2 +
      s * s * s * seg.u3;
    if (u < targetU) lo = s;
    else hi = s;
  }
  return (lo + hi) * 0.5;
}

function splitCubicAt(seg, s) {
  const u01 = seg.u0 + (seg.cu1 - seg.u0) * s;
  const y01 = seg.y0 + (seg.cy1 - seg.y0) * s;
  const u12 = seg.cu1 + (seg.cu2 - seg.cu1) * s;
  const y12 = seg.cy1 + (seg.cy2 - seg.cy1) * s;
  const u23 = seg.cu2 + (seg.u3 - seg.cu2) * s;
  const y23 = seg.cy2 + (seg.y3 - seg.cy2) * s;

  const u012 = u01 + (u12 - u01) * s;
  const y012 = y01 + (y12 - y01) * s;
  const u123 = u12 + (u23 - u12) * s;
  const y123 = y12 + (y23 - y12) * s;

  const u0123 = u012 + (u123 - u012) * s;
  const y0123 = y012 + (y123 - y012) * s;

  return [
    { u0: seg.u0, y0: seg.y0, cu1: u01, cy1: y01, cu2: u012, cy2: y012, u3: u0123, y3: y0123 },
    { u0: u0123, y0: y0123, cu1: u123, cy1: y123, cu2: u23, cy2: y23, u3: seg.u3, y3: seg.y3 },
  ];
}

function extractCubicSubsegment(seg, uStart, uEnd) {
  const s0 = solveCubicParamForU(seg, uStart);
  const s1 = solveCubicParamForU(seg, uEnd);
  if (s0 <= 1e-7 && s1 >= 1 - 1e-7) return { ...seg };
  const [, right] = s0 <= 1e-7 ? [null, seg] : splitCubicAt(seg, s0);
  const remSpan = 1 - s0;
  const localS1 = remSpan > 1e-9 ? Math.min(1, Math.max(0, (s1 - s0) / remSpan)) : 1;
  const [sub] = localS1 >= 1 - 1e-7 ? [right] : splitCubicAt(right, localS1);
  sub.u0 = uStart;
  sub.u3 = uEnd;
  return sub;
}

/**
 * 合并两条贝塞尔链的断点（始终完整保留目标链 `toSegs` 全部断点，保证 `t=1` 零几何误差）。
 */
function mergeNormalizedKnots(fromSegs, toSegs) {
  const raw = [0, 1];
  for (let i = 0; i < toSegs.length; i++) raw.push(toSegs[i].u3);
  if (fromSegs.length <= 64) {
    for (let i = 0; i < fromSegs.length; i++) raw.push(fromSegs[i].u3);
  } else {
    const stride = Math.ceil(fromSegs.length / 48);
    for (let i = 0; i < fromSegs.length; i += stride) raw.push(fromSegs[i].u3);
  }
  raw.sort((a, b) => a - b);
  const uniq = [0];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] - uniq[uniq.length - 1] > 1e-6) {
      uniq.push(raw[i]);
    }
  }
  uniq[uniq.length - 1] = 1;
  return uniq;
}

function subdivideChainToKnots(segs, knots) {
  const out = new Array(knots.length - 1);
  let j = 0;
  for (let k = 0; k < knots.length - 1; k++) {
    const a = knots[k];
    const b = knots[k + 1];
    const mid = (a + b) * 0.5;
    while (j < segs.length - 1 && segs[j].u3 < mid) j++;
    out[k] = extractCubicSubsegment(segs[j], a, b);
  }
  return out;
}

function buildPathFromNormalizedSegs(segs, leftX, spanX) {
  const xAt = (u) => (leftX + u * spanX).toFixed(1);
  let d = `M ${xAt(segs[0].u0)} ${segs[0].y0.toFixed(1)}`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    d += ` C ${xAt(s.cu1)} ${s.cy1.toFixed(1)}, ${xAt(s.cu2)} ${s.cy2.toFixed(1)}, ${xAt(s.u3)} ${s.y3.toFixed(1)}`;
  }
  return d;
}

/**
 * 求解标准 CSS `cubic-bezier(x1, y1, x2, y2)` 在进度 `t` (`0..1`) 处的精确输出值，
 * 确保 JS 曲线形变、峰值胶囊滑动及进度条宽度缩放严格同频。
 */
function evalCubicBezier(x1, y1, x2, y2, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const s = (lo + hi) * 0.5;
    const inv = 1 - s;
    const bx = 3 * inv * inv * s * x1 + 3 * inv * s * s * x2 + s * s * s;
    if (bx < t) lo = s;
    else hi = s;
  }
  const s = (lo + hi) * 0.5;
  const inv = 1 - s;
  return 3 * inv * inv * s * y1 + 3 * inv * s * s * y2 + s * s * s;
}

/**
 * 根据分桶总数及标签平均长度，计算底部 X 轴应当展示的均匀刻度下标列表。
 *
 * @param {Array<{ label?: string }>} slots
 * @returns {number[]}
 */
function computeTickIndices(slots) {
  const n = slots.length;
  if (n <= 1) return [0];
  const sampleLabel = String(slots[Math.floor(n / 2)]?.label || slots[0]?.label || '');
  const maxDirectTicks = sampleLabel.length > 6 ? 5 : 8;
  if (n <= maxDirectTicks) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const maxTicks = sampleLabel.length > 6 ? 5 : 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    const idx = Math.round((k / (maxTicks - 1)) * (n - 1));
    set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 基于非零活跃日的分位数阈值计算热力图 5 档色阶（0 ~ 4），避免单日极端峰值压缩其余活跃日的层次对比。
 *
 * @param {number[]} nonZeroValues 已升序排列的正数 Token 列表
 * @param {number} maxTokens
 * @returns {{ q1: number, q2: number, q3: number, maxTokens: number, count: number }}
 */
function computeHeatmapThresholds(nonZeroValues, maxTokens) {
  const n = nonZeroValues.length;
  if (n === 0 || maxTokens <= 0) {
    return { q1: 0, q2: 0, q3: 0, maxTokens: 0, count: 0 };
  }
  if (n < 4) {
    return {
      q1: maxTokens * 0.25,
      q2: maxTokens * 0.5,
      q3: maxTokens * 0.75,
      maxTokens,
      count: n,
    };
  }
  return {
    q1: nonZeroValues[Math.floor((n - 1) * 0.25)],
    q2: nonZeroValues[Math.floor((n - 1) * 0.5)],
    q3: nonZeroValues[Math.floor((n - 1) * 0.75)],
    maxTokens,
    count: n,
  };
}

function resolveHeatmapLevel(tokens, thresholds) {
  if (tokens <= 0 || thresholds.maxTokens <= 0) return 0;
  if (tokens >= thresholds.maxTokens || tokens > thresholds.q3) return 4;
  if (tokens > thresholds.q2) return 3;
  if (tokens > thresholds.q1) return 2;
  return 1;
}

/**
 * 解析日期槽位的年份与月份信息（兼容真实时间戳 `startMs` 与测试简写 `label`）。
 *
 * @param {object} slot
 * @returns {{ year: number, month: number, day: number }}
 */
function parseSlotCalendarParts(slot) {
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const d = new Date(sMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = String(slot?.label || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { year: new Date().getFullYear(), month: Number(m[1]), day: Number(m[2]) };
  }
  return { year: new Date().getFullYear(), month: 0, day: 0 };
}

/**
 * 构建热力图顶部与周列对齐的月份刻度标签（自动跳过首尾过窄残月，防止相邻月份文字重叠）。
 *
 * @param {Array<object>} slots
 * @param {number} firstDow 首日对应的星期行索引（0 = 周一 .. 6 = 周日）
 * @param {number} totalWeeks 总周列数
 * @returns {Array<{ col: number, text: string }>}
 */
function buildHeatmapMonthTicks(slots, firstDow, totalWeeks) {
  if (!slots.length || totalWeeks <= 0) return [];
  const firstParts = parseSlotCalendarParts(slots[0]);
  const lastParts = parseSlotCalendarParts(slots[slots.length - 1]);
  const crossYear = firstParts.year !== lastParts.year;

  const candidates = [];
  let prevMonthKey = '';

  for (let col = 0; col < totalWeeks; col++) {
    let chosenParts = null;
    for (let row = 0; row < 7; row++) {
      const idx = col * 7 + row - firstDow;
      if (idx < 0 || idx >= slots.length) continue;
      const parts = parseSlotCalendarParts(slots[idx]);
      if (!parts.month) continue;
      const mKey = `${parts.year}-${parts.month}`;
      if (col === 0 && !chosenParts) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
      if (mKey !== prevMonthKey) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
    }
    if (chosenParts && chosenParts.month > 0) {
      candidates.push({ col, year: chosenParts.year, month: chosenParts.month });
    }
  }

  const baseMinGap = totalWeeks > 40 ? 4 : 3;
  if (
    candidates.length >= 2 &&
    candidates[0].col === 0 &&
    candidates[1].col - candidates[0].col < baseMinGap
  ) {
    candidates.shift();
  }

  const ticks = [];
  let nextAllowedCol = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (totalWeeks > 16 && c.col >= totalWeeks - 1) continue;
    if (ticks.length > 0 && c.col < nextAllowedCol) continue;
    const showYear = crossYear && (c.month === 1 || ticks.length === 0);
    const text = showYear
      ? t('chart.trend.hmMonthYear', { yy: String(c.year).slice(-2), month: c.month })
      : t('chart.trend.hmMonthOnly', { month: c.month });
    ticks.push({ col: c.col, text });
    nextAllowedCol = c.col + (showYear ? baseMinGap + 1 : baseMinGap);
  }
  return ticks;
}

/**
 * 创建交互式历史趋势组件（<=90 天为 SVG 平滑曲线图，>90 天自动切换为类 GitHub 每日小格子热力图）。
 *
 * @param {{ onSelectSlot?: (slot: object) => void }} [options]
 * @returns {{
 *   el: HTMLElement,
 *   update: (series?: Array<object>) => void,
 *   destroy: () => void
 * }}
 */
export function createTrendAreaChart({ onSelectSlot = null } = {}) {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 184;
  const TOP_Y = 26;
  const BOTTOM_Y = 164;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'trend-svg');
  svg.setAttribute('aria-hidden', 'true');

  // 垂直线性渐变（每实例独立 ID，避免多图表挂载时 SVG url(#...) 冲突）
  const gradId = `trend-area-grad-${++chartUidCounter}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.34');

  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');

  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 背景水平与垂直参考网格线（水平网格全宽贴边铺满 0..viewW）
  const hGridGroup = document.createElementNS(SVG_NS, 'g');
  hGridGroup.setAttribute('class', 'trend-grid');
  const hGridLines = [];
  for (const y of [
    TOP_Y,
    Math.round(TOP_Y + SPAN_Y / 3),
    Math.round(TOP_Y + (SPAN_Y * 2) / 3),
    BOTTOM_Y,
  ]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    hGridGroup.appendChild(line);
    hGridLines.push(line);
  }
  svg.appendChild(hGridGroup);

  const vGridGroup = document.createElementNS(SVG_NS, 'g');
  vGridGroup.setAttribute('class', 'trend-grid trend-v-grid');
  svg.appendChild(vGridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  // 悬停十字准星及焦点圆点
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '12');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.2');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', text: '0' });

  // 共享悬停详情浮层卡片（曲线图和热力格子图共用，含分模型四段进度条及底部四通道明细）
  const tooltipContent = createConsumptionBreakdownContent({
    showModelDot: false,
    monoTitle: true,
  });

  const tooltipEl = h(
    'div',
    { className: 'trend-tooltip is-rich-breakdown', hidden: true },
    tooltipContent.children
  );

  // 底部对齐刻度轴（曲线模式）
  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const plotStage = h(
    'div',
    { className: `trend-plot-stage${typeof onSelectSlot === 'function' ? ' is-clickable' : ''}` },
    [peakPill, svg]
  );

  // 类 GitHub 每日小格子热力图容器（> 90 天模式）
  const wdayMonEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayMon') });
  const wdayWedEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayWed') });
  const wdayFriEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayFri') });
  const wdaySunEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdaySun') });
  const hmWeekdaysEl = h('div', { className: 'trend-hm-weekdays', 'aria-hidden': 'true' }, [
    h('span', { className: 'trend-hm-month-spacer' }),
    wdayMonEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayWedEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayFriEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdaySunEl,
  ]);
  const hmMonthsEl = h('div', { className: 'trend-hm-months' });
  const hmGridEl = h('div', {
    className: 'trend-hm-grid',
    role: 'grid',
    'aria-label': t('chart.trend.hmAria'),
  });
  const hmTrackEl = h('div', { className: 'trend-hm-track' }, [hmMonthsEl, hmGridEl]);
  const hmScrollEl = h('div', { className: 'trend-hm-scroll' }, [hmTrackEl]);
  const hmBodyEl = h('div', { className: 'trend-heatmap-body' }, [hmWeekdaysEl, hmScrollEl]);

  const hmSummaryEl = h('span', { className: 'trend-hm-summary text-mono', text: '' });
  const hmLessEl = h('span', { text: t('chart.trend.hmLess') });
  const hmMoreEl = h('span', { text: t('chart.trend.hmMore') });
  const hmLegendEl = h('span', { className: 'trend-hm-legend', 'aria-hidden': 'true' }, [
    hmLessEl,
    h('span', { className: 'trend-hm-swatch lv-0' }),
    h('span', { className: 'trend-hm-swatch lv-1' }),
    h('span', { className: 'trend-hm-swatch lv-2' }),
    h('span', { className: 'trend-hm-swatch lv-3' }),
    h('span', { className: 'trend-hm-swatch lv-4' }),
    hmMoreEl,
  ]);
  const hmFooterEl = h('div', { className: 'trend-hm-footer' }, [hmSummaryEl, hmLegendEl]);
  const heatmapStage = h('div', { className: 'trend-heatmap-stage', hidden: true }, [
    hmBodyEl,
    hmFooterEl,
  ]);

  const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
    plotStage,
    xAxisEl,
    heatmapStage,
    tooltipEl,
  ]);

  let currentSlots = [];
  let currentPts = [];
  let currentIsHeatmap = false;
  let currentHeatmapWeeks = 0;
  let currentHeatmapFirstDow = 0;
  let currentHeatmapGapPx = 2;
  let currentCellEls = [];
  let tickElsByIdx = new Map();
  let hoveredIdx = -1;
  let hoveredCellEl = null;
  let lastPointer = null;
  let lastRenderSig = '';
  let lastTickLabelsSig = '';
  let hasRenderedOnce = false;
  let hasRenderedLineOnce = false;
  let peakReadyArmed = false;
  let peakReadyRaf = 0;
  let tipTrackRaf = 0;
  let morphRafId = 0;
  let committedSegs = [];
  let liveMorphSegs = null;
  const transientClassTimers = new Map();

  const CURVE_MORPH_DURATION_MS = 240;

  function cleanupTransientClass(el) {
    const rec = transientClassTimers.get(el);
    if (!rec) return;
    clearTimeout(rec.tid);
    el?.removeEventListener?.('animationend', rec.onEnd);
    el?.classList?.remove(rec.cls);
    transientClassTimers.delete(el);
  }

  function triggerTransientClass(el, cls, fallbackMs = 650) {
    if (!el || !el.classList) return;
    cleanupTransientClass(el);
    el.classList.remove(cls);
    void el.offsetWidth;
    const onEnd = (ev) => {
      if (ev && ev.target && ev.target !== el) return;
      cleanupTransientClass(el);
    };
    const tid = setTimeout(() => cleanupTransientClass(el), fallbackMs);
    transientClassTimers.set(el, { cls, tid, onEnd });
    el.addEventListener?.('animationend', onEnd);
    el.classList.add(cls);
  }

  function clearAllTransientTimers() {
    for (const el of Array.from(transientClassTimers.keys())) {
      cleanupTransientClass(el);
    }
  }

  function cancelCurveMorph() {
    if (
      morphRafId &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(morphRafId);
    }
    morphRafId = 0;
  }

  function cancelPeakReadyRaf() {
    if (
      peakReadyRaf &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(peakReadyRaf);
    }
    peakReadyRaf = 0;
  }

  function canAnimateInBrowser() {
    if (
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      typeof window.getComputedStyle !== 'function' ||
      typeof performance === 'undefined' ||
      typeof performance.now !== 'function'
    ) {
      return false;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      return false;
    }
    return true;
  }

  function startCurveMorph(
    fromSegs,
    toSegs,
    { leftX, rightX, spanX, finalLineD, finalAreaD }
  ) {
    cancelCurveMorph();
    if (!canAnimateInBrowser() || fromSegs.length === 0 || toSegs.length === 0) {
      liveMorphSegs = null;
      patchAttr(linePath, 'd', finalLineD);
      patchAttr(areaPath, 'd', finalAreaD);
      return;
    }

    const knots = mergeNormalizedKnots(fromSegs, toSegs);
    const alignedFrom = subdivideChainToKnots(fromSegs, knots);
    const alignedTo = subdivideChainToKnots(toSegs, knots);
    const segCount = alignedTo.length;
    let maxDeltaY = 0;
    for (let i = 0; i < segCount; i++) {
      const a = alignedFrom[i];
      const b = alignedTo[i];
      maxDeltaY = Math.max(
        maxDeltaY,
        Math.abs(b.y0 - a.y0),
        Math.abs(b.cy1 - a.cy1),
        Math.abs(b.cy2 - a.cy2),
        Math.abs(b.y3 - a.y3)
      );
    }

    if (maxDeltaY < 0.25) {
      liveMorphSegs = null;
      patchAttr(linePath, 'd', finalLineD);
      patchAttr(areaPath, 'd', finalAreaD);
      return;
    }

    const activeLive = alignedFrom.map((s) => ({ ...s }));
    liveMorphSegs = activeLive;
    const rightXFixed = rightX.toFixed(1);
    const leftXFixed = leftX.toFixed(1);
    const startTs = performance.now();

    const step = (nowTs) => {
      const elapsed = Math.max(0, nowTs - startTs);
      const rawT = Math.min(1, elapsed / CURVE_MORPH_DURATION_MS);
      if (rawT >= 1) {
        morphRafId = 0;
        liveMorphSegs = null;
        patchAttr(linePath, 'd', finalLineD);
        patchAttr(areaPath, 'd', finalAreaD);
        return;
      }
      const ease = evalCubicBezier(0.22, 1, 0.36, 1, rawT);
      for (let i = 0; i < segCount; i++) {
        const a = alignedFrom[i];
        const b = alignedTo[i];
        const cur = activeLive[i];
        cur.u0 = a.u0 + (b.u0 - a.u0) * ease;
        cur.y0 = a.y0 + (b.y0 - a.y0) * ease;
        cur.cu1 = a.cu1 + (b.cu1 - a.cu1) * ease;
        cur.cy1 = a.cy1 + (b.cy1 - a.cy1) * ease;
        cur.cu2 = a.cu2 + (b.cu2 - a.cu2) * ease;
        cur.cy2 = a.cy2 + (b.cy2 - a.cy2) * ease;
        cur.u3 = a.u3 + (b.u3 - a.u3) * ease;
        cur.y3 = a.y3 + (b.y3 - a.y3) * ease;
      }
      const morphLineD = buildPathFromNormalizedSegs(activeLive, leftX, spanX);
      const morphAreaD = `${morphLineD} L ${rightXFixed} ${BOTTOM_Y} L ${leftXFixed} ${BOTTOM_Y} Z`;
      patchAttr(linePath, 'd', morphLineD);
      patchAttr(areaPath, 'd', morphAreaD);
      morphRafId = window.requestAnimationFrame(step);
    };

    morphRafId = window.requestAnimationFrame(step);
  }

  function cancelTipTrackRaf() {
    if (tipTrackRaf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(tipTrackRaf);
    }
    tipTrackRaf = 0;
  }

  function armTooltipTracking(wasHidden) {
    if (!wasHidden) return;
    patchClasses(tooltipEl, { 'is-tracking': false });
    patchClasses(hoverDot, { 'is-tracking': false });
    void tooltipEl.offsetWidth;
    cancelTipTrackRaf();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      tipTrackRaf = window.requestAnimationFrame(() => {
        tipTrackRaf = 0;
        if (!tooltipEl.hasAttribute('hidden')) {
          patchClasses(tooltipEl, { 'is-tracking': true });
          patchClasses(hoverDot, { 'is-tracking': true });
        }
      });
    } else {
      patchClasses(tooltipEl, { 'is-tracking': true });
      patchClasses(hoverDot, { 'is-tracking': true });
    }
  }

  function populateTooltipContent(slot) {
    const slotTok = safeSlotTokens(slot.tokens);
    const slotCost = Number.isFinite(Number(slot.costUsd)) ? Math.max(0, Number(slot.costUsd)) : 0;
    tooltipContent.update({
      title: formatTrendSlotFullLabel(slot) || slot.label || '--',
      calls: slot.calls,
      totalTokens: slotTok,
      costText: formatUsd(slotCost, {
        precise: slotCost > 0 && slotCost < 0.1,
      }),
      inputTokens: slot.inputTokens,
      cacheReadTokens: slot.cacheReadTokens,
      thinkingTokens: slot.thinkingTokens,
      responseTokens: slot.responseTokens,
      outputTokens: slot.outputTokens,
      segments: Array.isArray(slot.modelSegments) ? slot.modelSegments : [],
    });
  }

  let cachedWrapRect = null;
  let cachedSvgRect = null;
  let cachedHmGridRect = null;
  let cachedClipRect = undefined;

  function invalidateHoverRects() {
    cachedWrapRect = null;
    cachedSvgRect = null;
    cachedHmGridRect = null;
    cachedClipRect = undefined;
  }

  function getCachedWrapRect() {
    if (!cachedWrapRect) {
      cachedWrapRect = chartWrap.getBoundingClientRect?.() || null;
    }
    return cachedWrapRect;
  }

  function positionTooltipNearAnchor(fallbackX, fallbackY, pointer = null) {
    const wrapRect = getCachedWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(chartWrap.clientWidth || viewW || DEFAULT_VIEW_W);
    const wrapH =
      wrapRect && wrapRect.height > 0
        ? wrapRect.height
        : Number(chartWrap.offsetHeight || VIEW_H);

    const tipW = Number(tooltipEl.offsetWidth || 0) || 216;
    const tipH = Number(tooltipEl.offsetHeight || 0) || 104;

    const hasPointer =
      pointer &&
      Number.isFinite(Number(pointer.clientX)) &&
      Number.isFinite(Number(pointer.clientY)) &&
      wrapRect &&
      wrapRect.width > 0 &&
      wrapRect.height > 0;

    const anchorX = hasPointer ? Number(pointer.clientX) - wrapRect.left : fallbackX;
    const anchorY = hasPointer ? Number(pointer.clientY) - wrapRect.top : fallbackY;

    if (cachedClipRect === undefined) {
      const clipEl = chartWrap.closest?.('.view-pane, .cons-view-stage') || null;
      cachedClipRect = clipEl?.getBoundingClientRect?.() || null;
    }
    const clipRect = cachedClipRect;
    const hasClip = Boolean(
      clipRect && clipRect.height > 0 && wrapRect && wrapRect.height > 0
    );
    const minY = hasClip ? clipRect.top - wrapRect.top + 6 : -tipH - 16;
    const maxY = hasClip ? clipRect.bottom - wrapRect.top - tipH - 6 : wrapH + 16;

    const maxLeft = Math.max(4, wrapW - tipW - 4);
    let leftPx = Math.max(4, Math.min(maxLeft, anchorX - tipW / 2));
    const aboveY = anchorY - tipH - 14;
    let topPx;

    if (aboveY >= minY) {
      topPx = Math.min(maxY, aboveY);
    } else if (anchorX + 16 + tipW <= wrapW - 4) {
      leftPx = anchorX + 16;
      topPx = Math.max(minY, Math.min(maxY, anchorY - tipH / 2));
    } else if (anchorX - 16 - tipW >= 4) {
      leftPx = anchorX - 16 - tipW;
      topPx = Math.max(minY, Math.min(maxY, anchorY - tipH / 2));
    } else {
      topPx = Math.max(minY, Math.min(maxY, anchorY + 18));
    }

    patchStyleVar(tooltipEl, '--tip-x', `${Math.round(leftPx)}px`);
    patchStyleVar(tooltipEl, '--tip-shift', '0px');
    patchStyleVar(tooltipEl, '--tip-y', `${Math.round(topPx)}px`);
  }

  function showLineHoverAtIndex(idx, pointer = null) {
    if (currentIsHeatmap || idx < 0 || idx >= currentSlots.length || !currentPts[idx]) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedIdx = idx !== hoveredIdx;
    hoveredIdx = idx;
    if (pointer) {
      lastPointer = pointer;
    }
    const slot = currentSlots[idx];
    const pt = currentPts[idx];

    if (wasHidden || changedIdx) {
      patchAttr(hoverLine, 'hidden', false);
      patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
      patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

      patchAttr(hoverDot, 'hidden', false);
      patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
      patchAttr(hoverDot, 'cy', pt.y.toFixed(1));

      patchAttr(peakPill, 'hidden', true);
      patchClasses(tooltipEl, {
        'is-hm-bottom': false,
        'is-hm-top': false,
        'is-line-low': false,
      });
      patchAttr(tooltipEl, 'hidden', false);
      populateTooltipContent(slot);

      for (const [tIdx, el] of tickElsByIdx.entries()) {
        patchClasses(el, { 'is-hovered': tIdx === idx });
      }
    }

    const wrapRect = getCachedWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(chartWrap.clientWidth || viewW || DEFAULT_VIEW_W);
    const fallbackX = (pt.x / Math.max(1, viewW)) * wrapW;
    const fallbackY = pt.y + 6;
    positionTooltipNearAnchor(fallbackX, fallbackY, pointer || lastPointer);
    armTooltipTracking(wasHidden);
  }

  function showHeatmapHoverAtIndex(idx, cellEl, pointer = null) {
    if (!currentIsHeatmap || idx < 0 || idx >= currentSlots.length) {
      clearHover();
      return;
    }
    const targetCell = cellEl || currentCellEls[idx] || null;
    if (!targetCell) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedCell = idx !== hoveredIdx || hoveredCellEl !== targetCell;
    hoveredIdx = idx;
    if (pointer) {
      lastPointer = pointer;
    }
    if (hoveredCellEl && hoveredCellEl !== targetCell) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
    }
    hoveredCellEl = targetCell;
    patchClasses(targetCell, { 'is-hovered': true });

    const slot = currentSlots[idx];
    const row = Number(targetCell.getAttribute('data-hm-row') || 0);
    const col = Number(targetCell.getAttribute('data-hm-col') || 0);

    if (wasHidden || changedCell) {
      patchClasses(tooltipEl, {
        'is-hm-bottom': false,
        'is-hm-top': false,
        'is-line-low': false,
      });
      patchAttr(tooltipEl, 'hidden', false);
      populateTooltipContent(slot);
    }

    const wrapRect = getCachedWrapRect();
    const cellRect = targetCell.getBoundingClientRect?.() || null;
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(chartWrap.clientWidth || viewW || DEFAULT_VIEW_W);
    let fallbackX =
      currentHeatmapWeeks > 0 ? ((col + 0.5) / currentHeatmapWeeks) * wrapW : wrapW / 2;
    let fallbackY = 20 + row * 14;
    if (
      wrapRect &&
      wrapRect.width > 0 &&
      cellRect &&
      cellRect.width > 0 &&
      cellRect.width < wrapRect.width
    ) {
      fallbackX = cellRect.left + cellRect.width / 2 - wrapRect.left;
      fallbackY = cellRect.top + cellRect.height / 2 - wrapRect.top;
    }

    positionTooltipNearAnchor(fallbackX, fallbackY, pointer || lastPointer);
    armTooltipTracking(wasHidden);
  }

  function clearHover() {
    invalidateHoverRects();
    cancelTipTrackRaf();
    hoveredIdx = -1;
    lastPointer = null;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': false,
      'is-tracking': false,
    });
    patchClasses(hoverDot, { 'is-tracking': false });
    if (!currentIsHeatmap) {
      patchAttr(peakPill, 'hidden', false);
    }
    if (hoveredCellEl) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
      hoveredCellEl = null;
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of hGridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function handlePointerMove(e) {
    if (currentIsHeatmap || !currentSlots.length) return;
    if (!cachedSvgRect) {
      cachedSvgRect = svg.getBoundingClientRect();
    }
    const rect = cachedSvgRect;
    if (!rect || rect.width <= 0) {
      cachedSvgRect = null;
      return;
    }
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
    );
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    showLineHoverAtIndex(idx, pointer);
  }

  function findDirectHeatmapCell(e) {
    let cur = e?.target || null;
    while (cur && cur !== hmGridEl) {
      const idxAttr = cur.getAttribute?.('data-slot-idx');
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== '') {
        const idx = Number(idxAttr);
        if (Number.isFinite(idx) && idx >= 0 && idx < currentSlots.length) {
          return { idx, cellEl: cur };
        }
      }
      cur = cur.parentNode || null;
    }
    return null;
  }

  function resolveHeatmapCellFromPointer(e) {
    const directHit = findDirectHeatmapCell(e);
    if (directHit) return directHit;

    const clientX = Number(e?.clientX);
    const clientY = Number(e?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    if (!cachedHmGridRect) {
      cachedHmGridRect = hmGridEl.getBoundingClientRect?.() || null;
    }
    const rect = cachedHmGridRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || currentHeatmapWeeks <= 0) {
      cachedHmGridRect = null;
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    const W = currentHeatmapWeeks;
    const G = currentHeatmapGapPx;
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    if (
      relX < -(G + 1) ||
      relX > rect.width + G + 1 ||
      relY < -(G + 1) ||
      relY > rect.height + G + 1
    ) {
      return null;
    }

    const pitchX = (rect.width + G) / W;
    const pitchY = (rect.height + G) / 7;
    const cellW = Math.max(1, pitchX - G);
    const cellH = Math.max(1, pitchY - G);

    function distanceToCell(c, r) {
      const x0 = c * pitchX;
      const y0 = r * pitchY;
      const dx = relX < x0 ? x0 - relX : relX > x0 + cellW ? relX - (x0 + cellW) : 0;
      const dy = relY < y0 ? y0 - relY : relY > y0 + cellH ? relY - (y0 + cellH) : 0;
      return { chebyshev: Math.max(dx, dy), distSq: dx * dx + dy * dy };
    }

    // 指针滑入当前悬停格四周的空隙（gap）时保持原高亮，彻底消除跨格空隙闪烁与边缘微抖
    if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
      const curGridPos = currentHeatmapFirstDow + hoveredIdx;
      const curCol = Math.floor(curGridPos / 7);
      const curRow = curGridPos % 7;
      if (distanceToCell(curCol, curRow).chebyshev <= G + 0.75) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
    }

    // 快速扫过或初始落入格子间隙时，按网格步距吸附到最近的有效日期格
    const approxCol = Math.max(0, Math.min(W - 1, Math.floor((relX + G * 0.5) / pitchX)));
    const approxRow = Math.max(0, Math.min(6, Math.floor((relY + G * 0.5) / pitchY)));
    const directSlotIdx = approxCol * 7 + approxRow - currentHeatmapFirstDow;
    if (
      directSlotIdx >= 0 &&
      directSlotIdx < currentSlots.length &&
      currentCellEls[directSlotIdx]
    ) {
      return { idx: directSlotIdx, cellEl: currentCellEls[directSlotIdx] };
    }

    // 首周补位或末周未来空白边缘：仅当仍在相邻有效格的间隙光晕内才吸附，深入纯空白角则清空
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let dc = -1; dc <= 1; dc++) {
      const c = approxCol + dc;
      if (c < 0 || c >= W) continue;
      for (let dr = -1; dr <= 1; dr++) {
        const r = approxRow + dr;
        if (r < 0 || r > 6) continue;
        const sIdx = c * 7 + r - currentHeatmapFirstDow;
        if (sIdx < 0 || sIdx >= currentSlots.length || !currentCellEls[sIdx]) continue;
        const d = distanceToCell(c, r);
        if (d.chebyshev <= G + 1.5 && d.distSq < bestDistSq) {
          bestDistSq = d.distSq;
          bestIdx = sIdx;
        }
      }
    }
    if (bestIdx >= 0) {
      return { idx: bestIdx, cellEl: currentCellEls[bestIdx] };
    }
    return null;
  }

  function handleHeatmapPointer(e) {
    if (!currentIsHeatmap || !currentSlots.length) return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) {
      clearHover();
      return;
    }
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    if (hit.idx !== hoveredIdx || hit.cellEl !== hoveredCellEl || pointer) {
      showHeatmapHoverAtIndex(hit.idx, hit.cellEl, pointer);
    }
  }

  function handleHeatmapWheel(e) {
    if (!currentIsHeatmap) return;
    const maxScrollLeft = (hmScrollEl.scrollWidth || 0) - (hmScrollEl.clientWidth || 0);
    if (maxScrollLeft <= 2) return;
    const dy = Number(e.deltaY || 0);
    const dx = Number(e.deltaX || 0);
    if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
      const prev = hmScrollEl.scrollLeft || 0;
      const next = Math.max(0, Math.min(maxScrollLeft, prev + dy));
      if (next !== prev) {
        hmScrollEl.scrollLeft = next;
        e.preventDefault?.();
      }
    }
  }

  function handleLineClick(e) {
    if (currentIsHeatmap || !currentSlots.length || typeof onSelectSlot !== 'function') return;
    let idx = hoveredIdx;
    const rect = svg.getBoundingClientRect?.();
    if (rect && rect.width > 0 && Number.isFinite(Number(e?.clientX))) {
      const relX = ((e.clientX - rect.left) / rect.width) * viewW;
      const { leftX, spanX } = resolvePlotBounds(viewW);
      const ratio = (relX - leftX) / Math.max(1, spanX);
      idx = Math.max(
        0,
        Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
      );
    }
    const slot = currentSlots[idx];
    if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
      onSelectSlot(slot);
    }
  }

  function handleHeatmapClick(e) {
    handleHeatmapPointer(e);
    if (!currentIsHeatmap || !currentSlots.length || typeof onSelectSlot !== 'function') return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) return;
    const slot = currentSlots[hit.idx];
    if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
      onSelectSlot(slot);
    }
  }

  plotStage.addEventListener('mousemove', handlePointerMove);
  plotStage.addEventListener('click', handleLineClick);
  plotStage.addEventListener('mouseleave', clearHover);

  hmGridEl.addEventListener('mouseover', handleHeatmapPointer);
  hmGridEl.addEventListener('mousemove', handleHeatmapPointer);
  hmGridEl.addEventListener('click', handleHeatmapClick);
  hmGridEl.addEventListener('mouseleave', clearHover);
  hmScrollEl.addEventListener('wheel', handleHeatmapWheel);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      invalidateHoverRects();
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    cancelTipTrackRaf();
    cancelCurveMorph();
    cancelPeakReadyRaf();
    clearAllTransientTimers();
    plotStage.removeEventListener('mousemove', handlePointerMove);
    plotStage.removeEventListener('click', handleLineClick);
    plotStage.removeEventListener('mouseleave', clearHover);
    hmGridEl.removeEventListener('mouseover', handleHeatmapPointer);
    hmGridEl.removeEventListener('mousemove', handleHeatmapPointer);
    hmGridEl.removeEventListener('click', handleHeatmapClick);
    hmGridEl.removeEventListener('mouseleave', clearHover);
    hmScrollEl.removeEventListener('wheel', handleHeatmapWheel);
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 根据最新时间分桶序列重绘平滑曲线（<=90天/小时级）或类 GitHub 每日小格子热力图（>90天）。
   */
  function update(series = []) {
    const slots =
      Array.isArray(series) && series.length >= 1
        ? series
        : [
            { label: '00:00', fullLabel: '00:00 - 01:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '06:00', fullLabel: '06:00 - 07:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '12:00', fullLabel: '12:00 - 13:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '18:00', fullLabel: '18:00 - 19:00', tokens: 0, calls: 0, costUsd: 0 },
          ];
    currentSlots = slots;

    const isHourly =
      slots[0]?.granularity === 'hour' ||
      slots[0]?.granularity === 'minute' ||
      String(slots[0]?.label || '').includes(':');
    const useHeatmap = !isHourly && slots.length > HEATMAP_DAYS_THRESHOLD;
    const modeChanged = useHeatmap !== currentIsHeatmap;
    currentIsHeatmap = useHeatmap;

    if (modeChanged) {
      clearHover();
      cancelCurveMorph();
      liveMorphSegs = null;
    }
    patchClasses(chartWrap, { 'is-heatmap': useHeatmap });
    patchAttr(plotStage, 'hidden', useHeatmap);
    patchAttr(xAxisEl, 'hidden', useHeatmap);
    patchAttr(heatmapStage, 'hidden', !useHeatmap);
    if (hasRenderedOnce && modeChanged && canAnimateInBrowser()) {
      if (useHeatmap) {
        triggerTransientClass(heatmapStage, 'is-stage-entering');
      } else {
        triggerTransientClass(plotStage, 'is-stage-entering');
        triggerTransientClass(xAxisEl, 'is-switching');
      }
    }

    if (!useHeatmap) {
      syncViewWidth();
    }

    let maxTokens = 0;
    let peakIdx = 0;
    let activeDays = 0;
    const nonZeroVals = [];

    for (let i = 0; i < slots.length; i++) {
      const tokVal = safeSlotTokens(slots[i]?.tokens);
      if (tokVal > 0) {
        activeDays++;
        nonZeroVals.push(tokVal);
      }
      if (tokVal >= maxTokens) {
        maxTokens = tokVal;
        peakIdx = i;
      }
    }

    const locale = getEffectiveLocale();
    patchText(wdayMonEl, t('chart.trend.wdayMon'));
    patchText(wdayWedEl, t('chart.trend.wdayWed'));
    patchText(wdayFriEl, t('chart.trend.wdayFri'));
    patchText(wdaySunEl, t('chart.trend.wdaySun'));
    patchAttr(hmGridEl, 'aria-label', t('chart.trend.hmAria'));
    patchText(hmLessEl, t('chart.trend.hmLess'));
    patchText(hmMoreEl, t('chart.trend.hmMore'));

    const sig =
      `${locale}|${useHeatmap ? 'hm' : `line:${viewW}`}|` +
      slots
        .map((s) => {
          const mSig = Array.isArray(s?.modelSegments)
            ? s.modelSegments
                .map(
                  (m) =>
                    `${m.key}:${m.color}:${m.pctText}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}`
                )
                .join(',')
            : '';
          return `${s?.startMs || ''}:${s?.label || ''}:${s?.fullLabel || ''}:${safeSlotTokens(s?.tokens)}:${safeSlotTokens(s?.inputTokens)}:${safeSlotTokens(s?.cacheReadTokens)}:${safeSlotTokens(s?.thinkingTokens)}:${safeSlotTokens(s?.responseTokens)}:${Number(s?.costUsd || 0)}:${Number(s?.calls || 0)}:${mSig}`;
        })
        .join('|');

    if (hoveredIdx >= 0 && hoveredIdx < slots.length && !tooltipEl.hasAttribute('hidden')) {
      populateTooltipContent(slots[hoveredIdx]);
    }

    if (useHeatmap) {
      currentPts = [];
      if (sig !== lastRenderSig) {
        lastRenderSig = sig;
        nonZeroVals.sort((a, b) => a - b);
        const thresholds = computeHeatmapThresholds(nonZeroVals, maxTokens);

        const firstStartMs = Number(slots[0]?.startMs);
        const firstDow =
          Number.isFinite(firstStartMs) && firstStartMs > 0
            ? (new Date(firstStartMs).getDay() + 6) % 7
            : 0;
        const totalCells = firstDow + slots.length;
        const totalWeeks = Math.max(1, Math.ceil(totalCells / 7));
        const gapPx = totalWeeks > 42 ? 1.5 : 2;
        currentHeatmapWeeks = totalWeeks;
        currentHeatmapFirstDow = firstDow;
        currentHeatmapGapPx = gapPx;

        patchStyleVar(hmBodyEl, '--hm-weeks', String(totalWeeks));
        patchStyleVar(hmBodyEl, '--hm-gap', `${gapPx}px`);

        // 重建顶部对齐月份标签
        while (hmMonthsEl.firstChild) hmMonthsEl.removeChild(hmMonthsEl.firstChild);
        const monthTicks = buildHeatmapMonthTicks(slots, firstDow, totalWeeks);
        for (const mt of monthTicks) {
          const mEl = h('span', { className: 'trend-hm-month text-mono', text: mt.text });
          patchStyleVar(mEl, '--hm-col', String(mt.col));
          hmMonthsEl.appendChild(mEl);
        }

        // 重建 7 行 × N 周列的每日小格子（一格一天），使用 DocumentFragment 一次性批量挂载减少重排
        while (hmGridEl.firstChild) hmGridEl.removeChild(hmGridEl.firstChild);
        hoveredCellEl = null;
        currentCellEls = new Array(slots.length);
        const gridFrag =
          typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : null;
        const gridTarget = gridFrag || hmGridEl;

        for (let pad = 0; pad < firstDow; pad++) {
          gridTarget.appendChild(
            h('span', { className: 'trend-hm-cell is-pad', 'aria-hidden': 'true' })
          );
        }

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const tok = safeSlotTokens(slot?.tokens);
          const lv = resolveHeatmapLevel(tok, thresholds);
          const gridPos = firstDow + i;
          const col = Math.floor(gridPos / 7);
          const row = gridPos % 7;
          const cellEl = h('span', {
            className: `trend-hm-cell lv-${lv}`,
            'data-slot-idx': String(i),
            'data-hm-col': String(col),
            'data-hm-row': String(row),
            role: 'gridcell',
          });
          gridTarget.appendChild(cellEl);
          currentCellEls[i] = cellEl;
        }
        if (gridFrag) {
          hmGridEl.appendChild(gridFrag);
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (hmScrollEl.scrollWidth > hmScrollEl.clientWidth) {
              hmScrollEl.scrollLeft = hmScrollEl.scrollWidth;
            }
          });
        }
      }

      const peakSlot = slots[peakIdx];
      const summaryText =
        maxTokens > 0 && peakSlot?.label
          ? t('chart.trend.hmActivePeak', {
              active: activeDays,
              total: slots.length,
              label: peakSlot.label,
              tokens: formatTokensPrecise(maxTokens),
            })
          : t('chart.trend.hmActiveZero', { total: slots.length });
      patchText(hmSummaryEl, summaryText);

      if (hoveredIdx >= slots.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHeatmapHoverAtIndex(hoveredIdx, currentCellEls[hoveredIdx], lastPointer);
      }
      hasRenderedOnce = true;
      return;
    }

    // --- <= 90 天（或整点/分钟级）：渲染平滑面积曲线图（1:1 贴边对齐 + 连续插值形变过渡） ---
    currentCellEls = [];
    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = Math.max(1, maxTokens);
    const isSingle = slots.length === 1;
    const pts = slots.map((s, idx) => {
      const tok = safeSlotTokens(s?.tokens);
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (idx / Math.max(1, slots.length - 1)) * spanX;
      const ratio = maxTokens > 0 ? tok / denom : 0;
      const y = BOTTOM_Y - ratio * SPAN_Y;
      return { x, y, tokens: tok };
    });
    currentPts = pts;

    const nextSegs = pointsToNormalizedCubicSegs(pts, BOTTOM_Y);

    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      let lineD;
      let areaD;
      if (isSingle) {
        if (maxTokens > 0) {
          lineD = buildSmoothSplinePath([
            { x: leftX, y: BOTTOM_Y },
            pts[0],
            { x: rightX, y: BOTTOM_Y },
          ]);
        } else {
          const yStr = pts[0].y.toFixed(1);
          lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
        }
        areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
      } else {
        lineD = buildSmoothSplinePath(pts);
        areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${BOTTOM_Y} L ${pts[0].x.toFixed(1)} ${BOTTOM_Y} Z`;
      }

      const prevSegs = liveMorphSegs || committedSegs;
      committedSegs = nextSegs;
      if (hasRenderedLineOnce && !modeChanged && prevSegs.length > 0) {
        startCurveMorph(prevSegs, nextSegs, {
          leftX,
          rightX,
          spanX,
          finalLineD: lineD,
          finalAreaD: areaD,
        });
      } else {
        cancelCurveMorph();
        liveMorphSegs = null;
        patchAttr(linePath, 'd', lineD);
        patchAttr(areaPath, 'd', areaD);
      }
      hasRenderedLineOnce = true;

      // 渲染对齐底部刻度的垂直参考网格线及 X 轴标签（起止标签严格左右贴边）
      const tickIndices = computeTickIndices(slots);
      const nextTickLabelsSig = tickIndices
        .map((tIdx) => `${tIdx}:${slots[tIdx]?.label || ''}`)
        .join('|');
      const ticksChanged =
        hasRenderedOnce &&
        !modeChanged &&
        lastTickLabelsSig !== '' &&
        nextTickLabelsSig !== lastTickLabelsSig;
      lastTickLabelsSig = nextTickLabelsSig;

      while (vGridGroup.firstChild) vGridGroup.removeChild(vGridGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();

      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = pts[tIdx];
        const slot = slots[tIdx];
        if (!pt || !slot) continue;

        if (i > 0 && i < tickIndices.length - 1) {
          const vLine = document.createElementNS(SVG_NS, 'line');
          vLine.setAttribute('x1', pt.x.toFixed(1));
          vLine.setAttribute('y1', '16');
          vLine.setAttribute('x2', pt.x.toFixed(1));
          vLine.setAttribute('y2', String(BOTTOM_Y));
          vGridGroup.appendChild(vLine);
        }

        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: slot.label || '',
          title: formatTrendSlotFullLabel(slot) || slot.label || '',
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => {
          lastPointer = null;
          showLineHoverAtIndex(tIdx);
        };
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      if (ticksChanged && canAnimateInBrowser()) {
        triggerTransientClass(xAxisEl, 'is-switching');
        triggerTransientClass(vGridGroup, 'is-switching');
      }
    }

    const peakPt = pts[peakIdx] || { x: viewW / 2, y: BOTTOM_Y };

    const peakSlot = slots[peakIdx];
    const peakText =
      maxTokens > 0 && peakSlot?.label
        ? t('chart.trend.peakPill', {
            label: peakSlot.label,
            tokens: formatTokensPrecise(maxTokens),
          })
        : formatTokensPrecise(maxTokens);
    patchText(peakPill, peakText);
    const pctLeft = Math.max(12, Math.min(88, (peakPt.x / viewW) * 100));
    patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);
    if (!peakReadyArmed) {
      peakReadyArmed = true;
      if (canAnimateInBrowser()) {
        peakReadyRaf = window.requestAnimationFrame(() => {
          peakReadyRaf = 0;
          patchClasses(peakPill, { 'is-ready': true });
        });
      } else {
        patchClasses(peakPill, { 'is-ready': true });
      }
    }

    if (hoveredIdx >= slots.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showLineHoverAtIndex(hoveredIdx, lastPointer);
    }
    hasRenderedOnce = true;
  }

  return { el: chartWrap, update, destroy };
}
