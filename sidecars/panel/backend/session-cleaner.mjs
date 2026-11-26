/**
 * @fileoverview 本地 Antigravity 三端会话事务清理、崩溃恢复、外部关联清理与在线账本脱敏引擎 (`session-cleaner.mjs`)。
 *
 * 核心保障：
 * 1. 每客户端存储目录互斥锁（`.um-clean.lock`）+ 按客户端运行态守卫（禁止删除正在运行客户端的会话）；
 * 2. 两阶段暂存提交状态机（`.um-clean-prepare-*` -> `.um-clean-*` -> `.um-clean-purge-*`），
 *    在 `conversation_summaries.db` 内写入 `um_cleanup_commits` 提交点，配全量字节级 SHA-256 CAS 校验；
 * 3. 启动/扫描自动崩溃恢复：已提交继续善后（`VACUUM` / 外部收据），未提交逆序无损还原；
 * 4. 级联删除同源 `nesting_depth > 0` 嵌套子代理，严禁误删 `/fork` 独立会话；
 * 5. 跨端联动清理未运行端的同 ID 仅索引条目与用户确认的历史孤立索引；
 * 6. 迁移归档附件保护：检测到已迁移源会话的归档记录时默认保留源端 `brain/<id>/`；
 * 7. 原生进程内 SQLite 账本隐私脱敏：清除已删会话标题与用户输入提示词，100% 保留 Token/费用统计。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCAL_ENDPOINT_ID } from '../shared/window-bridge-protocol.mjs';
import { getLocalTrajectoryCacheStore } from './config.mjs';
import { writeJsonAtomicSync } from './fs-atomic.mjs';
import { filterSummaryProtoIndex } from './proto-wire.mjs';
import {
  SESSION_CLIENT_DEFS,
  cleanupProtectedMigrationArchives,
  collectAllStoresLiveIds,
  collectStoreArtifactIds,
  collectStoreIndexIds,
  decodeMetaBlobLight,
  decodeSummaryRelationsLight,
  deleteConversationParentsByIds,
  detectRunningClients,
  findProtectedMigrationArchives,
  getSessionClientDef,
  hasAnyClientStoreDir,
  isDbLightSubagent,
  normalizeSessionUuid,
  readConversationParentsMap,
  resolveElectronAppDataDir,
  resolveGeminiDir,
  resolveMigrationBackupRoot,
  resolveNoFollowFile,
  resolveNoFollowPath,
  resolveScopedTrajectoryCacheStore,
  sweepOrphanedMigrationArchiveDbs,
  withWritableSqliteDb,
} from './session-store.mjs';
import { withReadOnlySqliteDb } from './sqlite-client.mjs';
import { DEFAULT_REDACTED_SESSION_TITLE } from './trajectory-sqlite-ledger.mjs';
import { clearUsageAggregatorMemo } from './usage-aggregator.mjs';

const CLEAN_LOCK_FILENAME = '.um-clean.lock';
const CLEAN_LOCK_STALE_MS = 10 * 60 * 1000;
const STAGE_PREPARE_PREFIX = '.um-clean-prepare-';
const STAGE_ACTIVE_PREFIX = '.um-clean-';
const STAGE_PURGE_PREFIX = '.um-clean-purge-';
const STAGE_EXTRAS_PREFIX = '.um-clean-extras-';
export const MAX_SIDECAR_LOG_BYTES = 16 * 1024 * 1024;

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 为单个客户端存储目录获取进程级互斥锁，防止并发清理交错。
 *
 * @param {string} clientRoot
 * @returns {() => void} release callback
 */
export function acquireStoreLock(clientRoot) {
  const lockCheck = resolveNoFollowFile(clientRoot, [CLEAN_LOCK_FILENAME]);
  if (!lockCheck.ok) {
    throw new Error(`store_lock_unsafe: ${lockCheck.error || 'invalid_path'}`);
  }
  const lockPath = lockCheck.path;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // 忽略释放异常
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let isStale = false;
      try {
        const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
        const ageMs = Date.now() - Number(raw?.createdAtMs || 0);
        if (ageMs > CLEAN_LOCK_STALE_MS || (raw?.pid && !isProcessAlive(raw.pid))) {
          isStale = true;
        }
      } catch {
        isStale = true;
      }
      if (isStale && attempt === 0) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // 继续走冲突报错
        }
      }
      const lockErr = new Error('store_locked');
      lockErr.code = 'STORE_LOCKED';
      throw lockErr;
    }
  }
  const fallbackErr = new Error('store_locked');
  fallbackErr.code = 'STORE_LOCKED';
  throw fallbackErr;
}

function isNonRetryableStoreError(err) {
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'STORE_LOCKED' ||
    code === 'CLIENT_RUNNING' ||
    code === 'PROTO_CORRUPT' ||
    msg.includes('store_locked') ||
    msg.includes('client_running') ||
    msg.includes('malformed protobuf') ||
    msg.includes('truncated protobuf') ||
    msg.includes('unsupported summary protobuf')
  );
}

// ---------------------------------------------------------------------------
// 文本/JSON/sidecar 过滤辅助
// ---------------------------------------------------------------------------

/**
 * 逐字节切分 JSONL/日志文本行，保留原始 `\n` / `\r\n` 换行符。
 *
 * @param {Buffer} rawBuf
 * @returns {Buffer[]}
 */
function splitRawBufferLines(rawBuf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < rawBuf.length; i += 1) {
    if (rawBuf[i] === 0x0a) {
      lines.push(rawBuf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < rawBuf.length) {
    lines.push(rawBuf.subarray(start));
  }
  return lines;
}

export function filterHistoryJsonlBuffer(rawBuf, removeSet) {
  const lines = splitRawBufferLines(rawBuf);
  const kept = [];
  let changed = false;
  for (const lineBuf of lines) {
    const text = lineBuf.toString('utf8').trim();
    if (!text) {
      kept.push(lineBuf);
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const cid = normalizeSessionUuid(parsed?.conversationId || parsed?.conversation_id || '');
      if (cid && removeSet.has(cid)) {
        changed = true;
        continue;
      }
    } catch {
      // 无法解析的原始行原样保留，绝不丢数据
    }
    kept.push(lineBuf);
  }
  return { buffer: changed ? Buffer.concat(kept) : rawBuf, changed };
}

export function filterLogLinesContainingIds(rawBuf, removeList) {
  if (rawBuf.length === 0 || removeList.length === 0) {
    return { buffer: rawBuf, changed: false };
  }
  const lines = splitRawBufferLines(rawBuf);
  const kept = [];
  let changed = false;
  for (const lineBuf of lines) {
    const lower = lineBuf.toString('latin1').toLowerCase();
    let hit = false;
    for (const id of removeList) {
      if (lower.includes(id)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      changed = true;
    } else {
      kept.push(lineBuf);
    }
  }
  return { buffer: changed ? Buffer.concat(kept) : rawBuf, changed };
}

function filterLastConversationsJson(rawBuf, removeSet) {
  const text = rawBuf.toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { buffer: rawBuf, changed: false };
  }
  let changed = false;
  const next = {};
  for (const [ws, val] of Object.entries(parsed)) {
    const cid = normalizeSessionUuid(val);
    if (cid && removeSet.has(cid)) {
      changed = true;
      continue;
    }
    next[ws] = val;
  }
  if (!changed) return { buffer: rawBuf, changed: false };
  return { buffer: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'), changed: true };
}

function filterConversationMetadataJson(rawBuf, removeSet) {
  const text = rawBuf.toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !parsed.conversations || typeof parsed.conversations !== 'object') {
    return { buffer: rawBuf, changed: false };
  }
  let changed = false;
  const nextConvs = {};
  for (const [k, v] of Object.entries(parsed.conversations)) {
    const cid = normalizeSessionUuid(k);
    if (cid && removeSet.has(cid)) {
      changed = true;
      continue;
    }
    nextConvs[k] = v;
  }
  if (!changed) return { buffer: rawBuf, changed: false };
  const nextRoot = { ...parsed, conversations: nextConvs };
  return { buffer: Buffer.from(`${JSON.stringify(nextRoot, null, 2)}\n`, 'utf8'), changed: true };
}

/**
 * 扫描 `sidecar_data/<plugin>/<panel>/events/*.json`，找出归属被删会话的事件文件。
 * 显式保护 `/fork` 事件（`parentConversationId` 非空且 `nestingDepth === 0` 且自身/根 ID 未命中 `removeSet`）。
 *
 * @param {string} clientRoot
 * @param {Set<string>} removeSet
 * @returns {string[][]} 相对路径段列表
 */
export function findMatchingSidecarEventRelPaths(clientRoot, removeSet) {
  const matched = [];
  const sidecarCheck = resolveNoFollowPath(clientRoot, ['sidecar_data']);
  if (!sidecarCheck.ok || !sidecarCheck.exists || !sidecarCheck.stat?.isDirectory()) {
    return matched;
  }

  let plugins = [];
  try {
    plugins = readdirSync(sidecarCheck.path);
  } catch {
    return matched;
  }

  for (const pluginName of plugins) {
    const pluginCheck = resolveNoFollowPath(clientRoot, ['sidecar_data', pluginName]);
    if (!pluginCheck.ok || !pluginCheck.exists || !pluginCheck.stat?.isDirectory()) continue;
    let panels = [];
    try {
      panels = readdirSync(pluginCheck.path);
    } catch {
      continue;
    }
    for (const panelName of panels) {
      const eventsCheck = resolveNoFollowPath(clientRoot, ['sidecar_data', pluginName, panelName, 'events']);
      if (!eventsCheck.ok || !eventsCheck.exists || !eventsCheck.stat?.isDirectory()) continue;
      let files = [];
      try {
        files = readdirSync(eventsCheck.path);
      } catch {
        continue;
      }
      for (const fileName of files) {
        if (!fileName.toLowerCase().endsWith('.json')) continue;
        const relSegments = ['sidecar_data', pluginName, panelName, 'events', fileName];
        const fileCheck = resolveNoFollowFile(clientRoot, relSegments);
        if (!fileCheck.ok || !fileCheck.exists) continue;
        try {
          const parsed = JSON.parse(readFileSync(fileCheck.path, 'utf8'));
          const convMeta = parsed?.payload?.conversationMetadata;
          const innerMeta = convMeta?.metadata || {};
          const directCid = normalizeSessionUuid(
            convMeta?.conversationId || parsed?.conversationId || parsed?.payload?.conversationId || ''
          );
          const rootCid = normalizeSessionUuid(innerMeta?.rootConversationId || '');
          const parentCid = normalizeSessionUuid(innerMeta?.parentConversationId || '');
          const depth = Number(innerMeta?.nestingDepth || 0);

          if (directCid && removeSet.has(directCid)) {
            matched.push(relSegments);
            continue;
          }
          // 明确保护独立 /fork 会话事件（含多级 /fork 链 A -> B -> C，绝不因共享早期 rootCid 而误删）
          if (depth === 0) {
            continue;
          }
          if (parentCid) {
            if (removeSet.has(parentCid)) {
              matched.push(relSegments);
            }
          } else if (rootCid && removeSet.has(rootCid)) {
            matched.push(relSegments);
          }
        } catch {
          // 忽略非 JSON 或损坏事件文件
        }
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// 级联子代理收集（严禁包含 /fork）
// ---------------------------------------------------------------------------

/**
 * 收集给定存储中，属于 `rootIds` 的同源嵌套子代理与旁路提问（递归级联，但绝不包含 `/fork`）。
 *
 * @param {string} clientRoot
 * @param {Set<string>} rootIds
 * @returns {{ expandedIds: Set<string>, cascadeSubagentIds: string[] }}
 */
export function expandStoreCascadeTargets(clientRoot, rootIds) {
  const expanded = new Set();
  for (const id of rootIds || []) {
    const norm = normalizeSessionUuid(id);
    if (norm) expanded.add(norm);
  }
  if (!clientRoot || expanded.size === 0) {
    return { expandedIds: expanded, cascadeSubagentIds: [] };
  }

  // 构建 parentId -> childId[]（仅限嵌套子代理 / 旁路提问，绝不包含 nesting_depth === 0 的 /fork）
  const childrenByParent = new Map();
  const addEdge = (parentId, childId) => {
    const p = normalizeSessionUuid(parentId);
    const c = normalizeSessionUuid(childId);
    if (!p || !c || p === c) return;
    if (!childrenByParent.has(p)) childrenByParent.set(p, new Set());
    childrenByParent.get(p).add(c);
  };

  const inspectConvDbIsSubagent = (cid) => {
    const dbFile = resolveNoFollowFile(clientRoot, ['conversations', `${cid}.db`]);
    if (!dbFile.ok || !dbFile.exists) return false;
    try {
      return Boolean(
        withReadOnlySqliteDb(dbFile.path, (cdb) => {
          let trajectoryType = 0;
          let sourceNum = 0;
          try {
            const mr = cdb.prepare('SELECT trajectory_type, source FROM trajectory_meta LIMIT 1').get();
            trajectoryType = Number(mr?.trajectory_type || 0);
            sourceNum = Number(mr?.source || 0);
          } catch {
            // ignore
          }
          let metaInfo = { nestingDepth: 0, hasSubagentSpec: false };
          try {
            const br = cdb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
            if (br?.data) metaInfo = decodeMetaBlobLight(br.data);
          } catch {
            // ignore
          }
          return isDbLightSubagent({ trajectoryType, sourceNum, ...metaInfo });
        })
      );
    } catch {
      return false;
    }
  };

  const sumRelById = new Map();
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  if (sumCheck.ok && sumCheck.exists) {
    try {
      withReadOnlySqliteDb(sumCheck.path, (db) => {
        let rows = [];
        try {
          rows = db
            .prepare(
              'SELECT conversation_id, parent_conversation_id, nesting_depth, source, raw_summary FROM conversation_summaries'
            )
            .all();
        } catch {
          try {
            rows = db
              .prepare(
                'SELECT conversation_id, parent_conversation_id, nesting_depth FROM conversation_summaries'
              )
              .all();
          } catch {
            rows = [];
          }
        }
        for (const row of rows || []) {
          const cid = normalizeSessionUuid(row?.conversation_id);
          if (!cid) continue;
          sumRelById.set(cid, decodeSummaryRelationsLight(row));
        }

        const isChildCascadeEligible = (cid) => {
          const rel = sumRelById.get(cid);
          if (rel) return rel.isSubagent;
          return inspectConvDbIsSubagent(cid);
        };

        for (const [cid, rel] of sumRelById.entries()) {
          if (rel.isSubagent) {
            const pid =
              rel.parentConversationId ||
              (rel.rootConversationId && rel.rootConversationId !== cid ? rel.rootConversationId : '');
            if (pid) addEdge(pid, cid);
          }
          for (const sqId of rel.sideQuestionChildren) {
            if (isChildCascadeEligible(sqId)) {
              addEdge(cid, sqId);
            }
          }
        }

        // conversation_parents（生产列名 parent_id，兼容 parent_conversation_id）同样必须校验非 /fork
        const parentMap = readConversationParentsMap(db);
        for (const [cid, pid] of parentMap.entries()) {
          if (isChildCascadeEligible(cid)) {
            addEdge(pid, cid);
          }
        }
      });
    } catch {
      // 忽略只读异常
    }
  }

  // 补充扫描未写入 conversation_summaries.db（或旧版无摘要库）的 conversations/*.db，找出孤立/脱机嵌套子代理关系
  const convCheck = resolveNoFollowPath(clientRoot, ['conversations']);
  if (convCheck.ok && convCheck.exists && convCheck.stat?.isDirectory()) {
    try {
      for (const name of readdirSync(convCheck.path)) {
        if (!name.toLowerCase().endsWith('.db')) continue;
        const cid = normalizeSessionUuid(name.slice(0, -3));
        if (!cid || sumRelById.has(cid)) continue;
        const dbFile = resolveNoFollowFile(clientRoot, ['conversations', name]);
        if (!dbFile.ok || !dbFile.exists) continue;
        try {
          withReadOnlySqliteDb(dbFile.path, (cdb) => {
            let trajectoryType = 0;
            let sourceNum = 0;
            try {
              const mr = cdb.prepare('SELECT trajectory_type, source FROM trajectory_meta LIMIT 1').get();
              trajectoryType = Number(mr?.trajectory_type || 0);
              sourceNum = Number(mr?.source || 0);
            } catch {
              // ignore
            }
            const br = cdb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
            if (!br?.data) return;
            const metaInfo = decodeMetaBlobLight(br.data);
            if (isDbLightSubagent({ trajectoryType, sourceNum, ...metaInfo })) {
              if (metaInfo.parentConversationId) {
                addEdge(metaInfo.parentConversationId, cid);
              } else if (metaInfo.rootConversationId && metaInfo.rootConversationId !== cid) {
                addEdge(metaInfo.rootConversationId, cid);
              }
            }
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const cascadeSubagentIds = [];
  const queue = Array.from(expanded);
  while (queue.length > 0) {
    const cur = queue.shift();
    const children = childrenByParent.get(cur);
    if (!children) continue;
    for (const childId of children) {
      if (expanded.has(childId)) continue;
      expanded.add(childId);
      cascadeSubagentIds.push(childId);
      queue.push(childId);
    }
  }

  return { expandedIds: expanded, cascadeSubagentIds };
}

// ---------------------------------------------------------------------------
// 外部关联清理（app_storage.json + 可选 Electron Cache / Code Cache）
// ---------------------------------------------------------------------------

function cleanupAppStorageFile(appStoragePath, goneIdSet) {
  if (!appStoragePath || !existsSync(appStoragePath) || goneIdSet.size === 0) {
    return { changed: false, removedKeys: 0 };
  }
  const st = lstatSync(appStoragePath);
  if (st.isSymbolicLink() || !st.isFile()) {
    return { changed: false, removedKeys: 0 };
  }
  const parsed = JSON.parse(readFileSync(appStoragePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { changed: false, removedKeys: 0 };
  }

  let changed = false;
  let removedKeys = 0;
  const next = { ...parsed };

  for (const key of Object.keys(next)) {
    const m = key.match(/^antigravity-multi-conversation-layout-v3-([0-9a-f-]{36})$/i);
    if (m && goneIdSet.has(m[1].toLowerCase())) {
      delete next[key];
      changed = true;
      removedKeys += 1;
    }
  }

  const indexKey = 'antigravity-multi-conversation-layout-v3-index';
  if (typeof next[indexKey] === 'string') {
    try {
      const arr = JSON.parse(next[indexKey]);
      if (Array.isArray(arr)) {
        const filtered = arr.filter((item) => {
          const norm = normalizeSessionUuid(item);
          return !(norm && goneIdSet.has(norm));
        });
        if (filtered.length !== arr.length) {
          next[indexKey] = JSON.stringify(filtered);
          changed = true;
          removedKeys += arr.length - filtered.length;
        }
      }
    } catch {
      // 保留不可解析项
    }
  }

  for (const paneKey of ['aux-pane-session', 'aux-pane-v2-session']) {
    if (typeof next[paneKey] !== 'string') continue;
    try {
      const obj = JSON.parse(next[paneKey]);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      let paneChanged = false;
      if (obj.conversationPanes && typeof obj.conversationPanes === 'object') {
        for (const k of Object.keys(obj.conversationPanes)) {
          const norm = normalizeSessionUuid(k);
          if (norm && goneIdSet.has(norm)) {
            delete obj.conversationPanes[k];
            paneChanged = true;
            removedKeys += 1;
          }
        }
      }
      for (const k of Object.keys(obj)) {
        const norm = normalizeSessionUuid(k);
        if (norm && goneIdSet.has(norm)) {
          delete obj[k];
          paneChanged = true;
          removedKeys += 1;
        }
      }
      if (paneChanged) {
        next[paneKey] = JSON.stringify(obj);
        changed = true;
      }
    } catch {
      // 忽略损坏 JSON 字符串
    }
  }

  if (changed) {
    writeJsonAtomicSync(appStoragePath, next);
  }
  return { changed, removedKeys };
}

export function clearElectronBrowserCachesIfIdle({
  electronAppDataDir = '',
  geminiDir = '',
  runningClients = null,
} = {}) {
  const warnings = [];
  const dir = resolveElectronAppDataDir({
    explicitAppDataDir: electronAppDataDir,
    explicitGeminiDir: geminiDir,
  });
  if (!dir || !existsSync(dir)) return { clearedDirs: 0, warnings };
  const running = runningClients || detectRunningClients();
  if (!running.checked || running.desktop) {
    warnings.push('browser_cache_skipped_desktop_running');
    return { clearedDirs: 0, warnings };
  }
  const clearedDirs = clearElectronBrowserCaches(dir, warnings);
  return { clearedDirs, warnings };
}

function clearElectronBrowserCaches(electronAppDataDir, warnings) {
  let clearedDirs = 0;
  for (const subName of ['Cache', 'Code Cache']) {
    const check = resolveNoFollowPath(electronAppDataDir, [subName]);
    if (!check.ok || !check.exists || !check.stat?.isDirectory()) continue;
    try {
      rmSync(check.path, { recursive: true, force: true });
      clearedDirs += 1;
    } catch (err) {
      warnings.push(`browser_cache_clear_failed(${subName}): ${err?.message || 'unknown'}`);
    }
  }
  return clearedDirs;
}

function executeExternalReceipt(receipt, options = {}) {
  const warnings = [];
  if (!receipt || typeof receipt !== 'object') {
    return { warnings, appStorageCleaned: false, clearedCacheDirs: 0, deferred: false };
  }

  const rawGeminiDir = options.geminiDir || receipt.geminiDir || '';
  const geminiDir = resolveGeminiDir(rawGeminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir || receipt.backupDir || '', rawGeminiDir);
  const electronAppDataDir = resolveElectronAppDataDir({
    explicitAppDataDir: options.electronAppDataDir || receipt.electronAppDataDir || '',
    explicitGeminiDir: rawGeminiDir,
  });
  const targetIds = Array.isArray(receipt.targetIds)
    ? receipt.targetIds.map((id) => normalizeSessionUuid(id)).filter(Boolean)
    : [];

  if (!electronAppDataDir || !existsSync(electronAppDataDir)) {
    return { warnings, appStorageCleaned: false, clearedCacheDirs: 0, deferred: false };
  }
  if (targetIds.length === 0 && !receipt.clearBrowserCache) {
    return { warnings, appStorageCleaned: false, clearedCacheDirs: 0, deferred: false };
  }

  // 严禁在桌面端 Electron 正在运行时覆写其内存持有的 app_storage.json 或删除浏览器缓存；
  // 保留 .um-clean-extras-*.json 收据，待桌面端退出后由 recoverPendingCleanups 自动补完。
  const running = options.runningClients || detectRunningClients(options);
  if (!running.checked || running.desktop) {
    if (receipt.clearBrowserCache) {
      warnings.push('browser_cache_skipped_desktop_running');
    }
    return { warnings, appStorageCleaned: false, clearedCacheDirs: 0, deferred: true };
  }

  let appStorageCleaned = false;
  if (targetIds.length > 0) {
    const liveAcrossAll = collectAllStoresLiveIds({ geminiDir, backupDir });
    const completelyGone = new Set(targetIds.filter((id) => !liveAcrossAll.has(id)));
    if (completelyGone.size > 0) {
      const storageCheck = resolveNoFollowFile(electronAppDataDir, ['app_storage.json']);
      if (storageCheck.ok && storageCheck.exists) {
        try {
          const res = cleanupAppStorageFile(storageCheck.path, completelyGone);
          appStorageCleaned = res.changed;
        } catch (err) {
          warnings.push(`app_storage_cleanup_failed: ${err?.message || 'unknown'}`);
        }
      }
    }
  }

  let clearedCacheDirs = 0;
  if (receipt.clearBrowserCache) {
    clearedCacheDirs = clearElectronBrowserCaches(electronAppDataDir, warnings);
  }

  return { warnings, appStorageCleaned, clearedCacheDirs, deferred: false };
}

// ---------------------------------------------------------------------------
// 两阶段事务暂存、提交、回滚与崩溃恢复
// ---------------------------------------------------------------------------

function verifySummaryCommitMarker(clientRoot, stageId) {
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  if (!sumCheck.ok || !sumCheck.exists) return false;
  try {
    return Boolean(
      withReadOnlySqliteDb(sumCheck.path, (db) => {
        try {
          const row = db.prepare('SELECT stage FROM um_cleanup_commits WHERE stage = ?').get(stageId);
          return Boolean(row?.stage);
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
}

function finalizeSummaryDbAfterCommit(clientRoot, stageId, warnings) {
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  if (!sumCheck.ok || !sumCheck.exists) return;
  try {
    withWritableSqliteDb(sumCheck.path, (db) => {
      try {
        db.prepare('DELETE FROM um_cleanup_commits WHERE stage = ?').run(stageId);
      } catch {
        // 表不存在时忽略
      }
      try {
        db.exec('PRAGMA secure_delete = ON;');
        db.exec('VACUUM;');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (err) {
        warnings.push(`summary_vacuum_failed: ${err?.message || 'unknown'}`);
      }
    });
  } catch (err) {
    warnings.push(`summary_finalize_failed: ${err?.message || 'unknown'}`);
  }
}

function validatePlanRelSegments(relSegments) {
  if (!Array.isArray(relSegments) || relSegments.length === 0) return false;
  for (const seg of relSegments) {
    if (
      typeof seg !== 'string' ||
      !seg ||
      seg === '.' ||
      seg === '..' ||
      seg.includes('/') ||
      seg.includes('\\') ||
      seg.includes('\0')
    ) {
      return false;
    }
  }
  return true;
}

function rollbackStage(clientRoot, stageDir, plan, warnings) {
  if (!plan || typeof plan !== 'object') return;
  // 1. 逆序还原替换文件
  const replacements = Array.isArray(plan.replacements) ? [...plan.replacements].reverse() : [];
  for (const rep of replacements) {
    if (!validatePlanRelSegments(rep.relSegments)) continue;
    const backupPath = join(stageDir, rep.backupName);
    if (!rep.hadOriginal || !existsSync(backupPath)) continue;
    const targetCheck = resolveNoFollowPath(clientRoot, rep.relSegments);
    if (!targetCheck.ok) {
      warnings.push(`rollback_unsafe_path: ${rep.relSegments.join('/')}`);
      continue;
    }
    try {
      // 如果当前线上文件不是我们刚写入的 nextName，拒绝覆写以防覆盖外部新写入
      const nextPath = join(stageDir, rep.nextName);
      if (targetCheck.exists && rep.nextSha256 && targetCheck.stat?.isFile()) {
        const curSha = sha256Hex(readFileSync(targetCheck.path));
        if (curSha !== rep.nextSha256 && curSha !== rep.expectedSha256) {
          warnings.push(`rollback_refused_modified: ${rep.relSegments.join('/')}`);
          continue;
        }
      }
      if (targetCheck.exists) {
        rmSync(targetCheck.path, { force: true });
      }
      mkdirSync(dirname(targetCheck.path), { recursive: true });
      renameSync(backupPath, targetCheck.path);
      if (existsSync(nextPath)) {
        rmSync(nextPath, { force: true });
      }
    } catch (err) {
      warnings.push(`rollback_replace_failed(${rep.relSegments.join('/')}): ${err?.message || 'unknown'}`);
    }
  }

  // 2. 逆序还原移出的活文件/目录
  const moves = Array.isArray(plan.moves) ? [...plan.moves].reverse() : [];
  for (const mv of moves) {
    if (!validatePlanRelSegments(mv.relSegments)) continue;
    const stagedPath = join(stageDir, mv.stagedName);
    if (!existsSync(stagedPath)) continue;
    const targetCheck = resolveNoFollowPath(clientRoot, mv.relSegments);
    if (!targetCheck.ok) {
      warnings.push(`rollback_unsafe_path: ${mv.relSegments.join('/')}`);
      continue;
    }
    if (targetCheck.exists) {
      warnings.push(`rollback_skipped_occupied: ${mv.relSegments.join('/')}`);
      continue;
    }
    try {
      mkdirSync(dirname(targetCheck.path), { recursive: true });
      renameSync(stagedPath, targetCheck.path);
    } catch (err) {
      warnings.push(`rollback_move_failed(${mv.relSegments.join('/')}): ${err?.message || 'unknown'}`);
    }
  }
}

/**
 * 在客户端未运行时，自动扫描并恢复上一次意外中断留下的暂存目录或外部收据。
 *
 * @param {string} clientRoot
 * @param {typeof SESSION_CLIENT_DEFS[number]} clientDef
 * @param {{ geminiDir?: string, electronAppDataDir?: string, runningClients?: object }} [options={}]
 * @returns {{ recovered: number, warnings: string[] }}
 */
export function recoverPendingCleanups(clientRoot, clientDef, options = {}) {
  const warnings = [];
  let recovered = 0;
  if (!clientRoot || !existsSync(clientRoot)) {
    return { recovered, warnings };
  }

  let entries = [];
  try {
    entries = readdirSync(clientRoot);
  } catch {
    return { recovered, warnings };
  }

  const relevant = entries.filter(
    (name) =>
      name.startsWith(STAGE_PREPARE_PREFIX) ||
      name.startsWith(STAGE_PURGE_PREFIX) ||
      name.startsWith(STAGE_EXTRAS_PREFIX) ||
      (name.startsWith(STAGE_ACTIVE_PREFIX) &&
        !name.startsWith(STAGE_PREPARE_PREFIX) &&
        !name.startsWith(STAGE_PURGE_PREFIX) &&
        !name.startsWith(STAGE_EXTRAS_PREFIX))
  );
  if (relevant.length === 0) {
    return { recovered, warnings };
  }

  let releaseLock = null;
  try {
    releaseLock = acquireStoreLock(clientRoot);
  } catch (err) {
    warnings.push(`recovery_skipped_locked(${clientDef?.id || 'store'}): ${err?.message || 'locked'}`);
    return { recovered, warnings };
  }

  try {
    for (const name of relevant) {
      const entryCheck = resolveNoFollowPath(clientRoot, [name]);
      if (!entryCheck.ok || !entryCheck.exists) continue;

      // 1. Prepare 残留：尚未触碰活文件，直接移除
      if (name.startsWith(STAGE_PREPARE_PREFIX)) {
        try {
          rmSync(entryCheck.path, { recursive: true, force: true });
          recovered += 1;
        } catch (err) {
          warnings.push(`recovery_prepare_remove_failed(${name}): ${err?.message || 'unknown'}`);
        }
        continue;
      }

      // 2. Purge 残留：已提交，继续清理并善后摘要库
      if (name.startsWith(STAGE_PURGE_PREFIX)) {
        const stageId = name.slice(STAGE_PURGE_PREFIX.length);
        finalizeSummaryDbAfterCommit(clientRoot, stageId, warnings);
        try {
          rmSync(entryCheck.path, { recursive: true, force: true });
          recovered += 1;
        } catch (err) {
          warnings.push(`recovery_purge_remove_failed(${name}): ${err?.message || 'unknown'}`);
        }
        continue;
      }

      // 3. 外部收据残留：续执行后删除收据（若桌面端仍在运行则继续保留待下次恢复）
      if (name.startsWith(STAGE_EXTRAS_PREFIX) && entryCheck.stat?.isFile()) {
        try {
          const receipt = JSON.parse(readFileSync(entryCheck.path, 'utf8'));
          const extRes = executeExternalReceipt(receipt, options);
          warnings.push(...extRes.warnings);
          if (!extRes.deferred) {
            rmSync(entryCheck.path, { force: true });
            recovered += 1;
          }
        } catch (err) {
          warnings.push(`recovery_extras_failed(${name}): ${err?.message || 'unknown'}`);
        }
        continue;
      }

      // 4. Active 阶段目录：检查是否已提交；已提交则转 purge 善后，未提交则逆序回滚
      if (name.startsWith(STAGE_ACTIVE_PREFIX) && entryCheck.stat?.isDirectory()) {
        const stageId = name.slice(STAGE_ACTIVE_PREFIX.length);
        const planPath = join(entryCheck.path, 'plan.json');
        let plan = null;
        try {
          if (existsSync(planPath)) {
            plan = JSON.parse(readFileSync(planPath, 'utf8'));
          }
        } catch {
          plan = null;
        }

        const isCommitted =
          existsSync(join(entryCheck.path, 'committed')) ||
          verifySummaryCommitMarker(clientRoot, stageId);

        if (isCommitted) {
          const purgeDir = join(clientRoot, `${STAGE_PURGE_PREFIX}${stageId}`);
          try {
            renameSync(entryCheck.path, purgeDir);
            finalizeSummaryDbAfterCommit(clientRoot, stageId, warnings);
            rmSync(purgeDir, { recursive: true, force: true });
            recovered += 1;
          } catch (err) {
            warnings.push(`recovery_commit_finish_failed(${name}): ${err?.message || 'unknown'}`);
          }
        } else {
          if (plan) {
            rollbackStage(clientRoot, entryCheck.path, plan, warnings);
          } else {
            warnings.push(`recovery_missing_plan(${name})`);
          }
          try {
            rmSync(entryCheck.path, { recursive: true, force: true });
            recovered += 1;
          } catch (err) {
            warnings.push(`recovery_rollback_cleanup_failed(${name}): ${err?.message || 'unknown'}`);
          }
        }
      }
    }
  } finally {
    releaseLock?.();
  }

  return { recovered, warnings };
}

/**
 * 在单个未运行客户端存储内执行两阶段事务清理（不负责进程检测，由外层已确认）。
 *
 * @param {{
 *   clientDef: typeof SESSION_CLIENT_DEFS[number],
 *   clientRoot: string,
 *   targetIds: Set<string>,
 *   protectedIds?: Set<string>,
 *   preserveProtectedBrain?: boolean,
 *   geminiDir?: string,
 *   electronAppDataDir?: string,
 *   clearBrowserCache?: boolean,
 *   runningClients?: object,
 *   onBeforeCommit?: (ctx: { stageDir: string, stageId: string }) => void,
 *   onAfterCommitBeforePurge?: (ctx: { stageDir: string, stageId: string }) => void,
 * }} params
 */
function executeStoreTransactionCleanup({
  clientDef,
  clientRoot,
  targetIds,
  protectedIds = new Set(),
  preserveProtectedBrain = true,
  geminiDir = '',
  backupDir = '',
  electronAppDataDir = '',
  clearBrowserCache = false,
  runningClients = null,
  onBeforeCommit = null,
  onAfterCommitBeforePurge = null,
}) {
  const warnings = [];
  const removeSet = new Set();
  for (const id of targetIds) {
    const norm = normalizeSessionUuid(id);
    if (norm) removeSet.add(norm);
  }
  if (removeSet.size === 0 || !existsSync(clientRoot)) {
    return { removedIds: [], protectedBrainKept: [], warnings };
  }

  const removeList = Array.from(removeSet);
  const stageId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const prepareDir = join(clientRoot, `${STAGE_PREPARE_PREFIX}${stageId}`);
  const activeDir = join(clientRoot, `${STAGE_ACTIVE_PREFIX}${stageId}`);
  const purgeDir = join(clientRoot, `${STAGE_PURGE_PREFIX}${stageId}`);

  const releaseLock = acquireStoreLock(clientRoot);
  let currentStageDir = prepareDir;
  let committed = false;
  let plan = null;
  const protectedBrainKept = [];

  try {
    mkdirSync(prepareDir, { recursive: true });
    const moves = [];
    const replacements = [];
    let seqIdx = 0;

    // 1. 收集每个目标会话的实体文件/目录
    for (const cid of removeList) {
      const fileSpecs = [
        ['conversations', `${cid}.db`],
        ['conversations', `${cid}.db-wal`],
        ['conversations', `${cid}.db-shm`],
        ['conversations', `${cid}.db-journal`],
        ['conversations', `${cid}.pb`],
        ['annotations', `${cid}.pbtxt`],
        ['presence', `${cid}.lock`],
      ];
      for (const relSegments of fileSpecs) {
        const check = resolveNoFollowFile(clientRoot, relSegments);
        if (!check.ok) {
          throw new Error(`unsafe_artifact_path(${relSegments.join('/')}): ${check.error}`);
        }
        if (check.exists) {
          seqIdx += 1;
          moves.push({
            relSegments,
            stagedName: `mv_${seqIdx}`,
            kind: 'file',
          });
        }
      }

      const brainCheck = resolveNoFollowPath(clientRoot, ['brain', cid]);
      if (!brainCheck.ok) {
        throw new Error(`unsafe_brain_path(brain/${cid}): ${brainCheck.error}`);
      }
      if (brainCheck.exists) {
        if (preserveProtectedBrain && protectedIds.has(cid)) {
          protectedBrainKept.push(cid);
          // 保留跨端迁入图片所需的媒体附件，但事务性剥离并清除整个 .system_generated（含 logs/steps/tasks）与 scratch 明文目录
          for (const subSeg of ['.system_generated', 'scratch']) {
            const subCheck = resolveNoFollowPath(clientRoot, ['brain', cid, subSeg]);
            if (!subCheck.ok) {
              throw new Error(`unsafe_brain_subpath(brain/${cid}/${subSeg}): ${subCheck.error}`);
            }
            if (subCheck.exists) {
              seqIdx += 1;
              moves.push({
                relSegments: ['brain', cid, subSeg],
                stagedName: `mv_${seqIdx}`,
                kind: subCheck.stat?.isDirectory() ? 'dir' : 'file',
              });
            }
          }
        } else {
          seqIdx += 1;
          moves.push({
            relSegments: ['brain', cid],
            stagedName: `mv_${seqIdx}`,
            kind: brainCheck.stat?.isDirectory() ? 'dir' : 'file',
          });
        }
      }
    }

    // 2. 收集匹配的 sidecar_data 事件文件（跳过 /fork）
    for (const relSegments of findMatchingSidecarEventRelPaths(clientRoot, removeSet)) {
      seqIdx += 1;
      moves.push({
        relSegments,
        stagedName: `mv_${seqIdx}`,
        kind: 'file',
      });
    }

    // 3. 准备待过滤重写的索引、缓存、历史与日志
    const stageReplacement = (relSegments, transformFn, { strictProto = false } = {}) => {
      const check = resolveNoFollowFile(clientRoot, relSegments);
      if (!check.ok) {
        throw new Error(`unsafe_index_path(${relSegments.join('/')}): ${check.error}`);
      }
      if (!check.exists) return;
      const origBuf = readFileSync(check.path);
      let res;
      try {
        res = transformFn(origBuf);
      } catch (err) {
        if (strictProto) {
          const protoErr = new Error(err?.message || 'proto_index_corrupt');
          protoErr.code = 'PROTO_CORRUPT';
          throw protoErr;
        }
        warnings.push(`index_filter_skipped(${relSegments.join('/')}): ${err?.message || 'parse_failed'}`);
        return;
      }
      if (!res || !res.changed) return;
      seqIdx += 1;
      const nextName = `rep_next_${seqIdx}`;
      const backupName = `rep_bak_${seqIdx}`;
      writeFileSync(join(prepareDir, nextName), res.buffer);
      replacements.push({
        relSegments,
        nextName,
        backupName,
        expectedSha256: sha256Hex(origBuf),
        nextSha256: sha256Hex(res.buffer),
        hadOriginal: true,
      });
    };

    if (clientDef.summaryProtoFile) {
      stageReplacement(
        [clientDef.summaryProtoFile],
        (buf) => filterSummaryProtoIndex(buf, removeSet, { isDesktop: Boolean(clientDef.isDesktopProto) }),
        { strictProto: true }
      );
    }

    stageReplacement(['cache', 'last_conversations.json'], (buf) =>
      filterLastConversationsJson(buf, removeSet)
    );
    stageReplacement(['cache', 'conversation_metadata.json'], (buf) =>
      filterConversationMetadataJson(buf, removeSet)
    );
    if (clientDef.hasHistoryJsonl) {
      stageReplacement(['history.jsonl'], (buf) => filterHistoryJsonlBuffer(buf, removeSet));
    }

    const sidecarLogCheck = resolveNoFollowFile(clientRoot, ['logs', 'sidecar.log']);
    if (sidecarLogCheck.ok && sidecarLogCheck.exists && (sidecarLogCheck.stat?.size || 0) <= MAX_SIDECAR_LOG_BYTES) {
      stageReplacement(['logs', 'sidecar.log'], (buf) =>
        filterLogLinesContainingIds(buf, removeList)
      );
    }

    const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
    if (!sumCheck.ok) {
      throw new Error(`unsafe_summary_db: ${sumCheck.error}`);
    }

    plan = {
      version: 1,
      stageId,
      clientId: clientDef.id,
      createdAtMs: Date.now(),
      targetIds: removeList,
      moves,
      replacements,
      hasSummaryDb: sumCheck.exists,
    };
    writeFileSync(join(prepareDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

    // 4. Prepare -> Active
    renameSync(prepareDir, activeDir);
    currentStageDir = activeDir;

    // 5. 逐个移出活产物到 activeDir
    for (const mv of moves) {
      const liveCheck = resolveNoFollowPath(clientRoot, mv.relSegments);
      if (!liveCheck.ok) {
        throw new Error(`live_path_unsafe(${mv.relSegments.join('/')}): ${liveCheck.error}`);
      }
      if (!liveCheck.exists) continue;
      renameSync(liveCheck.path, join(activeDir, mv.stagedName));
    }

    // 6. 逐个执行字节级 CAS 校验并原子替换索引/缓存文件
    for (const rep of replacements) {
      const liveCheck = resolveNoFollowFile(clientRoot, rep.relSegments);
      if (!liveCheck.ok || !liveCheck.exists) {
        throw new Error(`cas_missing(${rep.relSegments.join('/')})`);
      }
      const curSha = sha256Hex(readFileSync(liveCheck.path));
      if (curSha !== rep.expectedSha256) {
        throw new Error(`concurrent_modification(${rep.relSegments.join('/')})`);
      }
      renameSync(liveCheck.path, join(activeDir, rep.backupName));
      renameSync(join(activeDir, rep.nextName), liveCheck.path);
    }

    if (typeof onBeforeCommit === 'function') {
      onBeforeCommit({ stageDir: activeDir, stageId });
    }

    // 7. 原子提交点：写入 conversation_summaries.db 删除 + um_cleanup_commits 标记（或无库时写 committed）
    if (sumCheck.exists) {
      withWritableSqliteDb(sumCheck.path, (db) => {
        db.exec('PRAGMA secure_delete = ON;');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(
            'CREATE TABLE IF NOT EXISTS um_cleanup_commits (stage TEXT PRIMARY KEY, committed_at_ms INTEGER NOT NULL)'
          );
          const delSum = db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?');
          let delFts = null;
          try {
            delFts = db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?');
          } catch {
            delFts = null;
          }
          for (const cid of removeList) {
            delSum.run(cid);
            if (delFts) delFts.run(cid);
          }
          deleteConversationParentsByIds(db, removeList);

          if (delFts) {
            try {
              db.exec("INSERT INTO conversations_fts(conversations_fts) VALUES ('rebuild')");
            } catch {
              // 非标准 FTS5 表时跳过
            }
          }

          db.prepare(
            'INSERT OR REPLACE INTO um_cleanup_commits (stage, committed_at_ms) VALUES (?, ?)'
          ).run(stageId, Date.now());
          db.exec('COMMIT');
        } catch (txErr) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 忽略回滚异常
          }
          throw txErr;
        }
      });
    } else {
      writeFileSync(join(activeDir, 'committed'), `${Date.now()}\n`, 'utf8');
    }

    committed = true;

    if (typeof onAfterCommitBeforePurge === 'function') {
      onAfterCommitBeforePurge({ stageDir: activeDir, stageId });
    }

    // 8. 持久化外部清理收据（确保三端均已删除且桌面端空闲时同步清理 Electron app_storage.json 及可选浏览器缓存）
    let extrasReceiptPath = '';
    const resolvedAppData = resolveElectronAppDataDir({
      explicitAppDataDir: electronAppDataDir,
      explicitGeminiDir: geminiDir,
    });
    if (clearBrowserCache || (resolvedAppData && existsSync(resolvedAppData))) {
      extrasReceiptPath = join(clientRoot, `${STAGE_EXTRAS_PREFIX}${stageId}.json`);
      writeJsonAtomicSync(extrasReceiptPath, {
        stageId,
        targetIds: removeList,
        geminiDir,
        backupDir,
        electronAppDataDir: resolvedAppData,
        clearBrowserCache: Boolean(clearBrowserCache),
      });
    }

    // 9. Active -> Purge，释放磁盘并压缩摘要库
    renameSync(activeDir, purgeDir);
    currentStageDir = purgeDir;

    if (sumCheck.exists) {
      finalizeSummaryDbAfterCommit(clientRoot, stageId, warnings);
    }

    try {
      rmSync(purgeDir, { recursive: true, force: true });
    } catch (err) {
      warnings.push(`stage_purge_failed: ${err?.message || 'unknown'}`);
    }

    // 同步清理 archived-sources 下的源会话明文 SQLite 备份（保留媒体时替换为零明文 .protected.json 标记）
    const protectedDeletedList = removeList.filter((cid) => protectedIds.has(cid));
    if (protectedDeletedList.length > 0 || !preserveProtectedBrain) {
      cleanupProtectedMigrationArchives({
        backupDir,
        geminiDir,
        clientId: clientDef.id,
        sessionIds: preserveProtectedBrain ? protectedDeletedList : removeList,
        keepProtectionMarker: Boolean(preserveProtectedBrain),
      });
    }

    // 10. 提交后执行外部收据（若桌面端运行中则延后保留收据；失败记 warning，不回滚已提交删除）
    if (extrasReceiptPath && existsSync(extrasReceiptPath)) {
      try {
        const receipt = JSON.parse(readFileSync(extrasReceiptPath, 'utf8'));
        const extRes = executeExternalReceipt(receipt, {
          geminiDir,
          backupDir,
          electronAppDataDir,
          runningClients,
        });
        warnings.push(...extRes.warnings);
        if (!extRes.deferred) {
          rmSync(extrasReceiptPath, { force: true });
        }
      } catch (err) {
        warnings.push(`external_cleanup_failed: ${err?.message || 'unknown'}`);
      }
    }

    return {
      removedIds: removeList,
      protectedBrainKept,
      warnings,
    };
  } catch (err) {
    if (!committed) {
      if (currentStageDir === activeDir && plan) {
        rollbackStage(clientRoot, activeDir, plan, warnings);
      }
      try {
        if (existsSync(currentStageDir)) {
          rmSync(currentStageDir, { recursive: true, force: true });
        }
      } catch {
        // 忽略回滚后的清理异常
      }
    }
    err.cleanupWarnings = warnings;
    throw err;
  } finally {
    releaseLock();
  }
}

/**
 * 批量清理单个客户端存储的指定会话；若批处理遇单条文件异常则自动降级逐条重试。
 *
 * @param {object} params
 */
export function cleanClientSessionsBatch({
  clientDef,
  clientRoot,
  requestedIds,
  protectedIds = new Set(),
  preserveProtectedBrain = true,
  geminiDir = '',
  backupDir = '',
  electronAppDataDir = '',
  clearBrowserCache = false,
  runningClients = null,
  onBeforeCommit = null,
  onAfterCommitBeforePurge = null,
}) {
  const uniqueIds = [];
  const seen = new Set();
  for (const raw of requestedIds || []) {
    const norm = normalizeSessionUuid(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    uniqueIds.push(norm);
  }
  if (uniqueIds.length === 0) {
    return {
      succeeded: [],
      failed: [],
      cascadeSubagentIds: [],
      protectedBrainKept: [],
      warnings: [],
    };
  }

  const { expandedIds, cascadeSubagentIds } = expandStoreCascadeTargets(clientRoot, new Set(uniqueIds));

  // 单遍事务批量执行
  try {
    const res = executeStoreTransactionCleanup({
      clientDef,
      clientRoot,
      targetIds: expandedIds,
      protectedIds,
      preserveProtectedBrain,
      geminiDir,
      backupDir,
      electronAppDataDir,
      clearBrowserCache,
      runningClients,
      onBeforeCommit,
      onAfterCommitBeforePurge,
    });
    return {
      succeeded: uniqueIds,
      failed: [],
      cascadeSubagentIds,
      protectedBrainKept: res.protectedBrainKept,
      warnings: res.warnings,
    };
  } catch (batchErr) {
    if (uniqueIds.length === 1 || isNonRetryableStoreError(batchErr)) {
      return {
        succeeded: [],
        failed: uniqueIds.map((id) => ({
          clientId: clientDef.id,
          sessionId: id,
          error: batchErr?.message || 'delete_failed',
        })),
        cascadeSubagentIds: [],
        protectedBrainKept: [],
        warnings: Array.isArray(batchErr?.cleanupWarnings) ? batchErr.cleanupWarnings : [],
      };
    }

    // 降级逐条重试，防止单条坏文件拖垮整批
    const succeeded = [];
    const failed = [];
    const totalCascade = [];
    const totalProtectedKept = [];
    const totalWarnings = Array.isArray(batchErr?.cleanupWarnings)
      ? [...batchErr.cleanupWarnings]
      : [];

    for (let i = 0; i < uniqueIds.length; i += 1) {
      const id = uniqueIds[i];
      const subExpand = expandStoreCascadeTargets(clientRoot, new Set([id]));
      try {
        const singleRes = executeStoreTransactionCleanup({
          clientDef,
          clientRoot,
          targetIds: subExpand.expandedIds,
          protectedIds,
          preserveProtectedBrain,
          geminiDir,
          backupDir,
          electronAppDataDir,
          clearBrowserCache: false,
          runningClients,
        });
        succeeded.push(id);
        totalCascade.push(...subExpand.cascadeSubagentIds);
        totalProtectedKept.push(...singleRes.protectedBrainKept);
        totalWarnings.push(...singleRes.warnings);
      } catch (itemErr) {
        failed.push({
          clientId: clientDef.id,
          sessionId: id,
          error: itemErr?.message || 'delete_failed',
        });
        if (Array.isArray(itemErr?.cleanupWarnings)) {
          totalWarnings.push(...itemErr.cleanupWarnings);
        }
      }
    }

    if (clearBrowserCache && succeeded.length > 0) {
      const cacheRes = clearElectronBrowserCachesIfIdle({
        electronAppDataDir,
        geminiDir,
        runningClients,
      });
      totalWarnings.push(...cacheRes.warnings);
    }

    return {
      succeeded,
      failed,
      cascadeSubagentIds: totalCascade,
      protectedBrainKept: totalProtectedKept,
      warnings: totalWarnings,
    };
  }
}

/**
 * 联动清理其他未运行客户端中与 `deletedIds` 同 UUID 的仅索引残留，或用户显式确认的历史孤立索引。
 *
 * @param {{
 *   deletedIds: Iterable<string>,
 *   extraOrphanTargets?: Array<{ clientId: string, sessionId: string }>,
 *   runningClients: { desktop: boolean, cli: boolean, ide_legacy: boolean, checked: boolean },
 *   geminiDir?: string,
 *   electronAppDataDir?: string,
 * }} params
 */
export function cleanupCrossClientIndexOnlyResiduals({
  deletedIds = [],
  extraOrphanTargets = [],
  runningClients,
  geminiDir = '',
  backupDir = '',
  electronAppDataDir = '',
}) {
  const warnings = [];
  let cleanedCount = 0;
  if (!runningClients?.checked) {
    return { cleanedCount, warnings };
  }

  const baseGemini = resolveGeminiDir(geminiDir);
  const deletedSet = new Set();
  for (const raw of deletedIds) {
    const id = normalizeSessionUuid(raw);
    if (id) deletedSet.add(id);
  }

  const byClient = new Map();
  for (const def of SESSION_CLIENT_DEFS) {
    if (runningClients[def.id]) continue;
    const root = join(baseGemini, def.dirName);
    if (!existsSync(root)) continue;
    const artifactIds = collectStoreArtifactIds(root);
    const indexIds = collectStoreIndexIds(root, def);

    for (const id of deletedSet) {
      if (indexIds.has(id) && !artifactIds.has(id)) {
        if (!byClient.has(def.id)) byClient.set(def.id, new Set());
        byClient.get(def.id).add(id);
      }
    }
  }

  for (const item of extraOrphanTargets || []) {
    const def = getSessionClientDef(item?.clientId);
    const id = normalizeSessionUuid(item?.sessionId);
    if (!def || !id || runningClients[def.id]) continue;
    const root = join(baseGemini, def.dirName);
    if (!existsSync(root)) continue;
    const artifactIds = collectStoreArtifactIds(root);
    const indexIds = collectStoreIndexIds(root, def);
    if (indexIds.has(id) && !artifactIds.has(id)) {
      if (!byClient.has(def.id)) byClient.set(def.id, new Set());
      byClient.get(def.id).add(id);
    }
  }

  for (const [clientId, idSet] of byClient.entries()) {
    if (idSet.size === 0) continue;
    const def = getSessionClientDef(clientId);
    const root = join(baseGemini, def.dirName);
    const res = cleanClientSessionsBatch({
      clientDef: def,
      clientRoot: root,
      requestedIds: idSet,
      geminiDir: baseGemini,
      backupDir,
      electronAppDataDir,
      clearBrowserCache: false,
      runningClients,
    });
    cleanedCount += res.succeeded.length;
    warnings.push(...res.warnings);
    for (const f of res.failed) {
      warnings.push(`orphan_index_cleanup_failed(${clientId}/${f.sessionId}): ${f.error}`);
    }
  }

  return { cleanedCount, warnings };
}

// ---------------------------------------------------------------------------
// 原生账本在线隐私脱敏
// ---------------------------------------------------------------------------

/**
 * 针对已从全部本机客户端彻底消失的本地会话，在插件进程内实时脱敏 SQLite 账本与内存缓存。
 * 绝不触碰仍在任意客户端存活的会话，也绝不触碰远端 SSH 会话，且 100% 保留 Token/费用统计。
 *
 * @param {{
 *   targetIds?: Iterable<string>,
 *   sweepAllDeleted?: boolean,
 *   geminiDir?: string,
 *   cacheStore?: ReturnType<import('./trajectory-cache-store.mjs').createTrajectoryCacheStore>,
 *   placeholderTitle?: string,
 * }} [options={}]
 */
export function redactDeletedLedgerSessions({
  targetIds = [],
  sweepAllDeleted = false,
  geminiDir = '',
  backupDir = '',
  extraLiveIds = null,
  onlineDeletedByClient = null,
  cacheStore = undefined,
  placeholderTitle = DEFAULT_REDACTED_SESSION_TITLE,
} = {}) {
  const store = resolveScopedTrajectoryCacheStore(
    { geminiDir, cacheStore },
    getLocalTrajectoryCacheStore
  );
  if (!store) {
    if (String(geminiDir || '').trim() && cacheStore === undefined) {
      return {
        ok: true,
        skippedUnscoped: true,
        redactedConversations: 0,
        redactedSteps: 0,
        redactedBakConversations: 0,
        skippedLiveCount: 0,
        changedIds: [],
      };
    }
    return {
      ok: false,
      error: 'ledger_store_unavailable',
      redactedConversations: 0,
      redactedSteps: 0,
      redactedBakConversations: 0,
      skippedLiveCount: 0,
    };
  }
  if (typeof store.redactConversations !== 'function') {
    return {
      ok: false,
      error: 'ledger_store_unavailable',
      redactedConversations: 0,
      redactedSteps: 0,
      redactedBakConversations: 0,
      skippedLiveCount: 0,
    };
  }

  if (sweepAllDeleted && !hasAnyClientStoreDir({ geminiDir })) {
    return {
      ok: true,
      redactedConversations: 0,
      redactedSteps: 0,
      redactedBakConversations: 0,
      skippedLiveCount: 0,
      changedIds: [],
    };
  }

  const allLiveIds = collectAllStoresLiveIds({
    geminiDir,
    backupDir,
    excludeIdsByClient: !sweepAllDeleted ? onlineDeletedByClient : null,
  });
  if (extraLiveIds) {
    for (const raw of extraLiveIds) {
      const norm = normalizeSessionUuid(raw);
      if (norm) allLiveIds.add(norm);
    }
  }
  if (sweepAllDeleted) {
    sweepOrphanedMigrationArchiveDbs({ backupDir, geminiDir, allLiveIds });
  }

  const cachedEntries = store.listCachedTrajectoryEntries();
  if (sweepAllDeleted && allLiveIds.size > 0) {
    // 沿存活父会话的 subagentRefs 及子代理/旁路提问归属边做不动点闭包（排除独立已删 /fork）
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [rawId, entry] of cachedEntries) {
        const norm = normalizeSessionUuid(rawId);
        if (!norm) continue;
        if (allLiveIds.has(norm)) {
          for (const ref of entry?.subagentRefs || []) {
            const refId = normalizeSessionUuid(ref?.cascadeId);
            if (refId && !allLiveIds.has(refId)) {
              allLiveIds.add(refId);
              expanded = true;
            }
          }
        } else {
          const parentId = normalizeSessionUuid(entry?.parentConversationId || entry?.parentCascadeId);
          const isChildSubagent = Boolean(
            entry?.isSubagent ||
              entry?.isSideQuestion ||
              entry?.subagentSpec
          );
          if (isChildSubagent && parentId && allLiveIds.has(parentId)) {
            allLiveIds.add(norm);
            expanded = true;
          }
        }
      }
    }
  }

  const eligible = new Set();
  let skippedLiveCount = 0;

  if (sweepAllDeleted) {
    for (const [rawId, entry] of cachedEntries) {
      const norm = normalizeSessionUuid(rawId);
      if (!norm) continue;
      if (String(entry?.appSource || '').toLowerCase() === 'ssh') continue;
      if (allLiveIds.has(norm)) continue;
      eligible.add(norm);
    }
  } else {
    for (const raw of targetIds || []) {
      const norm = normalizeSessionUuid(raw);
      if (!norm) continue;
      if (allLiveIds.has(norm)) {
        skippedLiveCount += 1;
        continue;
      }
      eligible.add(norm);
    }
  }

  if (eligible.size === 0) {
    return {
      ok: true,
      redactedConversations: 0,
      redactedSteps: 0,
      redactedBakConversations: 0,
      skippedLiveCount,
      changedIds: [],
    };
  }

  const res = store.redactConversations(eligible, { placeholderTitle });
  if ((res.redactedConversations || 0) > 0 || (res.redactedSteps || 0) > 0) {
    clearUsageAggregatorMemo(LOCAL_ENDPOINT_ID);
  }
  return {
    ...res,
    skippedLiveCount,
  };
}
