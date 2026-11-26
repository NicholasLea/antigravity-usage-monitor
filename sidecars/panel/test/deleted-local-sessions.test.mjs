import test from 'node:test';
import assert from 'node:assert/strict';
import { backendHarness } from './backend-harness.mjs';

const DELETED_ID = '11111111-1111-4111-8111-111111111111';
const LIVE_ID = '22222222-2222-4222-8222-222222222222';
const EMPTY_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '44444444-4444-4444-8444-444444444444';
const STORE_DIR = '/test-home/.gemini/antigravity/conversations';
const T0 = Date.parse('2026-11-26T12:00:00Z');

function makeStep(overrides = {}) {
  return {
    createdAtMs: T0 - 10_000,
    modelKey: 'gemini-4-neon-high',
    inputTokens: 70_000,
    cacheReadTokens: 20_000,
    outputTokens: 10_000,
    thinkingTokens: 2_000,
    responseTokens: 8_000,
    ...overrides,
  };
}

test('deleted local session is hidden from conversations list while retaining usage stats and unarchives if restored', async () => {
  const diskDirs = { [STORE_DIR]: [] };
  const h = backendHarness({
    clock: () => T0,
    userStatus: { email: 'owner@example.test' },
    diskDirs,
    cache: {
      [DELETED_ID]: {
        title: 'Deleted Private Session',
        appSource: 'standalone',
        accountName: 'owner@example.test',
        diskMtimeMs: T0 - 10_000,
        lastModifiedMs: T0 - 10_000,
        steps: [makeStep()],
      },
    },
  });

  const p1 = await h.buildTelemetryPayloadInternal(DELETED_ID, true, { range: 'all' });
  assert.equal(p1.conversations.length, 0, 'deleted local session hidden from selector');
  assert.equal(p1.activeConversation?.cascadeId ?? null, null, 'activeConversation does not cling to deleted id');
  assert.equal(p1.consumption.account.calls, 1, 'usage calls retained');
  assert.equal(p1.consumption.account.totalTokens, 100_000, 'usage tokens retained');
  assert.ok(p1.consumption.account.costUsd > 0, 'usage cost retained');
  assert.equal(h.getCachedTrajectory(DELETED_ID)?.archived, true, 'cached entry archived for ledger preservation');

  // Restoring local file brings the session back without double counting
  diskDirs[STORE_DIR] = [`${DELETED_ID}.pb`];
  const p2 = await h.buildTelemetryPayloadInternal(DELETED_ID, true, { range: 'all' });
  assert.equal(p2.conversations.length, 1, 'restored local session reappears in selector');
  assert.equal(p2.conversations[0].cascadeId, DELETED_ID);
  assert.equal(h.getCachedTrajectory(DELETED_ID)?.archived, undefined, 'archived flag cleared on restore');
  assert.equal(p2.consumption.account.calls, 1, 'restored copy does not double count');
  assert.equal(p2.consumption.account.totalTokens, 100_000);
});

test('archived redacted sessions and empty deleted sessions stay hidden from conversations while live sessions remain selectable', async () => {
  const h = backendHarness({
    clock: () => T0,
    userStatus: { email: 'owner@example.test' },
    diskDirs: { [STORE_DIR]: [`${LIVE_ID}.pb`] },
    summaries: {
      [LIVE_ID]: {
        summary: 'Active Session',
        stepCount: 1,
        lastModifiedTime: new Date(T0).toISOString(),
      },
    },
    cache: {
      [DELETED_ID]: {
        title: '[Deleted Session]',
        archived: true,
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0 - 5_000,
        steps: [makeStep()],
      },
      [EMPTY_ID]: {
        title: 'Deleted Empty Session',
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0 - 4_000,
        steps: [],
      },
      [LIVE_ID]: {
        title: 'Active Session',
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0,
        steps: [makeStep({ createdAtMs: T0 - 1_000 })],
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal(DELETED_ID, true, { range: 'all' });
  assert.deepEqual(
    Array.from(p.conversations, (c) => c.cascadeId),
    [LIVE_ID],
    'only live session appears in recent conversations'
  );
  assert.equal(p.activeConversation?.cascadeId, LIVE_ID, 'falls back to latest live session');
  assert.equal(p.consumption.account.calls, 2, 'archived redacted session still contributes to account usage');
  assert.equal(p.consumption.account.totalTokens, 200_000);
  assert.equal(h.getCachedTrajectory(EMPTY_ID), undefined, 'empty deleted ghost removed from cache');
});

test('account switch, unreadable store, and stale parent subagentRefs are handled safely', async () => {
  const diskDirs = { [STORE_DIR]: [] };
  const h = backendHarness({
    clock: () => T0,
    userStatus: { email: 'other@example.test' },
    diskDirs,
    cache: {
      [DELETED_ID]: {
        title: 'Owner Account Session',
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0 - 10_000,
        steps: [makeStep()],
      },
    },
  });

  // 1. Different account signed in -> must not falsely archive or hide owner@example.test's session
  const pOther = await h.buildTelemetryPayloadInternal(null, true, { range: 'all' });
  assert.equal(pOther.conversations.length, 1);
  assert.equal(pOther.conversations[0].cascadeId, DELETED_ID);
  assert.equal(h.getCachedTrajectory(DELETED_ID)?.archived, undefined);

  // 2. Owner signs back in, but store directory throws EACCES -> incomplete scan must not hide or archive
  h.state.userStatus.email = 'owner@example.test';
  diskDirs[STORE_DIR] = Object.assign(new Error('busy'), { code: 'EACCES' });
  const pBusy = await h.buildTelemetryPayloadInternal(null, true, { range: 'all' });
  assert.equal(pBusy.conversations.length, 1);
  assert.equal(h.getCachedTrajectory(DELETED_ID)?.archived, undefined);

  // 3. Store becomes readable again -> confirmed missing -> archived and hidden
  diskDirs[STORE_DIR] = [];
  const pGone = await h.buildTelemetryPayloadInternal(null, true, { range: 'all' });
  assert.equal(pGone.conversations.length, 0);
  assert.equal(h.getCachedTrajectory(DELETED_ID)?.archived, true);

  // 4. Stale parent subagentRefs cannot resurrect an explicitly archived child
  const hParent = backendHarness({
    clock: () => T0,
    userStatus: { email: 'owner@example.test' },
    diskDirs: { [STORE_DIR]: [`${LIVE_ID}.pb`] },
    summaries: {
      [LIVE_ID]: {
        summary: 'Live Parent',
        stepCount: 1,
        lastModifiedTime: new Date(T0).toISOString(),
      },
    },
    cache: {
      [LIVE_ID]: {
        title: 'Live Parent',
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0,
        steps: [makeStep()],
        subagentRefs: [{ cascadeId: CHILD_ID, role: 'Deleted Worker' }],
      },
      [CHILD_ID]: {
        title: '[Deleted Session]',
        archived: true,
        isSubagent: true,
        parentConversationId: LIVE_ID,
        rootConversationId: LIVE_ID,
        appSource: 'standalone',
        accountName: 'owner@example.test',
        lastModifiedMs: T0 - 5_000,
        steps: [makeStep()],
      },
    },
  });
  const pParent = await hParent.buildTelemetryPayloadInternal(LIVE_ID, true, { range: 'all' });
  assert.equal(pParent.conversations.length, 1);
  assert.equal(pParent.conversations[0].subagentCount, 0, 'archived child not resurrected under live parent');
  assert.equal(pParent.consumption.account.calls, 2, 'archived child usage still counted');
});
