/**
 * @fileoverview Standalone decoupled Metric Matrix Widget (`MetricMatrixWidget.js`).
 * Renders 1..4 user-selected telemetry cells dynamically via `metricRegistry.js`,
 * plus optional Large Sparkline Trend cards (1..2 items) for Hover Popover mode.
 */

import { defineComponent } from '../../core/component.js';
import {
  applyRubberBand,
  areSlotListsEqual,
  buildReorderedItems,
  createDropSettleAnimator,
  hitTestLinearCenter,
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
  setTranslate3d,
  startPointerDragSession,
} from '../../core/domPatch.js';
import { SVG_NS, createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import {
  buildSparklineGeometry,
  extractOverviewMetricSeries,
  resolveOverviewMetricCell,
  splitMetricValueAndUnit,
} from '../../registries/metricRegistry.js';
import {
  resolveEffectiveClientMetricMatrixConfig,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

let sparklineGradSeq = 0;

function extractToneClass(valueClass = '') {
  const m = String(valueClass || '').match(/\b(tone-(?:good|info|warn|danger|muted)|accent-(?:speed|ok))\b/);
  return m ? m[1] : '';
}

function createSparklineSvg(gradId) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cell-sparkline-svg');
  svg.setAttribute('viewBox', '0 0 108 34');
  svg.setAttribute('preserveAspectRatio', 'xMaxYMid meet');
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
  stopTop.setAttribute('stop-color', 'currentColor');
  stopTop.setAttribute('stop-opacity', '0.22');
  const stopBot = document.createElementNS(SVG_NS, 'stop');
  stopBot.setAttribute('offset', '100%');
  stopBot.setAttribute('stop-color', 'currentColor');
  stopBot.setAttribute('stop-opacity', '0.02');
  grad.appendChild(stopTop);
  grad.appendChild(stopBot);
  defs.appendChild(grad);

  const axisLine = document.createElementNS(SVG_NS, 'line');
  axisLine.setAttribute('class', 'cell-sparkline-axis');
  axisLine.setAttribute('x1', '4');
  axisLine.setAttribute('y1', '32');
  axisLine.setAttribute('x2', '104');
  axisLine.setAttribute('y2', '32');

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('class', 'cell-sparkline-area');
  areaPath.setAttribute('fill', `url(#${gradId})`);

  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('class', 'cell-sparkline-line');
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '1.65');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'cell-sparkline-dot');
  dot.setAttribute('r', '2.75');
  dot.setAttribute('fill', 'currentColor');

  svg.appendChild(defs);
  svg.appendChild(axisLine);
  svg.appendChild(areaPath);
  svg.appendChild(polyline);
  svg.appendChild(dot);

  return { svg, axisLine, areaPath, polyline, dot };
}

export const MetricMatrixWidget = defineComponent({
  name: 'MetricMatrixWidget',
  setup({ props, onCleanup }) {
    const widgetMode = props?.mode === 'hover' ? 'hover' : 'overview';
    const hasMetricReorder =
      typeof props?.onReorderMetrics === 'function' || typeof props?.onPreviewMetrics === 'function';
    const onRequestVerticalDrag =
      typeof props?.onRequestVerticalDrag === 'function' ? props.onRequestVerticalDrag : null;
    const canParentDragModule =
      typeof props?.canDragParentModule === 'function' ? props.canDragParentModule : () => false;
    const getCtxAgentId =
      typeof props?.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const matrixEl = h('section', {
      className: 'telemetry-matrix',
      'aria-label': t('module.metrics'),
      'data-cols': '4',
    });
    patchStyleVar(matrixEl, '--matrix-cols', '4');

    let currentVisibleKeys = [];
    let currentOverflowKeys = [];
    let lastUpdatePayload = null;
    let pendingUpdatePayload = null;
    let activeDrag = null;
    const settleAnimator = createDropSettleAnimator('is-settling', ' scale(1.02)');

    function resetDragVisuals() {
      patchClasses(matrixEl, { 'is-dragging-matrix': false });
      for (const cellEl of matrixEl.children || []) {
        patchClasses(cellEl, { 'is-cell-dragging': false, 'is-cell-drag-sibling': false });
        if (cellEl?.style) {
          cellEl.style.transition = '';
          cellEl.style.transform = '';
        }
      }
    }

    function teardownActiveDrag({ revert = false, flushPending = true } = {}) {
      if (!activeDrag) return;
      const { startVisible, overflowTail, getWorkingVisible, session } = activeDrag;
      const moved = session.isMoved();
      activeDrag = null;
      session.cancel(true);
      resetDragVisuals();
      if (revert && moved && !areSlotListsEqual(startVisible, getWorkingVisible())) {
        props?.onPreviewMetrics?.([...startVisible, ...overflowTail]);
      }
      if (flushPending && pendingUpdatePayload) {
        const queued = pendingUpdatePayload;
        pendingUpdatePayload = null;
        applyUpdatePayload(queued);
      }
    }

    function startMetricCellDrag(e, startIdx) {
      if (!hasMetricReorder || (e && e.button != null && e.button !== 0)) return;
      if (currentVisibleKeys.length <= 1 || startIdx < 0 || startIdx >= currentVisibleKeys.length) {
        return;
      }
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (activeDrag) teardownActiveDrag({ revert: false, flushPending: true });
      settleAnimator.clear();

      const startVisible = [...currentVisibleKeys];
      const overflowTail = [...currentOverflowKeys];
      const count = startVisible.length;
      const cellEls = Array.from(matrixEl.children || []).slice(0, count);
      if (cellEls.length !== count) return;
      const origIndices = Array.from({ length: count }, (_, idx) => idx);
      let targetIdx = startIdx;
      let workingVisible = [...startVisible];
      let slotRects = [];
      let isMultiRow = false;
      let startMatrixLeft = 0;
      let startMatrixTop = 0;
      let hasMatrixRect = false;
      let lastDragOffsetX = 0;
      let lastDragOffsetY = 0;

      function updateSiblingTransforms(nextTargetIdx) {
        const perm = buildReorderedItems(origIndices, startIdx, nextTargetIdx);
        for (let pos = 0; pos < count; pos += 1) {
          const orig = perm[pos];
          if (orig !== startIdx) {
            setTranslate3d(cellEls[orig], slotRects[pos].left - slotRects[orig].left, slotRects[pos].top - slotRects[orig].top);
          }
        }
      }

      const session = startPointerDragSession(e, {
        threshold: 4,
        onStart: ({ startX, startY, clientX, clientY }) => {
          slotRects = [];
          for (let i = 0; i < count; i += 1) {
            const r = cellEls[i]?.getBoundingClientRect?.();
            const ok = Boolean(r && Number.isFinite(r.width) && r.width > 0);
            const width = ok ? r.width : 110;
            const height = ok ? r.height : 64;
            const left = ok ? r.left : i * 116;
            const top = ok ? r.top : 0;
            slotRects.push({
              left,
              top,
              width,
              height,
              right: left + width,
              bottom: top + height,
              centerX: left + width * 0.5,
              centerY: top + height * 0.5,
            });
          }
          isMultiRow = slotRects.some((r) => Math.abs(r.top - slotRects[0].top) > 10);
          if (
            !isMultiRow &&
            onRequestVerticalDrag &&
            canParentDragModule() &&
            Math.abs(clientY - startY) > Math.abs(clientX - startX) * 1.15
          ) {
            activeDrag = null;
            onRequestVerticalDrag(e, clientX, clientY);
            return false;
          }
          const mr = matrixEl?.getBoundingClientRect?.();
          hasMatrixRect = Boolean(mr && Number.isFinite(mr.width) && mr.width > 0);
          startMatrixLeft = hasMatrixRect ? mr.left : 0;
          startMatrixTop = hasMatrixRect ? mr.top : 0;
          patchClasses(matrixEl, { 'is-dragging-matrix': true });
          for (let k = 0; k < count; k += 1) {
            patchClasses(cellEls[k], { 'is-cell-dragging': k === startIdx, 'is-cell-drag-sibling': k !== startIdx });
          }
          updateSiblingTransforms(targetIdx);
        },
        onMove: ({ clientX, clientY, startX, startY }) => {
          const mr = hasMatrixRect ? matrixEl?.getBoundingClientRect?.() : null;
          const rawDeltaX = clientX - startX - (mr && mr.width > 0 ? mr.left - startMatrixLeft : 0);
          const rawDeltaY = clientY - startY - (mr && mr.width > 0 ? mr.top - startMatrixTop : 0);

          const clampedX = applyRubberBand(
            rawDeltaX,
            Math.min(...slotRects.map((r) => r.left)) - slotRects[startIdx].left,
            Math.max(...slotRects.map((r) => r.right)) - slotRects[startIdx].right,
            14,
            0.25
          );
          const clampedY = isMultiRow
            ? applyRubberBand(
                rawDeltaY,
                Math.min(...slotRects.map((r) => r.top)) - slotRects[startIdx].top,
                Math.max(...slotRects.map((r) => r.bottom)) - slotRects[startIdx].bottom,
                14,
                0.25
              )
            : rawDeltaY === 0
              ? 0
              : Math.sign(rawDeltaY) * Math.min(8, Math.abs(rawDeltaY) * 0.18);

          lastDragOffsetX = clampedX;
          lastDragOffsetY = clampedY;
          setTranslate3d(cellEls[startIdx], clampedX, clampedY, ' scale(1.02)');

          let nextTarget = startIdx;
          if (!isMultiRow) {
            nextTarget = hitTestLinearCenter(
              slotRects.map((r) => ({ start: r.left, size: r.width, end: r.right, center: r.centerX })),
              startIdx,
              rawDeltaX
            );
          } else {
            const cx = slotRects[startIdx].centerX + rawDeltaX;
            const cy = slotRects[startIdx].centerY + rawDeltaY;
            let bestDistSq = Infinity;
            for (let i = 0; i < count; i += 1) {
              const d2 = (cx - slotRects[i].centerX) ** 2 + (cy - slotRects[i].centerY) ** 2;
              if (d2 < bestDistSq) {
                bestDistSq = d2;
                nextTarget = i;
              }
            }
          }
          if (nextTarget !== targetIdx) {
            targetIdx = nextTarget;
            workingVisible = buildReorderedItems(startVisible, startIdx, targetIdx);
            updateSiblingTransforms(targetIdx);
            props?.onPreviewMetrics?.([...workingVisible, ...overflowTail]);
          }
        },
        onEnd: ({ moved, cancelled }) => {
          if (cancelled) {
            teardownActiveDrag({ revert: true, flushPending: true });
            return;
          }
          const finalTargetIdx = targetIdx;
          const finalVisible = [...workingVisible];
          const finalFull = [...finalVisible, ...overflowTail];
          const targetOffsetX =
            moved && slotRects[finalTargetIdx] && slotRects[startIdx]
              ? slotRects[finalTargetIdx].left - slotRects[startIdx].left
              : 0;
          const targetOffsetY =
            moved && slotRects[finalTargetIdx] && slotRects[startIdx]
              ? slotRects[finalTargetIdx].top - slotRects[startIdx].top
              : 0;
          const residualX = moved ? lastDragOffsetX - targetOffsetX : 0;
          const residualY = moved ? lastDragOffsetY - targetOffsetY : 0;
          const changed = moved && !areSlotListsEqual(startVisible, finalVisible);

          teardownActiveDrag({ revert: false, flushPending: !changed });
          if (changed) {
            pendingUpdatePayload = null;
            currentVisibleKeys = finalVisible;
            if (lastUpdatePayload?.data) {
              const prevSettings = lastUpdatePayload.data.settings || {};
              const syncOverview = widgetMode !== 'hover' || prevSettings.hoverSyncOverviewMetrics !== false;
              applyUpdatePayload({
                data: {
                  ...lastUpdatePayload.data,
                  settings: {
                    ...prevSettings,
                    ...(syncOverview ? { overviewMetrics: finalFull } : { hoverMetrics: finalFull }),
                  },
                },
              });
            }
            props?.onReorderMetrics?.(finalFull);
          }
          if (moved && matrixEl.children?.[finalTargetIdx]) {
            settleAnimator.trigger(matrixEl.children[finalTargetIdx], residualX, residualY);
          }
        },
      });

      activeDrag = { startVisible, overflowTail, getWorkingVisible: () => workingVisible, session };
    }

    function createMetricCellNode() {
      const gradId = `wm-spark-grad-${++sparklineGradSeq}`;
      const labelSpan = h('span', { text: '—' });
      const iconSvg = createSvgIcon('pulse', { size: 11 });
      const valueEl = h('strong', { className: 'cell-value', text: '—' });
      const subEl = h('span', { className: 'cell-sub', text: '—' });

      const trendNumEl = h('strong', { className: 'cell-trend-num', text: '—' });
      const trendUnitEl = h('span', { className: 'cell-trend-unit', text: '' });
      const trendSubEl = h('span', { className: 'cell-trend-sub', text: '—' });
      const spark = createSparklineSvg(gradId);
      const sparkWrapEl = h('div', { className: 'cell-sparkline-wrap' }, [spark.svg]);
      const trendRowEl = h('div', { className: 'cell-trend-row', hidden: true }, [
        h('div', { className: 'cell-trend-left' }, [
          h('div', { className: 'cell-trend-metric' }, [trendNumEl, trendUnitEl]),
          trendSubEl,
        ]),
        sparkWrapEl,
      ]);

      const el = h(
        'div',
        {
          className: 'matrix-cell',
          ...(hasMetricReorder
            ? {
                onPointerdown: (e) => {
                  const idx = Array.from(matrixEl.children || []).indexOf(el);
                  if (idx >= 0) startMetricCellDrag(e, idx);
                },
              }
            : {}),
        },
        [
          h('div', { className: 'cell-label' }, [labelSpan, iconSvg]),
          valueEl,
          subEl,
          trendRowEl,
        ]
      );
      return {
        el,
        refs: {
          el,
          labelSpan,
          iconSvg,
          valueEl,
          subEl,
          trendRowEl,
          trendNumEl,
          trendUnitEl,
          trendSubEl,
          sparkWrapEl,
          spark,
        },
      };
    }

    function applyUpdatePayload({ data } = {}) {
      lastUpdatePayload = { data };
      patchAttr(matrixEl, 'aria-label', t('module.metrics'));
      const settings = data?.settings || {};
      const {
        isLarge: isLargeTrend,
        metrics: metricKeys,
        allMetrics,
      } = resolveEffectiveClientMetricMatrixConfig(widgetMode, settings);
      currentVisibleKeys = [...metricKeys];
      currentOverflowKeys = Array.isArray(allMetrics) ? allMetrics.slice(metricKeys.length) : [];
      const canDragCells = hasMetricReorder && metricKeys.length > 1;
      const dragHint = canDragCells
        ? canParentDragModule()
          ? t('settings.str.metricOrModuleDragHint')
          : t('settings.str.metricDragHint')
        : null;
      const maxCols = isLargeTrend ? 3 : 4;
      const colCount = Math.max(1, Math.min(maxCols, metricKeys.length));
      patchClasses(matrixEl, {
        'is-large-trend': isLargeTrend,
        'is-metrics-reorderable': canDragCells,
      });
      patchAttr(matrixEl, 'data-cols', String(colCount));
      patchStyleVar(matrixEl, '--matrix-cols', String(colCount));

      const { hasSubagents, scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId(),
        isLargeTrend
      );
      const active = scopedConv || data?.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};
      const quotas = data?.quotas || {};
      const locale = getEffectiveLocale();
      const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
      const seriesSteps = isLargeTrend
        ? active.sparklineSteps || active.recentSteps || data?.activeConversation?.recentSteps || []
        : [];
      const sparkWidth = colCount === 1 ? 248 : colCount === 2 ? 136 : 74;
      const sparkHeight = 34;
      const sparkStrokeWidth = colCount === 3 ? '1.55' : '1.65';
      const sparkDotRadius = colCount === 3 ? '2.5' : '2.75';

      const cells = metricKeys.map((key) => {
        const base = resolveOverviewMetricCell(key, {
          active,
          ctx,
          quotas,
          settings,
          hasSubagents,
        });
        if (!isLargeTrend) {
          return { ...base, isLargeTrend: false, sparkSig: '' };
        }
        const series = extractOverviewMetricSeries(key, seriesSteps, {
          maxPoints: 16,
          limitTokens,
        });
        const geom = buildSparklineGeometry(series, { width: sparkWidth, height: sparkHeight });
        const split = splitMetricValueAndUnit(base.valueText);
        const tone = extractToneClass(base.valueClass);
        const sparkSig = `${sparkWidth}x${sparkHeight}:${geom.linePoints}:${geom.lastX},${geom.lastY}`;
        return {
          ...base,
          isLargeTrend: true,
          tone,
          trendMain: split.main,
          trendUnit: split.unit,
          sparkWidth,
          sparkHeight,
          sparkStrokeWidth,
          sparkDotRadius,
          geom,
          sparkSig,
        };
      });

      patchKeyedList(matrixEl, cells, {
        keyFn: (cell) => cell.key,
        sigFn: (cell) =>
          `${locale}:${cell.isLargeTrend ? 'L' : 'M'}:${cell.key}:${cell.label}:${cell.icon}:${cell.isPulsing}:${cell.valueClass}:${cell.valueText}:${cell.subClass}:${cell.subText}:${cell.sparkSig}:${dragHint || ''}`,
        createRow: createMetricCellNode,
        updateRow: (refs, cell) => {
          patchAttr(refs.el, 'data-metric-key', cell.key);
          patchAttr(refs.el, 'title', dragHint);
          patchClasses(refs.el, { 'is-trend-card': cell.isLargeTrend });
          patchText(refs.labelSpan, cell.label);
          patchSvgIcon(refs.iconSvg, cell.icon);
          refs.iconSvg.setAttribute('width', String(cell.iconSize));
          refs.iconSvg.setAttribute('height', String(cell.iconSize));
          patchClasses(refs.iconSvg, { 'is-pulsing': Boolean(cell.isPulsing) });

          patchAttr(refs.valueEl, 'hidden', cell.isLargeTrend);
          patchAttr(refs.subEl, 'hidden', cell.isLargeTrend);
          patchAttr(refs.trendRowEl, 'hidden', !cell.isLargeTrend);

          if (!cell.isLargeTrend) {
            patchAttr(refs.valueEl, 'class', cell.valueClass);
            patchText(refs.valueEl, cell.valueText);
            patchAttr(refs.subEl, 'class', cell.subClass);
            patchText(refs.subEl, cell.subText);
            return;
          }

          patchAttr(
            refs.trendNumEl,
            'class',
            cell.tone ? `cell-trend-num ${cell.tone}` : 'cell-trend-num'
          );
          patchText(refs.trendNumEl, cell.trendMain);
          patchText(refs.trendUnitEl, cell.trendUnit);
          patchAttr(refs.trendUnitEl, 'hidden', !cell.trendUnit);
          patchText(refs.trendSubEl, cell.subText);

          patchAttr(
            refs.sparkWrapEl,
            'class',
            cell.tone ? `cell-sparkline-wrap ${cell.tone}` : 'cell-sparkline-wrap'
          );
          refs.spark.svg.setAttribute('viewBox', `0 0 ${cell.sparkWidth} ${cell.sparkHeight}`);
          refs.spark.polyline.setAttribute('stroke-width', cell.sparkStrokeWidth);
          refs.spark.dot.setAttribute('r', cell.sparkDotRadius);
          refs.spark.axisLine.setAttribute('x2', String(cell.sparkWidth - 4));
          refs.spark.axisLine.setAttribute('y1', String(cell.geom.baselineY));
          refs.spark.axisLine.setAttribute('y2', String(cell.geom.baselineY));

          if (cell.geom.hasLine) {
            refs.spark.areaPath.setAttribute('d', cell.geom.areaPath);
            refs.spark.polyline.setAttribute('points', cell.geom.linePoints);
            patchAttr(refs.spark.areaPath, 'hidden', false);
            patchAttr(refs.spark.polyline, 'hidden', false);
          } else {
            refs.spark.areaPath.setAttribute('d', '');
            refs.spark.polyline.setAttribute('points', '');
            patchAttr(refs.spark.areaPath, 'hidden', true);
            patchAttr(refs.spark.polyline, 'hidden', true);
          }

          if (cell.geom.hasDot) {
            refs.spark.dot.setAttribute('cx', String(cell.geom.lastX));
            refs.spark.dot.setAttribute('cy', String(cell.geom.lastY));
            patchAttr(refs.spark.dot, 'hidden', false);
          } else {
            patchAttr(refs.spark.dot, 'hidden', true);
          }
        },
      });
    }

    function update(payload = {}) {
      if (activeDrag) {
        pendingUpdatePayload = payload;
        return;
      }
      applyUpdatePayload(payload);
    }

    onCleanup(() => {
      teardownActiveDrag({ revert: false, flushPending: false });
      settleAnimator.clear();
    });

    // Initialize default 4-cell skeleton so hover/overview has zero initial height jump
    update({ data: null });

    return {
      el: matrixEl,
      refs: { update },
    };
  },
});
