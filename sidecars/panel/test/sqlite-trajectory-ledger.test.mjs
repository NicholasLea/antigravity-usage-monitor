import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { MODEL_IDENTITY_VERSION } from '../trajectory-metrics.mjs';
import {
  DEFAULT_HOT_SESSION_LRU_LIMIT,
  createTrajectoryCacheStore,
} from '../backend/trajectory-cache-store.mjs';

const execFileAsync = promisify(execFile);

function loadJsonHelper(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function makeRichStep(stepIndex, overrides = {}) {
  const baseMs = Date.parse('2026-11-20T08:00:00Z') + stepIndex * 5_000;
  return {
    stepIndex,
    isCompactionStep: false,
    modelKey: 'MODEL_PLACEHOLDER_M429',
    modelSource: 'generatorMetadata.chatModel.model',
    responseModel: 'gemini-4-carbon-high',
    modelIdentityVersion: MODEL_IDENTITY_VERSION,
    modelDisplayName: 'Gemini 4 Carbon (High)',
    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    createdAt: new Date(baseMs).toISOString(),
    createdAtMs: baseMs,
    hasVisibleText: true,
    hasToolCalls: false,
    inputTokens: 10_000 + stepIndex * 100,
    cacheReadTokens: 40_000,
    outputTokens: 600,
    thinkingTokens: 200,
    responseTokens: 400,
    estimatedContextTokens: 50_600,
    maxContextBudgetTokens: 1_000_000,
    reportedContextLimitTokens: 1_000_000,
    contextBreakdown: {
      totalTokens: 50_600,
      messagesTokens: 32_000,
      userInputTokens: 8_000,
      assistantTokens: 14_000,
      toolResultsTokens: 10_000,
      subagentTokens: 0,
      checkpointTokens: 0,
      systemToolsTokens: 9_600,
      mcpToolsTokens: 2_000,
      skillsTokens: 3_000,
      systemPromptTokens: 3_000,
      userRulesTokens: 1_000,
    },
    measurementVersion: 4,
    isComplete: true,
    nativeTtftSec: 1.5,
    nativeStreamSec: 4.5,
    viewableDelaySec: 1.6,
    ttftSec: 1.5,
    ttftSource: 'generator_metadata',
    thinkingDurationSec: 1.2,
    totalDurationSec: 6.0,
    totalTokPerSec: 100,
    speedBasis: 'request_total',
    speedSampleEligible: true,
    speedReason: null,
    turnIndex: 1,
    isTurnStart: stepIndex === 1,
    turnPrompt: `Prompt for step ${stepIndex}`,
    turnPromptClean: `Prompt for step ${stepIndex}`,
    turnHasMedia: false,
    turnMediaOnly: false,
    ...overrides,
  };
}

function encodeVarint(val) {
  let v = BigInt(val);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodeFieldVarint(fieldNo, val) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)]);
}

function encodeFieldBytes(fieldNo, bufOrStr) {
  const b = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(b.length), b]);
}

function encodeTimestamp(sec) {
  return encodeFieldBytes(1, Buffer.concat([encodeFieldVarint(1, sec)])).subarray(2);
}

function encodeStepMeta({ createdSec, finishedSec, stepIndex, originCid, inputTokens, outputTokens }) {
  const ts = (sec) => encodeFieldBytes(1, Buffer.concat([encodeFieldVarint(1, sec)])).subarray(2);
  const mu = Buffer.concat([
    encodeFieldVarint(1, 1429), // MODEL_PLACEHOLDER_M429 (Carbon High)
    encodeFieldVarint(2, inputTokens),
    encodeFieldVarint(3, outputTokens),
    encodeFieldVarint(6, 24),
  ]);
  return Buffer.concat([
    encodeFieldBytes(1, ts(createdSec)),
    encodeFieldBytes(7, ts(finishedSec)),
    encodeFieldBytes(9, mu),
    encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, stepIndex), encodeFieldBytes(4, originCid)])),
  ]);
}

test('SQLite ledger automatically migrates legacy trajectory_usage_cache.json to .sqlite, archives .bak, and preserves lossless details & anomalies', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-mig-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const legacyJson = join(tmp, 'trajectory_usage_cache.json');
  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const mainCid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const subCid = 'bbbbbbbb-2222-4222-8222-222222222222';

  const step1 = makeRichStep(1, {
    accountName: 'alice@example.com',
    anomaly: {
      count: 2,
      severity: 'warn',
      primaryKind: 'rate_limit',
      totalDelaySec: 8.5,
      kinds: { rate_limit: 2 },
    },
    anomalySig: 'rl:2',
  });
  const cpStep = makeRichStep(2, {
    isCompactionStep: true,
    modelKey: undefined,
    responseModel: '',
    modelDisplayName: '',
    contextBreakdown: null,
    inputTokens: 5_000,
    cacheReadTokens: 0,
    outputTokens: 300,
    thinkingTokens: 0,
    responseTokens: 300,
  });
  delete cpStep.modelKey;

  writeFileSync(
    legacyJson,
    JSON.stringify({
      [mainCid.toUpperCase()]: {
        title: 'Legacy Migrated Root',
        signature: 'v10-model-identity:sqlite:1::100:200|0:0',
        accountName: 'bob@example.com',
        workspaceUri: 'file:///f:/demo/project',
        subagentRefs: [{ cascadeId: subCid, role: 'Researcher', typeName: 'research', spawnOrder: 0 }],
        steps: [step1, cpStep],
      },
      [subCid]: {
        title: 'Researcher',
        parentConversationId: mainCid,
        rootConversationId: mainCid,
        subagentSpec: { typeName: 'research', role: 'Researcher' },
        steps: [makeRichStep(1, { inputTokens: 2_000, outputTokens: 100 })],
      },
    }),
    'utf8'
  );

  const store = createTrajectoryCacheStore({
    cacheFilePath: legacyJson,
    sqliteFilePath: sqliteFile,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });

  // Cold startup list reads slim accounting entries without hydrating detail_json
  const entries = store.listCachedTrajectoryEntries();
  assert.equal(entries.length, 2);
  assert.equal(existsSync(sqliteFile), true);
  assert.equal(existsSync(legacyJson), false, 'legacy JSON moved out of active path');
  assert.equal(existsSync(`${legacyJson}.bak`), true, 'legacy JSON safely archived to .bak');

  // Cold entry omits heavy contextBreakdown/turnPrompt, retains anomaly/accountName/inferred compaction model!
  assert.equal(store.isConversationCold(mainCid), true);
  const coldMain = store.getCachedTrajectoryEntryByLower(mainCid)?.entry;
  assert.ok(coldMain);
  assert.equal(coldMain.steps.length, 2);
  assert.equal(coldMain.steps[0].contextBreakdown, undefined, 'cold step omits heavy contextBreakdown');
  assert.equal(coldMain.steps[0].turnPrompt, undefined, 'cold step omits heavy turnPrompt');
  assert.deepEqual(coldMain.steps[0].anomaly, step1.anomaly, 'cold step preserves anomaly for model ranking');
  assert.equal(coldMain.steps[0].accountName, 'alice@example.com');
  assert.equal(coldMain.steps[1].modelKey, 'MODEL_PLACEHOLDER_M429', 'compaction step inferred model during migration');

  // Explicit hydration restores 100% lossless step details
  const hydratedMain = store.getHydratedTrajectoryEntryByLower(mainCid)?.entry;
  assert.equal(store.isConversationCold(mainCid), false);
  assert.deepEqual(hydratedMain.steps[0].contextBreakdown, step1.contextBreakdown);
  assert.equal(hydratedMain.steps[0].turnPrompt, 'Prompt for step 1');
  assert.equal(hydratedMain.steps[0].reportedContextLimitTokens, 1_000_000);
});

test('Hot 24-session LRU evicts cold detail memory, never thrashes during full-list scans, and re-hydrates on demand', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-lru-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const store = createTrajectoryCacheStore({
    sqliteFilePath: sqliteFile,
    enableSqlite: true,
    hotSessionLimit: 24,
  });

  const originalStep0 = makeRichStep(1, {
    turnPrompt: 'Deep historical architecture prompt #0',
    anomaly: { count: 1, severity: 'danger', primaryKind: 'timeout', totalDelaySec: 30, kinds: { timeout: 1 } },
  });

  for (let i = 0; i < 32; i += 1) {
    const cid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    store.setCachedTrajectory(cid, {
      title: `Session #${i}`,
      signature: `v10-model-identity:sqlite:1::${i}`,
      wasRunning: false,
      contextGroupsTelemetry: 3,
      turnRailTelemetry: true,
      anomalyTelemetry: 1,
      steps: [i === 0 ? originalStep0 : makeRichStep(1, { turnPrompt: `Prompt #${i}` })],
    });
  }

  // Before flush, dirty unflushed sessions MUST NOT drop detail_json prematurely!
  const cid0 = '00000000-0000-4000-8000-000000000000';
  assert.ok(store.getCachedTrajectory(cid0).steps[0].contextBreakdown, 'dirty unflushed session retains detail');

  // Flush writes all 32 to SQLite, then trims hot LRU down to 24!
  assert.equal(store.flushTrajectoryCacheNow(), true);
  assert.equal(store.getHotSessionCount(), 24);
  assert.equal(store.isConversationCold(cid0), true, 'oldest session #0 evicted to cold slim mode');
  assert.equal(store.getCachedTrajectory(cid0).steps[0].contextBreakdown, undefined);
  assert.deepEqual(store.getCachedTrajectory(cid0).steps[0].anomaly, originalStep0.anomaly);

  // Iterating all 32 conversations via getCachedTrajectory / listCachedTrajectoryEntries MUST NOT hydrate cold sessions!
  for (const [cid] of store.listCachedTrajectoryEntries()) {
    const e = store.getCachedTrajectory(cid);
    assert.equal(e.steps.length, 1);
  }
  assert.equal(store.isConversationCold(cid0), true, 'scan loop caused zero cold SQLite reads');
  assert.equal(store.getHotSessionCount(), 24);

  // Explicit hydration of cold session #0 restores exact original step and evicts #8
  const hydrated0 = store.getHydratedTrajectory(cid0);
  assert.equal(store.isConversationCold(cid0), false);
  assert.equal(store.getHotSessionCount(), 24);
  assert.equal(isDeepStrictEqual(hydrated0.steps[0], originalStep0), true);
  assert.equal(store.isConversationCold('00000000-0000-4000-8000-000000000008'), true);
});

test('Step-level O(delta) UPSERT, conversation undo tail truncation, and cross-process WAL sync keep zero file locks', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-wal-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const storeWriter = createTrajectoryCacheStore({ sqliteFilePath: sqliteFile, enableSqlite: true });
  const storeReader = createTrajectoryCacheStore({ sqliteFilePath: sqliteFile, enableSqlite: true });

  const cid = 'cccccccc-3333-4333-8333-333333333333';
  const s1 = makeRichStep(1, { inputTokens: 1_000 });
  const s2 = makeRichStep(2, { inputTokens: 2_000 });
  const s3 = makeRichStep(3, { inputTokens: 3_000 });
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session',
    signature: 'sig-3',
    steps: [s1, s2, s3],
  });
  storeWriter.flushTrajectoryCacheNow();

  // Reader hydrates initial 3 steps
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 3);

  // Append step #4: verify SQLite now has 4 rows and Reader picks up incremental write_seq update
  const s4 = makeRichStep(4, { inputTokens: 4_000 });
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session',
    signature: 'sig-4',
    steps: [s1, s2, s3, s4],
  });
  storeWriter.flushTrajectoryCacheNow();

  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 4);
  assert.equal(storeReader.getCachedTrajectory(cid).steps[3].inputTokens, 4_000);

  // Simulate Undo in Antigravity: steps shrink from 4 back to 2 -> pos 2 & 3 MUST be deleted from SQLite!
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session (Undone)',
    signature: 'sig-2',
    steps: [s1, s2],
  });
  storeWriter.flushTrajectoryCacheNow();

  const dbCheck = new DatabaseSync(sqliteFile, { readOnly: true });
  const stepRowCount = dbCheck
    .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE cascade_id = ?')
    .get(cid).cnt;
  dbCheck.close();
  assert.equal(stepRowCount, 2, 'undone tail steps pos >= 2 truncated cleanly');

  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 2);

  // Simulate clearCache on Writer (with cid live -> cleared): Reader syncs epoch bump and removes cid!
  storeWriter.clearCache({ liveCascadeIds: [cid] });
  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid), undefined);
});

test('Deleting source conversation in Antigravity + clicking Rebuild Cache permanently preserves deleted conversation tokens, costs, and details', async (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-perm-'));
  t.after(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore Windows WAL cleanup race
    }
  });

  const geminiDir = join(tmp, 'gemini');
  const agyDir = join(geminiDir, 'antigravity');
  const convDir = join(agyDir, 'conversations');
  const dataDir = join(tmp, 'panel-data');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const cidDeleted = 'dddddddd-4444-4444-8444-444444444444';
  const cidLive = 'eeeeeeee-5555-4555-8555-555555555555';
  const baseSec = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);

  // Create conversation_summaries.db and both .db files
  const sumDbPath = join(agyDir, 'conversation_summaries.db');
  const sumDb = new DatabaseSync(sumDbPath);
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      status TEXT,
      source TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      agent_name TEXT,
      not_fully_idle INTEGER,
      killed INTEGER,
      step_count INTEGER,
      last_modified_time TEXT,
      app_data_dir TEXT,
      raw_summary BLOB
    );
    CREATE TABLE conversation_parents (conversation_id TEXT, parent_id TEXT);
  `);
  const insSum = sumDb.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary) VALUES (?, ?, 'CASCADE_RUN_STATUS_IDLE', '', 2, '2026-11-18T00:01:00Z', 'antigravity', ?)"
  );
  insSum.run(cidDeleted, 'Deleted Precious Ledger Task', Buffer.alloc(0));
  insSum.run(cidLive, 'Surviving Live Task', Buffer.alloc(0));
  sumDb.close();

  const createConvSqlite = (cid, promptText, inTok, outTok) => {
    const p = join(convDir, `${cid}.db`);
    const db = new DatabaseSync(p);
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
    db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)').run(
      Buffer.concat([
        encodeFieldBytes(1, encodeTimestamp(baseSec + 1)),
        encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, 0), encodeFieldBytes(4, cid)])),
      ]),
      encodeFieldBytes(19, encodeFieldBytes(2, promptText))
    );
    db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)').run(
      encodeStepMeta({
        createdSec: baseSec + 10,
        finishedSec: baseSec + 15,
        stepIndex: 1,
        originCid: cid,
        inputTokens: inTok,
        outputTokens: outTok,
      }),
      encodeFieldBytes(20, encodeFieldBytes(1, 'Completed task'))
    );
    db.close();
    return p;
  };

  const deletedDbFile = createConvSqlite(cidDeleted, 'Keep my billing forever', 100_000, 10_000);
  const liveDbFile = createConvSqlite(cidLive, 'Still working on this', 50_000, 5_000);

  const apiUrl = new URL('../backend/api-actions.mjs', import.meta.url).href;
  const telUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
  const cfgUrl = new URL('../backend/config.mjs', import.meta.url).href;

  const script = `
    import { unlinkSync } from 'node:fs';
    import { executeRebuildCacheAction } from ${JSON.stringify(apiUrl)};
    import { buildTelemetryPayloadInternal } from ${JSON.stringify(telUrl)};
    import { flushTrajectoryCacheNow, getCachedTrajectory, getHydratedTrajectory } from ${JSON.stringify(cfgUrl)};
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

    // 1. Initial scan records both conversations in trajectory_store.sqlite
    const before = await buildTelemetryPayloadInternal(${JSON.stringify(cidLive)}, { range: 'all' });
    flushTrajectoryCacheNow();
    const totalTokensBefore = before.consumption.account.totalTokens;

    // 2. Delete cidDeleted completely from Antigravity (.db + summary row), and add a step to cidLive!
    unlinkSync(${JSON.stringify(deletedDbFile)});
    const sdb = new DatabaseSync(${JSON.stringify(sumDbPath)});
    sdb.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(${JSON.stringify(cidDeleted)});
    sdb.close();

    // 3. Click Rebuild Cache TWICE in a row!
    const r1 = executeRebuildCacheAction();
    const r2 = executeRebuildCacheAction();

    // 4. Rebuild telemetry & inspect both cidLive and deleted cidDeleted
    const afterLive = await buildTelemetryPayloadInternal(${JSON.stringify(cidLive)}, { range: 'all' });
    const afterDeleted = await buildTelemetryPayloadInternal(${JSON.stringify(cidDeleted)}, { range: 'all' });
    flushTrajectoryCacheNow();

    const cachedDeleted = getCachedTrajectory(${JSON.stringify(cidDeleted)});
    const hydratedDeleted = getHydratedTrajectory(${JSON.stringify(cidDeleted)});

    console.log(JSON.stringify({
      r1Ok: r1.ok,
      r2Ok: r2.ok,
      totalTokensBefore,
      totalTokensAfter: afterLive.consumption.account.totalTokens,
      deletedArchivedFlag: Boolean(cachedDeleted?.archived),
      deletedStepCount: hydratedDeleted?.steps?.length || 0,
      deletedTurnPrompt: hydratedDeleted?.steps?.[0]?.turnPrompt || '',
      deletedViewSteps: afterDeleted.activeConversation?.recentSteps?.length || 0,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: '',
      USAGE_MONITOR_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    },
  });

  const out = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(out.r1Ok, true);
  assert.equal(out.r2Ok, true);
  // 100k + 10k (cidDeleted) + 50k + 5k (cidLive) = 165,000 tokens -> 100% preserved after deleting cidDeleted + 2x Rebuild Cache!
  assert.equal(out.totalTokensBefore, 165_000);
  assert.equal(out.totalTokensAfter, 165_000, 'deleted conversation tokens & cost permanently preserved');
  assert.equal(out.deletedArchivedFlag, true, 'deleted conversation marked archived');
  assert.equal(out.deletedStepCount, 1);
  assert.equal(out.deletedTurnPrompt, 'Keep my billing forever', 'deleted conversation detail_json preserved');
  assert.equal(out.deletedViewSteps, 1, 'clicking archived deleted conversation still renders step details');
  assert.equal(existsSync(liveDbFile), true);
});

test('SQLite hardening: cold metadata vs peer append safety, mixed-case re-keying, corrupt DB quarantine + .bak recovery, and 64-session LRU', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-hardening-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Default hot LRU comfortably holds 30 quick-stat sessions + active subagents without cyclic thrashing
  assert.equal(DEFAULT_HOT_SESSION_LRU_LIMIT, 64);

  const dbPath = join(dir, 'trajectory_store.sqlite');
  const jsonPath = join(dir, 'trajectory_usage_cache.json');
  const mixedUpperCid = 'ABCDEF99-1111-4222-8333-444455556666';
  const mixedLowerCid = mixedUpperCid.toLowerCase();
  const conflictCid = '11112222-3333-4444-8555-666677778888';

  // Seed initial DB via Store Writer
  const writer = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  writer.setCachedTrajectory(mixedUpperCid, {
    signature: 'v4:init',
    title: 'Mixed Case Session',
    steps: [makeRichStep(1, { turnPrompt: 'Mixed case prompt 1' })],
  });
  writer.setCachedTrajectory(conflictCid, {
    signature: 'v4:s2',
    title: 'Initial Title',
    steps: [
      makeRichStep(1, { turnPrompt: 'Step 1 intact' }),
      makeRichStep(2, { turnPrompt: 'Step 2 intact' }),
    ],
  });
  assert.equal(writer.flushTrajectoryCacheNow(), true);

  // Open Peer A (cold reader/writer) BEFORE Peer B appends Step #3
  const peerA = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const coldConflict = peerA.getCachedTrajectory(conflictCid);
  assert.equal(coldConflict.steps.length, 2);
  assert.equal(peerA.isConversationCold(conflictCid), true);

  // Peer B appends Step #3 (with rich detail_json) to conflictCid and flushes first
  const peerB = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const hydratedB = peerB.getHydratedTrajectory(conflictCid);
  peerB.setCachedTrajectory(conflictCid, {
    ...hydratedB,
    signature: 'v4:s3',
    steps: [...hydratedB.steps, makeRichStep(3, { turnPrompt: 'Step 3 from Peer B' })],
  });
  assert.equal(peerB.flushTrajectoryCacheNow(), true);

  // Peer A (still holding stale 2-step cold entry!) updates metadata & re-keys mixedUpperCid -> mixedLowerCid
  peerA.setCachedTrajectory(conflictCid, {
    ...coldConflict,
    workspaceUri: 'file:///workspace/project-a',
  });
  const coldMixed = peerA.getCachedTrajectory(mixedUpperCid);
  assert.equal(peerA.isConversationCold(mixedUpperCid), true);
  peerA.setCachedTrajectory(mixedLowerCid, { ...coldMixed, title: 'Normalized Lower Title' });
  assert.equal(peerA.flushTrajectoryCacheNow(), true);

  // Also test array-copied slim steps ([...coldEntry.steps]) losing array-level _isColdSlimSteps
  const peerC = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const coldMixedC = peerC.getCachedTrajectory(mixedLowerCid);
  peerC.setCachedTrajectory(mixedLowerCid, {
    ...coldMixedC,
    steps: [...coldMixedC.steps],
  });
  assert.equal(peerC.flushTrajectoryCacheNow(), true);

  // Verify fresh reader sees ALL 3 steps + ALL detail_json on conflictCid AND preserved detail_json on mixedLowerCid!
  const verifier = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const verifiedConflict = verifier.getHydratedTrajectory(conflictCid);
  assert.equal(verifiedConflict.steps.length, 3, 'Peer B step #3 was NOT truncated by Peer A cold metadata flush');
  assert.equal(verifiedConflict.steps[0].turnPrompt, 'Step 1 intact');
  assert.equal(verifiedConflict.steps[1].turnPrompt, 'Step 2 intact');
  assert.equal(verifiedConflict.steps[2].turnPrompt, 'Step 3 from Peer B');
  assert.equal(verifiedConflict.steps[2].contextBreakdown.totalTokens, 50_600);

  const verifiedMixed = verifier.getHydratedTrajectory(mixedLowerCid);
  assert.equal(verifiedMixed.title, 'Normalized Lower Title');
  assert.equal(verifiedMixed.steps.length, 1);
  assert.equal(verifiedMixed.steps[0].turnPrompt, 'Mixed case prompt 1', 'mixed-case re-keying + array-spread preserved detail_json');

  // 2. Corrupt SQLite file self-healing + automatic recovery from trajectory_usage_cache.json.bak
  const corruptDir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-corrupt-'));
  t.after(() => {
    rmSync(corruptDir, { recursive: true, force: true });
  });
  const corruptDbPath = join(corruptDir, 'trajectory_store.sqlite');
  const corruptJsonPath = join(corruptDir, 'trajectory_usage_cache.json');
  const bakCid = '99998888-7777-4666-8555-444433332222';
  writeFileSync(corruptDbPath, 'CORRUPT_HEADER_NOT_A_VALID_SQLITE_3_DATABASE_IMAGE', 'utf8');
  writeFileSync(
    `${corruptJsonPath}.bak`,
    JSON.stringify({
      [bakCid]: {
        signature: 'v4:bak',
        title: 'Recovered From Backup',
        steps: [makeRichStep(1, { turnPrompt: 'Backup survived corruption' })],
      },
    }),
    'utf8'
  );

  const healedStore = createTrajectoryCacheStore({
    cacheFilePath: corruptJsonPath,
    sqliteFilePath: corruptDbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const recovered = healedStore.getHydratedTrajectory(bakCid);
  assert.ok(recovered, 'corrupt SQLite quarantined and recovered from .json.bak');
  assert.equal(recovered.title, 'Recovered From Backup');
  assert.equal(recovered.steps[0].turnPrompt, 'Backup survived corruption');
  const quarantinedFiles = readdirSync(corruptDir).filter((f) => f.includes('.corrupt.'));
  assert.equal(quarantinedFiles.length >= 1, true, 'corrupt DB preserved as .corrupt.<ts>');

  // 3. Transient startup load error does NOT latch loadedOnce permanently
  let failFirstLoad = true;
  const retryStore = createTrajectoryCacheStore({
    cacheFilePath: '/virtual/retry.json',
    enableSqlite: false,
    loadJsonFn: () => {
      if (failFirstLoad) {
        failFirstLoad = false;
        throw new Error('transient EBUSY');
      }
      return { [bakCid]: { signature: 'v4:ok', steps: [makeRichStep(1)] } };
    },
  });
  assert.throws(() => retryStore.getCachedTrajectory(bakCid), /transient EBUSY/);
  assert.equal(retryStore.getCachedTrajectory(bakCid)?.steps?.length, 1, 'second read succeeds cleanly');
});
