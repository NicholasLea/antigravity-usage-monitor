#!/usr/bin/env node
/**
 * @fileoverview Zero-dependency builder and validator for Antigravity Host I18n packs.
 *
 * Reads modular source dictionaries under `host-i18n/sources/<locale>/`, validates
 * key conflicts, regex anchoring/safety, and schema integrity, and emits deterministic
 * compressed packs under `host-i18n/dist/packs/<locale>.json` alongside
 * `host-i18n/dist/manifest.json` with SHA-256 digests.
 *
 * Usage:
 *   node host-i18n/scripts/build-packs.mjs
 *   node host-i18n/scripts/build-packs.mjs --check
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HOST_I18N_ROOT = resolve(__dirname, '..');
export const PACK_SCHEMA_VERSION = 1;
export const SUPPORTED_DEPTHS = Object.freeze(['light', 'deep']);
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const ALLOWED_REGEX_FLAGS_RE = /^[i]?$/;
const UNSAFE_NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*{]/;

function isPlainObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sortRecordKeys(record) {
  const out = {};
  for (const key of Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = record[key];
  }
  return out;
}

/**
 * Validates a single anchored regex pattern rule for safety and determinism.
 *
 * @param {object} rule
 * @param {string} contextLabel
 * @returns {{ source: string, flags: string, replace: string, hint?: string }}
 */
export function validatePatternRule(rule, contextLabel = 'pattern') {
  if (!isPlainObject(rule)) {
    throw new Error(`${contextLabel}: pattern entry must be an object`);
  }
  const source = typeof rule.source === 'string' ? rule.source : '';
  const flags = typeof rule.flags === 'string' ? rule.flags : '';
  const replace = typeof rule.replace === 'string' ? rule.replace : '';
  const hint = typeof rule.hint === 'string' ? rule.hint.trim() : '';

  if (!source || source.length > 360) {
    throw new Error(`${contextLabel}: pattern source must be 1..360 chars`);
  }
  if (!source.startsWith('^') || !source.endsWith('$')) {
    throw new Error(`${contextLabel}: pattern "${source}" must be strictly anchored with ^ and $`);
  }
  if (!ALLOWED_REGEX_FLAGS_RE.test(flags)) {
    throw new Error(`${contextLabel}: unsupported regex flags "${flags}" (only "" or "i" allowed)`);
  }
  if (UNSAFE_NESTED_QUANTIFIER_RE.test(source)) {
    throw new Error(`${contextLabel}: potentially catastrophic nested quantifier in "${source}"`);
  }
  if (!replace) {
    throw new Error(`${contextLabel}: replacement string cannot be empty`);
  }
  try {
    // Compile to ensure valid JS RegExp syntax.
    // eslint-disable-next-line no-new
    new RegExp(source, flags);
  } catch (err) {
    throw new Error(`${contextLabel}: invalid RegExp "${source}": ${err.message}`);
  }
  return hint ? { source, flags, replace, hint } : { source, flags, replace };
}

function mergeExactBucket(target, bucket, fileLabel, bucketName) {
  if (bucket === undefined) return;
  if (!isPlainObject(bucket)) {
    throw new Error(`${fileLabel}: "${bucketName}" must be a plain object`);
  }
  for (const [rawKey, rawVal] of Object.entries(bucket)) {
    const key = String(rawKey).trim();
    const val = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!key) {
      throw new Error(`${fileLabel}: empty key in "${bucketName}"`);
    }
    if (!val) {
      throw new Error(`${fileLabel}: empty translation for "${key}" in "${bucketName}"`);
    }
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw new Error(`${fileLabel}: duplicate key "${key}" in "${bucketName}"`);
    }
    target[key] = val;
  }
}

function patternLiteralSpecificity(source) {
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

function sortPatternsBySpecificity(list) {
  return [...list].sort((a, b) => {
    const specDiff = patternLiteralSpecificity(b.source) - patternLiteralSpecificity(a.source);
    if (specDiff !== 0) return specDiff;
    const lenDiff = b.source.length - a.source.length;
    if (lenDiff !== 0) return lenDiff;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
}

function mergePatternBucket(target, list, fileLabel, bucketName) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    throw new Error(`${fileLabel}: "${bucketName}" patterns must be an array`);
  }
  const seen = new Set(target.map((p) => `${p.flags}:${p.source}`));
  for (let i = 0; i < list.length; i += 1) {
    const rule = validatePatternRule(list[i], `${fileLabel}[${bucketName}#${i}]`);
    const sig = `${rule.flags}:${rule.source}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    target.push(rule);
  }
}

/**
 * Compiles one locale folder under `sources/<locale>/` into a validated pack object.
 *
 * @param {string} localeDir
 * @param {string} folderLocale
 */
export function compileLocaleSourceDir(localeDir, folderLocale) {
  if (!LOCALE_RE.test(folderLocale)) {
    throw new Error(`Invalid locale folder name: "${folderLocale}"`);
  }
  const metaPath = join(localeDir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`Missing meta.json in ${localeDir}`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!isPlainObject(meta)) {
    throw new Error(`${metaPath}: meta.json must be a JSON object`);
  }
  const locale = String(meta.locale || '').trim();
  if (locale !== folderLocale) {
    throw new Error(`${metaPath}: meta.locale "${locale}" must match folder "${folderLocale}"`);
  }
  const name = String(meta.name || '').trim();
  const nativeName = String(meta.nativeName || '').trim();
  const version = String(meta.version || '').trim();
  if (!name || !nativeName || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new Error(`${metaPath}: name, nativeName, and SemVer version are required`);
  }

  const baseExact = {};
  const lightExact = {};
  const deepExact = {};
  const basePatterns = [];
  const lightPatterns = [];
  const deepPatterns = [];

  const fileNames = readdirSync(localeDir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (fileNames.length === 0) {
    throw new Error(`${localeDir}: at least one dictionary JSON file is required`);
  }

  for (const fileName of fileNames) {
    const absPath = join(localeDir, fileName);
    const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      throw new Error(`${absPath}: dictionary file must be a JSON object`);
    }
    const label = `${folderLocale}/${fileName}`;
    if (fileName === 'patterns.json' || Array.isArray(parsed.base) || Array.isArray(parsed.light) || Array.isArray(parsed.deep)) {
      mergePatternBucket(basePatterns, parsed.base, label, 'base');
      mergePatternBucket(lightPatterns, parsed.light, label, 'light');
      mergePatternBucket(deepPatterns, parsed.deep, label, 'deep');
    } else {
      mergeExactBucket(baseExact, parsed.base, label, 'base');
      mergeExactBucket(lightExact, parsed.light, label, 'light');
      mergeExactBucket(deepExact, parsed.deep, label, 'deep');
    }
  }

  // Ensure light/deep overlays do not silently shadow base keys unless intentional:
  // disallow exact key duplication between base and light/deep so layering stays unambiguous.
  for (const key of Object.keys(lightExact)) {
    if (Object.prototype.hasOwnProperty.call(baseExact, key)) {
      throw new Error(`${folderLocale}: key "${key}" exists in both "base" and "light"`);
    }
  }
  for (const key of Object.keys(deepExact)) {
    if (Object.prototype.hasOwnProperty.call(baseExact, key)) {
      throw new Error(`${folderLocale}: key "${key}" exists in both "base" and "deep"`);
    }
  }

  const sortedBaseExact = sortRecordKeys(baseExact);
  const sortedLightExact = sortRecordKeys(lightExact);
  const sortedDeepExact = sortRecordKeys(deepExact);
  const sortedBasePatterns = sortPatternsBySpecificity(basePatterns);
  const sortedLightPatterns = sortPatternsBySpecificity(lightPatterns);
  const sortedDeepPatterns = sortPatternsBySpecificity(deepPatterns);

  const packObj = {
    schemaVersion: PACK_SCHEMA_VERSION,
    locale,
    name,
    nativeName,
    version,
    depths: [...SUPPORTED_DEPTHS],
    base: {
      exact: sortedBaseExact,
      patterns: sortedBasePatterns,
    },
    modes: {
      light: {
        exact: sortedLightExact,
        patterns: sortedLightPatterns,
      },
      deep: {
        exact: sortedDeepExact,
        patterns: sortedDeepPatterns,
      },
    },
  };

  const jsonText = JSON.stringify(packObj) + '\n';
  const sha256 = sha256Hex(jsonText);
  const bytes = Buffer.byteLength(jsonText, 'utf8');

  return {
    locale,
    meta: {
      locale,
      name,
      nativeName,
      version,
      file: `packs/${locale}.json`,
      sha256,
      bytes,
      depths: [...SUPPORTED_DEPTHS],
      stats: {
        baseExact: Object.keys(sortedBaseExact).length,
        lightExact: Object.keys(sortedLightExact).length,
        deepExact: Object.keys(sortedDeepExact).length,
        basePatterns: basePatterns.length,
        lightPatterns: lightPatterns.length,
        deepPatterns: deepPatterns.length,
      },
    },
    packObj,
    jsonText,
  };
}

/**
 * Builds or validates (`checkOnly: true`) all packs under `rootDir/sources` into `rootDir/dist`.
 *
 * @param {{ rootDir?: string, checkOnly?: boolean }} [options]
 */
export function buildAllHostI18nPacks({
  rootDir = DEFAULT_HOST_I18N_ROOT,
  checkOnly = false,
} = {}) {
  const sourcesDir = join(rootDir, 'sources');
  const distDir = join(rootDir, 'dist');
  const packsOutDir = join(distDir, 'packs');

  if (!existsSync(sourcesDir)) {
    throw new Error(`Missing host-i18n sources directory: ${sourcesDir}`);
  }

  const localeFolders = readdirSync(sourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (localeFolders.length === 0) {
    throw new Error(`No locale directories found in ${sourcesDir}`);
  }

  const compiled = localeFolders.map((folder) =>
    compileLocaleSourceDir(join(sourcesDir, folder), folder)
  );

  const manifestObj = {
    schemaVersion: PACK_SCHEMA_VERSION,
    packs: compiled.map((item) => item.meta),
  };
  const manifestText = JSON.stringify(manifestObj, null, 2) + '\n';

  if (checkOnly) {
    const manifestPath = join(distDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`Check failed: missing ${manifestPath}`);
    }
    const diskManifest = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
    if (diskManifest !== manifestText) {
      throw new Error('Check failed: host-i18n/dist/manifest.json is out of date with sources');
    }
    for (const item of compiled) {
      const packPath = join(packsOutDir, `${item.locale}.json`);
      if (!existsSync(packPath)) {
        throw new Error(`Check failed: missing ${packPath}`);
      }
      const diskPack = readFileSync(packPath, 'utf8').replace(/\r\n/g, '\n');
      if (diskPack !== item.jsonText) {
        throw new Error(`Check failed: ${packPath} is out of date with sources`);
      }
      if (sha256Hex(diskPack) !== item.meta.sha256) {
        throw new Error(`Check failed: SHA-256 mismatch for ${packPath}`);
      }
    }
    return { checked: true, manifest: manifestObj, packs: compiled };
  }

  mkdirSync(packsOutDir, { recursive: true });
  const expectedFiles = new Set(compiled.map((item) => `${item.locale}.json`));
  for (const existing of readdirSync(packsOutDir)) {
    if (existing.endsWith('.json') && !expectedFiles.has(existing)) {
      rmSync(join(packsOutDir, existing), { force: true });
    }
  }
  for (const item of compiled) {
    writeFileSync(join(packsOutDir, `${item.locale}.json`), item.jsonText, 'utf8');
  }
  writeFileSync(join(distDir, 'manifest.json'), manifestText, 'utf8');

  return { checked: false, manifest: manifestObj, packs: compiled };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes('--check');
  const res = buildAllHostI18nPacks({ checkOnly });
  const summary = res.manifest.packs
    .map(
      (p) =>
        `${p.locale}@${p.version} (base=${p.stats.baseExact}, light=${p.stats.lightExact}, deep=${p.stats.deepExact}, patterns=${p.stats.basePatterns + p.stats.lightPatterns + p.stats.deepPatterns}, ${(p.bytes / 1024).toFixed(1)} KB)`
    )
    .join(', ');
  console.log(
    checkOnly
      ? `[host-i18n] Check passed: ${summary}`
      : `[host-i18n] Built ${res.manifest.packs.length} pack(s): ${summary}`
  );
}
