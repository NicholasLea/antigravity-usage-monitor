import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAllHostI18nPacks,
  validatePatternRule,
} from '../../../host-i18n/scripts/build-packs.mjs';
import {
  auditCatalogAgainstPack,
  loadIgnoreLists,
} from '../../../host-i18n/scripts/audit-host-i18n.mjs';
import { mergeHostI18nTranslations } from '../../../host-i18n/scripts/merge-translations.mjs';
import {
  HOST_I18N_GLOBAL_KEY,
  HOST_I18N_OFF_LOCALE,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
} from '../shared/host-i18n-protocol.mjs';
import {
  assertAllowedHostI18nUrl,
  fetchHostI18nTextWithFallback,
} from '../backend/host-i18n/http-fetch.mjs';
import {
  compileHostI18nRuntimePayload,
  createHostI18nPackManager,
  isRemoteHostI18nPackNewer,
} from '../backend/host-i18n/pack-manager.mjs';
import {
  applyHostI18nInPage,
  collectUntranslatedHostUiInPage,
  createHostI18nApplyExpression,
  createHostI18nCollectExpression,
  createHostI18nDisposeExpression,
  createHostI18nHeartbeatExpression,
} from '../backend/host-i18n/runtime-translator.mjs';
import { handleHostI18nPostAction } from '../backend/host-i18n/index.mjs';
import { createWindowBridgeController } from '../backend/window-bridge.mjs';
import { dispatchBridgeApiRequest } from '../backend/api-actions.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const REAL_HOST_I18N_ROOT = join(REPO_ROOT, 'host-i18n');

function sha256(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function createTempDir(t, prefix = 'ag-host-i18n-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Shared protocol & pack builder validation
// ---------------------------------------------------------------------------

test('host-i18n protocol normalizers handle edge cases cleanly', () => {
  assert.equal(normalizeHostI18nLocale(''), HOST_I18N_OFF_LOCALE);
  assert.equal(normalizeHostI18nLocale('original'), HOST_I18N_OFF_LOCALE);
  assert.equal(normalizeHostI18nLocale('zh_cn'), 'zh-CN');
  assert.equal(normalizeHostI18nLocale('ja-jp'), 'ja-JP');
  assert.equal(normalizeHostI18nLocale('../evil'), HOST_I18N_OFF_LOCALE);
  assert.equal(normalizeHostI18nDepth('deep'), 'deep');
  assert.equal(normalizeHostI18nDepth('full'), 'deep');
  assert.equal(normalizeHostI18nDepth('unknown'), 'light');
});

test('host-i18n build-packs --check verifies real repository dist artifacts and rejects unsafe patterns', (t) => {
  const checked = buildAllHostI18nPacks({ rootDir: REAL_HOST_I18N_ROOT, checkOnly: true });
  assert.equal(checked.checked, true);
  const expectedLocales = ['zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR'];
  const realCatalog = JSON.parse(
    readFileSync(join(REAL_HOST_I18N_ROOT, 'sources', 'en-US.catalog.json'), 'utf8')
  );
  const ignoreLists = loadIgnoreLists(join(REAL_HOST_I18N_ROOT, 'sources', 'ignore.json'));
  for (const locale of expectedLocales) {
    const packMeta = checked.manifest.packs.find((p) => p.locale === locale);
    assert.ok(packMeta, `${locale} pack must exist in manifest`);
    assert.ok(
      packMeta.stats.baseExact + packMeta.stats.deepExact >= 5000,
      `Expected full ${locale} coverage >= 5000 exact entries, got ${packMeta.stats.baseExact + packMeta.stats.deepExact}`
    );
    assert.ok(
      packMeta.stats.basePatterns + packMeta.stats.deepPatterns >= 800,
      `Expected full ${locale} coverage >= 800 patterns, got ${packMeta.stats.basePatterns + packMeta.stats.deepPatterns}`
    );
    const packObj = JSON.parse(
      readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', `${locale}.json`), 'utf8')
    );
    const auditReport = auditCatalogAgainstPack(realCatalog, packObj, ignoreLists);
    assert.equal(auditReport.missingExact.length, 0, `${locale} must have 0 missing exact translations`);
    assert.equal(auditReport.missingTemplates.length, 0, `${locale} must have 0 missing dynamic templates`);
    assert.equal(auditReport.brokenPatterns.length, 0, `${locale} must have 0 broken pattern backreferences`);
    assert.equal(auditReport.redundantModeExact.length, 0, `${locale} must have 0 redundant identical light/deep keys`);
  }
  const realPackObj = JSON.parse(
    readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
  );

  // Verify screenshot-reported Appearance, General Mode Copy, Queue, Outside-of-Projects & Model Tags translate cleanly
  const deepMerged = compileHostI18nRuntimePayload(realPackObj, 'deep');
  const lightMerged = compileHostI18nRuntimePayload(realPackObj, 'light');
  assert.equal(deepMerged.exact['Leaving Soon'], '即将下线');
  assert.equal(deepMerged.exact['Notice'], '提示');
  assert.equal(deepMerged.exact['New'], '新');
  assert.equal(deepMerged.exact['Contrast'], '对比度');
  assert.equal(deepMerged.exact['Strong'], '强');
  assert.equal(deepMerged.exact['Font'], '字体');
  assert.equal(deepMerged.exact['Light Theme'], '浅色主题');
  assert.equal(deepMerged.exact['Dark Theme'], '深色主题');
  assert.equal(deepMerged.exact['Preset'], '预设');
  assert.equal(deepMerged.exact['Background'], '背景色');
  assert.equal(deepMerged.exact['Foreground'], '前景色');
  assert.equal(deepMerged.exact['Accent'], '强调色');
  assert.equal(deepMerged.exact['Code Preview'], '代码预览');
  assert.equal(deepMerged.exact['Knowledge Work'], '知识工作');
  assert.equal(deepMerged.exact['Software Engineering'], '软件工程');
  assert.equal(deepMerged.exact['Queue'], '排队');
  assert.equal(deepMerged.exact['Settings for conversations outside of projects.'], '非项目对话设置。');
  assert.equal(
    lightMerged.exact['Full interface for coding, developer tools, and managing agents.'],
    '用于编写代码、使用开发者工具及管理 Agent 的完整界面。'
  );
  assert.equal(
    deepMerged.exact['Full interface for coding, developer tools, and managing agents.'],
    '用于编写代码、使用开发者工具及管理智能体的完整界面。'
  );

  assert.throws(
    () => validatePatternRule({ source: 'unanchored (\\d+)', flags: '', replace: '$1' }),
    /strictly anchored/
  );
  assert.throws(
    () => validatePatternRule({ source: '^(a+)+$', flags: '', replace: 'x' }),
    /nested quantifier/
  );
  assert.throws(
    () => validatePatternRule({ source: '^ok$', flags: 'g', replace: 'x' }),
    /unsupported regex flags/
  );

  // Verify duplicate base/light conflict fails loudly in isolated workspace
  const workDir = createTempDir(t);
  const srcDir = join(workDir, 'sources', 'ja-JP');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'meta.json'),
    JSON.stringify({ locale: 'ja-JP', name: 'Japanese', nativeName: '日本語', version: '1.0.0' })
  );
  writeFileSync(
    join(srcDir, 'common.json'),
    JSON.stringify({ base: { Save: '保存' }, light: { Save: 'セーブ' }, deep: { Save: '保存' } })
  );
  assert.throws(
    () => buildAllHostI18nPacks({ rootDir: workDir }),
    /exists in both "base" and "light"/
  );

  // Verify mergeHostI18nTranslations resolves base vs light/deep splits cleanly without collisions
  const mergeRoot = createTempDir(t);
  const mergeLocaleDir = join(mergeRoot, 'sources', 'ja-JP');
  mkdirSync(mergeLocaleDir, { recursive: true });
  writeFileSync(
    join(mergeLocaleDir, 'meta.json'),
    JSON.stringify({ locale: 'ja-JP', name: 'Japanese', nativeName: '日本語', version: '1.0.0' })
  );
  writeFileSync(
    join(mergeLocaleDir, 'common.json'),
    JSON.stringify({ base: { Save: '保存', Agent: 'Agent' } })
  );
  const merged = mergeHostI18nTranslations({
    locale: 'ja-JP',
    rootDir: mergeRoot,
    ignorePath: join(mergeRoot, 'sources', 'ignore.json'),
    bump: 'patch',
    patch: {
      exact: {
        Agent: { light: 'Agent', deep: 'エージェント' },
        'Light Theme': 'ライトテーマ',
      },
      patterns: [
        { source: '^Archive (.+?)$', flags: '', hint: 'Archive', light: '$1 をアーカイブ', deep: '$1 をアーカイブ' },
      ],
      ignore: { exact: ['Google Sans'], templates: ['^Bar (.+?)$'] },
    },
  });
  assert.equal(merged.version, '1.0.1');
  assert.equal(merged.exactAdded, 1);
  assert.equal(merged.exactUpdated, 1);
  assert.equal(merged.patternsAdded, 1);
  assert.equal(merged.ignoreAdded, 2);
  const builtJa = JSON.parse(readFileSync(join(mergeRoot, 'dist', 'packs', 'ja-JP.json'), 'utf8'));
  assert.equal(builtJa.base.exact['Agent'], undefined, 'Upgraded split key must be removed from base');
  assert.equal(builtJa.modes.light.exact['Agent'], 'Agent');
  assert.equal(builtJa.modes.deep.exact['Agent'], 'エージェント');
  assert.equal(builtJa.base.exact['Light Theme'], 'ライトテーマ');
});

// ---------------------------------------------------------------------------
// 2. HTTP allowlist, fallback, SHA-256 verification & PackManager lifecycle
// ---------------------------------------------------------------------------

test('host-i18n downloader enforces HTTPS allowlist and falls back from GitHub Raw to jsDelivr', async () => {
  assert.throws(() => assertAllowedHostI18nUrl('http://raw.githubusercontent.com/a/b'));
  assert.throws(() => assertAllowedHostI18nUrl('https://evil.example.com/manifest.json'));

  const visited = [];
  const res = await fetchHostI18nTextWithFallback(
    [
      'https://raw.githubusercontent.com/yuhuan-dev/antigravity-usage-monitor/main/host-i18n/dist/manifest.json',
      'https://cdn.jsdelivr.net/gh/yuhuan-dev/antigravity-usage-monitor@main/host-i18n/dist/manifest.json',
    ],
    {
      fetchImpl: async (url) => {
        visited.push(url);
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: false, status: 503, text: async () => 'unavailable' };
        }
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
    }
  );
  assert.equal(visited.length, 2);
  assert.match(res.url, /cdn\.jsdelivr\.net/);
  assert.equal(res.text, '{"ok":true}');
});

test('PackManager verifies SHA-256, rejects tampered packs, hot-switches light/deep offline, and syncs cross-process via mtime', async (t) => {
  const dataDir = createTempDir(t);
  const realManifestText = readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'manifest.json'), 'utf8');
  const realPackText = readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8');

  let tamperMode = true;
  let fetchCalls = 0;
  const mockFetch = async (url) => {
    fetchCalls += 1;
    if (url.endsWith('/manifest.json')) {
      return { ok: true, status: 200, text: async () => realManifestText };
    }
    if (url.endsWith('/packs/zh-CN.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => (tamperMode ? realPackText.replace('设置', '篡改') : realPackText),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  const mgr = createHostI18nPackManager({ dataDir, fetchImpl: mockFetch, ref: 'main' });

  // Tampered pack must be rejected and NOT persisted
  await assert.rejects(() => mgr.selectLanguage({ locale: 'zh-CN', depth: 'light' }), /Integrity check failed/);
  assert.equal(existsSync(join(dataDir, 'host-i18n', 'packs', 'zh-CN.json')), false);
  assert.equal(mgr.loadState().locale, 'off');

  // Valid pack downloads, verifies, and activates in light mode
  tamperMode = false;
  const sel = await mgr.selectLanguage({ locale: 'zh-CN', depth: 'light' });
  assert.equal(sel.ok, true);
  assert.equal(sel.downloaded, true);
  assert.equal(sel.state.locale, 'zh-CN');
  assert.equal(sel.state.depth, 'light');

  const lightPayload = mgr.getActiveBridgeDescriptor().getPayload();
  assert.equal(lightPayload.exact['Settings'], '设置');
  assert.equal(lightPayload.exact['Manage MCP Servers'], '管理 MCP Servers');
  assert.equal(lightPayload.exact['Subagent'], 'Subagent');

  // Switching light -> deep must perform ZERO network requests
  const fetchesBeforeDepth = fetchCalls;
  mgr.setDepth('deep');
  assert.equal(fetchCalls, fetchesBeforeDepth);
  const deepPayload = mgr.getActiveBridgeDescriptor().getPayload();
  assert.equal(deepPayload.exact['Manage MCP Servers'], '管理 MCP 服务');
  assert.equal(deepPayload.exact['Subagent'], '子代理');

  // A second independent manager instance (simulating separate daemon process) observes saved state immediately
  const daemonMgr = createHostI18nPackManager({ dataDir, fetchImpl: mockFetch });
  const daemonDesc = daemonMgr.getActiveBridgeDescriptor();
  assert.equal(daemonDesc.active, true);
  assert.equal(daemonDesc.locale, 'zh-CN');
  assert.equal(daemonDesc.depth, 'deep');

  // Removing active pack cleans disk and reverts state to 'off'
  const removed = mgr.removePack('zh-CN');
  assert.equal(removed.ok, true);
  assert.equal(removed.state.locale, 'off');
  assert.equal(existsSync(join(dataDir, 'host-i18n', 'packs', 'zh-CN.json')), false);
});

// ---------------------------------------------------------------------------
// 3. Lossless DOM runtime translator & untranslated collector
// ---------------------------------------------------------------------------

function createMockDom() {
  class MockNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.parentElement = null;
      this.childNodes = [];
    }
  }
  class MockText extends MockNode {
    constructor(value) {
      super(3);
      this.nodeValue = value;
    }
  }
  class MockElement extends MockNode {
    constructor(tagName, { id = '', className = '', attrs = {}, contentEditable = false } = {}) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.isContentEditable = contentEditable;
      this._attrs = new Map(Object.entries(attrs));
      if (id) this._attrs.set('id', id);
      if (className) this._attrs.set('class', className);
    }
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    }
    getAttribute(name) {
      return this._attrs.has(name) ? this._attrs.get(name) : null;
    }
    setAttribute(name, value) {
      this._attrs.set(name, String(value));
    }
    hasAttribute(name) {
      return this._attrs.has(name);
    }
    _matchesSimple(sel) {
      const s = sel.trim();
      if (!s) return false;
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
      if (s === '[data-ag-i18n-ignore]') return this.hasAttribute('data-ag-i18n-ignore');
      if (s === '[contenteditable="true"]') return this.isContentEditable || this.getAttribute('contenteditable') === 'true';
      if (s === '[data-testid*="markdown"]') return String(this.getAttribute('data-testid') || '').includes('markdown');
      if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1);
        const eqIdx = inner.indexOf('=');
        if (eqIdx < 0) return this.hasAttribute(inner);
        const k = inner.slice(0, eqIdx);
        const v = inner.slice(eqIdx + 1).replace(/^"|"$/g, '');
        return this.getAttribute(k) === v;
      }
      if (s.includes(' ')) {
        const [ancSel, selfSel] = s.split(/\s+/);
        return this._matchesSimple(selfSel) && Boolean(this.parentElement?.closest(ancSel));
      }
      return this.tagName.toLowerCase() === s.toLowerCase();
    }
    closest(selectorList) {
      const parts = String(selectorList || '').split(',');
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (parts.some((sel) => cur._matchesSimple(sel))) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selectorList) {
      const parts = String(selectorList || '').split(',');
      const out = [];
      const walk = (node) => {
        if (!node || node.nodeType !== 1) return;
        if (parts.some((sel) => node._matchesSimple(sel))) out.push(node);
        for (const ch of node.childNodes) walk(ch);
      };
      walk(this);
      return out;
    }
  }

  const body = new MockElement('body');
  const doc = { body, documentElement: body };
  const observers = [];
  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger(mutations) {
      if (!this.disconnected) this.cb(mutations);
    }
  }

  const win = {
    MutationObserver: MockMutationObserver,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  return { win, doc, body, MockElement, MockText, observers };
}

test('runtime translator translates light/deep losslessly, skips code/chat/plugin Shadow Hosts, handles React updates, and collects missing UI strings', () => {
  const { win, doc, body, MockElement, MockText, observers } = createMockDom();
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;

  try {
    const packObj = JSON.parse(
      readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
    );
    const packHash = sha256(JSON.stringify(packObj));
    const lightPayload = compileHostI18nRuntimePayload(packObj, 'light', packHash);
    const deepPayload = compileHostI18nRuntimePayload(packObj, 'deep', packHash);

    // Build mock Antigravity DOM
    const btnSettings = body.appendChild(
      new MockElement('button', { attrs: { title: 'Open Settings', 'aria-label': 'Settings' } })
    );
    const txtSettings = btnSettings.appendChild(new MockText('  Settings  '));

    const btnMcp = body.appendChild(new MockElement('button'));
    const txtMcp = btnMcp.appendChild(new MockText('Manage MCP Servers'));

    const statusSpan = body.appendChild(new MockElement('span'));
    const txtThought = statusSpan.appendChild(new MockText('Thought for 12s'));

    const pluginCountSpan = body.appendChild(new MockElement('span'));
    const txtPluginCount = pluginCountSpan.appendChild(new MockText('3 plugins installed'));

    const inputEl = body.appendChild(
      new MockElement('input', { attrs: { placeholder: 'Ask anything...' } })
    );

    const btnUntranslated = body.appendChild(new MockElement('button'));
    btnUntranslated.appendChild(new MockText('Quantum Hyperdrive Mode'));

    // Dynamic specificity precedence: mode-specific pattern MUST beat generic base `^Show (.+?)$`
    const subagentsMoreBtn = body.appendChild(new MockElement('button'));
    const txtSubagentsMore = subagentsMoreBtn.appendChild(new MockText('Show 3 more subagents'));

    // CloudCode server-pushed model badge & removal notice tooltip
    const noticeBadge = body.appendChild(new MockElement('span'));
    const txtNoticeBadge = noticeBadge.appendChild(new MockText('Notice'));
    const noticeTip = body.appendChild(new MockElement('div'));
    const txtNoticeTip = noticeTip.appendChild(
      new MockText('GPT-OSS will be removed from Antigravity on November 30, 2026.')
    );

    // Shortcut suffix boundary safety: `Submit (Enter)` translates, `Submitted` must NOT be mangled
    const submitShortcutBtn = body.appendChild(new MockElement('button'));
    const txtSubmitShortcut = submitShortcutBtn.appendChild(new MockText('Submit (Enter)'));
    const submittedSpan = body.appendChild(new MockElement('span'));
    const txtSubmittedWord = submittedSpan.appendChild(new MockText('Submitted'));

    // Case-insensitive short-label fallback (`Accept All` -> matches `Accept all`)
    const acceptAllBtn = body.appendChild(new MockElement('button'));
    const txtAcceptAll = acceptAllBtn.appendChild(new MockText('Accept All'));

    // Real Antigravity UI toolbar inside markdown-table-* MUST be translated (NOT falsely skipped)
    const mdTableBtn = body.appendChild(
      new MockElement('button', { attrs: { 'data-testid': 'markdown-table-menu' } })
    );
    const txtMdTableBtn = mdTableBtn.appendChild(new MockText('Copy'));

    // Excluded areas that MUST NEVER be translated or collected
    const codeEl = body.appendChild(new MockElement('code'));
    const txtCode = codeEl.appendChild(new MockText('Settings'));

    const proseEl = body.appendChild(new MockElement('div', { className: 'prose' }));
    const txtProse = proseEl.appendChild(new MockText('Manage MCP Servers'));

    const userMsgEl = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'user-message-content' } })
    );
    const txtUserMsg = userMsgEl.appendChild(new MockText('Settings'));

    const codeGutterEl = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'code-gutter' } })
    );
    const txtCodeGutter = codeGutterEl.appendChild(new MockText('Cancel'));

    const mdCodeBlockEl = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'markdown-code-block-preview' } })
    );
    const txtMdCodeBlock = mdCodeBlockEl.appendChild(new MockText('Open Settings'));

    const pluginPortal = body.appendChild(new MockElement('div', { id: 'ag-usage-monitor-portal' }));
    const txtPortal = pluginPortal.appendChild(new MockText('Settings'));

    const monacoEl = body.appendChild(new MockElement('div', { className: 'monaco-editor' }));
    const txtMonaco = monacoEl.appendChild(new MockText('Cancel'));

    // 1. Apply Light mode
    const lightRes = applyHostI18nInPage(lightPayload, 'boot-1', HOST_I18N_GLOBAL_KEY);
    assert.equal(lightRes.applied, true);
    assert.equal(txtSettings.nodeValue, '  设置  ');
    assert.equal(btnSettings.getAttribute('title'), '打开设置');
    assert.equal(btnSettings.getAttribute('aria-label'), '设置');
    assert.equal(txtMcp.nodeValue, '管理 MCP Servers');
    assert.equal(txtThought.nodeValue, '已思考 12s');
    assert.equal(txtPluginCount.nodeValue, '已安装 3 个 Plugin');
    assert.equal(txtSubagentsMore.nodeValue, '展开其余 3 个 Subagent');
    assert.equal(txtNoticeBadge.nodeValue, '提示');
    assert.equal(
      txtNoticeTip.nodeValue,
      'GPT-OSS 将于 November 30, 2026 从 Antigravity 中移除。'
    );
    assert.equal(txtSubmitShortcut.nodeValue, '提交 (Enter)');
    assert.notEqual(txtSubmittedWord.nodeValue, '提交ted');
    assert.equal(txtAcceptAll.nodeValue, '全部接受');
    assert.equal(txtMdTableBtn.nodeValue, '复制');
    assert.equal(inputEl.getAttribute('placeholder'), '输入任何问题...');

    // Excluded subtrees stayed 100% untouched
    assert.equal(txtCode.nodeValue, 'Settings');
    assert.equal(txtProse.nodeValue, 'Manage MCP Servers');
    assert.equal(txtUserMsg.nodeValue, 'Settings');
    assert.equal(txtCodeGutter.nodeValue, 'Cancel');
    assert.equal(txtMdCodeBlock.nodeValue, 'Open Settings');
    assert.equal(txtPortal.nodeValue, 'Settings');
    assert.equal(txtMonaco.nodeValue, 'Cancel');

    // 2. React updates a tracked TextNode in-place ("Thought for 12s" -> "Thought for 15s")
    txtThought.nodeValue = 'Thought for 15s';
    observers[0].trigger([{ type: 'characterData', target: txtThought }]);
    assert.equal(txtThought.nodeValue, '已思考 15s');

    // 3. Hot-switch Light -> Deep without page reload
    const deepRes = applyHostI18nInPage(deepPayload, 'boot-1', HOST_I18N_GLOBAL_KEY);
    assert.equal(deepRes.applied, true);
    assert.equal(txtMcp.nodeValue, '管理 MCP 服务');
    assert.equal(txtPluginCount.nodeValue, '已安装 3 个插件');
    assert.equal(txtSubagentsMore.nodeValue, '展开其余 3 个子代理');
    assert.equal(txtThought.nodeValue, '已思考 15s');

    // 4. Collect untranslated UI strings (should pick up "Quantum Hyperdrive Mode", NOT excluded or translated items)
    const collected = collectUntranslatedHostUiInPage(HOST_I18N_GLOBAL_KEY);
    assert.ok(collected.items.some((item) => item.text === 'Quantum Hyperdrive Mode'));
    assert.equal(
      collected.items.some((item) => item.text === 'Settings' || item.text === 'Manage MCP Servers'),
      false
    );

    // 5. Dispose restores every single translated text node and attribute losslessly
    win[HOST_I18N_GLOBAL_KEY].dispose();
    assert.equal(win[HOST_I18N_GLOBAL_KEY], undefined);
    assert.equal(txtSettings.nodeValue, '  Settings  ');
    assert.equal(btnSettings.getAttribute('title'), 'Open Settings');
    assert.equal(btnSettings.getAttribute('aria-label'), 'Settings');
    assert.equal(txtMcp.nodeValue, 'Manage MCP Servers');
    assert.equal(txtThought.nodeValue, 'Thought for 15s');
    assert.equal(txtPluginCount.nodeValue, '3 plugins installed');
    assert.equal(txtSubagentsMore.nodeValue, 'Show 3 more subagents');
    assert.equal(txtSubmitShortcut.nodeValue, 'Submit (Enter)');
    assert.equal(txtAcceptAll.nodeValue, 'Accept All');
    assert.equal(txtMdTableBtn.nodeValue, 'Copy');
    assert.equal(inputEl.getAttribute('placeholder'), 'Ask anything...');
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

test('runtime translator handles long (>240 char) & multiline descriptions and scales cleanly across the full zh-CN@2.0.0 catalog', () => {
  const { win, doc, body, MockElement, MockText } = createMockDom();
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;

  try {
    const packObj = JSON.parse(
      readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
    );
    const packHash = sha256(JSON.stringify(packObj));
    const deepPayload = compileHostI18nRuntimePayload(packObj, 'deep', packHash);
    const exactEntries = Object.entries(deepPayload.exact);
    const longEntry = exactEntries.find(([k]) => k.length > 240);
    assert.ok(longEntry, 'zh-CN@2.0.0 should contain long (>240 char) settings descriptions');

    const longP = body.appendChild(new MockElement('p'));
    const txtLong = longP.appendChild(new MockText(longEntry[0]));

    // Populate a large DOM (1,500 UI text nodes) to verify compile + scan + restore speed
    const nodes = [];
    for (let i = 0; i < 1500 && i < exactEntries.length; i += 1) {
      const span = body.appendChild(new MockElement('span'));
      const tn = span.appendChild(new MockText(exactEntries[i][0]));
      nodes.push({ tn, orig: exactEntries[i][0] });
    }

    const t0 = performance.now();
    const res = applyHostI18nInPage(deepPayload, 'boot-perf', HOST_I18N_GLOBAL_KEY);
    const elapsedMs = performance.now() - t0;

    assert.equal(res.applied, true);
    assert.equal(txtLong.nodeValue, longEntry[1]);
    assert.ok(elapsedMs < 1000, `Expected full pack compile+scan < 1000ms, got ${elapsedMs.toFixed(1)}ms`);

    win[HOST_I18N_GLOBAL_KEY].dispose();
    assert.equal(txtLong.nodeValue, longEntry[0]);
    for (const item of nodes) {
      assert.equal(item.tn.nodeValue, item.orig);
    }
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

// ---------------------------------------------------------------------------
// 4. CDP Bridge integration (Desktop + IDE chat iframe, skip IDE workbench, sidebar independence)
// ---------------------------------------------------------------------------

test('window-bridge injects Host I18n into Desktop & IDE chat iframe, skips IDE workbench, uses lightweight heartbeat, and disposes cleanly', async (t) => {
  const homeDir = createTempDir(t);
  const devToolsDir = join(homeDir, 'AppData', 'Roaming', 'Antigravity');
  mkdirSync(devToolsDir, { recursive: true });

  const evaluatedByWs = new Map();
  const pageAliveRevision = new Map();

  // Mock CDP HTTP /json/list server
  const cdpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const port = cdpServer.address().port;
      const targets = [
        {
          id: 'desktop-1',
          type: 'page',
          title: 'Antigravity',
          url: 'https://127.0.0.1:45123/c/11111111-1111-1111-1111-111111111111',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/desktop-1`,
        },
        {
          id: 'ide-wb-1',
          type: 'page',
          title: 'Antigravity IDE',
          url: 'vscode-file://vscode-app/c:/app/workbench.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/ide-wb-1`,
        },
        {
          id: 'ide-chat-1',
          parentId: 'ide-wb-1',
          type: 'iframe',
          title: 'Chat',
          url: 'http://127.0.0.1:45124/c/22222222-2222-2222-2222-222222222222?extensionView=true',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/ide-chat-1`,
        },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => cdpServer.listen(0, '127.0.0.1', r));
  t.after(() => cdpServer.close());
  const cdpPort = cdpServer.address().port;
  writeFileSync(join(devToolsDir, 'DevToolsActivePort'), `${cdpPort}\n/devtools/browser/test\n`);

  // Mock WebSocket for CDP Runtime.evaluate
  class FakeCdpWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const expr = String(msg?.params?.expression || '');
      if (!evaluatedByWs.has(this.url)) evaluatedByWs.set(this.url, []);
      evaluatedByWs.get(this.url).push(expr);

      let value = null;
      if (expr.includes('needsApply: true')) {
        const revMatch = expr.match(/st\.revision !== ("[^"]+")/);
        const rev = revMatch ? JSON.parse(revMatch[1]) : '';
        value =
          pageAliveRevision.get(this.url) === rev
            ? { alive: true, needsApply: false, revision: rev, translatedCount: 4 }
            : { alive: false, needsApply: true };
      } else if (expr.includes('applyHostI18nInPage')) {
        const revMatch = expr.match(/"revision":"([^"]+)"/);
        if (revMatch) pageAliveRevision.set(this.url, revMatch[1]);
        value = { applied: true, translatedCount: 4 };
      } else if (expr.includes('disposed: true')) {
        pageAliveRevision.delete(this.url);
        value = { disposed: true };
      } else {
        value = { origin: 'https://127.0.0.1:45123', title: 'Antigravity', csrfToken: '', appConfig: null };
      }

      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { value } } }),
        })
      );
    }
    close() {
      this._emit('close', {});
    }
  }

  let active = true;
  let payloadBuilds = 0;
  const controller = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async () => '',
    // Sidebar-only mode! Overlay is OFF, proving Host I18n works independently.
    getSettingsFn: () => ({ windowMountMode: 'sidebar', enableWindowOverlay: false }),
    getBundleVersionFn: () => 'vtest',
    env: { APPDATA: join(homeDir, 'AppData', 'Roaming') },
    platform: 'win32',
    homeDir,
    autoConfigureIdeArgv: false,
    WebSocketImpl: FakeCdpWebSocket,
    getHostI18nDescriptorFn: () =>
      active
        ? {
            active: true,
            locale: 'zh-CN',
            depth: 'light',
            revision: 'zh-CN:light:1.0.0:abcdef123456',
            getPayload: () => {
              payloadBuilds += 1;
              return {
                locale: 'zh-CN',
                depth: 'light',
                revision: 'zh-CN:light:1.0.0:abcdef123456',
                exact: { Settings: '设置' },
                patterns: [],
              };
            },
          }
        : { active: false, revision: '', getPayload: null },
  });

  // First sync: applies full payload to Desktop + IDE chat iframe, skips IDE workbench
  await controller.syncAllWindows();
  const desktopUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/desktop-1`;
  const ideWbUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/ide-wb-1`;
  const ideChatUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/ide-chat-1`;

  assert.equal(payloadBuilds, 1, 'Payload should be built once per tick and shared across targets');
  assert.ok(
    (evaluatedByWs.get(desktopUrl) || []).some((e) => e.includes('applyHostI18nInPage')),
    'Desktop window must receive Host I18n apply'
  );
  assert.ok(
    (evaluatedByWs.get(ideChatUrl) || []).some((e) => e.includes('applyHostI18nInPage')),
    'IDE extensionView chat iframe must receive Host I18n apply'
  );
  assert.equal(
    (evaluatedByWs.get(ideWbUrl) || []).some((e) => e.includes('applyHostI18nInPage')),
    false,
    'IDE VS Code workbench shell must NOT receive Host I18n injection'
  );
  assert.equal(controller.getBridgeStatus().hostI18nAppliedCount, 2);

  // Second sync: both targets are alive with matching revision -> lightweight heartbeat only!
  await controller.syncAllWindows();
  assert.equal(payloadBuilds, 1, 'Heartbeat tick must NOT rebuild or resend full dictionary');

  // Turn off Host I18n -> disposes across targets cleanly
  active = false;
  await controller.notifyHostI18nChanged();
  assert.ok((evaluatedByWs.get(desktopUrl) || []).some((e) => e.includes('disposed: true')));
  assert.ok((evaluatedByWs.get(ideChatUrl) || []).some((e) => e.includes('disposed: true')));
  assert.equal(controller.getBridgeStatus().hostI18nAppliedCount, 0);

  await controller.stop();
});

// ---------------------------------------------------------------------------
// 5. API dispatcher contract
// ---------------------------------------------------------------------------

test('dispatchBridgeApiRequest routes GET/POST /api/host-i18n and __hostI18nAction compat channel cleanly', async (t) => {
  const dataDir = createTempDir(t);
  const localDistDir = join(REAL_HOST_I18N_ROOT, 'dist');
  const mgr = createHostI18nPackManager({ dataDir, localSourceDir: localDistDir });

  let notifyCount = 0;
  const opts = {
    hostI18nManager: mgr,
    onHostI18nChanged: () => {
      notifyCount += 1;
    },
    collectHostI18nUntranslated: async () => ({
      targets: 1,
      items: [{ text: 'Experimental Menu', kind: 'text', count: 2 }],
    }),
  };

  const getRes = await dispatchBridgeApiRequest('/api/host-i18n', 'GET', undefined, opts);
  assert.equal(getRes.status, 200);
  const getBody = JSON.parse(getRes.body);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.locale, 'off');
  assert.ok(getBody.packs.some((p) => p.locale === 'zh-CN'));

  const selRes = await dispatchBridgeApiRequest(
    '/api/host-i18n',
    'POST',
    { action: 'select', locale: 'zh-CN', depth: 'light' },
    opts
  );
  assert.equal(selRes.status, 200);
  const selBody = JSON.parse(selRes.body);
  assert.equal(selBody.ok, true);
  assert.equal(selBody.locale, 'zh-CN');
  assert.equal(selBody.depth, 'light');
  assert.equal(selBody.active, true);
  assert.equal(notifyCount, 1);

  const collectRes = await dispatchBridgeApiRequest(
    '/api/settings',
    'POST',
    { __hostI18nAction: 'collect_untranslated' },
    opts
  );
  assert.equal(collectRes.status, 200);
  const collectBody = JSON.parse(collectRes.body);
  assert.equal(collectBody.ok, true);
  assert.equal(collectBody.count, 1);
  assert.deepEqual(collectBody.template, { base: { 'Experimental Menu': '' } });

  // Verify unknown action returns 400
  const badRes = await handleHostI18nPostAction({ action: 'invalid_op' }, { manager: mgr });
  assert.equal(badRes.status, 400);
  assert.equal(badRes.payload.ok, false);
});

test('zh-CN@1.0.1 light/deep rules cover Customizations/Workspace/effort tiers/plan copy and collector catches div/shadowRoot/multiline strings while skipping icons', () => {
  const { win, doc, body, MockElement, MockText } = createMockDom();
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;

  try {
    const packObj = JSON.parse(
      readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
    );
    const packHash = sha256(JSON.stringify(packObj));
    const lightPayload = compileHostI18nRuntimePayload(packObj, 'light', packHash);
    const deepPayload = compileHostI18nRuntimePayload(packObj, 'deep', packHash);

    // Build DOM nodes matching Antigravity's real layout (including <div>, <span>, shadowRoot, icon ligatures)
    const navCustomizations = body.appendChild(new MockElement('span'));
    const txtCustomizations = navCustomizations.appendChild(new MockText('Customizations'));

    const titleWorkspace = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'title-menu-bar-item' } })
    );
    const txtWorkspace = titleWorkspace.appendChild(new MockText('Workspace'));

    const effortLow = body.appendChild(new MockElement('span'));
    const txtLow = effortLow.appendChild(new MockText('Low'));
    const effortMed = body.appendChild(new MockElement('span'));
    const txtMed = effortMed.appendChild(new MockText('Medium'));
    const effortHigh = body.appendChild(new MockElement('span'));
    const txtHigh = effortHigh.appendChild(new MockText('High'));
    const effortExtra = body.appendChild(new MockElement('span'));
    const txtExtra = effortExtra.appendChild(new MockText('Extra'));
    const effortMax = body.appendChild(new MockElement('span'));
    const txtMax = effortMax.appendChild(new MockText('Max'));

    const planDesc = body.appendChild(new MockElement('span'));
    const txtPlanDesc = planDesc.appendChild(
      new MockText('You are subscribed to the best Google AI plan.')
    );

    // Untranslated nodes in <div>, <li>, multiline, and shadowRoot (previously missed by UI_CONTROL_SELECTOR)
    const missingDiv = body.appendChild(new MockElement('div'));
    missingDiv.appendChild(new MockText('Unmapped Div Banner'));

    const missingLi = body.appendChild(new MockElement('li'));
    missingLi.appendChild(new MockText('Unmapped List Item'));

    const missingMultiline = body.appendChild(new MockElement('div'));
    missingMultiline.appendChild(new MockText('First unmapped line\nSecond unmapped line'));

    const shadowHost = body.appendChild(new MockElement('div'));
    const shadowRoot = new MockElement('div');
    shadowRoot.nodeType = 11;
    const shadowInner = shadowRoot.appendChild(new MockElement('div'));
    shadowInner.appendChild(new MockText('Shadow Panel Heading'));
    shadowHost.shadowRoot = shadowRoot;

    // Icon ligatures and skipped zones that must NOT be collected
    const iconSpan = body.appendChild(
      new MockElement('span', { className: 'material-symbols-outlined' })
    );
    iconSpan.appendChild(new MockText('chevron_right'));
    const ariaHiddenIcon = body.appendChild(
      new MockElement('span', { attrs: { 'aria-hidden': 'true' } })
    );
    ariaHiddenIcon.appendChild(new MockText('refresh'));
    const proseDiv = body.appendChild(new MockElement('div', { className: 'prose' }));
    proseDiv.appendChild(new MockText('Assistant prose paragraph should never leak'));

    // Real Antigravity AI reply bubble (.bleed-contain + data-markdown-block-index), sidebar conversation row,
    // file pills, breadcrumbs, step items, and noise tokens (filenames, kebab-case, fullwidth punct, acronyms)
    const aiBubble = body.appendChild(new MockElement('div', { className: 'bleed-contain bg-muted' }));
    const aiBubbleText = aiBubble.appendChild(new MockText('Settings'));
    aiBubble.appendChild(new MockText('Unmapped AI Reply Prose'));

    const mdBlock = body.appendChild(
      new MockElement('div', { attrs: { 'data-markdown-block-index': '0' } })
    );
    const mdBlockText = mdBlock.appendChild(new MockText('Cancel'));

    const sidebarRow = body.appendChild(new MockElement('div', { className: 'agy-sidebar-row' }));
    const convTitleText = sidebarRow.appendChild(new MockText('Settings'));
    sidebarRow.appendChild(new MockText('Chinese Greeting'));

    const convHistoryLink = body.appendChild(
      new MockElement('a', {
        attrs: { href: '/c/12345678-1234-1234-1234-1234567890ab', 'aria-label': 'Greeting and Hello' },
      })
    );
    convHistoryLink.appendChild(new MockText('Opening Two Bees'));

    const entityPill = body.appendChild(
      new MockElement('a', { attrs: { 'data-testid': 'entity-pill', 'data-quotable-inline': 'true' } })
    );
    entityPill.appendChild(new MockText('HostI18nCard.js'));

    const breadcrumbSeg = body.appendChild(
      new MockElement('span', {
        attrs: { 'data-testid': 'breadcrumb-segment', 'aria-label': 'Project: antigravity-usage-monitor' },
      })
    );
    breadcrumbSeg.appendChild(new MockText('antigravity-usage-monitor'));

    const stepItem = body.appendChild(
      new MockElement('li', { attrs: { 'data-testid': 'step-plan-item' } })
    );
    stepItem.appendChild(new MockText('Dynamic Agent Step Title'));

    const noiseWrap = body.appendChild(new MockElement('div'));
    for (const noise of [
      'host-i18n.test.mjs',
      'image.png',
      'host-i18n',
      'antigravity-usage-monitor',
      'Antigravity',
      'DOM',
      'KB',
      'React',
      'SemVer',
      'vX',
      '：Antigravity',
      '（sha256',
    ]) {
      noiseWrap.appendChild(new MockText(noise));
    }

    const stepChip = body.appendChild(
      new MockElement('button', {
        attrs: { 'data-testid': 'step-plan-chip', 'aria-label': '5/5 steps. Show plan' },
      })
    );
    const txtStepChip = stepChip.appendChild(new MockText('5/5 steps'));
    const navBreadcrumb = body.appendChild(
      new MockElement('nav', { attrs: { 'aria-label': 'Breadcrumb' } })
    );

    // 1. Apply Light mode
    applyHostI18nInPage(lightPayload, 'boot-v101', HOST_I18N_GLOBAL_KEY);
    assert.equal(txtCustomizations.nodeValue, '自定义扩展');
    assert.equal(txtWorkspace.nodeValue, '工作区');
    assert.equal(txtLow.nodeValue, 'Low');
    assert.equal(txtMed.nodeValue, 'Medium');
    assert.equal(txtHigh.nodeValue, 'High');
    assert.equal(txtExtra.nodeValue, 'Extra');
    assert.equal(txtMax.nodeValue, 'Max');
    assert.equal(txtPlanDesc.nodeValue, '您已订阅最高级别的 Google AI 方案。');
    assert.equal(txtStepChip.nodeValue, '5/5 步');
    assert.equal(stepChip.getAttribute('aria-label'), '5/5 步。展开计划');
    assert.equal(navBreadcrumb.getAttribute('aria-label'), '面包屑导航');
    assert.equal(aiBubbleText.nodeValue, 'Settings');
    assert.equal(mdBlockText.nodeValue, 'Cancel');
    assert.equal(convTitleText.nodeValue, 'Settings');
    assert.equal(
      lightPayload.exact['Ask anything, @ to mention, / for actions'],
      '输入任何问题，@ 提及内容，/ 调用操作'
    );
    assert.equal(
      lightPayload.exact['Message subagent, @ to mention, / for actions'],
      '向 Subagent 发送消息，@ 提及内容，/ 调用操作'
    );
    assert.equal(
      deepPayload.exact['Message subagent, @ to mention, / for actions'],
      '向子代理发送消息，@ 提及内容，/ 调用操作'
    );

    // 2. Collector must catch <div>, <li>, multiline, and shadowRoot, while excluding AI replies, sidebar titles, pills, filenames, and acronyms
    const collected = collectUntranslatedHostUiInPage(HOST_I18N_GLOBAL_KEY);
    const texts = new Set(collected.items.map((item) => item.text));
    assert.ok(texts.has('Unmapped Div Banner'));
    assert.ok(texts.has('Unmapped List Item'));
    assert.ok(texts.has('First unmapped line\nSecond unmapped line'));
    assert.ok(texts.has('Shadow Panel Heading'));
    for (const forbidden of [
      'Low',
      'High',
      'chevron_right',
      'refresh',
      'Assistant prose paragraph should never leak',
      'Unmapped AI Reply Prose',
      'Chinese Greeting',
      'Greeting and Hello',
      'Opening Two Bees',
      'HostI18nCard.js',
      'Project: antigravity-usage-monitor',
      'antigravity-usage-monitor',
      'Dynamic Agent Step Title',
      'host-i18n.test.mjs',
      'image.png',
      'host-i18n',
      'Antigravity',
      'DOM',
      'KB',
      'React',
      'SemVer',
      'vX',
      '：Antigravity',
      '（sha256',
      '5/5 steps',
      'Breadcrumb',
    ]) {
      assert.equal(texts.has(forbidden), false, `Collector must not report "${forbidden}"`);
    }

    // 3. Hot-switch Light -> Deep translates effort tiers cleanly
    applyHostI18nInPage(deepPayload, 'boot-v101', HOST_I18N_GLOBAL_KEY);
    assert.equal(txtCustomizations.nodeValue, '自定义扩展');
    assert.equal(txtWorkspace.nodeValue, '工作区');
    assert.equal(txtLow.nodeValue, '低');
    assert.equal(txtMed.nodeValue, '中');
    assert.equal(txtHigh.nodeValue, '高');
    assert.equal(txtExtra.nodeValue, '极高');
    assert.equal(txtMax.nodeValue, '最高');
    assert.equal(txtPlanDesc.nodeValue, '您已订阅最高级别的 Google AI 方案。');

    win[HOST_I18N_GLOBAL_KEY].dispose();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

test('PackManager enforces SemVer 2.0 anti-downgrade on status snapshot and install/update (1.0.1 never downgrades to 1.0.0)', async (t) => {
  assert.equal(isRemoteHostI18nPackNewer('1.0.0', '1.0.1'), false);
  assert.equal(isRemoteHostI18nPackNewer('1.0.1', '1.0.1'), false);
  assert.equal(isRemoteHostI18nPackNewer('1.0.1-beta.1', '1.0.1'), false);
  assert.equal(isRemoteHostI18nPackNewer('1.0.1', '1.0.0'), true);
  assert.equal(isRemoteHostI18nPackNewer('1.0.1', '1.0.1-beta.1'), true);
  assert.equal(isRemoteHostI18nPackNewer('invalid', '1.0.0'), false);

  const dataDir = createTempDir(t);
  const makePack = (version, extraKey) =>
    JSON.stringify({
      schemaVersion: 1,
      locale: 'zh-CN',
      name: 'Chinese (Simplified)',
      nativeName: '简体中文',
      version,
      depths: ['light', 'deep'],
      base: { exact: { Settings: '设置', [extraKey]: '测试' }, patterns: [] },
      modes: { light: { exact: {}, patterns: [] }, deep: { exact: {}, patterns: [] } },
    }) + '\n';

  const pack100 = makePack('1.0.0', 'OldKey');
  const pack101 = makePack('1.0.1', 'NewKey');
  const pack102 = makePack('1.0.2', 'NewerKey');

  let activeRemotePack = pack101;
  let activeRemoteVersion = '1.0.1';
  let packFetchCount = 0;

  const mockFetch = async (url) => {
    if (url.endsWith('/manifest.json')) {
      const manifest = {
        schemaVersion: 1,
        generatedAt: '2026-11-25T00:00:00.000Z',
        packs: [
          {
            locale: 'zh-CN',
            name: 'Chinese (Simplified)',
            nativeName: '简体中文',
            version: activeRemoteVersion,
            file: 'packs/zh-CN.json',
            sha256: sha256(activeRemotePack),
            bytes: Buffer.byteLength(activeRemotePack, 'utf8'),
            depths: ['light', 'deep'],
          },
        ],
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(manifest) };
    }
    if (url.endsWith('/packs/zh-CN.json')) {
      packFetchCount += 1;
      return { ok: true, status: 200, text: async () => activeRemotePack };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  const mgr = createHostI18nPackManager({ dataDir, fetchImpl: mockFetch, ref: 'main' });

  // 1. Install 1.0.1 initially
  await mgr.selectLanguage({ locale: 'zh-CN', depth: 'light' });
  assert.equal(mgr.loadInstalledPack('zh-CN').pack.version, '1.0.1');
  assert.equal(packFetchCount, 1);

  // 2. Remote serves older 1.0.0 (different hash & lower SemVer) -> updateAvailable MUST be false & update MUST NOT downgrade
  activeRemotePack = pack100;
  activeRemoteVersion = '1.0.0';
  const manifestRes100 = await mgr.refreshManifest({ force: true });
  const snap100 = mgr.getStatusSnapshot({ manifestResult: manifestRes100 });
  const zh100 = snap100.packs.find((p) => p.locale === 'zh-CN');
  assert.equal(zh100.installedVersion, '1.0.1');
  assert.equal(zh100.remoteVersion, '1.0.0');
  assert.equal(zh100.updateAvailable, false);

  const downgradeRes = await handleHostI18nPostAction(
    { action: 'update', locale: 'zh-CN' },
    { manager: mgr }
  );
  assert.equal(downgradeRes.status, 200);
  assert.equal(downgradeRes.payload.updated, false);
  assert.equal(downgradeRes.payload.alreadyUpToDate, true);
  assert.equal(mgr.loadInstalledPack('zh-CN').pack.version, '1.0.1');
  assert.equal(packFetchCount, 1, 'Must NOT even download older remote pack');

  // 3. Remote serves newer 1.0.2 -> updateAvailable MUST be true & update upgrades cleanly
  activeRemotePack = pack102;
  activeRemoteVersion = '1.0.2';
  const manifestRes102 = await mgr.refreshManifest({ force: true });
  const snap102 = mgr.getStatusSnapshot({ manifestResult: manifestRes102 });
  assert.equal(snap102.packs.find((p) => p.locale === 'zh-CN').updateAvailable, true);

  const upgradeRes = await handleHostI18nPostAction(
    { action: 'update', locale: 'zh-CN' },
    { manager: mgr }
  );
  assert.equal(upgradeRes.status, 200);
  assert.equal(upgradeRes.payload.updated, true);
  assert.equal(upgradeRes.payload.alreadyUpToDate, false);
  assert.equal(mgr.loadInstalledPack('zh-CN').pack.version, '1.0.2');
  assert.equal(packFetchCount, 2);
});

test('runtime translator and collector skip Antigravity code-line/diff/code-block containers, ignore AI/UI acronyms, and translate just now + relative time + diff source labels', () => {
  const { win, doc, body, MockElement, MockText } = createMockDom();
  const zhPack = JSON.parse(
    readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
  );
  const packHash = sha256(JSON.stringify(zhPack));
  const lightPayload = compileHostI18nRuntimePayload(zhPack, 'light', packHash);
  const deepPayload = compileHostI18nRuntimePayload(zhPack, 'deep', packHash);

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  try {
    globalThis.window = win;
    globalThis.document = doc;

    // 1. Unified/split diff row (.code-line + data-diff-type + .line-content) containing CSS tokens
    //    matching dictionary words ('background', 'color', 'none')
    const diffLine = body.appendChild(
      new MockElement('div', {
        className: 'code-line group flex flex-nowrap select-contain',
        attrs: { 'data-diff-type': '1', 'data-current-original-line': '1377' },
      })
    );
    const diffContent = diffLine.appendChild(
      new MockElement('div', { className: 'line-content group/line overflow-y-clip' })
    );
    const cssPropBg = diffContent.appendChild(new MockElement('span')).appendChild(new MockText('background'));
    const cssPropColor = diffContent.appendChild(new MockElement('span')).appendChild(new MockText('color'));
    const cssValNone = diffContent.appendChild(new MockElement('span')).appendChild(new MockText('none'));

    // 2. File viewer line ([data-line-number] + [data-line-tokens]) and standalone .code-block
    const fileLine = body.appendChild(
      new MockElement('div', { attrs: { 'data-line-number': '12' } })
    );
    const lineTokens = fileLine.appendChild(
      new MockElement('span', { attrs: { 'data-line-tokens': 'true' } })
    );
    const fileTokenBg = lineTokens.appendChild(new MockText('background'));
    const codeBlock = body.appendChild(
      new MockElement('div', { className: 'code-block w-full text-sm' })
    );
    const codeBlockToken = codeBlock.appendChild(new MockElement('span')).appendChild(new MockText('Color'));

    // 3. Real UI strings: just now, w/mo/y ago, diff source labels, and tab titles
    const justNowEl = body.appendChild(new MockElement('span')).appendChild(new MockText('just now'));
    const weeksAgoEl = body.appendChild(new MockElement('span')).appendChild(new MockText('2w ago'));
    const monthsAgoEl = body.appendChild(new MockElement('span')).appendChild(new MockText('3mo ago'));
    const yearsAgoEl = body.appendChild(new MockElement('span')).appendChild(new MockText('1y ago'));
    const singleEditEl = body
      .appendChild(new MockElement('span', { attrs: { 'data-testid': 'diff-source-label' } }))
      .appendChild(new MockText('single edit'));
    const tabTitleSingle = body
      .appendChild(new MockElement('span'))
      .appendChild(new MockText('views-tables.css (single edit)'));
    const tabTitleAllEdits = body
      .appendChild(new MockElement('span'))
      .appendChild(new MockText('views-tables.css (all agent edits)'));

    // 4. Universal acronyms AI / UI that collector must NOT flag as missing translations
    const aiBadge = body.appendChild(new MockElement('span')).appendChild(new MockText('AI'));
    const uiBadge = body.appendChild(new MockElement('span')).appendChild(new MockText('UI'));

    applyHostI18nInPage(lightPayload, 'boot-code-guard', HOST_I18N_GLOBAL_KEY);

    // Code & diff tokens MUST remain untouched
    assert.equal(cssPropBg.nodeValue, 'background');
    assert.equal(cssPropColor.nodeValue, 'color');
    assert.equal(cssValNone.nodeValue, 'none');
    assert.equal(fileTokenBg.nodeValue, 'background');
    assert.equal(codeBlockToken.nodeValue, 'Color');

    // UI strings MUST translate cleanly
    assert.equal(justNowEl.nodeValue, '刚刚');
    assert.equal(weeksAgoEl.nodeValue, '2 周前');
    assert.equal(monthsAgoEl.nodeValue, '3 个月前');
    assert.equal(yearsAgoEl.nodeValue, '1 年前');
    assert.equal(singleEditEl.nodeValue, '单次编辑');
    assert.equal(tabTitleSingle.nodeValue, 'views-tables.css（单次编辑）');
    assert.equal(tabTitleAllEdits.nodeValue, 'views-tables.css（全部 Agent 编辑）');
    assert.equal(aiBadge.nodeValue, 'AI');
    assert.equal(uiBadge.nodeValue, 'UI');

    // Collector must ignore AI, UI, and code/diff contents
    const collected = collectUntranslatedHostUiInPage(HOST_I18N_GLOBAL_KEY);
    const collectedTexts = new Set(collected.items.map((item) => item.text));
    for (const ignored of ['AI', 'UI', 'background', 'color', 'none', 'just now']) {
      assert.equal(collectedTexts.has(ignored), false, `Collector must not report "${ignored}"`);
    }

    // Deep mode localizes Agent in diff source labels
    applyHostI18nInPage(deepPayload, 'boot-code-guard', HOST_I18N_GLOBAL_KEY);
    assert.equal(tabTitleAllEdits.nodeValue, 'views-tables.css（全部智能体编辑）');
    assert.equal(cssPropBg.nodeValue, 'background');

    win[HOST_I18N_GLOBAL_KEY].dispose();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

test('Issue #54: runtime translator and collector exempt AI replies (streaming word spans), thinking markdown, KaTeX math, tables, and single lowercase prose words without breaking UI chrome or CDP serialization', () => {
  const { win, doc, body, MockElement, MockText, observers } = createMockDom();
  const zhPack = JSON.parse(
    readFileSync(join(REAL_HOST_I18N_ROOT, 'dist', 'packs', 'zh-CN.json'), 'utf8')
  );
  const packHash = sha256(JSON.stringify(zhPack));
  const lightPayload = compileHostI18nRuntimePayload(zhPack, 'light', packHash);

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  try {
    globalThis.window = win;
    globalThis.document = doc;

    // 1. Streaming AI reply inside planner-response-text + [data-markdown-root] (.md-divider-spacing)
    //    Reproduces per-word <span> split where exactMap ('for','the','waiting','result') and
    //    exactLowerMap ('display','on','all','tasks','before') previously mangled English replies.
    const plannerTurn = body.appendChild(new MockElement('div'));
    const thinkingTrigger = plannerTurn.appendChild(
      new MockElement('button', { attrs: { 'data-testid': 'thinking-collapsible-trigger' } })
    );
    const txtThinkingTrigger = thinkingTrigger.appendChild(new MockText('Thought for 12s'));
    const thinkingBody = plannerTurn.appendChild(new MockElement('div', { className: 'cursor-edit pl-2' }));
    // IDE-style markdown root (only .md-divider-spacing, no data-markdown-root)
    const thinkingMdRoot = thinkingBody.appendChild(
      new MockElement('div', { className: 'text-base md-divider-spacing break-words' })
    );
    const thinkingWordFor = thinkingMdRoot.appendChild(new MockElement('span')).appendChild(new MockText('for '));
    const thinkingWordEffort = thinkingMdRoot
      .appendChild(new MockElement('strong'))
      .appendChild(new MockText('effort'));

    const plannerResp = plannerTurn.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'planner-response-text' } })
    );
    const mdRoot = plannerResp.appendChild(
      new MockElement('div', {
        className: 'text-base leading-relaxed select-text md-divider-spacing break-words',
        attrs: { 'data-markdown-root': '' },
      })
    );
    const streamingParagraph = mdRoot.appendChild(new MockElement('p'));
    const streamingWords = [
      'Thanks ',
      'for ',
      'the ',
      'proposal ',
      'and ',
      'reference ',
      'implementation! ',
      'Multi-currency ',
      'display ',
      'has ',
      'long ',
      'been ',
      'on ',
      'the ',
      'v1.5.6 ',
      'roadmap. ',
      'Just ',
      'waiting ',
      'for ',
      'all ',
      'remaining ',
      'tasks ',
      'in ',
      'that ',
      'release ',
      'to ',
      'wrap ',
      'up ',
      'before ',
      'shipping ',
      '— ',
      'should ',
      'have ',
      'a ',
      'result ',
      'today. ',
      'Stay ',
      'tuned 🙏',
    ];
    const streamingTextNodes = streamingWords.map((w) =>
      streamingParagraph.appendChild(new MockElement('span')).appendChild(new MockText(w))
    );

    // Sibling action bar outside planner-response-text MUST keep translating
    const actionBar = plannerTurn.appendChild(new MockElement('div'));
    const btnCopy = actionBar.appendChild(
      new MockElement('button', { attrs: { 'aria-label': 'Copy' } })
    );
    const tipGood = actionBar.appendChild(new MockElement('span')).appendChild(new MockText('Good Response'));
    const tipBad = actionBar.appendChild(new MockElement('span')).appendChild(new MockText('Bad Response'));
    const relTime = actionBar.appendChild(new MockElement('span')).appendChild(new MockText('just now'));

    // 2. Standalone KaTeX inline & display formulas (even outside planner-response-text)
    const katexInline = body.appendChild(new MockElement('span', { className: 'katex' }));
    const katexMathml = katexInline.appendChild(new MockElement('span', { className: 'katex-mathml' }));
    const katexMathTag = katexMathml.appendChild(new MockElement('math'));
    const txtMathmlEffort = katexMathTag.appendChild(new MockText('effort'));
    const katexHtml = katexInline.appendChild(
      new MockElement('span', { className: 'katex-html', attrs: { 'aria-hidden': 'true' } })
    );
    const txtKatexHtmlEffort = katexHtml
      .appendChild(new MockElement('span', { className: 'mord text' }))
      .appendChild(new MockText('effort'));
    const txtKatexHtmlTitleEffort = katexHtml
      .appendChild(new MockElement('span', { className: 'mord text' }))
      .appendChild(new MockText('Effort'));

    const katexDisplayWrap = body.appendChild(
      new MockElement('span', { className: 'md-math-display block my-2' })
    );
    const katexDisplay = katexDisplayWrap.appendChild(new MockElement('span', { className: 'katex-display' }));
    const txtKatexDisplayFor = katexDisplay
      .appendChild(new MockElement('span'))
      .appendChild(new MockText('for'));

    // 3. Markdown table cells ([data-md-table]) vs table menu toolbar (portal / sibling UI chrome)
    const mdTableHost = body.appendChild(new MockElement('div', { className: 'md-table-host' }));
    const mdTableMenuBtn = mdTableHost.appendChild(
      new MockElement('button', { attrs: { 'data-testid': 'markdown-table-menu', 'aria-label': 'Copy' } })
    );
    const mdTableCopyItem = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'markdown-table-copy-markdown' } })
    );
    const txtMdTableCopyItem = mdTableCopyItem.appendChild(new MockText('Copy as Markdown'));
    const mdTableBody = mdTableHost.appendChild(
      new MockElement('div', { attrs: { 'data-md-table': 'table-1' } })
    );
    const txtTableCellEffort = mdTableBody
      .appendChild(new MockElement('table'))
      .appendChild(new MockElement('td'))
      .appendChild(new MockText('Effort'));

    // 4. Additional AI/user content containers
    const progressUpdate = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'progress-update-response-text' } })
    );
    const txtProgressUpdate = progressUpdate.appendChild(new MockText('waiting'));
    const askHeader = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'ask-question-header-text' } })
    );
    const txtAskHeader = askHeader.appendChild(new MockText('Effort'));
    const askOption = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'ask-question-option-text' } })
    );
    const txtAskOption = askOption.appendChild(new MockText('Settings'));
    const commentText = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'comment-card-text' } })
    );
    const txtComment = commentText.appendChild(new MockText('Settings'));
    const liveAgent = body.appendChild(
      new MockElement('div', { attrs: { 'data-testid': 'live-agent-turn' } })
    );
    const txtLiveAgent = liveAgent.appendChild(new MockText('Settings'));

    // 5. Defense-in-depth: single lowercase words outside exempt containers MUST NOT hit Title Case exactLowerMap,
    //    while Title Case labels & mixed-case UI phrases STILL translate accurately.
    const bareLowerEffort = body.appendChild(new MockElement('span')).appendChild(new MockText('effort'));
    const bareLowerDisplay = body.appendChild(new MockElement('span')).appendChild(new MockText('display'));
    const bareLowerOn = body.appendChild(new MockElement('span')).appendChild(new MockText('on'));
    const bareLowerAll = body.appendChild(new MockElement('span')).appendChild(new MockText('all'));
    const bareLowerTasks = body.appendChild(new MockElement('span')).appendChild(new MockText('tasks'));
    const bareLowerBefore = body.appendChild(new MockElement('span')).appendChild(new MockText('before'));

    const uiTitleEffort = body.appendChild(new MockElement('span')).appendChild(new MockText('Effort'));
    const uiAcceptAll = body.appendChild(new MockElement('button')).appendChild(new MockText('Accept All'));
    const uiFontSize = body.appendChild(new MockElement('span')).appendChild(new MockText('Font size'));
    const uiImage = body.appendChild(new MockElement('span')).appendChild(new MockText('Image'));

    // Execute via isolated CDP Runtime.evaluate expression (`new Function` has ZERO access to module scope!)
    const applyExpr = createHostI18nApplyExpression(lightPayload, 'boot-issue54');
    const applyRes = new Function(`return (${applyExpr});`)();
    assert.equal(applyRes.applied, true);

    // Streaming AI reply & thinking body stayed 100% untouched
    assert.equal(
      streamingTextNodes.map((n) => n.nodeValue).join(''),
      streamingWords.join('')
    );
    assert.equal(thinkingWordFor.nodeValue, 'for ');
    assert.equal(thinkingWordEffort.nodeValue, 'effort');

    // MutationObserver incremental streaming word append inside planner-response-text stays untouched
    const streamedSpan = streamingParagraph.appendChild(new MockElement('span'));
    const txtStreamedFor = streamedSpan.appendChild(new MockText('for '));
    observers[0].trigger([{ type: 'childList', addedNodes: [streamedSpan] }]);
    assert.equal(txtStreamedFor.nodeValue, 'for ');

    // KaTeX math formulas, table cells, and extra AI/user content containers stayed 100% untouched
    assert.equal(txtMathmlEffort.nodeValue, 'effort');
    assert.equal(txtKatexHtmlEffort.nodeValue, 'effort');
    assert.equal(txtKatexHtmlTitleEffort.nodeValue, 'Effort');
    assert.equal(txtKatexDisplayFor.nodeValue, 'for');
    assert.equal(txtTableCellEffort.nodeValue, 'Effort');
    assert.equal(txtProgressUpdate.nodeValue, 'waiting');
    assert.equal(txtAskHeader.nodeValue, 'Effort');
    assert.equal(txtAskOption.nodeValue, 'Settings');
    assert.equal(txtComment.nodeValue, 'Settings');
    assert.equal(txtLiveAgent.nodeValue, 'Settings');

    // Bare single lowercase words did NOT falsely trigger Title Case exactLowerMap
    assert.equal(bareLowerEffort.nodeValue, 'effort');
    assert.equal(bareLowerDisplay.nodeValue, 'display');
    assert.equal(bareLowerOn.nodeValue, 'on');
    assert.equal(bareLowerAll.nodeValue, 'all');
    assert.equal(bareLowerTasks.nodeValue, 'tasks');
    assert.equal(bareLowerBefore.nodeValue, 'before');

    // Legitimate Antigravity UI chrome & mixed-case phrases translated cleanly
    assert.equal(txtThinkingTrigger.nodeValue, '已思考 12s');
    assert.equal(btnCopy.getAttribute('aria-label'), '复制');
    assert.equal(tipGood.nodeValue, '优质回复');
    assert.equal(tipBad.nodeValue, '回复不佳');
    assert.equal(relTime.nodeValue, '刚刚');
    assert.equal(mdTableMenuBtn.getAttribute('aria-label'), '复制');
    assert.equal(txtMdTableCopyItem.nodeValue, '复制为 Markdown');
    assert.equal(uiTitleEffort.nodeValue, '思考强度');
    assert.equal(uiAcceptAll.nodeValue, '全部接受');
    assert.equal(uiFontSize.nodeValue, '字号');
    assert.equal(uiImage.nodeValue, '图片');

    // Isolated CDP collect expression must NOT throw ReferenceError and must NOT leak AI prose / KaTeX
    const collectExpr = createHostI18nCollectExpression();
    const collected = new Function(`return (${collectExpr});`)();
    const collectedTexts = new Set(collected.items.map((item) => item.text));
    for (const leaked of ['Multi-currency', 'proposal', 'implementation!', 'roadmap.']) {
      assert.equal(collectedTexts.has(leaked), false, `Collector must not report AI prose "${leaked}"`);
    }

    win[HOST_I18N_GLOBAL_KEY].dispose();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});
