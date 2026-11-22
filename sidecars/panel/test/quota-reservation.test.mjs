import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QR_LEASE_IDLE_EXPIRY_MS,
  createQuotaReservationTracker,
} from '../backend/quota-reservation.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';

const T0 = Date.parse('2026-11-22T09:00:00Z');
const RESET_5H = Date.parse('2026-11-22T14:00:00Z');
const RESET_WK = Date.parse('2026-11-28T09:00:00Z');

test('quota-reservation: 5h & weekly independently track staggered leases (错档触发)', () => {
  const tracker = createQuotaReservationTracker();

  // Bootstrap settled baseline: 5h ≈ 0.75 %/$, weekly ≈ 0.22 %/$
  const pool0 = new Map([
    [
      'Gemini',
      {
        poolKey: 'Gemini',
        has5h: true,
        hasWeekly: true,
        remainingFraction: 1 - 0.03,
        usedPct: 3.0,
        resetTime: new Date(RESET_5H).toISOString(),
        weeklyRemainingFraction: 1 - 0.11,
        weeklyUsedPct: 11.0,
        weeklyResetTime: new Date(RESET_WK).toISOString(),
      },
    ],
  ]);
  const stats0 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.0, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.0, unpricedCalls: 0 },
        exactCost5hUsd: 4.0,
        exactCostWeeklyUsd: 50.0,
        recent10m: { lastActivityMs: T0, activeSessionCount: 1, costUsd: 0.1 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool0,
    poolCycleStats: stats0,
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  assert.equal(pool0.get('Gemini').reservedPct, 0);
  assert.equal(pool0.get('Gemini').weeklyReservedPct, 0);

  // Heavy turn ($0.10): 5h jumps +1.0% (lease 1%), weekly jumps +0.5% (lease 0.5%)
  const t1 = T0 + 20_000;
  const pool1 = new Map([
    [
      'Gemini',
      {
        ...pool0.get('Gemini'),
        remainingFraction: 1 - 0.04,
        usedPct: 4.0,
        weeklyRemainingFraction: 1 - 0.115,
        weeklyUsedPct: 11.5,
      },
    ],
  ]);
  const stats1 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.1, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.1, unpricedCalls: 0 },
        exactCost5hUsd: 4.1,
        exactCostWeeklyUsd: 50.1,
        recent10m: { lastActivityMs: t1, activeSessionCount: 1, costUsd: 0.2 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool1,
    poolCycleStats: stats1,
    quotaFetchedAtMs: t1,
    nowMs: t1,
  });

  // 5h excess = 1.0 - 0.075 = 0.925 -> 0.9%; weekly excess = 0.5 - 0.022 = 0.478 -> 0.5%
  assert.equal(pool1.get('Gemini').reservedPct, 0.9);
  assert.equal(pool1.get('Gemini').reservedLeaseCount, 1);
  assert.equal(pool1.get('Gemini').weeklyReservedPct, 0.5);
  assert.equal(pool1.get('Gemini').weeklyReservedLeaseCount, 1);
});

test('quota-reservation: consumes inside active lease and snaps to 0 on partial refund (退还差额)', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Seed calibrated baseline: 1% per $1.00 (4.0% / $4.00)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Trigger 1.0% lease on $0.05 step -> excess = 0.95% -> 1.0%
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);

  // Follow-up turns spend $0.35 inside the lease while official stays flat at 5.0%
  const t2 = t1 + 30_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(r2.reservedPct, 0.6);

  // 10 minutes idle: server refunds remaining 0.6% (official drops 5.0% -> 4.4%)
  const t3 = t2 + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.4,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 0);
  assert.equal(r3.reservedLeaseCount, 0);
});

test('quota-reservation: stacks multiple concurrent session leases (2%+) and settles FIFO', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::weekly';

  // Seed weekly baseline: 0.2 %/$ (10% / $50)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 50.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Session A triggers +1.0% weekly lease
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 50.1,
    poolLastActivityMs: t1,
    activeSessionCount10m: 1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);
  assert.equal(r1.reservedLeaseCount, 1);

  // Session B opens concurrently and triggers a second +1.0% weekly lease -> total ~2.0%
  const t2 = t1 + 25_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 12.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 2,
    nowMs: t2,
  });
  assert.equal(r2.reservedPct, 2.0);
  assert.equal(r2.reservedLeaseCount, 2);

  // Session A's lease expires first (-0.98% refund) -> Session B's ~1.0% lease remains
  const t3 = t1 + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.02,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 1,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 1.0);
  assert.equal(r3.reservedLeaseCount, 1);

  // Session B's lease expires (-0.98% refund) -> back to 0%
  const t4 = t2 + 10 * 60 * 1000;
  const r4 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.04,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t4,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 0,
    nowMs: t4,
  });
  assert.equal(r4.reservedPct, 0);
  assert.equal(r4.reservedLeaseCount, 0);
});

test('quota-reservation: avoids false positives on genuinely large steps, handles TTL expiry & cycle reset', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Baseline 0.75 %/$
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 3.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Legitimate large $2.00 step -> expected +1.5%, official +1.5% -> NOT a reservation
  const t1 = T0 + 20_000;
  const rLarge = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 6.0,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(rLarge.reservedPct, 0);

  // Lease triggers (+0.5% on tiny $0.02 step), then idle past TTL+grace with no refund -> auto expires
  const t2 = t1 + 20_000;
  const rJump = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(rJump.reservedPct, 0.5);

  const tExpired = t2 + QR_LEASE_IDLE_EXPIRY_MS + 1_000;
  const rExpired = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: tExpired,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: tExpired,
  });
  assert.equal(rExpired.reservedPct, 0);

  // Trigger another lease then simulate 5h cycle rollover -> clears immediately while keeping rate
  const t3 = tExpired + 20_000;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 6.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 6.05,
    poolLastActivityMs: t3,
    nowMs: t3,
  });
  const tReset = t3 + 60_000;
  const rReset = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 0.0,
    resetTimeMs: RESET_5H + 5 * 3600 * 1000,
    quotaFetchedAtMs: tReset,
    cycleCostUsd: 0,
    poolLastActivityMs: t3,
    nowMs: tReset,
  });
  assert.equal(rReset.reservedPct, 0);
  assert.ok(tracker._buckets.get(key).ratePctPerUsd > 0, 'calibrated rate preserved across reset');
});

test('experimentalQuotaReservation setting defaults false and round-trips through schema & backup', () => {
  const def = normalizeFullSettings({});
  assert.equal(def.experimentalQuotaReservation, false);

  const enabled = normalizeFullSettings({ experimentalQuotaReservation: true });
  assert.equal(enabled.experimentalQuotaReservation, true);

  const json = buildExportableSettingsJson(enabled);
  const parsed = parseImportedSettingsJson(json);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patch.experimentalQuotaReservation, true);
});

test('backendHarness buildTelemetry populates reservedPct on pools across official quota jumps', async () => {
  let now = T0;
  const h = backendHarness({
    clock: () => now,
    userStatus: { email: 'tester@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.96,
              resetTime: new Date(RESET_5H).toISOString(),
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: new Date(RESET_WK).toISOString(),
            },
          ],
        },
      ],
    },
  });

  const p1 = await h.buildTelemetryPayloadInternal(null, true);
  const g1 = p1.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(p1.settings.experimentalQuotaReservation, false);
  assert.equal(g1.reservedPct, 0);
  assert.equal(g1.weeklyReservedPct, 0);

  // Advance clock beyond quota cache TTL and simulate a +1.0% 5h lease jump with no local cost change
  now += 20_000;
  h.state.quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.95,
            resetTime: new Date(RESET_5H).toISOString(),
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.845,
            resetTime: new Date(RESET_WK).toISOString(),
          },
        ],
      },
    ],
  };

  const p2 = await h.buildTelemetryPayloadInternal(null, true);
  const g2 = p2.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(g2.reservedPct, 1.0);
  assert.equal(g2.weeklyReservedPct, 0.5);

  const logRes = await h.dispatchBridgeApiRequest('/api/quota-reservation/log', 'GET');
  assert.equal(logRes.status, 200);
  const logJson = JSON.parse(logRes.body);
  assert.equal(logJson.ok, true);
  assert.ok(logJson.count >= 4, 'baseline + lease events recorded in ring buffer');
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === '5h' && e.event === 'lease'),
    '5h lease jump logged'
  );
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === 'weekly' && e.event === 'lease'),
    'weekly lease jump logged'
  );
});

test('QuotaPoolsWidget & SettingsOtherTab render experimental reservation bar/text and toggle', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const origNavigator = globalThis.navigator;
  let copiedClipboardText = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          copiedClipboardText = String(text);
        },
      },
    },
  });
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };
  const savedPatches = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/quota-reservation/log')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          generatedAt: '2026-11-22T09:20:00.000Z',
          count: 1,
          buckets: [{ pool: 'Gemini', win: '5h', usedPct: 4.1, reservedPct: 1, leases: 1 }],
          events: [
            {
              ts: '2026-11-22T09:19:50.000Z',
              pool: 'Gemini',
              win: '5h',
              event: 'lease',
              usedPct: 4.1,
              dUsed: 1,
              rsvPct: 1,
              leases: 1,
            },
          ],
        }),
      };
    }
    if (String(url).includes('/api/settings') && opts.method === 'POST') {
      const patch = JSON.parse(opts.body);
      savedPatches.push(patch);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, settings: patch }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }, { SettingsOtherTab }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
      import('../src/views/settings/SettingsOtherTab.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const baseData = {
      settings: { experimentalQuotaReservation: false },
      account: { tierName: 'Google AI Ultra', planName: 'Pro' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 4.1,
            remainingPct: 95.9,
            reservedPct: 1.0,
            reservedLeaseCount: 1,
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            weeklyUsedPct: 16.2,
            weeklyRemainingPct: 83.8,
            weeklyReservedPct: 0.5,
            weeklyReservedLeaseCount: 1,
            weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
          },
        ],
        weekly: { isOfficial: true },
      },
    };

    // Toggle OFF: no reserved highlight
    widget.refs.update({ data: baseData, minuteTick: 1 });
    const rsvTagsOff = widget.el.querySelectorAll('.quota-reserved-pct');
    assert.equal(rsvTagsOff.length, 2);
    assert.equal(rsvTagsOff[0].hidden, true);
    assert.equal(rsvTagsOff[1].hidden, true);
    const fillBarsOff = widget.el.querySelectorAll('.progress-fill');
    assert.equal(fillBarsOff[0].style.getPropertyValue('--fill-w'), '4.1%');

    // Toggle ON: violet reserved bar segment + colored percentage tag
    widget.refs.update({
      data: { ...baseData, settings: { experimentalQuotaReservation: true } },
      minuteTick: 1,
    });
    const rsvTagsOn = widget.el.querySelectorAll('.quota-reserved-pct');
    assert.equal(rsvTagsOn[0].hidden, false);
    assert.equal(rsvTagsOn[0].textContent, '预占 1.0%');
    assert.equal(rsvTagsOn[1].hidden, false);
    assert.equal(rsvTagsOn[1].textContent, '预占 0.5%');

    const fillBarsOn = widget.el.querySelectorAll('.progress-fill');
    const rsvBarsOn = widget.el.querySelectorAll('.progress-fill-reserved');
    assert.equal(fillBarsOn[0].style.getPropertyValue('--fill-w'), '3.1%');
    assert.equal(rsvBarsOn[0].style.getPropertyValue('--reserved-w'), '1%');
    assert.equal(rsvBarsOn[0].classList.contains('is-active'), true);
    assert.equal(fillBarsOn[1].style.getPropertyValue('--fill-w'), '15.7%');
    assert.equal(rsvBarsOn[1].style.getPropertyValue('--reserved-w'), '0.5%');

    // SettingsOtherTab renders experimental badge and persists toggle click
    const othTab = SettingsOtherTab({ onLayoutChange: () => {} });
    othTab.refs.renderSettings({ experimentalQuotaReservation: false }, []);
    const badge = othTab.el.querySelector('.settings-experimental-badge');
    assert.ok(badge, 'experimental badge rendered');
    assert.equal(badge.textContent, '试验性');

    const toggleBtns = othTab.refs.quotaReserveToggle.el.querySelectorAll('.seg-btn');
    assert.equal(toggleBtns.length, 2);
    toggleBtns[0].dispatchEvent({
      type: 'click',
      stopPropagation() {},
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
      savedPatches.some((p) => p.experimentalQuotaReservation === true),
      true,
      'clicking 开启 saves experimentalQuotaReservation: true'
    );

    othTab.refs.exportReserveLogBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 25));
    const copiedObj = JSON.parse(copiedClipboardText);
    assert.equal(copiedObj.count, 1);
    assert.equal(copiedObj.events[0].event, 'lease');
    assert.equal(copiedObj.events[0].pool, 'Gemini');

    othTab.destroy();
    widget.destroy();
  } finally {
    globalThis.fetch = origFetch;
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNavigator,
    });
  }
});
