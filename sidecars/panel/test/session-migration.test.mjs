import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  encodeProtoBytesField,
  encodeProtoStringField,
  encodeProtoTimestamp,
  encodeProtoVarintField,
  splitProtoRawFields,
} from '../backend/proto-wire.mjs';
import {
  getSessionMigrationCatalog,
  migrateSessions,
  migratorParseWorkspaceLabel,
  migratorToDesktopEncodedUri,
  migratorToRawFileUri,
} from '../backend/session-migrator.mjs';
import { readLocalSqliteTrajectory } from '../backend/cli-sqlite-reader.mjs';
import { createMockDom } from './mock-dom.mjs';

function initSummaryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL,
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob,
      group_id text NOT NULL DEFAULT ""
    );
  `);
  return db;
}

function createConvDb(dbPath, { cid, tid, source = 17, projectId = 'default-cli-project', wsUri = 'file:///C:/Users/Test', promptText = 'hello from cli', stepCount = 2, preserveTag15 = true }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (
      trajectory_id text PRIMARY KEY,
      cascade_id text,
      trajectory_type integer,
      source integer
    );
    CREATE TABLE steps (
      idx integer PRIMARY KEY,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 0,
      has_subtrajectory numeric NOT NULL DEFAULT false,
      metadata blob,
      error_details blob,
      permissions blob,
      task_details blob,
      render_info blob,
      step_payload blob,
      step_format integer NOT NULL DEFAULT 0
    );
    CREATE TABLE gen_metadata (
      idx integer PRIMARY KEY,
      data blob,
      size integer NOT NULL DEFAULT 0
    );
    CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
    CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
    CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
    CREATE TABLE battle_mode_infos (idx integer PRIMARY KEY, data blob);
  `);

  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, ?)').run(tid, cid, source);

  const wsSub = Buffer.concat([encodeProtoStringField(1, wsUri), encodeProtoStringField(3, '')]);
  const metaParts = [
    encodeProtoBytesField(1, wsSub),
    encodeProtoBytesField(2, encodeProtoTimestamp(1795000000000)),
    encodeProtoStringField(6, cid),
    encodeProtoStringField(7, wsUri),
    encodeProtoStringField(18, projectId),
  ];
  if (preserveTag15) {
    metaParts.push(encodeProtoBytesField(15, Buffer.from([0xde, 0xad, 0xbe, 0xef])));
  }
  db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
    Buffer.concat(metaParts)
  );

  for (let i = 0; i < stepCount; i++) {
    const isUser = i % 2 === 0;
    const srcInfo = Buffer.concat([
      encodeProtoStringField(1, tid),
      encodeProtoVarintField(2, i),
      encodeProtoStringField(4, cid),
    ]);
    const stepMeta = encodeProtoBytesField(20, srcInfo);
    const stepPayload = isUser
      ? encodeProtoBytesField(19, encodeProtoStringField(2, promptText))
      : encodeProtoBytesField(20, encodeProtoStringField(1, 'ok reply'));
    db.prepare(
      'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)'
    ).run(i, isUser ? 14 : 15, stepMeta, stepPayload);
  }
  db.close();
}

test('Cross-client session migration clones CLI/Legacy-IDE/Desktop SQLite sessions safely with fork dedup and rolling backups', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mig-test-'));
  const geminiDir = join(tempRoot, '.gemini');
  const backupDir = join(tempRoot, 'backups');

  try {
    // URI helper checks
    assert.equal(
      migratorToRawFileUri('file:///f%3A/ppt/1111/antigravity-usage-monitor'),
      'file:///f:/ppt/1111/antigravity-usage-monitor'
    );
    assert.equal(
      migratorToDesktopEncodedUri('file:///F:/ppt/1111/antigravity-usage-monitor'),
      'file:///f%3A/ppt/1111/antigravity-usage-monitor'
    );
    assert.deepEqual(
      migratorParseWorkspaceLabel('file:///f%3A/ppt/1111/antigravity-usage-monitor'),
      { name: 'antigravity-usage-monitor', displayPath: 'f:/ppt/1111/antigravity-usage-monitor' }
    );

    // 1. Single client only -> available must be false
    const deskRoot = join(geminiDir, 'antigravity');
    mkdirSync(join(deskRoot, 'conversations'), { recursive: true });
    mkdirSync(join(deskRoot, 'annotations'), { recursive: true });
    mkdirSync(join(deskRoot, 'brain'), { recursive: true });

    const deskCid = '11111111-1111-4111-8111-111111111111';
    const deskTid = '11111111-1111-4111-8111-111111111112';
    const projId = '99a28d35-a873-4c32-b8d1-81a62e23c33d';
    const projWsEnc = 'file:///f%3A/ppt/1111/antigravity-usage-monitor';

    createConvDb(join(deskRoot, 'conversations', `${deskCid}.db`), {
      cid: deskCid,
      tid: deskTid,
      source: 1,
      projectId: projId,
      wsUri: 'file:///f:/ppt/1111/antigravity-usage-monitor',
      promptText: 'desktop session prompt',
      stepCount: 4,
    });
    writeFileSync(join(deskRoot, 'annotations', `${deskCid}.pbtxt`), 'title:"Desktop Main Chat"\n', 'utf8');

    const deskSum = initSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    deskSum
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, last_user_input_time,
          last_user_input_step_index, app_data_dir, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        deskCid,
        'Desktop Main Chat',
        'Desktop Main Chat',
        4,
        '2026-11-21 10:00:00.000000+00:00',
        JSON.stringify([projWsEnc]),
        'CASCADE_RUN_STATUS_IDLE',
        '',
        projId,
        '2026-11-21 09:59:00.000000+00:00',
        2,
        'antigravity',
        Buffer.concat([
          encodeProtoStringField(1, 'Desktop Main Chat'),
          encodeProtoVarintField(2, 4),
          encodeProtoStringField(4, deskTid),
          encodeProtoVarintField(5, 1),
          encodeProtoVarintField(22, 4),
        ])
      );
    deskSum.close();

    const singleCat = getSessionMigrationCatalog({ geminiDir });
    assert.equal(singleCat.available, false, 'Single client hides migration feature');

    // 2. Add CLI client (1 idle untitled, 1 running, 1 subagent, 1 empty 0-step) + Legacy IDE client
    const cliRoot = join(geminiDir, 'antigravity-cli');
    mkdirSync(join(cliRoot, 'conversations'), { recursive: true });
    mkdirSync(join(cliRoot, 'annotations'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain'), { recursive: true });

    const cliIdleCid = '22222222-2222-4222-8222-222222222221';
    const cliRunCid = '22222222-2222-4222-8222-222222222222';
    const cliSubCid = '22222222-2222-4222-8222-222222222223';
    const cliEmptyCid = '22222222-2222-4222-8222-222222222224';

    createConvDb(join(cliRoot, 'conversations', `${cliIdleCid}.db`), {
      cid: cliIdleCid,
      tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      source: 17,
      promptText: '<USER_REQUEST>Fix Braille progress bar width</USER_REQUEST>',
      stepCount: 6,
    });
    mkdirSync(join(cliRoot, 'brain', cliIdleCid, '.user_uploaded'), { recursive: true });
    writeFileSync(join(cliRoot, 'brain', cliIdleCid, '.user_uploaded', 'shot.png'), 'pngdata', 'utf8');

    createConvDb(join(cliRoot, 'conversations', `${cliRunCid}.db`), {
      cid: cliRunCid,
      tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      source: 17,
      stepCount: 4,
    });
    createConvDb(join(cliRoot, 'conversations', `${cliSubCid}.db`), {
      cid: cliSubCid,
      tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      source: 17,
      stepCount: 2,
    });
    createConvDb(join(cliRoot, 'conversations', `${cliEmptyCid}.db`), {
      cid: cliEmptyCid,
      tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      source: 17,
      stepCount: 0,
    });

    const cliSum = initSummaryDb(join(cliRoot, 'conversation_summaries.db'));
    const insertCliSum = cliSum.prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, project_id, parent_conversation_id,
        nesting_depth, not_fully_idle, killed, last_user_input_time,
        last_user_input_step_index, app_data_dir, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertCliSum.run(
      cliIdleCid,
      '',
      '',
      6,
      '2026-11-21 12:00:00.000000+00:00',
      '["file:///C:/Users/Administrator"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      'default-cli-project',
      '',
      0,
      0,
      0,
      '2026-11-21 11:58:00.000000+00:00',
      4,
      'antigravity-cli',
      Buffer.concat([
        encodeProtoVarintField(2, 6),
        encodeProtoStringField(4, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
        encodeProtoVarintField(5, 1),
        encodeProtoVarintField(20, 17), // CLI source tag that must be stripped
        encodeProtoVarintField(22, 4),
      ])
    );
    insertCliSum.run(
      cliRunCid,
      'Active CLI Task',
      'Active CLI Task',
      4,
      '2026-11-21 12:05:00.000000+00:00',
      '["file:///C:/Users/Administrator"]',
      'CASCADE_RUN_STATUS_RUNNING',
      '',
      'default-cli-project',
      '',
      0,
      1,
      0,
      '2026-11-21 12:04:00.000000+00:00',
      2,
      'antigravity-cli',
      null
    );
    insertCliSum.run(
      cliSubCid,
      'Subagent Child',
      '',
      2,
      '2026-11-21 11:50:00.000000+00:00',
      '["file:///C:/Users/Administrator"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      'default-cli-project',
      cliIdleCid,
      1,
      0,
      0,
      '2026-11-21 11:50:00.000000+00:00',
      0,
      'antigravity-cli',
      null
    );
    insertCliSum.run(
      cliEmptyCid,
      '',
      '',
      0,
      '0001-01-01 00:00:00+00:00',
      '["file:///C:/Users/Administrator"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      'default-cli-project',
      '',
      0,
      0,
      0,
      '0001-01-01 00:00:00+00:00',
      -1,
      'antigravity-cli',
      null
    );
    cliSum.close();

    // Legacy IDE (.db without conversation_summaries.db)
    const legacyRoot = join(geminiDir, 'antigravity-ide');
    mkdirSync(join(legacyRoot, 'conversations'), { recursive: true });
    const legacyCid = '33333333-3333-4333-8333-333333333331';
    createConvDb(join(legacyRoot, 'conversations', `${legacyCid}.db`), {
      cid: legacyCid,
      tid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      source: 1,
      projectId: '',
      wsUri: 'file:///e:/legacy-app',
      promptText: 'Refactor legacy sidebar',
      stepCount: 4,
    });

    const cat = getSessionMigrationCatalog({ geminiDir });
    assert.equal(cat.available, true, 'Multi-client setup exposes migration catalog');
    assert.equal(cat.sessionsByClient.cli.length, 2, 'Excludes subagent and 0-step empty CLI sessions');
    const idleItem = cat.sessionsByClient.cli.find((s) => s.cascadeId === cliIdleCid);
    const runItem = cat.sessionsByClient.cli.find((s) => s.cascadeId === cliRunCid);
    assert.equal(idleItem.title, 'Fix Braille progress bar width', 'Falls back to cleaned first user prompt title');
    assert.equal(idleItem.isRunning, false);
    assert.equal(runItem.isRunning, true);
    assert.equal(cat.sessionsByClient.ide_legacy.length, 1);
    assert.equal(cat.sessionsByClient.ide_legacy[0].title, 'Refactor legacy sidebar');
    assert.ok(cat.desktopProjects.some((p) => p.projectId === projId && p.name === 'antigravity-usage-monitor'));
    assert.ok(cat.desktopProjects.some((p) => p.projectId === 'outside-of-project' && p.isOutsideProject));

    // 3. Default FULL MOVE mode: CLI -> Desktop (1 idle + 1 running -> idle moves with original UUID & ALL historical steps!)
    const migRes = migrateSessions(
      {
        sourceClient: 'cli',
        targetClient: 'desktop',
        cascadeIds: [cliIdleCid, cliRunCid],
        targetProjectId: projId,
      },
      { geminiDir, backupDir }
    );
    assert.equal(migRes.ok, true);
    assert.equal(migRes.mode, 'move');
    assert.equal(migRes.migratedCount, 1);
    assert.equal(migRes.failedCount, 1);
    assert.equal(migRes.needsWindowReload, true);
    assert.ok(migRes.backupPath && existsSync(migRes.backupPath), 'Creates backup before modifying target summary DB');

    const okItem = migRes.results.find((r) => r.ok);
    const runErr = migRes.results.find((r) => !r.ok);
    assert.equal(runErr.error, 'session_running');
    assert.equal(okItem.newCascadeId, cliIdleCid, 'Full move preserves original cascadeId so historical steps stay intact');
    assert.ok(
      okItem.archivedSourcePath && existsSync(okItem.archivedSourcePath),
      'Archives source DB snapshot before removing from source client'
    );

    // Verify source CLI .db removed & summary deleted, while brain media remains readable
    assert.equal(existsSync(join(cliRoot, 'conversations', `${cliIdleCid}.db`)), false);
    assert.ok(existsSync(join(cliRoot, 'brain', cliIdleCid, '.user_uploaded', 'shot.png')));
    const checkCliSumDb = new DatabaseSync(join(cliRoot, 'conversation_summaries.db'), { readOnly: true });
    assert.equal(
      checkCliSumDb
        .prepare('SELECT count(*) as c FROM conversation_summaries WHERE conversation_id = ?')
        .get(cliIdleCid).c,
      0,
      'Removes moved session from source client summary DB'
    );
    checkCliSumDb.close();

    // Verify moved Desktop artifacts
    const movedDbPath = join(deskRoot, 'conversations', `${okItem.newCascadeId}.db`);
    assert.ok(existsSync(movedDbPath));
    assert.ok(existsSync(join(deskRoot, 'brain', okItem.newCascadeId, '.user_uploaded', 'shot.png')));
    const annText = readFileSync(join(deskRoot, 'annotations', `${okItem.newCascadeId}.pbtxt`), 'utf8');
    assert.ok(annText.includes('Fix Braille progress bar width'));

    // Inspect moved DB metadata & unknown field 15 preservation
    const movedDb = new DatabaseSync(movedDbPath, { readOnly: true });
    const metaRow = movedDb.prepare('SELECT * FROM trajectory_meta').get();
    assert.equal(metaRow.cascade_id, cliIdleCid);
    assert.equal(metaRow.trajectory_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
    assert.equal(metaRow.source, 1);
    const blobRow = movedDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
    const blobFields = splitProtoRawFields(blobRow.data);
    assert.equal(blobFields.find((f) => f.fn === 6)?.payload.toString('utf8'), cliIdleCid);
    assert.equal(blobFields.find((f) => f.fn === 7)?.payload.toString('utf8'), projWsEnc);
    assert.equal(blobFields.find((f) => f.fn === 18)?.payload.toString('utf8'), projId);
    assert.deepEqual(
      blobFields.find((f) => f.fn === 15)?.payload,
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      'Preserves unknown protobuf fields byte-for-byte'
    );
    movedDb.close();

    // Verify ALL historical steps (#0..#5, including #1/#3/#5 planner responses) are preserved in telemetry!
    const decodedMoved = readLocalSqliteTrajectory(movedDbPath, { cascadeId: cliIdleCid });
    assert.ok(decodedMoved, 'Moved session decodes cleanly via cli-sqlite-reader');
    assert.equal(decodedMoved.numTotalSteps, 6, 'All 6 historical steps (#0..#5) stay intact after full move');
    assert.deepEqual(
      decodedMoved.steps.map((s) => s.idx),
      [0, 1, 2, 3, 4, 5],
      'Historical step numbering remains continuous without jumping'
    );

    // Verify target summary DB row & stripped fn 20 CLI source tag
    const checkSumDb = new DatabaseSync(join(deskRoot, 'conversation_summaries.db'), { readOnly: true });
    const sumRow = checkSumDb
      .prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?')
      .get(cliIdleCid);
    assert.equal(sumRow.project_id, projId);
    assert.equal(sumRow.source, '');
    assert.equal(sumRow.app_data_dir, 'antigravity');
    assert.equal(sumRow.workspace_uris, JSON.stringify([projWsEnc]));
    const rawSumFields = splitProtoRawFields(sumRow.raw_summary);
    assert.equal(rawSumFields.some((f) => f.fn === 20), false, 'Strips CLI source enum from raw_summary');
    checkSumDb.close();

    // 4. Optional CLONE mode: Desktop -> CLI (fresh UUID, source untouched, zero double-billing)
    const revRes = migrateSessions(
      {
        sourceClient: 'desktop',
        targetClient: 'cli',
        mode: 'clone',
        cascadeIds: [deskCid],
      },
      { geminiDir, backupDir }
    );
    assert.equal(revRes.ok, true);
    assert.equal(revRes.mode, 'clone');
    assert.equal(revRes.needsWindowReload, false);
    const cliClone = revRes.results[0];
    assert.notEqual(cliClone.newCascadeId, deskCid, 'Clone mode assigns fresh UUID');
    assert.ok(existsSync(join(deskRoot, 'conversations', `${deskCid}.db`)), 'Clone mode leaves source untouched');
    assert.equal(cliClone.resumeCommand, `agy --conversation ${cliClone.newCascadeId}`);
    const cliCloneDbPath = join(cliRoot, 'conversations', `${cliClone.newCascadeId}.db`);
    const cliCloneDb = new DatabaseSync(cliCloneDbPath, { readOnly: true });
    assert.equal(cliCloneDb.prepare('SELECT source FROM trajectory_meta').get().source, 17);
    cliCloneDb.close();
    assert.equal(
      readLocalSqliteTrajectory(cliCloneDbPath, { cascadeId: cliClone.newCascadeId }),
      null,
      'Clone mode deduplicates cloned historical steps so global billing never double-counts'
    );

    // 5. Legacy IDE (no summary DB) -> Desktop App in clone mode synthesizes valid raw_summary
    const legRes = migrateSessions(
      {
        sourceClient: 'ide_legacy',
        targetClient: 'desktop',
        mode: 'clone',
        cascadeIds: [legacyCid],
        targetProjectId: 'outside-of-project',
      },
      { geminiDir, backupDir }
    );
    assert.equal(legRes.ok, true);
    const legSumDb = new DatabaseSync(join(deskRoot, 'conversation_summaries.db'), { readOnly: true });
    const legSumRow = legSumDb
      .prepare('SELECT project_id, title, raw_summary FROM conversation_summaries WHERE conversation_id = ?')
      .get(legRes.results[0].newCascadeId);
    assert.equal(legSumRow.project_id, 'outside-of-project');
    assert.equal(legSumRow.title, 'Refactor legacy sidebar');
    assert.ok(legSumRow.raw_summary.byteLength > 20);
    legSumDb.close();

    // 6. Rolling backups stay capped at <= 5
    for (let k = 0; k < 6; k++) {
      migrateSessions(
        {
          sourceClient: 'ide_legacy',
          targetClient: 'desktop',
          mode: 'clone',
          cascadeIds: [legacyCid],
          targetProjectId: 'outside-of-project',
        },
        { geminiDir, backupDir }
      );
    }
    const deskBackups = readdirSync(backupDir).filter(
      (n) => n.startsWith('conversation_summaries_desktop_') && n.endsWith('.db')
    );
    assert.ok(deskBackups.length <= 5, `Rolling backup cap enforced (got ${deskBackups.length})`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('SessionMigrationCard stays hidden for single-client hosts and renders multi-select migration workflow', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = { document: doc };

  try {
    const { SessionMigrationCard } = await import(
      '../src/components/settings/SessionMigrationCard.js'
    );

    // 1. Single client -> hidden
    const hiddenCard = SessionMigrationCard({
      loadCatalog: async () => ({
        available: false,
        clients: [{ id: 'desktop', exists: true, canBeTarget: true, sessionCount: 5 }],
        sessionsByClient: { desktop: [] },
        desktopProjects: [],
      }),
    });
    assert.equal(hiddenCard.el.hasAttribute('hidden'), true);
    await hiddenCard.refs.ensureLoaded();
    assert.equal(hiddenCard.el.hasAttribute('hidden'), true);
    hiddenCard.destroy();

    // 2. Multi-client -> visible, selects CLI session, migrates to Desktop project
    let capturedPayload = null;
    const card = SessionMigrationCard({
      loadCatalog: async () => ({
        available: true,
        clients: [
          { id: 'desktop', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 2 },
          { id: 'cli', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 2 },
        ],
        sessionsByClient: {
          cli: [
            {
              cascadeId: '22222222-2222-4222-8222-222222222221',
              title: 'CLI Debug Session',
              stepCount: 12,
              lastModifiedMs: Date.now() - 120000,
              workspaceName: 'Administrator',
              workspacePath: 'C:/Users/Administrator',
              isRunning: false,
            },
            {
              cascadeId: '22222222-2222-4222-8222-222222222222',
              title: 'Live Active Session',
              stepCount: 4,
              lastModifiedMs: Date.now(),
              workspaceName: 'Administrator',
              workspacePath: 'C:/Users/Administrator',
              isRunning: true,
            },
          ],
          desktop: [],
        },
        desktopProjects: [
          {
            projectId: '99a28d35-a873-4c32-b8d1-81a62e23c33d',
            name: 'antigravity-usage-monitor',
            workspaceUri: 'file:///f%3A/ppt/1111/antigravity-usage-monitor',
            workspacePath: 'f:/ppt/1111/antigravity-usage-monitor',
          },
          {
            projectId: 'outside-of-project',
            name: '',
            isOutsideProject: true,
          },
        ],
      }),
      runMigrate: async (payload) => {
        capturedPayload = payload;
        return {
          ok: true,
          sourceClient: payload.sourceClient,
          targetClient: payload.targetClient,
          targetProjectId: payload.targetProjectId,
          migratedCount: payload.cascadeIds.length,
          failedCount: 0,
          needsWindowReload: true,
          results: [
            {
              ok: true,
              sourceCascadeId: payload.cascadeIds[0],
              newCascadeId: '99999999-9999-4999-8999-999999999999',
              title: 'CLI Debug Session',
            },
          ],
        };
      },
    });

    await card.refs.ensureLoaded();
    assert.equal(card.el.hasAttribute('hidden'), false, 'Card becomes visible when >=2 clients detected');

    const rows = card.el.querySelectorAll('.smig-item');
    assert.equal(rows.length, 2);
    const migrateBtn = card.el.querySelector('.smig-migrate-btn');
    assert.equal(migrateBtn.hasAttribute('disabled'), true);

    // Clicking running session does not select it
    rows[1].dispatchEvent({ type: 'click', target: rows[1] });
    assert.equal(migrateBtn.hasAttribute('disabled'), true);

    // Clicking idle session selects it and enables Migrate button
    rows[0].dispatchEvent({ type: 'click', target: rows[0] });
    assert.equal(migrateBtn.hasAttribute('disabled'), false);

    // Trigger migration (defaults to full move mode)
    await migrateBtn.dispatchEvent({ type: 'click', target: migrateBtn });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(capturedPayload, {
      sourceClient: 'cli',
      targetClient: 'desktop',
      mode: 'move',
      cascadeIds: ['22222222-2222-4222-8222-222222222221'],
      targetProjectId: '99a28d35-a873-4c32-b8d1-81a62e23c33d',
    });

    // Switch to clone mode and verify payload reflects mode: 'clone'
    const modeBtns = card.el.querySelectorAll('.smig-mode-btn');
    assert.equal(modeBtns.length, 2);
    modeBtns[1].dispatchEvent({ type: 'click', target: modeBtns[1] });
    const rows2 = card.el.querySelectorAll('.smig-item');
    rows2[0].dispatchEvent({ type: 'click', target: rows2[0] });
    await migrateBtn.dispatchEvent({ type: 'click', target: migrateBtn });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(capturedPayload.mode, 'clone');

    const resultBox = card.el.querySelector('.smig-result');
    assert.equal(resultBox.hasAttribute('hidden'), false);
    assert.ok(resultBox.textContent.includes('Ctrl+R'));
    card.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
