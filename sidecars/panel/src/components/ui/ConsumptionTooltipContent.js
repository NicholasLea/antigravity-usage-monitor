/**
 * @fileoverview 消耗统计统一悬浮详情内容组件 (ConsumptionTooltipContent).
 * 供历史趋势（折线/热力图）、客户端来源、会话排行及月度统计悬浮卡片复用：
 * 1. 顶部标题/日期行 + 右侧调用次数；
 * 2. 核心大字总量 (`TOKEN`) + 右侧预估费用；
 * 3. 分模型明细行（模型名/Token/占比 + 同「模型排行」Token 模式一致的四段构成进度条，不显示多余分组标题）；
 * 4. 底部四通道汇总（输入 / 缓存 / 思考 / 输出）。
 */

import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatTokensPrecise } from '../../core/formatters.js';
import { t } from '../../i18n/index.js';
import { createFourSegmentBar } from './FourSegmentBar.js';

function safeNonNeg(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveSegmentChannels(seg) {
  const inputTokens = safeNonNeg(seg?.inputTokens);
  const cacheReadTokens = safeNonNeg(seg?.cacheReadTokens);
  const thinkingTokens = safeNonNeg(seg?.thinkingTokens);
  const responseTokens =
    seg?.responseTokens != null
      ? safeNonNeg(seg.responseTokens)
      : Math.max(0, safeNonNeg(seg?.outputTokens) - thinkingTokens);
  return { inputTokens, cacheReadTokens, thinkingTokens, responseTokens };
}

/**
 * 创建可增量更新的消耗统计悬浮详情内容结构。
 *
 * @param {{ showModelDot?: boolean, monoTitle?: boolean }} [options]
 * @returns {{
 *   children: HTMLElement[],
 *   update: (payload: {
 *     title?: string,
 *     calls?: number,
 *     totalTokens?: number,
 *     costText?: string,
 *     inputTokens?: number,
 *     cacheReadTokens?: number,
 *     thinkingTokens?: number,
 *     responseTokens?: number,
 *     outputTokens?: number,
 *     segments?: Array<object>,
 *   }) => void,
 * }}
 */
export function createConsumptionBreakdownContent({
  showModelDot = false,
  monoTitle = false,
} = {}) {
  const titleEl = h('span', {
    className: monoTitle ? 'trend-tip-time text-mono' : 'trend-tip-time',
  });
  const callsEl = h('span', { className: 'trend-tip-calls text-mono' });
  const headEl = h('div', { className: 'trend-tip-head cons-tip-head' }, [titleEl, callsEl]);

  const heroNumEl = h('span', { className: 'cons-tip-hero-num', text: '0' });
  const heroUnitEl = h('span', { className: 'cons-tip-hero-unit', text: ' TOKEN' });
  const tokensEl = h('strong', { className: 'trend-tip-tokens cons-tip-hero text-mono' }, [
    heroNumEl,
    heroUnitEl,
  ]);
  const costEl = h('span', { className: 'trend-tip-cost text-mono' });
  const mainEl = h('div', { className: 'trend-tip-main cons-tip-main' }, [tokensEl, costEl]);

  function createModelRow() {
    const dotEl = h('span', {
      className: 'dot-swatch cons-model-dot',
      hidden: !showModelDot,
    });
    const nameEl = h('span', { className: 'cons-pop-model-name' });
    const tokEl = h('span', { className: 'cons-pop-model-tok' });
    const pctEl = h('strong', { className: 'cons-pop-model-pct' });
    const segBar = createFourSegmentBar();
    const rowEl = h('div', { className: 'cons-pop-model-row' }, [
      h('div', { className: 'cons-pop-model-head' }, [
        h('span', { className: 'cons-pop-model-left' }, [dotEl, nameEl]),
        h('span', { className: 'cons-pop-model-right text-mono' }, [tokEl, pctEl]),
      ]),
      segBar.el,
    ]);
    return {
      el: rowEl,
      refs: { rowEl, dotEl, nameEl, tokEl, pctEl, segBar },
    };
  }

  const modelsEl = h('div', { className: 'cons-pop-models', hidden: true });

  const inLabelEl = h('span', { className: 'cons-pop-chan-label', text: t('cons.legInput') });
  const inValEl = h('strong', { className: 'cons-pop-chan-val text-mono', text: '0' });
  const cacheLabelEl = h('span', { className: 'cons-pop-chan-label', text: t('cons.legCache') });
  const cacheValEl = h('strong', { className: 'cons-pop-chan-val text-mono', text: '0' });
  const thinkLabelEl = h('span', { className: 'cons-pop-chan-label', text: t('cons.legThinking') });
  const thinkValEl = h('strong', { className: 'cons-pop-chan-val text-mono', text: '0' });
  const outLabelEl = h('span', { className: 'cons-pop-chan-label', text: t('cons.legOutput') });
  const outValEl = h('strong', { className: 'cons-pop-chan-val text-mono', text: '0' });

  const channelsEl = h('div', { className: 'cons-pop-channels', hidden: true }, [
    h('div', { className: 'cons-pop-chan' }, [
      h('span', { className: 'cons-pop-chan-head' }, [
        h('span', { className: 'dot-swatch seg-input' }),
        inLabelEl,
      ]),
      inValEl,
    ]),
    h('div', { className: 'cons-pop-chan' }, [
      h('span', { className: 'cons-pop-chan-head' }, [
        h('span', { className: 'dot-swatch seg-cached' }),
        cacheLabelEl,
      ]),
      cacheValEl,
    ]),
    h('div', { className: 'cons-pop-chan' }, [
      h('span', { className: 'cons-pop-chan-head' }, [
        h('span', { className: 'dot-swatch seg-thinking' }),
        thinkLabelEl,
      ]),
      thinkValEl,
    ]),
    h('div', { className: 'cons-pop-chan' }, [
      h('span', { className: 'cons-pop-chan-head' }, [
        h('span', { className: 'dot-swatch seg-output' }),
        outLabelEl,
      ]),
      outValEl,
    ]),
  ]);

  function update(payload = {}) {
    patchText(titleEl, payload.title || '--');
    patchText(
      callsEl,
      t('cons.callsCount', { calls: Math.max(0, Math.floor(Number(payload.calls) || 0)) })
    );
    const totalTokens = safeNonNeg(payload.totalTokens);
    patchText(heroNumEl, formatTokensPrecise(totalTokens));
    patchText(heroUnitEl, ' TOKEN');
    patchText(costEl, payload.costText || '');

    const rows = Array.isArray(payload.segments) ? payload.segments : [];
    patchAttr(modelsEl, 'hidden', rows.length === 0);
    patchKeyedList(modelsEl, rows, {
      keyFn: (r) => r.key,
      sigFn: (r) =>
        `${showModelDot ? 1 : 0}:${r.key}:${r.label}:${r.color || ''}:${r.tokText}:${r.pctText}:${r.isOther ? 1 : 0}:${r.tok || 0}:${r.inputTokens || 0}:${r.cacheReadTokens || 0}:${r.thinkingTokens || 0}:${r.responseTokens ?? ''}:${r.outputTokens ?? ''}`,
      createRow: createModelRow,
      updateRow: (rRefs, r) => {
        patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
        patchAttr(rRefs.dotEl, 'hidden', !showModelDot);
        if (showModelDot) {
          patchStyleVar(rRefs.dotEl, '--dot-color', r.color);
        }
        patchText(rRefs.nameEl, r.label);
        patchText(rRefs.tokEl, r.tokText);
        patchText(rRefs.pctEl, r.pctText);

        const segTok = safeNonNeg(r.tok);
        const pct = Math.max(0, Math.min(100, Number(r.pct) || 0));
        const scaleRatio = segTok > 0 ? Math.min(1, Math.max(0.008, pct / 100)) : 0;
        const ch = resolveSegmentChannels(r);
        const chSum = ch.inputTokens + ch.cacheReadTokens + ch.thinkingTokens + ch.responseTokens;
        if (chSum > 0) {
          rRefs.segBar.update({
            inputTokens: ch.inputTokens,
            cacheReadTokens: ch.cacheReadTokens,
            thinkingTokens: ch.thinkingTokens,
            responseTokens: ch.responseTokens,
            scaleRatio,
          });
        } else if (segTok > 0) {
          rRefs.segBar.update({
            inputTokens: 0,
            cacheReadTokens: segTok,
            thinkingTokens: 0,
            responseTokens: 0,
            scaleRatio,
          });
        } else {
          rRefs.segBar.update({
            inputTokens: 0,
            cacheReadTokens: 0,
            thinkingTokens: 0,
            responseTokens: 0,
            scaleRatio: 0,
          });
        }
      },
    });

    const hasExplicitChannels =
      payload.inputTokens !== undefined ||
      payload.cacheReadTokens !== undefined ||
      payload.thinkingTokens !== undefined ||
      payload.responseTokens !== undefined ||
      payload.outputTokens !== undefined;
    let inTok = safeNonNeg(payload.inputTokens);
    let cacheTok = safeNonNeg(payload.cacheReadTokens);
    let thinkTok = safeNonNeg(payload.thinkingTokens);
    let respTok =
      payload.responseTokens != null
        ? safeNonNeg(payload.responseTokens)
        : Math.max(0, safeNonNeg(payload.outputTokens) - thinkTok);
    let hasChannels = hasExplicitChannels;

    if (!hasChannels && rows.length > 0) {
      let segIn = 0;
      let segCache = 0;
      let segThink = 0;
      let segResp = 0;
      for (const seg of rows) {
        const ch = resolveSegmentChannels(seg);
        segIn += ch.inputTokens;
        segCache += ch.cacheReadTokens;
        segThink += ch.thinkingTokens;
        segResp += ch.responseTokens;
      }
      if (segIn + segCache + segThink + segResp > 0) {
        inTok = segIn;
        cacheTok = segCache;
        thinkTok = segThink;
        respTok = segResp;
        hasChannels = true;
      }
    }

    const showChannels = totalTokens > 0 && hasChannels;
    patchAttr(channelsEl, 'hidden', !showChannels);
    if (showChannels) {
      patchText(inLabelEl, t('cons.legInput'));
      patchText(cacheLabelEl, t('cons.legCache'));
      patchText(thinkLabelEl, t('cons.legThinking'));
      patchText(outLabelEl, t('cons.legOutput'));
      patchText(inValEl, formatTokensPrecise(inTok));
      patchText(cacheValEl, formatTokensPrecise(cacheTok));
      patchText(thinkValEl, formatTokensPrecise(thinkTok));
      patchText(outValEl, formatTokensPrecise(respTok));
    }
  }

  return {
    children: [headEl, mainEl, modelsEl, channelsEl],
    update,
  };
}
