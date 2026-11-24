/**
 * @fileoverview Pure regression math (OLS + IRLS-LOESS), nice axis tick generators,
 * SVG spline/polyline path builders, and step metric formatters extracted from SessionStepCharts.js.
 */

import {
  formatAgentBadgeText,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatTokens,
  formatTokensPrecise,
  formatUsd,
} from '../../core/formatters.js';
import { t } from '../../i18n/index.js';

/** 多模型节点和多曲线对比语义调色板（全部取自 tokens.css 语义变量，兼顾设计一致性和交叉曲线区分度） */
export const MODEL_COLOR_VARS = Object.freeze([
  'var(--ctx-cached)',
  'var(--ctx-skills)',
  'var(--ctx-user-input)',
  'var(--ctx-checkpoint)',
  'var(--ctx-tool-results)',
  'var(--ctx-subagent-msg)',
]);

/**
 * 提取步骤所属的基础模型分组键（和后端 `usage-aggregator.mjs` 中 `modelBreakdown[].label` 严格一致），
 * 且不受“精简代号 / 原始模型 ID”或“自动压缩”后缀切换影响。
 *
 * @param {object|null|undefined} step
 * @returns {string}
 */
export function getStepModelGroupKey(step) {
  if (!step || typeof step !== 'object') return t('fmt.unknownModel');
  const rawLabel = String(step.baseModelLabel || step.modelLabel || step.label || '')
    .replace(/\s*\[自动压缩\]\s*$/u, '')
    .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered)\)\s*$/i, '')
    .trim();
  if (rawLabel) return rawLabel;
  const rawShort = String(step.baseModelShort || step.modelShort || step.shortName || '')
    .replace(/·(?:压缩|Compact)\s*$/iu, '')
    .trim();
  return rawShort || t('fmt.unknownModel');
}

/**
 * 将逆序或混合代理的步骤列表归一化为严格时间升序序列（最旧 -> 最新）。
 *
 * @param {Array<object>} steps
 * @param {boolean} isMergedAllAgents
 * @returns {Array<object>}
 */
export function toChronologicalSteps(steps, isMergedAllAgents = false) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const copy = steps.slice();
  if (isMergedAllAgents) {
    copy.sort(
      (a, b) =>
        (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0) ||
        (Number(a?.agentIndex) || 0) - (Number(b?.agentIndex) || 0) ||
        (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0)
    );
    return copy;
  }
  copy.sort(
    (a, b) =>
      (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0) ||
      (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0)
  );
  return copy;
}

export function clampValue(v, minVal = 0, maxVal = Infinity) {
  if (!Number.isFinite(v)) return minVal;
  return Math.max(minVal, Math.min(maxVal, v));
}

/**
 * 双侧 95% 置信区间对应的 Student-t 临界值近似表（t_{0.975, df}）。
 *
 * @param {number} df 残差自由度
 * @returns {number}
 */
function tCritical95(df) {
  if (!Number.isFinite(df) || df <= 1.5) return 3.182;
  if (df <= 2.5) return 3.182 + (2.5 - df) * 0.9;
  if (df <= 3.5) return 2.776 + (3.5 - df) * 0.406;
  if (df <= 4.5) return 2.571 + (4.5 - df) * 0.205;
  if (df <= 6) return 2.447;
  if (df <= 8) return 2.306;
  if (df <= 10) return 2.228;
  if (df <= 15) return 2.131;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/**
 * 计算普通最小二乘线性回归（OLS: y = intercept + slope * x）。
 *
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, xs?: number[] }} [options]
 * @returns {{ values: number[], slope: number, intercept: number, mean: number, r: number, r2: number }}
 */
export function computeLinearFit(ys, { minVal = 0, maxVal = Infinity, xs = null } = {}) {
  const n = Array.isArray(ys) ? ys.length : 0;
  if (n === 0) {
    return { values: [], slope: 0, intercept: 0, mean: 0, r: 0, r2: 0 };
  }
  const xArr =
    Array.isArray(xs) && xs.length === n ? xs : Array.from({ length: n }, (_, idx) => idx);
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;
  if (n === 1) {
    const c = clampValue(ys[0], minVal, maxVal);
    return { values: [c], slope: 0, intercept: c, mean: c, r: 0, r2: 0 };
  }
  const meanX = xArr.reduce((acc, v) => acc + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const r =
    sxx > 1e-12 && syy > 1e-12 ? clampValue(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;
  const values = xArr.map((x) => clampValue(intercept + slope * x, minVal, maxVal));
  return { values, slope, intercept, mean: meanY, r, r2: r * r };
}

/**
 * 学术论文级回归和 95% 置信带计算引擎（Cleveland & Devlin 高斯局部加权线性回归 LOESS + 精确帽子矩阵标准误，
 * 小样本 n <= 5 时自动采用精确 OLS 线性回归和双曲 t 分布 95% 置信区间，等同于 R `ggplot2::geom_smooth(se = TRUE)`）。
 *
 * @param {number[]} xs 严格递增或单调的样本横坐标序列
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, gridSize?: number, span?: number }} [options]
 */
export function computePublicationFit(
  xs,
  ys,
  { minVal = 0, maxVal = Infinity, gridSize = 64, span = 0.5 } = {}
) {
  const n = Math.min(Array.isArray(xs) ? xs.length : 0, Array.isArray(ys) ? ys.length : 0);
  if (n === 0) {
    return {
      method: 'OLS',
      mean: 0,
      sd: 0,
      slope: 0,
      intercept: 0,
      r: 0,
      r2: 0,
      sampleFits: [],
      sampleCiLow: [],
      sampleCiHigh: [],
      sampleCiHalf: [],
      grid: [],
    };
  }

  const ols = computeLinearFit(ys, { minVal, maxVal, xs });
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dy = ys[i] - ols.mean;
    syy += dy * dy;
  }
  const sd = n > 1 ? Math.sqrt(syy / (n - 1)) : 0;

  if (n === 1) {
    const val = clampValue(ys[0], minVal, maxVal);
    return {
      method: 'OLS',
      mean: val,
      sd: 0,
      slope: 0,
      intercept: val,
      r: 0,
      r2: 0,
      sampleFits: [val],
      sampleCiLow: [val],
      sampleCiHigh: [val],
      sampleCiHalf: [0],
      grid: [{ x: xs[0], fit: val, ciLow: val, ciHigh: val }],
    };
  }

  const xMin = xs[0];
  const xMax = xs[n - 1];
  const xSpan = Math.max(1e-9, xMax - xMin);
  const M = Math.max(2, gridSize);
  const gridXs = Array.from({ length: M }, (_, k) => xMin + (k / (M - 1)) * xSpan);

  // 小样本（n <= 5）：采用精确 OLS 线性回归和 Student-t 双曲 95% CI 置信带
  if (n <= 5) {
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      sxx += dx * dx;
      const resid = ys[i] - (ols.intercept + ols.slope * xs[i]);
      sse += resid * resid;
    }
    const df = n - 2;
    const seResid = df >= 1 ? Math.sqrt(sse / df) : 0;
    const tCrit = df >= 1 ? tCritical95(df) : 0;

    const evalOlsAt = (x0) => {
      const rawFit = ols.intercept + ols.slope * x0;
      const sePred =
        seResid > 0
          ? seResid * Math.sqrt(1 / n + (sxx > 1e-12 ? ((x0 - meanX) * (x0 - meanX)) / sxx : 0))
          : 0;
      const half = tCrit * sePred;
      return {
        fit: clampValue(rawFit, minVal, maxVal),
        ciLow: clampValue(rawFit - half, minVal, maxVal),
        ciHigh: clampValue(rawFit + half, minVal, maxVal),
        half,
      };
    };

    const sampleEval = xs.map(evalOlsAt);
    const grid = gridXs.map((gx) => {
      const g = evalOlsAt(gx);
      return { x: gx, fit: g.fit, ciLow: g.ciLow, ciHigh: g.ciHigh };
    });

    return {
      method: 'OLS',
      mean: ols.mean,
      sd,
      slope: ols.slope,
      intercept: ols.intercept,
      r: ols.r,
      r2: ols.r2,
      sampleFits: sampleEval.map((e) => e.fit),
      sampleCiLow: sampleEval.map((e) => e.ciLow),
      sampleCiHigh: sampleEval.map((e) => e.ciHigh),
      sampleCiHalf: sampleEval.map((e) => e.half),
      grid,
    };
  }

  // n >= 6：Cleveland 高斯局部加权一阶线性回归（LOESS）+ 精确帽子矩阵杠杆度 95% CI 置信带
  const q = Math.max(5, Math.min(n, Math.ceil(span * n)));
  const wBuf = new Float64Array(n);
  const sortedXs = q <= n && xs.slice(0, n).every(
    (x, i) => Number.isFinite(x) && (i === 0 || xs[i - 1] <= x)
  );

  function loessBandwidth(x0) {
    // 有序 x 上的 q 个最近样本可取连续区间；二分比较两端，避免每个拟合点都排序。
    let left = 0;
    let right = n - q;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (x0 - xs[mid] > xs[mid + q] - x0) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return Math.max(Math.abs(xs[left] - x0), Math.abs(xs[left + q - 1] - x0));
  }

  function evalLoessPoint(x0, diagIdx = -1) {
    let h;
    if (sortedXs) {
      h = loessBandwidth(x0);
      if (h <= 1e-9) {
        h = Math.max(Math.abs(xs[0] - x0), Math.abs(xs[n - 1] - x0), xSpan * 0.05, 1e-6);
      }
    } else {
      const sortedDists = Array.from({ length: n }, (_, j) => Math.abs(xs[j] - x0)).sort((a, b) => a - b);
      h = sortedDists[q - 1];
      if (h <= 1e-9) {
        h = Math.max(sortedDists[n - 1], xSpan * 0.05, 1e-6);
      }
    }
    const maxDist = h * 1.0001;
    let start = 0;
    let end = n;
    if (sortedXs) {
      // 三次权重的支持区间之外权重为零，保留区间内样本原来的累加顺序。
      let right = n;
      while (start < right) {
        const mid = (start + right) >>> 1;
        if (x0 - xs[mid] >= maxDist) start = mid + 1;
        else right = mid;
      }
      let left = start;
      while (left < end) {
        const mid = (left + end) >>> 1;
        if (xs[mid] - x0 < maxDist) left = mid + 1;
        else end = mid;
      }
    }

    let sw = 0;
    let swx = 0;
    for (let j = start; j < end; j++) {
      const u = Math.abs(xs[j] - x0) / maxDist;
      const base = 1 - u * u * u;
      const w = u >= 1 ? 0 : base * base * base;
      wBuf[j] = w;
      sw += w;
      swx += w * xs[j];
    }

    if (sw <= 1e-12) {
      const fallbackVal = ols.intercept + ols.slope * x0;
      return { rawFit: fallbackVal, leverageNormSq: 1 / n, diagHat: 1 / n, localHatDiag: 1 / n };
    }

    const mx = swx / sw;
    let sxxW = 0;
    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const dx = xs[j] - mx;
      sxxW += w * dx * dx;
    }

    const dx0 = x0 - mx;
    const useSlope = sxxW > 1e-12;
    const inverseWeightSum = 1 / sw;
    const slopeScale = useSlope ? dx0 / sxxW : 0;
    const localHatDiag = inverseWeightSum + (useSlope ? (dx0 * dx0) / sxxW : 0);
    let rawFit = 0;
    let leverageNormSq = 0;
    let diagHat = 0;

    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const lj = w * inverseWeightSum + (useSlope ? w * (xs[j] - mx) * slopeScale : 0);
      rawFit += lj * ys[j];
      leverageNormSq += lj * lj;
      if (j === diagIdx) diagHat = lj;
    }

    return { rawFit, leverageNormSq, diagHat, localHatDiag };
  }

  const rawSampleFits = new Float64Array(n);
  const sampleLevSq = new Float64Array(n);
  let sse = 0;
  let traceL = 0;
  let precomputedGridEval = null;

  // 大样本（n > 200 且 x 单调有序）采用和 R `stats::loess(surface = "interpolate")` 一致的网格插值加速：
  // 仅在 M 个均匀网格顶点做精确 LOESS（O(M·N)），再线性插值样本拟合值和杠杆度，避免 O(N²) 阻塞主线程。
  if (n > 200 && sortedXs && M >= 2) {
    const gridRawFit = new Float64Array(M);
    const gridLevSq = new Float64Array(M);
    const gridHatDiag = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      const res = evalLoessPoint(gridXs[k], -1);
      gridRawFit[k] = res.rawFit;
      gridLevSq[k] = res.leverageNormSq;
      gridHatDiag[k] = res.localHatDiag;
    }
    precomputedGridEval = { gridRawFit, gridLevSq };

    const invSpan = (M - 1) / xSpan;
    const maxK0 = M - 2;
    for (let i = 0; i < n; i++) {
      const u = (xs[i] - xMin) * invSpan;
      const k0 = u <= 0 ? 0 : u >= maxK0 ? maxK0 : Math.floor(u);
      const frac = Math.max(0, Math.min(1, u - k0));
      const rf = gridRawFit[k0] + frac * (gridRawFit[k0 + 1] - gridRawFit[k0]);
      const ls = Math.max(0, gridLevSq[k0] + frac * (gridLevSq[k0 + 1] - gridLevSq[k0]));
      const hd = gridHatDiag[k0] + frac * (gridHatDiag[k0 + 1] - gridHatDiag[k0]);
      rawSampleFits[i] = rf;
      sampleLevSq[i] = ls;
      traceL += hd;
      const diff = ys[i] - rf;
      sse += diff * diff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const res = evalLoessPoint(xs[i], i);
      rawSampleFits[i] = res.rawFit;
      sampleLevSq[i] = res.leverageNormSq;
      traceL += res.diagHat;
      const diff = ys[i] - res.rawFit;
      sse += diff * diff;
    }
  }

  const dfRes = Math.max(1, n - traceL);
  const sigmaHat = Math.sqrt(sse / dfRes);
  const tCrit = tCritical95(dfRes);

  const sampleFits = new Array(n);
  const sampleCiLow = new Array(n);
  const sampleCiHigh = new Array(n);
  const sampleCiHalf = new Array(n);
  let clampedSse = 0;

  for (let i = 0; i < n; i++) {
    const fitVal = clampValue(rawSampleFits[i], minVal, maxVal);
    const half = tCrit * sigmaHat * Math.sqrt(sampleLevSq[i]);
    sampleFits[i] = fitVal;
    sampleCiLow[i] = clampValue(rawSampleFits[i] - half, minVal, maxVal);
    sampleCiHigh[i] = clampValue(rawSampleFits[i] + half, minVal, maxVal);
    sampleCiHalf[i] = half;
    const d = ys[i] - fitVal;
    clampedSse += d * d;
  }

  const grid = precomputedGridEval
    ? gridXs.map((gx, k) => {
        const rf = precomputedGridEval.gridRawFit[k];
        const half = tCrit * sigmaHat * Math.sqrt(Math.max(0, precomputedGridEval.gridLevSq[k]));
        return {
          x: gx,
          fit: clampValue(rf, minVal, maxVal),
          ciLow: clampValue(rf - half, minVal, maxVal),
          ciHigh: clampValue(rf + half, minVal, maxVal),
        };
      })
    : gridXs.map((gx) => {
        const res = evalLoessPoint(gx, -1);
        const half = tCrit * sigmaHat * Math.sqrt(res.leverageNormSq);
        return {
          x: gx,
          fit: clampValue(res.rawFit, minVal, maxVal),
          ciLow: clampValue(res.rawFit - half, minVal, maxVal),
          ciHigh: clampValue(res.rawFit + half, minVal, maxVal),
        };
      });

  const r2Loess = syy > 1e-12 ? clampValue(1 - clampedSse / syy, 0, 1) : 1;

  return {
    method: 'LOESS',
    mean: ols.mean,
    sd,
    slope: ols.slope,
    intercept: ols.intercept,
    r: ols.r,
    r2: r2Loess,
    sampleFits,
    sampleCiLow,
    sampleCiHigh,
    sampleCiHalf,
    grid,
  };
}

/**
 * Heckbert 科学坐标轴刻度取整算法，生成科研图表风格的均匀整洁刻度。
 */
export function niceStepNumber(range, round) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

export function computeNiceYScale(dataMin, dataMax, { minBound = 0, maxBound = Infinity, tickCount = 4 } = {}) {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 1;
  if (minBound === 0 && lo >= 0 && hi > 0 && lo <= hi * 0.32) {
    lo = 0;
  }
  if (hi - lo <= 1e-9) {
    const pad = lo > 0 ? lo * 0.15 : 1;
    lo = Math.max(minBound, lo - pad);
    hi = Math.min(maxBound, hi + pad);
    if (hi - lo <= 1e-9) {
      lo = Math.max(minBound, hi - 1);
    }
  } else {
    const pad = (hi - lo) * 0.05;
    lo = Math.max(minBound, lo - (lo === 0 ? 0 : pad));
    hi = Math.min(maxBound, hi + pad);
  }

  const rawRange = niceStepNumber(hi - lo, false);
  const step = niceStepNumber(rawRange / Math.max(2, tickCount - 1), true);
  let graphMin = Math.max(minBound, Math.floor(lo / step) * step);
  let graphMax = Math.min(maxBound, Math.ceil(hi / step) * step);
  if (graphMax - graphMin <= 1e-9) {
    graphMax = graphMin + step;
  }

  const ticks = [];
  for (let v = graphMin; v <= graphMax + step * 0.25; v += step) {
    const clamped = clampValue(+v.toPrecision(10), minBound, maxBound);
    if (ticks.length === 0 || Math.abs(clamped - ticks[ticks.length - 1]) > step * 1e-4) {
      ticks.push(clamped);
    }
    if (ticks.length >= 8) break;
  }
  return {
    min: ticks[0] ?? graphMin,
    max: ticks[ticks.length - 1] ?? graphMax,
    step,
    ticks,
  };
}

export function computeNiceXStepTicks(xs) {
  const n = xs.length;
  if (n === 0) return [];
  if (n <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const xMin = xs[0];
  const xMax = xs[n - 1];
  const span = xMax - xMin;
  if (span <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const step = Math.max(1, Math.round(niceStepNumber(span / 4.5, true)));
  const firstTick = Math.ceil(xMin / step) * step;
  const ticks = [];
  if (firstTick - xMin > step * 0.45) {
    ticks.push(Math.round(xMin));
  }
  for (let v = firstTick; v <= xMax + 1e-6; v += step) {
    ticks.push(Math.round(v));
    if (ticks.length >= 7) break;
  }
  if (ticks.length === 0) {
    return [Math.round(xMin), Math.round(xMax)];
  }
  return ticks;
}

export function formatYAxisTick(metric, val, step) {
  if (!Number.isFinite(val)) return '';
  if (Math.abs(val) < 1e-9) {
    return metric === 'cost' ? '$0' : metric === 'cache' ? '0%' : metric === 'ttft' ? '0s' : '0';
  }
  if (metric === 'tps') {
    return step >= 1 ? `${Math.round(val)}` : val.toFixed(1);
  }
  if (metric === 'ttft') {
    return step >= 1 ? `${Math.round(val)}s` : `${val.toFixed(1)}s`;
  }
  if (metric === 'cache') {
    return step >= 1 ? `${Math.round(val)}%` : formatPctNumber(val, { withSymbol: true });
  }
  if (metric === 'cost') {
    if (step >= 1) return `$${Math.round(val)}`;
    if (step >= 0.1) return `$${val.toFixed(1)}`;
    if (step >= 0.01) return `$${val.toFixed(2)}`;
    return `$${val.toFixed(3)}`;
  }
  return String(val);
}

export function buildPolylinePath(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
  }
  return d;
}

export function buildSplinePath(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.38;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.38;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

export function computeStepTickIndices(count) {
  if (count <= 0) return [];
  if (count <= 6) return Array.from({ length: count }, (_, i) => i);
  const maxTicks = 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    set.add(Math.round((k / (maxTicks - 1)) * (count - 1)));
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function formatStepAxisTag(st, showAgentPrefix) {
  const num = `#${Number(st?.stepIndex ?? 0)}`;
  if (!showAgentPrefix) return num;
  const badge = formatAgentBadgeText({
    agentKind:
      st?.agentKind || (!st?.isSubagent ? 'main' : st?.isSideQuestion ? 'side_question' : 'subagent'),
    agentOrdinal:
      st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0),
    isMain: !st?.isSubagent,
    isSideQuestion: Boolean(st?.isSideQuestion),
    sideIndex: st?.sideIndex || 0,
    index: st?.agentIndex || 0,
    badgeText: st?.agentBadge,
  });
  return `${badge}${num}`;
}

export function formatChartMetricValue(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return `${formatTokensPrecise(val)} tok`;
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return formatPctNumber(val, { withSymbol: true });
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}

export function formatChartMetricCompact(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return formatTokens(val);
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return formatPctNumber(val, { withSymbol: true });
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}
