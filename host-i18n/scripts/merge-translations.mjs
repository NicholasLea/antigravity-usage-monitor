#!/usr/bin/env node
/**
 * @fileoverview Conflict-free incremental merger for Antigravity Host I18n source dictionaries.
 *
 * Accepts a translation batch JSON (`exact`, `patterns`, `ignore`), routes entries into the right
 * modular files under `host-i18n/sources/<locale>/` without duplicating keys across files or
 * between `base` and `light`/`deep`, updates `host-i18n/sources/ignore.json`, optionally bumps
 * `meta.json` SemVer, and rebuilds + verifies `host-i18n/dist/`.
 *
 * Input JSON format:
 * {
 *   "exact": {
 *     "Light Theme": "浅色主题",
 *     "Queue": { "light": "Queue", "deep": "排队" }
 *   },
 *   "patterns": [
 *     { "source": "^Settings for conversations outside of (.+?)\\.$", "flags": "", "hint": "outside of", "light": "...", "deep": "..." }
 *   ],
 *   "ignore": {
 *     "exact": ["..."],
 *     "templates": ["^...$"]
 *   }
 * }
 *
 * Usage:
 *   node host-i18n/scripts/merge-translations.mjs --locale zh-CN --in patch.json [--bump patch|minor]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllHostI18nPacks } from './build-packs.mjs';
import { DEFAULT_IGNORE_PATH, HOST_I18N_ROOT } from './audit-host-i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[k] = obj[k];
  }
  return out;
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function bumpSemver(version, kind) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return version;
  let [, major, minor, patch] = m;
  major = Number(major);
  minor = Number(minor);
  patch = Number(patch);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  return version;
}

function pickShardFileName(key) {
  const first = String(key || '').trim().charAt(0).toLowerCase();
  if (first >= 'a' && first <= 'm') return 'ui-a-m.json';
  return 'ui-n-z.json';
}

export function mergeHostI18nTranslations({
  locale,
  patch,
  rootDir = HOST_I18N_ROOT,
  ignorePath = DEFAULT_IGNORE_PATH,
  bump = '',
  rebuild = true,
} = {}) {
  const localeDir = join(rootDir, 'sources', locale);
  if (!existsSync(join(localeDir, 'meta.json'))) {
    throw new Error(`Locale source directory not initialized: ${localeDir}`);
  }

  // Load all existing exact dictionary files and build key -> fileName index
  const dictFileNames = readdirSync(localeDir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json' && f !== 'patterns.json')
    .sort();
  const dictFiles = new Map();
  const keyToFile = new Map();

  for (const f of dictFileNames) {
    const obj = readJson(join(localeDir, f), { base: {}, light: {}, deep: {} });
    obj.base = obj.base || {};
    obj.light = obj.light || {};
    obj.deep = obj.deep || {};
    dictFiles.set(f, obj);
    for (const bucket of ['base', 'light', 'deep']) {
      for (const k of Object.keys(obj[bucket])) {
        keyToFile.set(k, f);
      }
    }
  }

  const ensureShard = (fileName) => {
    if (!dictFiles.has(fileName)) {
      dictFiles.set(fileName, { base: {}, light: {}, deep: {} });
    }
    return dictFiles.get(fileName);
  };

  let exactAdded = 0;
  let exactUpdated = 0;
  const dirtyFiles = new Set();

  for (const [rawKey, rawVal] of Object.entries(patch?.exact || {})) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    let lightVal = '';
    let deepVal = '';
    if (typeof rawVal === 'string') {
      lightVal = rawVal.trim();
      deepVal = rawVal.trim();
    } else if (rawVal && typeof rawVal === 'object') {
      lightVal = String(rawVal.light ?? rawVal.base ?? '').trim();
      deepVal = String(rawVal.deep ?? rawVal.base ?? lightVal).trim();
    }
    if (!lightVal || !deepVal) continue;

    const existingFile = keyToFile.get(key);
    const targetFileName = existingFile || pickShardFileName(key);
    const targetObj = ensureShard(targetFileName);

    const existed =
      Object.prototype.hasOwnProperty.call(targetObj.base, key) ||
      Object.prototype.hasOwnProperty.call(targetObj.light, key) ||
      Object.prototype.hasOwnProperty.call(targetObj.deep, key);

    // Clear all three buckets for this key before writing to guarantee zero base/mode collisions
    delete targetObj.base[key];
    delete targetObj.light[key];
    delete targetObj.deep[key];

    if (lightVal === deepVal) {
      targetObj.base[key] = lightVal;
    } else {
      targetObj.light[key] = lightVal;
      targetObj.deep[key] = deepVal;
    }
    keyToFile.set(key, targetFileName);
    dirtyFiles.add(targetFileName);
    if (existed) exactUpdated += 1;
    else exactAdded += 1;
  }

  for (const fileName of dirtyFiles) {
    const obj = dictFiles.get(fileName);
    const out = {};
    if (Object.keys(obj.base).length > 0) out.base = sortKeys(obj.base);
    if (Object.keys(obj.light).length > 0) out.light = sortKeys(obj.light);
    if (Object.keys(obj.deep).length > 0) out.deep = sortKeys(obj.deep);
    writeJson(join(localeDir, fileName), out);
  }

  // Merge patterns cleanly
  let patternsAdded = 0;
  let patternsUpdated = 0;
  const rawPatterns = Array.isArray(patch?.patterns) ? patch.patterns : [];
  if (rawPatterns.length > 0) {
    const patPath = join(localeDir, 'patterns.json');
    const patObj = readJson(patPath, { base: [], light: [], deep: [] });
    patObj.base = Array.isArray(patObj.base) ? patObj.base : [];
    patObj.light = Array.isArray(patObj.light) ? patObj.light : [];
    patObj.deep = Array.isArray(patObj.deep) ? patObj.deep : [];

    const sigOf = (r) => `${r.flags || ''}:${r.source}`;
    const removeBySig = (sig) => {
      let removed = false;
      for (const tier of ['base', 'light', 'deep']) {
        const before = patObj[tier].length;
        patObj[tier] = patObj[tier].filter((r) => sigOf(r) !== sig);
        if (patObj[tier].length !== before) removed = true;
      }
      return removed;
    };

    for (const item of rawPatterns) {
      if (!item || typeof item.source !== 'string') continue;
      const source = item.source.trim();
      const flags = typeof item.flags === 'string' ? item.flags : '';
      const hint = typeof item.hint === 'string' ? item.hint.trim() : '';
      const lightRep = String(item.light ?? item.replace ?? '').trim();
      const deepRep = String(item.deep ?? item.replace ?? lightRep).trim();
      if (!source || !lightRep || !deepRep) continue;

      const sig = `${flags}:${source}`;
      const existed = removeBySig(sig);
      const makeRule = (replace) => (hint ? { source, flags, replace, hint } : { source, flags, replace });

      if (lightRep === deepRep) {
        patObj.base.push(makeRule(lightRep));
      } else {
        patObj.light.push(makeRule(lightRep));
        patObj.deep.push(makeRule(deepRep));
      }
      if (existed) patternsUpdated += 1;
      else patternsAdded += 1;
    }

    writeJson(patPath, patObj);
  }

  // Merge verified ignore entries
  let ignoreAdded = 0;
  const ignoreExact = Array.isArray(patch?.ignore?.exact) ? patch.ignore.exact : [];
  const ignoreTemplates = Array.isArray(patch?.ignore?.templates) ? patch.ignore.templates : [];
  if (ignoreExact.length > 0 || ignoreTemplates.length > 0) {
    const curIgnore = readJson(ignorePath, {
      description: 'Verified non-UI code literals, vendor noise, and intentionally untranslated brand/model tokens excluded from missing-translation audits.',
      exact: [],
      templates: [],
    });
    const exSet = new Set(Array.isArray(curIgnore.exact) ? curIgnore.exact : []);
    const tpSet = new Set(Array.isArray(curIgnore.templates) ? curIgnore.templates : []);
    const before = exSet.size + tpSet.size;
    for (const s of ignoreExact) if (typeof s === 'string' && s.trim()) exSet.add(s.trim());
    for (const s of ignoreTemplates) if (typeof s === 'string' && s.trim()) tpSet.add(s.trim());
    ignoreAdded = exSet.size + tpSet.size - before;
    curIgnore.exact = Array.from(exSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    curIgnore.templates = Array.from(tpSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    writeJson(ignorePath, curIgnore);
  }

  let version = '';
  const metaPath = join(localeDir, 'meta.json');
  const meta = readJson(metaPath, {});
  if (bump) {
    meta.version = bumpSemver(meta.version, bump);
    writeJson(metaPath, meta);
  }
  version = meta.version;

  let buildResult = null;
  if (rebuild) {
    buildResult = buildAllHostI18nPacks({ rootDir, checkOnly: false });
    buildAllHostI18nPacks({ rootDir, checkOnly: true });
  }

  return {
    locale,
    version,
    exactAdded,
    exactUpdated,
    patternsAdded,
    patternsUpdated,
    ignoreAdded,
    buildResult,
  };
}

function parseCliArgs(argv) {
  const opts = { locale: 'zh-CN', inPath: '', bump: '', noBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--locale' && argv[i + 1]) opts.locale = argv[++i];
    else if (arg === '--in' && argv[i + 1]) opts.inPath = resolve(argv[++i]);
    else if (arg === '--bump' && argv[i + 1]) opts.bump = argv[++i];
    else if (arg === '--no-build') opts.noBuild = true;
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.inPath || !existsSync(cli.inPath)) {
    console.error('[merge-translations] Required --in <patch.json> file not found.');
    process.exit(1);
  }
  const patch = JSON.parse(readFileSync(cli.inPath, 'utf8'));
  const res = mergeHostI18nTranslations({
    locale: cli.locale,
    patch,
    bump: cli.bump,
    rebuild: !cli.noBuild,
  });
  console.log(
    `[merge-translations] Merged into ${res.locale}@${res.version}: exact +${res.exactAdded}/~${res.exactUpdated}, patterns +${res.patternsAdded}/~${res.patternsUpdated}, ignore +${res.ignoreAdded}`
  );
}
