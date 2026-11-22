/**
 * @fileoverview Standalone decoupled Quota Pools Widget (`QuotaPoolsWidget.js`).
 * Renders dynamic multi-pool quota bars (Gemini, Argon/Carbon, Claude & GPT)
 * and weekly summary footer for both `LiveOverviewView` and `WindowOverlayShell`.
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
import { formatCountdown, formatTokens, formatUsd } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

/**
 * 归一化动态配额池列表；在官方配额尚未返回时回退预占 Gemini 与 Claude & GPT 两个标准池槽位。
 *
 * @param {object|null|undefined} quotas
 * @param {number} minuteTick
 * @param {{ isPending?: boolean }} [options]
 * @returns {Array<object>}
 */
export function buildQuotaPoolItems(
  quotas,
  minuteTick = 0,
  { isPending = false, showReserved = false } = {}
) {
  const safeQuotas = quotas || {};
  const activePool = safeQuotas.activePool || {};
  const rawPools =
    Array.isArray(safeQuotas.pools) && safeQuotas.pools.length > 0
      ? safeQuotas.pools
      : [
          { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini' },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT' },
        ];
  const weekly = safeQuotas.weekly || {};
  const poolItems = rawPools.map((p) => {
    const key = p.poolKey || p.family || p.poolLabel || 'Other';
    const poolLabel = p.poolLabel || p.family || key;
    const isActivePool =
      Boolean(activePool.family) &&
      (activePool.poolKey === key ||
        activePool.family === p.family ||
        (key === 'Claude & GPT' && ['Claude', 'GPT'].includes(activePool.family)));
    return {
      key,
      poolLabel,
      poolData: p,
      fallbackWeekly: weekly,
      isActivePool,
      minuteTick,
      isPending,
      showReserved: Boolean(showReserved),
    };
  });
  if (
    weekly?.isOfficial === false &&
    poolItems.length > 0 &&
    !poolItems.some((item) => item.isActivePool)
  ) {
    poolItems[0].isActivePool = true;
  }
  return poolItems;
}

/**
 * 创建单个配额池的 DOM 行结构，内含 5h 限额及每周限额两个可独立显隐的子窗口进度条。
 */
export function createPoolQuotaRow() {
  const title5h = h('span', { className: 'quota-win-title', text: '5h' });
  const usage5h = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const left5h = h('span', { className: 'quota-win-left' }, [title5h, usage5h]);
  const meta5hBefore = h('span', { text: '--' });
  const meta5hReserved = h('span', { className: 'quota-reserved-pct', hidden: true, text: '' });
  const meta5hAfter = h('span', { hidden: true, text: '' });
  const meta5h = h('span', { className: 'panel-meta quota-win-meta text-mono' }, [
    meta5hBefore,
    meta5hReserved,
    meta5hAfter,
  ]);
  const fill5h = h('div', { className: 'progress-fill' });
  const fillReserved5h = h('div', { className: 'progress-fill-reserved' });
  const track5h = h('div', { className: 'progress-track' }, [fill5h, fillReserved5h]);
  const row5h = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [left5h, meta5h]),
    track5h,
  ]);

  const titleWk = h('span', { className: 'quota-win-title', text: t('quota.weeklyShort') });
  const usageWk = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const leftWk = h('span', { className: 'quota-win-left' }, [titleWk, usageWk]);
  const metaWkBefore = h('span', { text: '--' });
  const metaWkReserved = h('span', { className: 'quota-reserved-pct', hidden: true, text: '' });
  const metaWkAfter = h('span', { hidden: true, text: '' });
  const metaWk = h('span', { className: 'panel-meta quota-win-meta text-mono' }, [
    metaWkBefore,
    metaWkReserved,
    metaWkAfter,
  ]);
  const fillWk = h('div', { className: 'progress-fill' });
  const fillReservedWk = h('div', { className: 'progress-fill-reserved' });
  const trackWk = h('div', { className: 'progress-track' }, [fillWk, fillReservedWk]);
  const rowWk = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [leftWk, metaWk]),
    trackWk,
  ]);

  const el = h('div', { className: 'quota-pool-row' }, [
    row5h,
    rowWk,
  ]);

  return {
    el,
    refs: {
      row5h,
      left5h,
      title5h,
      usage5h,
      meta5h,
      meta5hBefore,
      meta5hReserved,
      meta5hAfter,
      track5h,
      fill5h,
      fillReserved5h,
      rowWk,
      leftWk,
      titleWk,
      usageWk,
      metaWk,
      metaWkBefore,
      metaWkReserved,
      metaWkAfter,
      trackWk,
      fillWk,
      fillReservedWk,
    },
  };
}

/**
 * 格式化可用额度面板底部的汇总行文案（官方配额模式下展示各池周期合计，自定义预算模式下展示自然周累计）。
 */
export function formatQuotaSummaryFooter(quotas, account) {
  const weekly = quotas?.weekly || {};
  const isCustomLocal = weekly.isOfficial === false;
  const tokStr = formatTokens(weekly.tokens || 0);
  const costStr = formatUsd(weekly.costUsd || 0);
  const leftText = isCustomLocal
    ? t('quota.footTokensCustom', { tok: tokStr, cost: costStr })
    : t('quota.footTokensCycle', { tok: tokStr, cost: costStr });
  const rightText =
    Number(account?.aiCredits) > 0
      ? t('quota.footCredits', { credits: account.aiCredits })
      : isCustomLocal
        ? t('quota.footCallsCustom', { calls: weekly.calls || 0 })
        : t('quota.footCallsCycle', { calls: weekly.calls || 0 });
  const tooltip = isCustomLocal ? t('quota.footTipCustom') : t('quota.footTipCycle');
  return { leftText, rightText, tooltip };
}

function syncQuotaWindowMeter({
  hasData,
  usedVal,
  remVal,
  resetTime,
  fallbackMetaText,
  showReserved,
  rawReservedPct,
  leaseCount,
  metaBeforeEl,
  metaReservedEl,
  metaAfterEl,
  trackEl,
  fillEl,
  fillReservedEl,
}) {
  const numReserved = showReserved && hasData ? Number(rawReservedPct || 0) : 0;
  const rsvVal =
    Number.isFinite(numReserved) && numReserved >= 0.05 ? Math.min(usedVal, numReserved) : 0;
  const actualVal = Math.max(0, usedVal - rsvVal);
  const resetStr = hasData ? formatCountdown(resetTime) : '';

  if (hasData && rsvVal > 0) {
    const rsvStr = rsvVal.toFixed(1);
    const actualStr = actualVal.toFixed(1);
    const leases = Math.max(1, Number(leaseCount) || 1);
    const tipText =
      leases >= 2
        ? t('quota.reservedTipMulti', { rsv: rsvStr, leases, actual: actualStr })
        : t('quota.reservedTip', { rsv: rsvStr, actual: actualStr });
    patchText(
      metaBeforeEl,
      t('quota.usedBeforeReserved', { reset: resetStr, used: usedVal.toFixed(1) })
    );
    metaReservedEl.hidden = false;
    patchText(metaReservedEl, t('quota.reservedTag', { rsv: rsvStr }));
    patchAttr(metaReservedEl, 'title', tipText);
    metaAfterEl.hidden = false;
    patchText(metaAfterEl, t('quota.usedAfterReserved', { rem: remVal.toFixed(1) }));
    patchAttr(trackEl, 'title', tipText);
    const actualWidth = +Math.min(100, actualVal).toFixed(2);
    const rsvWidth = +Math.min(Math.max(0, 100 - actualWidth), rsvVal).toFixed(2);
    patchStyleVar(fillEl, '--fill-w', `${actualWidth}%`);
    patchStyleVar(fillReservedEl, '--reserved-w', `${rsvWidth}%`);
    patchClasses(fillReservedEl, { 'is-active': true, 'has-sep': actualWidth > 0 });
  } else {
    patchText(
      metaBeforeEl,
      hasData
        ? t('quota.usedAndLeft', {
            reset: resetStr,
            used: usedVal.toFixed(1),
            rem: remVal.toFixed(1),
          })
        : fallbackMetaText
    );
    metaReservedEl.hidden = true;
    patchText(metaReservedEl, '');
    patchAttr(metaReservedEl, 'title', null);
    metaAfterEl.hidden = true;
    patchText(metaAfterEl, '');
    patchAttr(trackEl, 'title', null);
    patchStyleVar(fillEl, '--fill-w', `${Math.min(100, usedVal)}%`);
    patchStyleVar(fillReservedEl, '--reserved-w', '0%');
    patchClasses(fillReservedEl, { 'is-active': false, 'has-sep': false });
  }

  patchClasses(fillEl, {
    'tone-warn': usedVal >= 70 && usedVal < 85,
    'tone-danger': usedVal >= 85,
  });
}

/**
 * 同步单个配额池行的 5h 及每周窗口状态。
 */
export function syncPoolQuotaRow(refs, item, idx, rowEl) {
  const { poolData, poolLabel, fallbackWeekly, isActivePool, isPending, showReserved } = item;
  patchClasses(rowEl, { 'quota-pool-row': true, 'has-divider': idx > 0 });

  const has5h = poolData?.usedPct != null && poolData?.remainingPct != null;
  const used5hVal = has5h ? Number(poolData.usedPct) : 0;
  const rem5hVal = has5h ? Number(poolData.remainingPct) : 0;

  const useCustomWeekly = Boolean(isActivePool && fallbackWeekly?.isOfficial === false);
  const wkUsedRaw = useCustomWeekly
    ? fallbackWeekly?.usedPct
    : poolData?.weeklyUsedPct ?? (isActivePool ? fallbackWeekly?.usedPct : null);
  const wkRemRaw = useCustomWeekly
    ? fallbackWeekly?.remainingPct
    : poolData?.weeklyRemainingPct ?? (isActivePool ? fallbackWeekly?.remainingPct : null);
  const wkResetRaw = useCustomWeekly
    ? fallbackWeekly?.resetTime || poolData?.weeklyResetTime
    : poolData?.weeklyResetTime || (isActivePool ? fallbackWeekly?.resetTime : null);
  const hasWk = wkUsedRaw != null && wkRemRaw != null;
  const usedWkVal = hasWk ? Number(wkUsedRaw) : 0;
  const remWkVal = hasWk ? Number(wkRemRaw) : 0;

  const hide5h = !has5h && hasWk;
  const hideWk = !hasWk && has5h;
  refs.row5h.hidden = hide5h;
  refs.row5h.style.display = hide5h ? 'none' : 'flex';
  refs.rowWk.hidden = hideWk;
  refs.rowWk.style.display = hideWk ? 'none' : 'flex';

  const fallbackMetaText = isPending ? t('quota.loading') : t('quota.failed');
  const allowReserved = Boolean(showReserved && !isPending);

  patchText(refs.title5h, `5h (${poolLabel})`);
  const c5h = poolData?.cycle5h;
  if (!isPending && has5h && c5h && (c5h.tokens != null || c5h.costUsd != null)) {
    const tok5h = formatTokens(c5h.tokens || 0);
    const cost5h = formatUsd(c5h.costUsd || 0);
    const calls5h = Number(c5h.calls || 0);
    refs.usage5h.hidden = false;
    patchText(refs.usage5h, `· ${tok5h} (${cost5h})`);
    patchAttr(
      refs.left5h,
      'title',
      t('quota.cycle5hTitle', {
        pool: poolLabel,
        tok: tok5h,
        cost: cost5h,
        calls: calls5h,
      })
    );
  } else {
    refs.usage5h.hidden = true;
    patchText(refs.usage5h, '');
    patchAttr(refs.left5h, 'title', null);
  }
  syncQuotaWindowMeter({
    hasData: has5h,
    usedVal: used5hVal,
    remVal: rem5hVal,
    resetTime: poolData?.resetTime,
    fallbackMetaText,
    showReserved: allowReserved,
    rawReservedPct: poolData?.reservedPct,
    leaseCount: poolData?.reservedLeaseCount,
    metaBeforeEl: refs.meta5hBefore,
    metaReservedEl: refs.meta5hReserved,
    metaAfterEl: refs.meta5hAfter,
    trackEl: refs.track5h,
    fillEl: refs.fill5h,
    fillReservedEl: refs.fillReserved5h,
  });

  const customTitle =
    useCustomWeekly && fallbackWeekly?.title
      ? fallbackWeekly.title
      : t('quota.weeklyPool', { pool: poolLabel });
  patchText(refs.titleWk, customTitle);
  const cWk = useCustomWeekly
    ? fallbackWeekly
    : poolData?.cycleWeekly || (isActivePool ? fallbackWeekly : null);
  if (!isPending && hasWk && cWk && (cWk.tokens != null || cWk.costUsd != null)) {
    const tokWk = formatTokens(cWk.tokens || 0);
    const costWk = formatUsd(cWk.costUsd || 0);
    const callsWk = Number(cWk.calls || 0);
    refs.usageWk.hidden = false;
    patchText(refs.usageWk, `· ${tokWk} (${costWk})`);
    patchAttr(
      refs.leftWk,
      'title',
      useCustomWeekly
        ? t('quota.cycleWkCustomTitle', { tok: tokWk, cost: costWk, calls: callsWk })
        : t('quota.cycleWkPoolTitle', {
            pool: poolLabel,
            tok: tokWk,
            cost: costWk,
            calls: callsWk,
          })
    );
  } else {
    refs.usageWk.hidden = true;
    patchText(refs.usageWk, '');
    patchAttr(refs.leftWk, 'title', null);
  }
  syncQuotaWindowMeter({
    hasData: hasWk,
    usedVal: usedWkVal,
    remVal: remWkVal,
    resetTime: wkResetRaw,
    fallbackMetaText,
    showReserved: allowReserved && !useCustomWeekly,
    rawReservedPct: poolData?.weeklyReservedPct,
    leaseCount: poolData?.weeklyReservedLeaseCount,
    metaBeforeEl: refs.metaWkBefore,
    metaReservedEl: refs.metaWkReserved,
    metaAfterEl: refs.metaWkAfter,
    trackEl: refs.trackWk,
    fillEl: refs.fillWk,
    fillReservedEl: refs.fillReservedWk,
  });
}

export function quotaPoolRowSig(item, idx) {
  const c5h = item.poolData?.cycle5h;
  const cWk = item.poolData?.cycleWeekly;
  const fw = item.fallbackWeekly;
  return `${getEffectiveLocale()}:${idx}:${item.poolLabel}:${item.isActivePool}:${Boolean(item.isPending)}:${Boolean(item.showReserved)}:${item.minuteTick}:${item.poolData?.usedPct}:${item.poolData?.remainingPct}:${item.poolData?.reservedPct}:${item.poolData?.reservedLeaseCount}:${item.poolData?.resetTime}:${item.poolData?.weeklyUsedPct}:${item.poolData?.weeklyRemainingPct}:${item.poolData?.weeklyReservedPct}:${item.poolData?.weeklyReservedLeaseCount}:${item.poolData?.weeklyResetTime}:${c5h?.tokens}:${c5h?.costUsd}:${c5h?.calls}:${cWk?.tokens}:${cWk?.costUsd}:${cWk?.calls}:${fw?.isOfficial}:${fw?.usedPct}:${fw?.remainingPct}:${fw?.resetTime}:${fw?.title}:${fw?.tokens}:${fw?.costUsd}:${fw?.calls}`;
}

/**
 * 格式化可用额度面板右上角的账号订阅徽章（区分 Ultra 5x / 20x，并对 Pro / Free 去重）。
 *
 * @param {object|null|undefined} account
 * @returns {string}
 */
export function formatAccountTierBadge(account) {
  const tierName = String(account?.tierName || '').trim() || 'Google AI';
  const tierId = String(account?.tierId || '').trim().toLowerCase();
  const explicitMult = String(account?.tierMultiplier || '').trim();
  const inferredMult =
    explicitMult ||
    (/(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(`${tierId} ${tierName}`)
      ? '5x'
      : /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(`${tierId} ${tierName}`) || tierId === 'g1-ultra-tier'
        ? '20x'
        : '');
  const rawPlan = String(account?.planName || '').trim();
  const isUltra = /\bultra\b/i.test(tierName) || /ultra/i.test(tierId);

  if (isUltra) {
    if (inferredMult) {
      const hasMultInTier = new RegExp(`(?:^|\\s|·)${inferredMult}(?:$|\\s)`, 'i').test(tierName);
      return hasMultInTier ? tierName : `${tierName} · ${inferredMult}`;
    }
    if (rawPlan && !/^(?:pro|ultra)$/i.test(rawPlan)) {
      return `${tierName} · ${rawPlan}`;
    }
    return tierName;
  }

  if (!rawPlan) return tierName;
  const escapedPlan = rawPlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|\\s|·)${escapedPlan}(?:$|\\s)`, 'i').test(tierName)) {
    return tierName;
  }
  return `${tierName} · ${rawPlan}`;
}

export const QuotaPoolsWidget = defineComponent({
  name: 'QuotaPoolsWidget',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    const titleTextEl = h('span', { text: t('module.quotas') });
    const tierBadge = h('span', { className: 'panel-meta', text: 'Google AI · Pro' });
    const poolsListEl = h(
      'div',
      compactHover
        ? { className: 'wm-hover-quota-pools' }
        : { style: 'display: flex; flex-direction: column; gap: 0;' }
    );

    if (compactHover) {
      patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });
    }

    const legendActualTextEl = h('span', { text: t('quota.legendActual') });
    const legendReservedTextEl = h('span', { text: t('quota.legendReserved') });
    const reserveLegendEl = h(
      'div',
      { className: 'quota-reserve-legend', hidden: true },
      [
        h('span', { className: 'quota-legend-item' }, [
          h('span', { className: 'quota-legend-line is-actual', 'aria-hidden': 'true' }),
          legendActualTextEl,
        ]),
        h('span', { className: 'quota-legend-item' }, [
          h('span', { className: 'quota-legend-line is-reserved', 'aria-hidden': 'true' }),
          legendReservedTextEl,
        ]),
      ]
    );

    const quotaPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          titleTextEl,
        ]),
        tierBadge,
      ]),
      poolsListEl,
      reserveLegendEl,
    ]);

    function update({ data, minuteTick } = {}) {
      patchText(titleTextEl, t('module.quotas'));
      patchText(legendActualTextEl, t('quota.legendActual'));
      patchText(legendReservedTextEl, t('quota.legendReserved'));
      if (!data) {
        reserveLegendEl.hidden = true;
        if (compactHover) {
          patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
            keyFn: (item) => item.key,
            sigFn: quotaPoolRowSig,
            createRow: createPoolQuotaRow,
            updateRow: syncPoolQuotaRow,
          });
        }
        return;
      }

      const quotas = data.quotas || {};
      const showReserved = data.settings?.experimentalQuotaReservation === true;
      reserveLegendEl.hidden = !showReserved;
      const effTick = Number.isFinite(minuteTick) ? minuteTick : Math.floor(Date.now() / 30000);
      patchText(tierBadge, formatAccountTierBadge(data.account));
      patchKeyedList(poolsListEl, buildQuotaPoolItems(quotas, effTick, { showReserved }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });
    }

    return {
      el: quotaPanel,
      refs: { update, poolsListEl },
    };
  },
});
