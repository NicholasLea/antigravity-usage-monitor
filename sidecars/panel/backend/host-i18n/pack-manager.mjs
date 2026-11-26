/**
 * @fileoverview 独立解耦的 Antigravity 宿主语言包状态、远端清单同步、SHA-256 校验与本地缓存管理器。
 *
 * 持久化边界：
 * 全部落盘在 `DATA_DIR/host-i18n/` 下，与主插件 `settings.json` 及监控遥测状态完全隔离：
 * - `state.json`          ：当前选中的 `locale`（`'off'` 或 BCP-47）与 `depth`（`'light' | 'deep'`）
 * - `manifest-cache.json` ：远端仓库可用语言包清单缓存
 * - `installed-meta.json` ：已下载语言包元信息索引
 * - `packs/<locale>.json` ：通过 SHA-256 校验后的单语言分层语言包本体
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_I18N_DEFAULT_DEPTH,
  HOST_I18N_OFF_LOCALE,
  HOST_I18N_SCHEMA_VERSION,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
} from '../../shared/host-i18n-protocol.mjs';
import { DATA_DIR, OFFICIAL_GITHUB_REPO, detectCustomGitForkRepo } from '../config.mjs';
import { writeJsonAtomicSync, writeTextFileAtomicSync } from '../fs-atomic.mjs';
import { isPlainObject } from '../http-helpers.mjs';
import { compareSemver, isValidSemver } from '../pricing-catalog.mjs';
import { fetchHostI18nTextWithFallback } from './http-fetch.mjs';

export const DEFAULT_HOST_I18N_REF = 'main';
export const HOST_I18N_MANIFEST_TTL_MS = 6 * 3600 * 1000;
const HOST_I18N_SHA256_RE = /^[a-f0-9]{64}$/i;
const HOST_I18N_ALLOWED_REGEX_FLAGS_RE = /^[i]?$/;
const HOST_I18N_UNSAFE_REGEX_RE = /\([^)]*[+*][^)]*\)[+*{]/;

function hostI18nSha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * 按 SemVer 2.0 判断远端语言包版本是否严格高于本地已安装版本，防止旧版远端清单触发降级覆盖。
 *
 * @param {string} remoteVersion
 * @param {string} installedVersion
 * @returns {boolean}
 */
export function isRemoteHostI18nPackNewer(remoteVersion, installedVersion) {
  const remote = String(remoteVersion || '').trim();
  const local = String(installedVersion || '').trim();
  if (!remote || !isValidSemver(remote)) return false;
  if (!local || !isValidSemver(local)) return true;
  return compareSemver(remote, local) > 0;
}

function hostI18nResolveStoragePaths(baseDataDir = DATA_DIR) {
  const rootDir = join(baseDataDir, 'host-i18n');
  return {
    rootDir,
    stateFile: join(rootDir, 'state.json'),
    manifestCacheFile: join(rootDir, 'manifest-cache.json'),
    installedMetaFile: join(rootDir, 'installed-meta.json'),
    packsDir: join(rootDir, 'packs'),
  };
}

function hostI18nResolveRepoAndRef(options = {}) {
  const envRepo = String(process?.env?.USAGE_MONITOR_HOST_I18N_REPO || '').trim();
  const repo =
    String(options?.repo || '').trim() ||
    envRepo ||
    detectCustomGitForkRepo() ||
    OFFICIAL_GITHUB_REPO;
  const envRef = String(process?.env?.USAGE_MONITOR_HOST_I18N_REF || '').trim();
  const ref = String(options?.ref || '').trim() || envRef || DEFAULT_HOST_I18N_REF;
  const localDir =
    String(options?.localSourceDir || '').trim() ||
    String(process?.env?.USAGE_MONITOR_HOST_I18N_LOCAL_DIR || '').trim();
  return { repo, ref, localDir };
}

/**
 * 构建仓库内语言包文件的主/备下载 URL（GitHub Raw 主源 + jsDelivr 镜像兜底）。
 *
 * @param {string} relPath 如 `'manifest.json'` 或 `'packs/zh-CN.json'`
 * @param {{ repo?: string, ref?: string }} [options]
 * @returns {string[]}
 */
export function buildHostI18nAssetUrls(relPath, options = {}) {
  const cleanRel = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleanRel || cleanRel.includes('..')) {
    throw new Error(`Invalid host-i18n relative asset path: ${relPath}`);
  }
  const { repo, ref } = hostI18nResolveRepoAndRef(options);
  return [
    `https://raw.githubusercontent.com/${repo}/${ref}/host-i18n/dist/${cleanRel}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${ref}/host-i18n/dist/${cleanRel}`,
  ];
}

function sanitizeHostI18nExactMap(rawMap) {
  const out = {};
  if (!isPlainObject(rawMap)) return out;
  for (const [k, v] of Object.entries(rawMap)) {
    const key = String(k || '').replace(/\r\n/g, '\n').trim();
    const val = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
    if (!key || !val || key.length > 1000 || val.length > 1500) continue;
    out[key] = val;
  }
  return out;
}

function sanitizeHostI18nPatterns(rawList) {
  const out = [];
  if (!Array.isArray(rawList)) return out;
  for (const item of rawList) {
    if (!isPlainObject(item)) continue;
    const source = typeof item.source === 'string' ? item.source : '';
    const flags = typeof item.flags === 'string' ? item.flags : '';
    const replace = typeof item.replace === 'string' ? item.replace : '';
    const hint = typeof item.hint === 'string' ? item.hint.trim() : '';
    if (!source || source.length > 360 || !source.startsWith('^') || !source.endsWith('$')) {
      continue;
    }
    if (!HOST_I18N_ALLOWED_REGEX_FLAGS_RE.test(flags) || HOST_I18N_UNSAFE_REGEX_RE.test(source)) {
      continue;
    }
    if (!replace || replace.length > 800) continue;
    try {
      // 校验正则可合法编译
      // eslint-disable-next-line no-new
      new RegExp(source, flags);
    } catch {
      continue;
    }
    out.push(hint ? { source, flags, replace, hint } : { source, flags, replace });
  }
  return out;
}

/**
 * 校验并规范化远端或本地的 `manifest.json` 载荷。
 *
 * @param {unknown} raw
 * @returns {{ schemaVersion: number, packs: Array<object> }}
 */
export function sanitizeHostI18nManifest(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid host-i18n manifest payload');
  }
  const schemaVersion = Number(raw.schemaVersion || 0);
  if (schemaVersion !== HOST_I18N_SCHEMA_VERSION) {
    throw new Error(`Unsupported host-i18n manifest schemaVersion: ${schemaVersion}`);
  }
  const rawPacks = Array.isArray(raw.packs) ? raw.packs : [];
  const packs = [];
  const seen = new Set();
  for (const item of rawPacks) {
    if (!isPlainObject(item)) continue;
    const locale = normalizeHostI18nLocale(item.locale);
    if (locale === HOST_I18N_OFF_LOCALE || seen.has(locale)) continue;
    const sha256 = String(item.sha256 || '').trim().toLowerCase();
    const version = String(item.version || '').trim();
    const file = String(item.file || `packs/${locale}.json`)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!HOST_I18N_SHA256_RE.test(sha256) || !version || file.includes('..') || !file.endsWith('.json')) {
      continue;
    }
    seen.add(locale);
    packs.push({
      locale,
      name: String(item.name || locale).trim(),
      nativeName: String(item.nativeName || item.name || locale).trim(),
      version,
      file,
      sha256,
      bytes: Math.max(0, Number(item.bytes || 0) || 0),
      depths: Array.isArray(item.depths)
        ? item.depths.map((d) => normalizeHostI18nDepth(d)).filter((v, i, a) => a.indexOf(v) === i)
        : ['light', 'deep'],
      stats: isPlainObject(item.stats)
        ? {
            baseExact: Number(item.stats.baseExact || 0) || 0,
            lightExact: Number(item.stats.lightExact || 0) || 0,
            deepExact: Number(item.stats.deepExact || 0) || 0,
            basePatterns: Number(item.stats.basePatterns || 0) || 0,
            lightPatterns: Number(item.stats.lightPatterns || 0) || 0,
            deepPatterns: Number(item.stats.deepPatterns || 0) || 0,
          }
        : null,
    });
  }
  return { schemaVersion, packs };
}

/**
 * 校验并规范化单个语言包 JSON 内容。
 *
 * @param {unknown} raw
 * @param {string} expectedLocale
 */
export function sanitizeHostI18nPack(raw, expectedLocale = '') {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid host-i18n pack payload');
  }
  const schemaVersion = Number(raw.schemaVersion || 0);
  if (schemaVersion !== HOST_I18N_SCHEMA_VERSION) {
    throw new Error(`Unsupported host-i18n pack schemaVersion: ${schemaVersion}`);
  }
  const locale = normalizeHostI18nLocale(raw.locale);
  if (locale === HOST_I18N_OFF_LOCALE) {
    throw new Error('Invalid locale in host-i18n pack');
  }
  if (expectedLocale && locale !== normalizeHostI18nLocale(expectedLocale)) {
    throw new Error(`Pack locale mismatch: expected ${expectedLocale}, got ${locale}`);
  }
  const version = String(raw.version || '').trim();
  if (!version) {
    throw new Error('Missing version in host-i18n pack');
  }
  const baseExact = sanitizeHostI18nExactMap(raw.base?.exact);
  const basePatterns = sanitizeHostI18nPatterns(raw.base?.patterns);
  const lightExact = sanitizeHostI18nExactMap(raw.modes?.light?.exact);
  const lightPatterns = sanitizeHostI18nPatterns(raw.modes?.light?.patterns);
  const deepExact = sanitizeHostI18nExactMap(raw.modes?.deep?.exact);
  const deepPatterns = sanitizeHostI18nPatterns(raw.modes?.deep?.patterns);

  return {
    schemaVersion,
    locale,
    name: String(raw.name || locale).trim(),
    nativeName: String(raw.nativeName || raw.name || locale).trim(),
    version,
    base: { exact: baseExact, patterns: basePatterns },
    modes: {
      light: { exact: lightExact, patterns: lightPatterns },
      deep: { exact: deepExact, patterns: deepPatterns },
    },
  };
}

function hostI18nPatternSpecificityScore(source) {
  const s = String(source || '');
  let literalChars = 0;
  let parenDepth = 0;
  let inCharClass = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (parenDepth === 0 && !inCharClass && !/[dDwWsSbB]/.test(next)) {
        literalChars += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;
    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      continue;
    }
    if (parenDepth === 0 && !'^$.*+?{}|'.includes(ch)) {
      literalChars += 1;
    }
  }
  const looseWildcards = (s.match(/\(\.\+\?\)|\(\.\*\?\)/g) || []).length;
  const typedCaptures = (s.match(/\\d\+/g) || []).length;
  return literalChars * 4 + typedCaptures * 3 - looseWildcards * 6;
}

/**
 * 根据语言包与深/浅档位合成运行期单层查找载荷。
 *
 * @param {object} pack
 * @param {'light'|'deep'} depth
 * @param {string} sha256
 */
export function compileHostI18nRuntimePayload(pack, depth, sha256 = '') {
  const safeDepth = normalizeHostI18nDepth(depth);
  const modeBucket = safeDepth === 'deep' ? pack?.modes?.deep : pack?.modes?.light;
  const exact = {
    ...(pack?.base?.exact || {}),
    ...(modeBucket?.exact || {}),
  };
  const taggedPatterns = [
    ...(Array.isArray(pack?.base?.patterns)
      ? pack.base.patterns.map((rule) => ({ rule, tierRank: 0 }))
      : []),
    ...(Array.isArray(modeBucket?.patterns)
      ? modeBucket.patterns.map((rule) => ({ rule, tierRank: 1 }))
      : []),
  ];
  taggedPatterns.sort((a, b) => {
    const scoreDiff =
      hostI18nPatternSpecificityScore(b.rule?.source) -
      hostI18nPatternSpecificityScore(a.rule?.source);
    if (scoreDiff !== 0) return scoreDiff;
    if (b.tierRank !== a.tierRank) return b.tierRank - a.tierRank;
    return String(b.rule?.source || '').length - String(a.rule?.source || '').length;
  });
  const patterns = taggedPatterns.map((entry) => entry.rule);
  const hashTag = String(sha256 || hostI18nSha256(JSON.stringify(exact))).slice(0, 12);
  return {
    locale: pack.locale,
    depth: safeDepth,
    version: pack.version,
    revision: `${pack.locale}:${safeDepth}:${pack.version}:${hashTag}`,
    exact,
    patterns,
  };
}

/**
 * 创建独立的 Host I18n 包与状态管理器实例（可注入 `dataDir` / `fetchImpl` 便于隔离测试）。
 *
 * @param {{
 *   dataDir?: string,
 *   repo?: string,
 *   ref?: string,
 *   localSourceDir?: string,
 *   fetchImpl?: Function|null,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createHostI18nPackManager(options = {}) {
  const paths = hostI18nResolveStoragePaths(options.dataDir || DATA_DIR);
  const inFlightDownloads = new Map();
  let inFlightManifest = null;

  let cachedState = null;
  let cachedStateMtimeMs = -1;
  let cachedInstalledMeta = null;
  let cachedInstalledMetaMtimeMs = -1;
  const cachedPacks = new Map(); // locale -> { mtimeMs, sha256, pack }
  let cachedCompiledRuntime = null; // { revision, payload }

  function readMtimeMs(filePath) {
    try {
      const st = statSync(filePath, { throwIfNoEntry: false });
      return st ? Number(st.mtimeMs || 0) : -1;
    } catch {
      return -1;
    }
  }

  function readJsonFileSafe(filePath, fallback) {
    if (!existsSync(filePath)) return fallback;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function loadState() {
    const mtimeMs = readMtimeMs(paths.stateFile);
    if (mtimeMs < 0) {
      cachedState = {
        schemaVersion: HOST_I18N_SCHEMA_VERSION,
        locale: HOST_I18N_OFF_LOCALE,
        depth: HOST_I18N_DEFAULT_DEPTH,
        updatedAtMs: 0,
      };
      cachedStateMtimeMs = -1;
      return { ...cachedState };
    }
    if (cachedState && cachedStateMtimeMs === mtimeMs) {
      return { ...cachedState };
    }
    const raw = readJsonFileSafe(paths.stateFile, {});
    cachedState = {
      schemaVersion: HOST_I18N_SCHEMA_VERSION,
      locale: normalizeHostI18nLocale(raw?.locale),
      depth: normalizeHostI18nDepth(raw?.depth),
      updatedAtMs: Number(raw?.updatedAtMs || 0) || 0,
    };
    cachedStateMtimeMs = mtimeMs;
    return { ...cachedState };
  }

  function saveState(nextPartial) {
    const prev = loadState();
    const next = {
      schemaVersion: HOST_I18N_SCHEMA_VERSION,
      locale:
        nextPartial?.locale !== undefined
          ? normalizeHostI18nLocale(nextPartial.locale)
          : prev.locale,
      depth:
        nextPartial?.depth !== undefined
          ? normalizeHostI18nDepth(nextPartial.depth)
          : prev.depth,
      updatedAtMs: Date.now(),
    };
    mkdirSync(paths.rootDir, { recursive: true });
    writeJsonAtomicSync(paths.stateFile, next);
    cachedState = next;
    cachedStateMtimeMs = readMtimeMs(paths.stateFile);
    return { ...next };
  }

  function loadInstalledMeta() {
    const mtimeMs = readMtimeMs(paths.installedMetaFile);
    if (mtimeMs < 0) {
      cachedInstalledMeta = {};
      cachedInstalledMetaMtimeMs = -1;
      return {};
    }
    if (cachedInstalledMeta && cachedInstalledMetaMtimeMs === mtimeMs) {
      return { ...cachedInstalledMeta };
    }
    const raw = readJsonFileSafe(paths.installedMetaFile, {});
    const clean = {};
    if (isPlainObject(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const loc = normalizeHostI18nLocale(k);
        if (loc === HOST_I18N_OFF_LOCALE || !isPlainObject(v)) continue;
        clean[loc] = {
          locale: loc,
          name: String(v.name || loc),
          nativeName: String(v.nativeName || v.name || loc),
          version: String(v.version || ''),
          sha256: String(v.sha256 || '').toLowerCase(),
          bytes: Number(v.bytes || 0) || 0,
          downloadedAtMs: Number(v.downloadedAtMs || 0) || 0,
          source: String(v.source || ''),
        };
      }
    }
    cachedInstalledMeta = clean;
    cachedInstalledMetaMtimeMs = mtimeMs;
    return { ...clean };
  }

  function saveInstalledMeta(metaObj) {
    mkdirSync(paths.rootDir, { recursive: true });
    writeJsonAtomicSync(paths.installedMetaFile, metaObj);
    cachedInstalledMeta = { ...metaObj };
    cachedInstalledMetaMtimeMs = readMtimeMs(paths.installedMetaFile);
  }

  function getPackFilePath(locale) {
    const clean = normalizeHostI18nLocale(locale);
    if (clean === HOST_I18N_OFF_LOCALE) return '';
    return join(paths.packsDir, `${clean}.json`);
  }

  function loadInstalledPack(locale) {
    const clean = normalizeHostI18nLocale(locale);
    if (clean === HOST_I18N_OFF_LOCALE) return null;
    const filePath = getPackFilePath(clean);
    const mtimeMs = readMtimeMs(filePath);
    if (mtimeMs < 0) {
      cachedPacks.delete(clean);
      return null;
    }
    const memo = cachedPacks.get(clean);
    if (memo && memo.mtimeMs === mtimeMs) {
      return memo;
    }
    try {
      const rawText = readFileSync(filePath, 'utf8');
      const sha256 = hostI18nSha256(rawText);
      const pack = sanitizeHostI18nPack(JSON.parse(rawText), clean);
      const rec = { mtimeMs, sha256, pack, bytes: Buffer.byteLength(rawText, 'utf8') };
      cachedPacks.set(clean, rec);
      return rec;
    } catch {
      cachedPacks.delete(clean);
      return null;
    }
  }

  function loadCachedManifest() {
    const raw = readJsonFileSafe(paths.manifestCacheFile, null);
    if (!isPlainObject(raw)) return null;
    try {
      const clean = sanitizeHostI18nManifest(raw.manifest || raw);
      return {
        manifest: clean,
        fetchedAtMs: Number(raw.fetchedAtMs || 0) || 0,
        source: String(raw.source || ''),
        lastError: raw.lastError ? String(raw.lastError) : null,
      };
    } catch {
      return null;
    }
  }

  async function fetchAssetText(relPath) {
    const resolved = hostI18nResolveRepoAndRef(options);
    if (resolved.localDir) {
      const localPath = join(resolved.localDir, relPath);
      if (!existsSync(localPath)) {
        throw new Error(`Local host-i18n file not found: ${localPath}`);
      }
      return {
        text: readFileSync(localPath, 'utf8'),
        url: `local:${localPath}`,
        status: 200,
      };
    }
    if (!options.fetchImpl && String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid') {
      throw new Error('Remote host-i18n fetch disabled in test.invalid environment');
    }
    const urls = buildHostI18nAssetUrls(relPath, resolved);
    return fetchHostI18nTextWithFallback(urls, {
      fetchImpl: options.fetchImpl || null,
      timeoutMs: options.timeoutMs,
    });
  }

  async function refreshManifest({ force = false } = {}) {
    const cached = loadCachedManifest();
    const now = Date.now();
    if (!force && cached && now - cached.fetchedAtMs < HOST_I18N_MANIFEST_TTL_MS) {
      return { ok: true, fromCache: true, ...cached };
    }
    if (inFlightManifest) return inFlightManifest;

    inFlightManifest = (async () => {
      try {
        const res = await fetchAssetText('manifest.json');
        const manifest = sanitizeHostI18nManifest(JSON.parse(res.text));
        const record = {
          manifest,
          fetchedAtMs: Date.now(),
          source: res.url,
          lastError: null,
        };
        mkdirSync(paths.rootDir, { recursive: true });
        writeJsonAtomicSync(paths.manifestCacheFile, record);
        return { ok: true, fromCache: false, ...record };
      } catch (err) {
        const message = err?.message || 'Failed to fetch host-i18n manifest';
        return {
          ok: false,
          fromCache: Boolean(cached),
          manifest: cached?.manifest || { schemaVersion: HOST_I18N_SCHEMA_VERSION, packs: [] },
          fetchedAtMs: cached?.fetchedAtMs || 0,
          source: cached?.source || '',
          error: message,
        };
      }
    })().finally(() => {
      inFlightManifest = null;
    });

    return inFlightManifest;
  }

  async function installPack(rawLocale, { forceManifestRefresh = false, allowDowngrade = false } = {}) {
    const locale = normalizeHostI18nLocale(rawLocale);
    if (locale === HOST_I18N_OFF_LOCALE) {
      throw new Error('Cannot install pack for "off" locale');
    }
    if (inFlightDownloads.has(locale)) {
      return inFlightDownloads.get(locale);
    }

    const task = (async () => {
      const manifestRes = await refreshManifest({ force: forceManifestRefresh });
      let entry = manifestRes.manifest?.packs?.find((p) => p.locale === locale) || null;
      if (!entry && !forceManifestRefresh) {
        const refreshed = await refreshManifest({ force: true });
        entry = refreshed.manifest?.packs?.find((p) => p.locale === locale) || null;
      }
      if (!entry) {
        throw new Error(
          manifestRes.error
            ? `Language pack "${locale}" unavailable: ${manifestRes.error}`
            : `Language pack "${locale}" not found in repository manifest`
        );
      }

      const existingPack = loadInstalledPack(locale);
      const existingMeta = loadInstalledMeta()[locale] || null;
      const existingVersion = existingPack?.pack?.version || existingMeta?.version || '';
      if (
        existingPack &&
        !allowDowngrade &&
        existingVersion &&
        !isRemoteHostI18nPackNewer(entry.version, existingVersion)
      ) {
        return {
          ok: true,
          locale,
          updated: false,
          alreadyUpToDate: true,
          version: existingVersion,
          remoteVersion: entry.version,
          sha256: existingPack.sha256,
          bytes: existingPack.bytes,
          source: 'local-cache',
        };
      }

      const res = await fetchAssetText(entry.file);
      const actualHash = hostI18nSha256(res.text);
      if (actualHash !== entry.sha256) {
        throw new Error(
          `Integrity check failed for "${locale}" (expected ${entry.sha256.slice(0, 12)}, got ${actualHash.slice(0, 12)})`
        );
      }

      const pack = sanitizeHostI18nPack(JSON.parse(res.text), locale);
      if (
        existingPack &&
        !allowDowngrade &&
        existingVersion &&
        !isRemoteHostI18nPackNewer(pack.version, existingVersion)
      ) {
        return {
          ok: true,
          locale,
          updated: false,
          alreadyUpToDate: true,
          version: existingVersion,
          remoteVersion: pack.version,
          sha256: existingPack.sha256,
          bytes: existingPack.bytes,
          source: 'local-cache',
        };
      }

      mkdirSync(paths.packsDir, { recursive: true });
      const targetPath = getPackFilePath(locale);
      writeTextFileAtomicSync(targetPath, res.text);

      const meta = loadInstalledMeta();
      meta[locale] = {
        locale,
        name: pack.name,
        nativeName: pack.nativeName,
        version: pack.version,
        sha256: actualHash,
        bytes: Buffer.byteLength(res.text, 'utf8'),
        downloadedAtMs: Date.now(),
        source: res.url,
      };
      saveInstalledMeta(meta);
      cachedPacks.delete(locale);
      if (cachedCompiledRuntime?.payload?.locale === locale) {
        cachedCompiledRuntime = null;
      }
      const loaded = loadInstalledPack(locale);
      return {
        ok: true,
        locale,
        updated: true,
        alreadyUpToDate: false,
        version: pack.version,
        sha256: actualHash,
        bytes: loaded?.bytes || meta[locale].bytes,
        source: res.url,
      };
    })().finally(() => {
      inFlightDownloads.delete(locale);
    });

    inFlightDownloads.set(locale, task);
    return task;
  }

  async function selectLanguage({ locale: rawLocale, depth: rawDepth } = {}) {
    const locale = normalizeHostI18nLocale(rawLocale);
    const current = loadState();
    const depth =
      rawDepth !== undefined ? normalizeHostI18nDepth(rawDepth) : current.depth;

    if (locale === HOST_I18N_OFF_LOCALE) {
      const nextState = saveState({ locale: HOST_I18N_OFF_LOCALE, depth });
      return { ok: true, downloaded: false, state: nextState };
    }

    let downloaded = false;
    let loaded = loadInstalledPack(locale);
    if (!loaded) {
      await installPack(locale, { forceManifestRefresh: false });
      downloaded = true;
      loaded = loadInstalledPack(locale);
    }
    if (!loaded) {
      throw new Error(`Language pack "${locale}" failed to load after installation`);
    }

    const nextState = saveState({ locale, depth });
    return {
      ok: true,
      downloaded,
      state: nextState,
      packVersion: loaded.pack.version,
    };
  }

  function setDepth(rawDepth) {
    const depth = normalizeHostI18nDepth(rawDepth);
    const nextState = saveState({ depth });
    return { ok: true, state: nextState };
  }

  function removePack(rawLocale) {
    const locale = normalizeHostI18nLocale(rawLocale);
    if (locale === HOST_I18N_OFF_LOCALE) {
      return { ok: false, error: 'Invalid locale' };
    }
    const targetPath = getPackFilePath(locale);
    if (targetPath && existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
    }
    cachedPacks.delete(locale);
    if (cachedCompiledRuntime?.payload?.locale === locale) {
      cachedCompiledRuntime = null;
    }
    const meta = loadInstalledMeta();
    delete meta[locale];
    saveInstalledMeta(meta);

    const cur = loadState();
    let nextState = cur;
    if (cur.locale === locale) {
      nextState = saveState({ locale: HOST_I18N_OFF_LOCALE });
    }
    return { ok: true, removedLocale: locale, state: nextState };
  }

  function getActiveBridgeDescriptor() {
    const st = loadState();
    if (st.locale === HOST_I18N_OFF_LOCALE) {
      return { active: false, locale: HOST_I18N_OFF_LOCALE, depth: st.depth, revision: '', getPayload: null };
    }
    const loaded = loadInstalledPack(st.locale);
    if (!loaded) {
      return { active: false, locale: st.locale, depth: st.depth, revision: '', getPayload: null };
    }
    const revision = `${loaded.pack.locale}:${st.depth}:${loaded.pack.version}:${loaded.sha256.slice(0, 12)}`;
    return {
      active: true,
      locale: loaded.pack.locale,
      depth: st.depth,
      version: loaded.pack.version,
      revision,
      getPayload: () => {
        if (cachedCompiledRuntime && cachedCompiledRuntime.revision === revision) {
          return cachedCompiledRuntime.payload;
        }
        const payload = compileHostI18nRuntimePayload(loaded.pack, st.depth, loaded.sha256);
        cachedCompiledRuntime = { revision, payload };
        return payload;
      },
    };
  }

  function getStatusSnapshot({ manifestResult = null, bridgeStatus = null } = {}) {
    const state = loadState();
    const installedMeta = loadInstalledMeta();
    const cachedManifest = manifestResult || loadCachedManifest();
    const remotePacks = Array.isArray(cachedManifest?.manifest?.packs)
      ? cachedManifest.manifest.packs
      : [];

    const byLocale = new Map();
    for (const remote of remotePacks) {
      const localPack = loadInstalledPack(remote.locale);
      const localInfo = installedMeta[remote.locale] || null;
      const installed = Boolean(localPack);
      const installedSha = localPack?.sha256 || localInfo?.sha256 || '';
      const installedVersion = localPack?.pack?.version || localInfo?.version || '';
      byLocale.set(remote.locale, {
        locale: remote.locale,
        name: remote.name,
        nativeName: remote.nativeName,
        remoteVersion: remote.version,
        remoteSha256: remote.sha256,
        remoteBytes: remote.bytes,
        depths: remote.depths || ['light', 'deep'],
        stats: remote.stats || null,
        installed,
        installedVersion,
        installedBytes: localPack?.bytes || localInfo?.bytes || 0,
        downloadedAtMs: localInfo?.downloadedAtMs || 0,
        updateAvailable: Boolean(
          installed && isRemoteHostI18nPackNewer(remote.version, installedVersion)
        ),
      });
    }

    // 保留仅在本地存在（离线/自定义）的已安装包条目
    for (const [loc, localInfo] of Object.entries(installedMeta)) {
      if (byLocale.has(loc)) continue;
      const localPack = loadInstalledPack(loc);
      if (!localPack) continue;
      byLocale.set(loc, {
        locale: loc,
        name: localPack.pack.name,
        nativeName: localPack.pack.nativeName,
        remoteVersion: '',
        remoteSha256: '',
        remoteBytes: 0,
        depths: ['light', 'deep'],
        stats: {
          baseExact: Object.keys(localPack.pack.base.exact).length,
          lightExact: Object.keys(localPack.pack.modes.light.exact).length,
          deepExact: Object.keys(localPack.pack.modes.deep.exact).length,
          basePatterns: localPack.pack.base.patterns.length,
          lightPatterns: localPack.pack.modes.light.patterns.length,
          deepPatterns: localPack.pack.modes.deep.patterns.length,
        },
        installed: true,
        installedVersion: localPack.pack.version,
        installedBytes: localPack.bytes,
        downloadedAtMs: localInfo.downloadedAtMs || 0,
        updateAvailable: false,
      });
    }

    const activeDesc = getActiveBridgeDescriptor();
    const resolvedRepo = hostI18nResolveRepoAndRef(options);
    return {
      schemaVersion: HOST_I18N_SCHEMA_VERSION,
      locale: state.locale,
      depth: state.depth,
      active: activeDesc.active,
      activeRevision: activeDesc.revision,
      updatedAtMs: state.updatedAtMs,
      manifestFetchedAtMs: Number(cachedManifest?.fetchedAtMs || 0) || 0,
      manifestError: cachedManifest?.error || null,
      repo: resolvedRepo.repo,
      ref: resolvedRepo.ref,
      packs: Array.from(byLocale.values()),
      ...(bridgeStatus ? { bridgeStatus } : {}),
    };
  }

  return {
    paths,
    loadState,
    saveState,
    loadInstalledPack,
    refreshManifest,
    installPack,
    selectLanguage,
    setDepth,
    removePack,
    getActiveBridgeDescriptor,
    getStatusSnapshot,
  };
}
