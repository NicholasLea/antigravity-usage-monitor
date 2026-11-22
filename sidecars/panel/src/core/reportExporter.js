/**
 * @fileoverview RFC-4180 防公式注入 CSV 导出及 Markdown 诊断报告生成纯函数模块 (`reportExporter.js`)。
 * 零外部依赖、单遍 O(N) 拼接，供「按步查看」和「用量统计」视图复用。
 */

import {
  formatAnomalyKindLabel,
  formatCompactDateTime,
  formatMetric,
  formatSpeedMetric,
  formatTokensPrecise,
  formatUsd,
  mergeModelsByDisplayName,
  resolveModelDisplayInfo,
} from './formatters.js';

const PLAIN_SIGNED_NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;

/**
 * RFC-4180 安全转义单个 CSV 单元格，并防御电子表格公式注入（`=`, `+`, `-`, `@`, `\t`, `\r`）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (str.length > 0) {
    const first = str[0];
    if (
      (first === '=' ||
        first === '@' ||
        first === '\t' ||
        first === '\r' ||
        ((first === '+' || first === '-') && !PLAIN_SIGNED_NUMBER_RE.test(str.trim())))
    ) {
      str = `'${str}`;
    }
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells) {
  return cells.map(escapeCsvCell).join(',');
}

/**
 * 生成安全跨平台导出文件名（剔除非法路径字符并附加 `YYYYMMDD-HHmm` 时间戳）。
 *
 * @param {string} baseName
 * @param {string} ext
 * @param {number} [nowMs]
 * @returns {string}
 */
export function sanitizeExportFilename(baseName, ext = 'csv', nowMs = Date.now()) {
  const cleanBase = String(baseName || 'usage-report')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'usage-report';
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanExt = String(ext || 'csv').replace(/^\.+/, '');
  return `${cleanBase}-${stamp}.${cleanExt}`;
}

function escapeMdCell(value) {
  return String(value ?? '—')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 将当前步骤列表导出为带 UTF-8 BOM 的 RFC-4180 安全 CSV 字符串（Excel 打开中文零乱码）。
 *
 * @param {Array<object>} steps
 * @param {{ displaySettings?: object, includeBom?: boolean }} [opts]
 * @returns {string}
 */
export function buildStepsCsv(steps, { displaySettings = {}, includeBom = true } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const header = csvRow([
    'step',
    'timestamp',
    'agent',
    'model',
    'raw_model_id',
    'tok_per_sec',
    'ttft_sec',
    'duration_sec',
    'input_tokens',
    'cache_read_tokens',
    'output_tokens',
    'thinking_tokens',
    'response_tokens',
    'context_tokens',
    'cache_hit_pct',
    'cost_usd',
    'compaction',
    'anomaly_count',
    'anomalies',
    'prompt',
  ]);

  const rows = [header];
  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const mInfo = resolveModelDisplayInfo(st, displaySettings);
    const inTok = Number(st.inputTokens || 0);
    const cacheTok = Number(st.cacheReadTokens || 0);
    const outTok = Number(st.outputTokens || 0);
    const thinkTok = Number(st.thinkingTokens || 0);
    const replyTok =
      st.responseTokens != null ? Number(st.responseTokens) : Math.max(0, outTok - thinkTok);
    const promptTok = inTok + cacheTok;
    const cachePct =
      st.cacheHitPct != null && Number.isFinite(Number(st.cacheHitPct))
        ? Number(st.cacheHitPct).toFixed(1)
        : promptTok > 0
          ? ((cacheTok / promptTok) * 100).toFixed(1)
          : '0.0';
    const ctxTok = Number(st.contextTokens || promptTok + outTok);
    const anomCount = Number(st.anomaly?.count || 0);
    const anomDesc =
      anomCount > 0
        ? Object.entries(st.anomaly?.kinds || {})
            .map(([k, v]) => `${k}:${v}`)
            .join(';') || String(st.anomaly?.primaryKind || 'error')
        : '';
    rows.push(
      csvRow([
        st.stepIndex ?? '',
        st.createdAtMs ? new Date(st.createdAtMs).toISOString() : '',
        st.agentLabel || st.agentBadge || (st.isSubagent ? st.agentId || 'subagent' : 'main'),
        mInfo.text,
        st.rawModelId || st.modelKey || '',
        st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec))
          ? Number(st.tokPerSec).toFixed(2)
          : '',
        st.ttftSec != null && Number.isFinite(Number(st.ttftSec))
          ? Number(st.ttftSec).toFixed(3)
          : '',
        st.durationSec != null && Number.isFinite(Number(st.durationSec))
          ? Number(st.durationSec).toFixed(3)
          : '',
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        replyTok,
        ctxTok,
        cachePct,
        st.costUsd != null && Number.isFinite(Number(st.costUsd))
          ? Number(st.costUsd).toFixed(6)
          : '',
        st.isCompactionStep ? 'true' : 'false',
        anomCount,
        anomDesc,
        String(st.turnPrompt || st.rootTurnPrompt || '').replace(/\r?\n/g, ' ').trim(),
      ])
    );
  }
  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 生成当前会话（或筛选后步骤子集）的可分享 Markdown 诊断报告。
 *
 * @param {Array<object>} steps
 * @param {{ title?: string, cascadeId?: string, displaySettings?: object, filterNote?: string }} [opts]
 * @returns {string}
 */
export function buildStepsMarkdownReport(
  steps,
  { title = '', cascadeId = '', displaySettings = {}, filterNote = '' } = {}
) {
  const list = Array.isArray(steps) ? steps : [];
  let sumIn = 0;
  let sumCache = 0;
  let sumOut = 0;
  let sumCost = 0;
  let tpsSum = 0;
  let tpsCnt = 0;
  let ttftSum = 0;
  let ttftCnt = 0;
  let anomSteps = 0;
  let anomTotal = 0;
  let compactionCount = 0;
  const byModel = new Map();

  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const inTok = Number(st.inputTokens || 0);
    const cacheTok = Number(st.cacheReadTokens || 0);
    const outTok = Number(st.outputTokens || 0);
    const cost = Number(st.costUsd || 0);
    sumIn += inTok;
    sumCache += cacheTok;
    sumOut += outTok;
    if (Number.isFinite(cost) && cost > 0) sumCost += cost;
    if (!st.isCompactionStep && Number.isFinite(Number(st.tokPerSec)) && Number(st.tokPerSec) > 0) {
      tpsSum += Number(st.tokPerSec);
      tpsCnt += 1;
    }
    if (!st.isCompactionStep && Number.isFinite(Number(st.ttftSec)) && Number(st.ttftSec) >= 0) {
      ttftSum += Number(st.ttftSec);
      ttftCnt += 1;
    }
    if (st.isCompactionStep) compactionCount += 1;
    const ac = Number(st.anomaly?.count || 0);
    if (ac > 0) {
      anomSteps += 1;
      anomTotal += ac;
    }

    const mInfo = resolveModelDisplayInfo(st, displaySettings);
    const mKey = mInfo.text || 'Unknown';
    let mAcc = byModel.get(mKey);
    if (!mAcc) {
      mAcc = {
        label: mKey,
        calls: 0,
        inTok: 0,
        cacheTok: 0,
        outTok: 0,
        cost: 0,
        tpsSum: 0,
        tpsCnt: 0,
      };
      byModel.set(mKey, mAcc);
    }
    mAcc.calls += 1;
    mAcc.inTok += inTok;
    mAcc.cacheTok += cacheTok;
    mAcc.outTok += outTok;
    if (Number.isFinite(cost) && cost > 0) mAcc.cost += cost;
    if (!st.isCompactionStep && Number.isFinite(Number(st.tokPerSec)) && Number(st.tokPerSec) > 0) {
      mAcc.tpsSum += Number(st.tokPerSec);
      mAcc.tpsCnt += 1;
    }
  }

  const totalTok = sumIn + sumCache + sumOut;
  const promptTok = sumIn + sumCache;
  const cacheHitPct = promptTok > 0 ? ((sumCache / promptTok) * 100).toFixed(1) : '0.0';
  const avgTps = tpsCnt > 0 ? formatSpeedMetric(tpsSum / tpsCnt, ' tok/s') : '—';
  const avgTtft = ttftCnt > 0 ? formatMetric(ttftSum / ttftCnt, 's') : '—';
  const heading = title ? `# ${title}` : '# Session Telemetry Report';

  const lines = [
    heading,
    '',
    ...(cascadeId ? [`- **Session ID**: \`${cascadeId}\``] : []),
    ...(filterNote ? [`- **Scope**: ${filterNote}`] : []),
    `- **Steps**: ${list.length}${compactionCount > 0 ? ` (${compactionCount} compaction)` : ''}${anomTotal > 0 ? ` · **Anomalies**: ${anomTotal} across ${anomSteps} steps` : ''}`,
    `- **Total Tokens**: ${formatTokensPrecise(totalTok)} (Input ${formatTokensPrecise(sumIn)} / Cache ${formatTokensPrecise(sumCache)} · ${cacheHitPct}% / Output ${formatTokensPrecise(sumOut)})`,
    `- **Est. Cost**: ${formatUsd(sumCost, { precise: sumCost > 0 && sumCost < 0.1 })} · **Avg Speed**: ${avgTps} · **Avg TTFT**: ${avgTtft}`,
  ];

  const sortedModels = Array.from(byModel.values()).sort(
    (a, b) => b.cost - a.cost || b.inTok + b.cacheTok + b.outTok - (a.inTok + a.cacheTok + a.outTok)
  );
  if (sortedModels.length > 0) {
    lines.push(
      '',
      '## Model Breakdown',
      '',
      '| Model | Calls | Total Tokens | Cache Hit | Avg Speed | Est. Cost |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of sortedModels) {
      const mTotal = m.inTok + m.cacheTok + m.outTok;
      const mPrompt = m.inTok + m.cacheTok;
      const mCache = mPrompt > 0 ? `${((m.cacheTok / mPrompt) * 100).toFixed(1)}%` : '0.0%';
      const mTps = m.tpsCnt > 0 ? formatSpeedMetric(m.tpsSum / m.tpsCnt, ' tok/s') : '—';
      lines.push(
        `| ${escapeMdCell(m.label)} | ${m.calls} | ${formatTokensPrecise(mTotal)} | ${mCache} | ${mTps} | ${formatUsd(m.cost, { precise: m.cost > 0 && m.cost < 0.1 })} |`
      );
    }
  }

  const topCostly = list
    .filter((st) => Number(st?.costUsd || 0) > 0)
    .slice()
    .sort((a, b) => Number(b.costUsd || 0) - Number(a.costUsd || 0))
    .slice(0, 5);
  if (topCostly.length > 0) {
    lines.push(
      '',
      '## Top Costliest Steps',
      '',
      '| Step | Time | Model | Speed | TTFT | Context | Cost |',
      '| ---: | --- | --- | ---: | ---: | ---: | ---: |'
    );
    for (const st of topCostly) {
      const mInfo = resolveModelDisplayInfo(st, displaySettings);
      const timeStr = st.createdAtMs ? formatCompactDateTime(st.createdAtMs) : '—';
      const ctxTok = Number(
        st.contextTokens ||
          Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0) + Number(st.outputTokens || 0)
      );
      lines.push(
        `| #${st.stepIndex ?? '—'} | ${timeStr} | ${escapeMdCell(mInfo.text)} | ${formatSpeedMetric(st.tokPerSec, ' tok/s')} | ${formatMetric(st.ttftSec, 's')} | ${formatTokensPrecise(ctxTok)} | ${formatUsd(st.costUsd, { precise: true })} |`
      );
    }
  }

  if (anomTotal > 0) {
    const anomKindTotals = new Map();
    for (const st of list) {
      if (!st?.anomaly?.kinds) continue;
      for (const [k, v] of Object.entries(st.anomaly.kinds)) {
        const n = Number(v || 0);
        if (n > 0) anomKindTotals.set(k, (anomKindTotals.get(k) || 0) + n);
      }
    }
    if (anomKindTotals.size > 0) {
      const summary = Array.from(anomKindTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${formatAnomalyKindLabel(k)} ×${v}`)
        .join(', ');
      lines.push('', `**Anomaly Summary**: ${summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 将历史用量统计视图当前区间数据导出为结构化 CSV（含摘要、模型、项目、会话及趋势明细）。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, includeBom?: boolean }} [opts]
 * @returns {string}
 */
export function buildConsumptionCsv(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, includeBom = true } = {}
) {
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];
  const trend = Array.isArray(cons.trendSeries) ? cons.trendSeries : [];

  const rows = [
    csvRow(['section', 'name', 'calls', 'input_tokens', 'cache_read_tokens', 'output_tokens', 'total_tokens', 'cache_hit_pct', 'cost_usd', 'extra']),
    csvRow([
      'summary',
      range.label || range.key || 'all',
      Number(acc.calls || 0),
      Number(acc.inputTokens || 0),
      Number(acc.cacheReadTokens || 0),
      Number(acc.outputTokens || 0),
      Number(acc.totalTokens || 0),
      Number(acc.cacheHitPct || 0).toFixed(1),
      Number(acc.costUsd || 0).toFixed(4),
      `saved_usd=${Number(acc.savedCostUsd || 0).toFixed(4)}`,
    ]),
  ];

  for (const m of models) {
    rows.push(
      csvRow([
        'model',
        m.displayText || m.label || m.shortName || '—',
        Number(m.calls || 0),
        Number(m.inputTokens || 0),
        Number(m.cacheReadTokens || 0),
        Number(m.outputTokens || 0),
        Number(m.totalTokens || 0),
        Number(m.cacheHitPct || 0).toFixed(1),
        Number(m.costUsd || 0).toFixed(4),
        m.avgTokPerSec != null ? `avg_tps=${Number(m.avgTokPerSec).toFixed(1)}` : '',
      ])
    );
  }

  for (const w of workspaces) {
    rows.push(
      csvRow([
        'project',
        w.label || w.workspacePath || 'unbound',
        Number(w.calls || 0),
        Number(w.inputTokens || 0),
        Number(w.cacheReadTokens || 0),
        Number(w.responseTokens || 0) + Number(w.thinkingTokens || 0),
        Number(w.totalTokens || 0),
        Number(w.cacheHitPct || 0).toFixed(1),
        Number(w.costUsd || 0).toFixed(4),
        `sessions=${Number(w.sessionCount || 0)}`,
      ])
    );
  }

  for (const c of sessions) {
    rows.push(
      csvRow([
        'session',
        c.title || c.cascadeId || '—',
        Number(c.calls || 0),
        Number(c.inputTokens || 0),
        Number(c.cacheReadTokens || 0),
        Number(c.responseTokens || 0) + Number(c.thinkingTokens || 0),
        Number(c.totalTokens || 0),
        Number(c.cacheHitPct || 0).toFixed(1),
        Number(c.costUsd || 0).toFixed(4),
        c.sourceName || c.appSource || '',
      ])
    );
  }

  for (const slot of trend) {
    if (!slot || !(Number(slot.tokens || 0) > 0 || Number(slot.calls || 0) > 0)) continue;
    rows.push(
      csvRow([
        'trend',
        slot.fullLabel || slot.label || '',
        Number(slot.calls || 0),
        Number(slot.inputTokens || 0),
        Number(slot.cacheReadTokens || 0),
        Number(slot.outputTokens || 0),
        Number(slot.tokens || 0),
        '',
        Number(slot.costUsd || 0).toFixed(4),
        slot.granularity || '',
      ])
    );
  }

  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 生成历史用量统计当前区间的 Markdown 汇总报告。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object }} [opts]
 * @returns {string}
 */
export function buildConsumptionMarkdownReport(
  consumption,
  modelBreakdown = [],
  { displaySettings = {} } = {}
) {
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];

  const rangeLabel = range.label || range.key || 'All Time';
  const lines = [
    `# Usage Report · ${rangeLabel}`,
    '',
    `- **Total Tokens**: ${formatTokensPrecise(acc.totalTokens || 0)} (${Number(acc.calls || 0)} calls)`,
    `- **Est. Cost**: ${formatUsd(acc.costUsd || 0)} (Cache Saved ${formatUsd(acc.savedCostUsd || 0)})`,
    `- **Cache Hit Rate**: ${Number(acc.cacheHitPct || 0).toFixed(1)}% (Input ${formatTokensPrecise(acc.inputTokens || 0)} / Cache ${formatTokensPrecise(acc.cacheReadTokens || 0)} / Output ${formatTokensPrecise(acc.outputTokens || 0)})`,
  ];

  if (models.length > 0) {
    lines.push(
      '',
      '## Models',
      '',
      '| Model | Calls | Tokens | Cache Hit | Avg Speed | Est. Cost |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of models) {
      lines.push(
        `| ${escapeMdCell(m.displayText || m.label || m.shortName)} | ${Number(m.calls || 0)} | ${formatTokensPrecise(m.totalTokens || 0)} | ${Number(m.cacheHitPct || 0).toFixed(1)}% | ${m.avgTokPerSec != null ? formatSpeedMetric(m.avgTokPerSec, ' tok/s') : '—'} | ${formatUsd(m.costUsd || 0)} |`
      );
    }
  }

  if (workspaces.length > 0) {
    lines.push(
      '',
      '## Projects',
      '',
      '| Project | Sessions | Calls | Tokens | Cache Hit | Est. Cost |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const w of workspaces) {
      lines.push(
        `| ${escapeMdCell(w.label || w.workspacePath || 'Unbound')} | ${Number(w.sessionCount || 0)} | ${Number(w.calls || 0)} | ${formatTokensPrecise(w.totalTokens || 0)} | ${Number(w.cacheHitPct || 0).toFixed(1)}% | ${formatUsd(w.costUsd || 0)} |`
      );
    }
  }

  if (sessions.length > 0) {
    lines.push(
      '',
      '## Top Sessions',
      '',
      '| Session | Calls | Tokens | Cache Hit | Est. Cost |',
      '| --- | ---: | ---: | ---: | ---: |'
    );
    for (const c of sessions.slice(0, 8)) {
      lines.push(
        `| ${escapeMdCell(c.title || c.cascadeId)} | ${Number(c.calls || 0)} | ${formatTokensPrecise(c.totalTokens || 0)} | ${Number(c.cacheHitPct || 0).toFixed(1)}% | ${formatUsd(c.costUsd || 0)} |`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
