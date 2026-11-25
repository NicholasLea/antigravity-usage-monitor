#!/usr/bin/env node
/**
 * @fileoverview Zero-dependency read-only lexical UI string & template extractor
 * for Antigravity Desktop (`language_server.exe` embedded `main.js`) and
 * Antigravity IDE (`out/jetskiAgent/main.js`).
 *
 * Supports both Classic React (`E.createElement`) and Automatic JSX Runtime
 * (`d(Tag, { children: ... })`), filters out embedded vendor libraries (ELKjs,
 * Zod non-English locales, KaTeX, VS Code theme color metadata, Protobuf descriptors),
 * and produces a clean, high-recall `en-US` UI catalog (`exact` + `templates`).
 *
 * Usage:
 *   node host-i18n/scripts/extract-host-strings.mjs --auto --out host-i18n/sources/en-US.catalog.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG_OUT = resolve(__dirname, '..', 'sources', 'en-US.catalog.json');

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'delete', 'throw', 'case', 'in', 'of',
  'instanceof', 'new', 'yield', 'await', 'else', 'do',
]);

const SKIP_CREATE_ELEMENT_TAGS = new Set([
  'style', 'script', 'svg', 'path', 'circle', 'rect', 'line', 'polygon',
  'polyline', 'ellipse', 'g', 'defs', 'clipPath', 'mask', 'linearGradient',
  'radialGradient', 'stop', 'filter', 'use', 'symbol', 'animate', 'meta', 'link',
]);

const DOM_CREATE_ELEMENT_RECEIVERS = new Set([
  'document', 'doc', 'ownerDocument', 'mainDocument', '_document',
  'treeAdapter', 'u003ddocument',
]);

const UI_PROP_KEYS = new Set([
  'title', 'placeholder', 'aria-label', 'aria-placeholder',
  'aria-roledescription', 'aria-valuetext', 'aria-description', 'alt',
  'label', 'description', 'tooltip', 'tooltipText', 'tooltipContent',
  'tooltipTitle', 'heading', 'subheading', 'subtitle', 'header', 'footer',
  'text', 'message', 'emptyText', 'emptyTitle', 'emptyMessage',
  'emptyDescription', 'emptyStateTitle', 'emptyStateDescription',
  'confirmText', 'confirmLabel', 'cancelText', 'cancelLabel',
  'buttonText', 'buttonLabel', 'actionLabel', 'actionText', 'ctaLabel',
  'ctaText', 'hint', 'helperText', 'helpText', 'caption', 'badge',
  'badgeText', 'statusText', 'statusLabel', 'summary', 'errorMessage',
  'warningMessage', 'successMessage', 'toastMessage', 'triggerText',
  'triggerLabel', 'closeLabel', 'openLabel', 'searchPlaceholder',
  'filterPlaceholder', 'noResultsText', 'loadingText', 'fallbackText',
  'defaultLabel', 'selectedLabel', 'disabledReason', 'reason', 'detail',
  'details', 'note', 'callout', 'prompt', 'question', 'copyText',
  'copyTooltip', 'primaryActionLabel', 'secondaryActionLabel',
  'submitLabel', 'resetLabel', 'clearLabel', 'doneLabel', 'backLabel',
  'nextLabel', 'saveLabel', 'deleteLabel', 'removeLabel', 'addLabel',
  'createLabel', 'editLabel', 'children', 'shortLabel', 'displayName',
  'groupLabel', 'sectionTitle', 'tabLabel', 'menuLabel', 'emptyLabel',
  'prefix', 'suffix', 'singular', 'plural', 'ariaLabel', 'doneText',
  'activeText', 'inactiveText', 'pendingText', 'runningText', 'errorText',
  'successText', 'warningText', 'infoText', 'hoverText', 'titleText',
  'subtext', 'sublabel', 'subLabel', 'dialogTitle', 'dialogDescription',
  'modalTitle', 'modalDescription', 'cardTitle', 'cardDescription',
  'panelTitle', 'bannerText', 'noticeText', 'cta',
  'tagTitle', 'tagDescription', 'optionLabel', 'optionDescription',
  'emptyActionLabel', 'buttonTitle', 'sectionDescription', 'cardSubtitle',
  'toggleLabel', 'switchLabel', 'headerTitle', 'footerText',
  'linkText', 'linkLabel', 'ctaTitle', 'ctaDescription', 'categoryLabel',
  'groupTitle', 'tabTitle', 'itemLabel', 'itemDescription',
  'tooltipDescription', 'ariaDescription', 'placeholderText',
  'warningTitle', 'errorTitle', 'infoTitle', 'successTitle',
]);

const STRONG_OBJECT_UI_KEYS = new Set([
  'children', 'label', 'description', 'placeholder', 'aria-label', 'ariaLabel',
  'tooltip', 'tooltipText', 'tooltipContent', 'tooltipTitle',
  'heading', 'subheading', 'subtitle', 'emptyText', 'emptyTitle',
  'emptyMessage', 'emptyDescription', 'emptyStateTitle', 'emptyStateDescription',
  'confirmText', 'confirmLabel', 'cancelText', 'cancelLabel',
  'buttonText', 'buttonLabel', 'actionLabel', 'actionText',
  'ctaLabel', 'ctaText', 'helperText', 'helpText', 'hint',
  'primaryActionLabel', 'secondaryActionLabel', 'disabledReason',
  'noResultsText', 'loadingText', 'searchPlaceholder', 'filterPlaceholder',
  'errorMessage', 'warningMessage', 'successMessage', 'toastMessage',
  'shortLabel', 'groupLabel', 'sectionTitle', 'tabLabel', 'menuLabel',
  'triggerLabel', 'badgeText', 'statusLabel', 'statusText', 'title',
  'doneText', 'activeText', 'inactiveText', 'pendingText', 'runningText',
  'subtext', 'sublabel', 'subLabel', 'dialogTitle', 'dialogDescription',
  'modalTitle', 'modalDescription', 'cardTitle', 'cardDescription',
  'panelTitle', 'bannerText', 'noticeText', 'message', 'summary',
  'tagTitle', 'tagDescription', 'optionLabel', 'optionDescription',
  'emptyActionLabel', 'buttonTitle', 'sectionDescription', 'cardSubtitle',
  'toggleLabel', 'switchLabel', 'headerTitle', 'footerText',
  'linkText', 'linkLabel', 'ctaTitle', 'ctaDescription', 'categoryLabel',
  'groupTitle', 'tabTitle', 'itemLabel', 'itemDescription',
  'tooltipDescription', 'ariaDescription', 'placeholderText',
  'warningTitle', 'errorTitle', 'infoTitle', 'successTitle',
]);

const NON_UI_SINGLE_TITLE_WORDS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Function', 'Symbol', 'BigInt',
  'Promise', 'RegExp', 'Date', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError', 'AbortError', 'DOMException',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Math', 'JSON', 'Intl',
  'Buffer', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'URL',
  'Window', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent',
  'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'MessageChannel',
  'ShadowRoot', 'DocumentFragment', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'AbortController', 'AbortSignal', 'ReadableStream',
  'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'React', 'Fragment', 'Suspense', 'StrictMode', 'Component', 'PureComponent',
  'NaN', 'Infinity', 'Null', 'Undefined', 'True', 'False', 'Unknown', 'Any',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'Enter', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Space', 'Home', 'End', 'PageUp', 'PageDown',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Electron', 'Chromium',
  'Windows', 'Linux', 'Darwin', 'Android', 'Ubuntu', 'Debian', 'Fedora',
  'Google', 'Apple', 'Microsoft', 'GitHub', 'GitLab', 'Anthropic', 'OpenAI',
  'Claude', 'Gemini', 'Antigravity', 'Jetski', 'Monaco', 'Lexical', 'KaTeX',
  'Prism', 'Shiki', 'Mermaid', 'Tailwind', 'ReactDOM', 'Closure', 'Protobuf',
]);

const NON_UI_PROP_KEYS = new Set([
  'className', 'class', 'style', 'id', 'key', 'href', 'src', 'rel', 'target',
  'type', 'name', 'role', 'variant', 'size', 'color', 'icon', 'iconName',
  'data-testid', 'data-state', 'data-side', 'data-align', 'fill', 'stroke',
  'viewBox', 'd', 'xmlns', 'method', 'path', 'url', 'uri', 'fontFamily',
  'gridTemplateColumns', 'transform', 'transition', 'animation', 'cursor',
  'position', 'display', 'overflow', 'whiteSpace', 'textAlign', 'fontWeight',
]);

const NON_UI_FUNC_CALLS = new Set([
  'jj', 'cn', 'clsx', 'cx', 'twMerge', 'cva', 'Error', 'TypeError', 'RangeError',
  'RegExp', 'URL', 'Set', 'Map', 'console', 'log', 'warn', 'error', 'debug', 'info',
  'querySelector', 'querySelectorAll', 'getElementById', 'getAttribute', 'setAttribute',
  'addEventListener', 'removeEventListener', 'getItem', 'setItem', 'removeItem',
  'startsWith', 'endsWith', 'includes', 'indexOf', 'match', 'replace', 'split', 'join',
  'exec', 'test', 'encodeURIComponent', 'decodeURIComponent', 'assert', 'invariant',
  'createElement', 'createElementNS', 'getComputedStyle', 'defineProperty',
]);

const TAILWIND_TOKEN_RE =
  /^(?:!)?(?:(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|focus-within|active|disabled|dark|light|group-hover|peer-checked|open|closed|placeholder|before|after|first|last|odd|even|data-\[[^\]]+\]|aria-\[[^\]]+\]|\[[^\]]+\]):)*(?:flex|inline-flex|grid|block|inline-block|inline|hidden|relative|absolute|fixed|sticky|static|inset|inset-x|inset-y|top|right|bottom|left|z|w|h|min-w|max-w|min-h|max-h|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|items|justify|self|place|content|flex-1|flex-auto|flex-initial|flex-none|flex-col|flex-row|flex-wrap|flex-nowrap|shrink|shrink-0|grow|grow-0|overflow|overflow-x|overflow-y|truncate|whitespace|break|text|font|leading|tracking|align|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|no-underline|line-through|tabular-nums|select-none|select-text|select-all|cursor|pointer-events|bg|from|via|to|border|border-t|border-r|border-b|border-l|border-x|border-y|divide|rounded|ring|outline|shadow|opacity|mix-blend|blur|brightness|contrast|grayscale|invert|saturate|sepia|backdrop|transition|duration|ease|delay|animate|transform|scale|rotate|translate|skew|origin|appearance|resize|scroll|snap|touch|will-change|fill|stroke|sr-only|not-sr-only|group|peer|aspect|object|col|row|order|float|clear|isolate|box|table|caption|list|accent|caret|line-clamp)(?:-[\w./[\]()%-]+)?$/;

const SVG_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]{8,}$/;
const IDENTIFIER_CASE_RE = /^(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+|[a-z0-9]+(?:-[a-z0-9]+){1,})$/;
const URL_OR_PATH_RE = /^(?:https?:\/\/|wss?:\/\/|file:\/\/|mailto:|data:|vscode-file:|chrome:|about:|\/[\w./~-]+|\.\.?\/[\w./-]+|[A-Za-z]:\\|@[a-z0-9-]+\/[a-z0-9-]+|\*\.[\w]+|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|css|scss|html|json|md|png|svg|jpg|webp|wasm|exe|dll|sh|ps1|py|go|rs|java|cpp|yaml|yml|toml|lock|db|sqlite))$/i;
const PURE_SHORTCUT_RE =
  /^(?:(?:Ctrl|Cmd|Alt|Shift|Opt|Option|Meta|⌘|⌃|⌥|⇧)\s*\+\s*(?:[A-Za-z0-9F][a-z0-9]?|Enter|Esc|Tab|Space|Backspace|Delete|Up|Down|Left|Right|↵|⌫|⇥|⎋)(?:\s*\+\s*(?:[A-Za-z0-9F][a-z0-9]?|Enter|Esc|Tab|Space|Backspace|Delete|Up|Down|Left|Right))?|[⌘⌃⌥⇧↵⌫⇥⎋]{1,4}[A-Z0-9]?)$/;
const DEBUG_LOG_PREFIX_RE = /^(?:,\s*(?:binary|host|userType|pid|port|status|code|id)=|ERR_[A-Z0-9_]*:?|LexicalNode:|Malformed Worker RPC|Invalid grammar,|fulfill is |\.[a-z]+\(\)$|[A-Z][a-zA-Z0-9]+(?:Icon|Component)\(|^(?:Key|Digit)\{1\}$|Token#toString\(\):|^(?:Array|Uint8Array)\(\{1\}\)$|^(?:in_mdb|matches_principal)\(|^width \d+ms var\(|^transition-\[)/;
const PURE_SYMBOL_OR_NUM_RE = /^[\d.,:%$€£¥+\-*/=<>!?@#%^&*()[\]{}|\\/~`'"\s·•—–…←→↑↓]+$/;
const MIME_OR_HEADER_RE = /^(?:application|text|image|audio|video|font|multipart)\/[\w.+-]+$/i;
const CSS_VALUE_RE = /^(?:var\(--|rgb\(|rgba\(|hsl\(|hsla\(|oklch\(|color-mix\(|calc\(|cubic-bezier\(|linear-gradient\(|radial-gradient\(|#[0-9a-f]{3,8}$|\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|ms|s|deg|fr)$)/i;
const PROTO_OR_CODE_RE = /^(?:exa\.|google\.|third_party\.|org\.eclipse\.|MODEL_|CORTEX_|CASCADE_|EVENT_|LANGUAGE_|ERROR_|STATUS_|__[A-Z0-9_]+__)/;
const VENDOR_SKIP_RE = /^(?:KaTeX|TeX|LaTeX|MathML|Mermaid|Shiki|Prism|ProseMirror|CodeMirror|Monaco|xterm|PDF\.js|Chromium|Electron|React|Closure|ELK|DCGraph|AdjacencyList|Adjacency \[|ListItemNode|A ListItemNode|A stream that is in the CLOSED|ActuatorService|Represents a collate|Style for (?:classes|comments|enum|expressions|functions|interfaces|keywords|macros|member functions|method|namespaces|numbers|operators|parameters|properties|strings|structs|type|variables)\b|Sets or unsets the font style to |Sets the all font styles of the rule:|Token background colors are currently not supported|Specifies a minimum thickness, in ems|Trust the input, enabling all HTML features|Turn on strict \/ LaTeX faithfulness mode|The given editor argument does not match \$getEditor|To use \$generateHtmlFromNodes|Array Buffer DataView Date Error|Boolean\(window\.|Border on the side of the terminal tab in the panel|Colors and styles for the token\.)/;
const VSCODE_THEME_DESC_RE =
  /(?:\b(?:background|foreground|border)\s+color\b|The activity bar is showing on the far left or right|^Color of the |^Highlight color of |^Border color of |^Background color of |^Foreground color of |^Shadow color of |^Overview ruler marker color)/i;
const ELK_GRAPH_DESC_RE =
  /\b(?:bendpoint|polyomino|compaction|planar graph|hyperedge|crossing minimization|self-?loop|orthogonal edge|port constraints?|layered algorithm|node overlap removal|graph layout|wrapped edges? spacing)\b/i;
const NON_ENGLISH_SCRIPT_RE =
  /[\u00c0-\u024f\u0370-\u04ff\u0590-\u06ff\u0900-\u0dff\u1e00-\u1eff\u3000-\u9fff\uac00-\ud7af]/;
const ALLOWED_ENGLISH_LOANWORDS_RE = /\b(?:résumé|naïve|café|cliché|déjà|fiancé|über|façade|protégé)\b/i;
const BRAND_ONLY_RE =
  /^(?:Antigravity|Google|GitHub|GitLab|Bitbucket|Chrome|Chromium|Safari|Firefox|Edge|macOS|Windows|Linux|Ubuntu|Debian|WSL|Docker|Kubernetes|Node\.js|Python|TypeScript|JavaScript|HTML|CSS|JSON|YAML|TOML|XML|SQL|SVG|PDF|CSV|PNG|JPEG|WebP|GIF|UTF-8|ASCII|HTTP|HTTPS|SSH|TLS|SSL|TCP|UDP|DNS|IP|OAuth|JWT|UUID|SHA-256|MD5|Base64|Regex|URL|URI|API|SDK|DOM|CDP|RPC|gRPC|REST|GraphQL|WebSocket|WebRTC|VS Code|Visual Studio Code|Cursor|Windsurf|Claude|Gemini|GPT|OpenAI|Anthropic|DeepMind|Figma|Canva|Jira|Confluence|Slack|Linear|Notion|Netlify|Cloudflare|Databricks|Looker|Auth0|Bigin|ClickUp|n8n)$/i;

const VENDOR_REGION_MARKERS = [
  'file_third_party_',
  'Noto‘g‘ri kirish',
  'Giren tanınamadı',
  'Angka tidak valid',
  'Add Unnecessary Bendpoints',
  'Access to the polyominoes',
  'Activity bar background color',
  'KaTeX parse error',
  'A ListItemNode must have a ListNode',
  'Represents a collate operation',
];

/**
 * Extracts embedded `main.js` (and related web bundles) from `language_server.exe` ZIP payload (read-only).
 */
export function extractEmbeddedWebJsFromLsBinary(lsExePath) {
  const buf = readFileSync(lsExePath);
  const pk = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const results = [];
  let pos = 0;

  while ((pos = buf.indexOf(pk, pos)) !== -1) {
    if (pos + 30 < buf.length) {
      const nameLen = buf.readUInt16LE(pos + 26);
      const extraLen = buf.readUInt16LE(pos + 28);
      const compSize = buf.readUInt32LE(pos + 18);
      const uncompSize = buf.readUInt32LE(pos + 22);
      const method = buf.readUInt16LE(pos + 8);
      if (nameLen > 0 && nameLen < 200 && (method === 0 || method === 8)) {
        const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
        if (
          (name === 'main.js' && uncompSize > 500_000) ||
          name === 'index.html' ||
          name === 'page_agent_bundle.js' ||
          name === 'page_facade_bundle.js'
        ) {
          const dataStart = pos + 30 + nameLen + extraLen;
          const slice = buf.subarray(dataStart, dataStart + compSize);
          const content =
            method === 8 ? inflateRawSync(slice).toString('utf8') : slice.toString('utf8');
          results.push({ name: `ls:${name}`, content });
        }
      }
    }
    pos += 4;
  }
  return results;
}

function stripJsoncCommentsAndTrailingCommas(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extracts server-driven UI copy embedded as JSON/JSONC feature-flag configs inside `language_server.exe`
 * (e.g. `project-4k-mode-copy`, `agy-onboarding-personas`, `agy-featured-plugins`, `third-party-tools-disclaimer-text`).
 */
export function extractEmbeddedJsonUiStringsFromLsBinary(lsExePath) {
  const buf = readFileSync(lsExePath);
  const exactMap = new Map();
  const templateMap = new Map();

  const anchors = ['"project-4k-mode-copy"', '"agy-onboarding-personas"', '"agy-featured-plugins"'];
  const parsedStarts = new Set();
  const EMBEDDED_UI_KEYS = new Set([
    'title', 'displayName', 'description', 'label', 'subtitle', 'heading',
    'default', 'marketplace', 'badge', 'tagTitle', 'tagDescription',
    'message', 'text', 'cta', 'placeholder',
  ]);

  const walkJsonVal = (val, key = '', depth = 0) => {
    if (depth > 10 || val == null) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          walkJsonVal(JSON.parse(trimmed), key, depth + 1);
          return;
        } catch {
          // Fall through as plain string
        }
      }
      if (!EMBEDDED_UI_KEYS.has(key)) return;
      if (/\{[a-zA-Z0-9_]+\}/.test(trimmed)) {
        // Split placeholder templates like `...found here: {privacyPolicyLink}` into exact text segments
        // and also an anchored regex template so both full-text and link-split React TextNodes are covered.
        const parts = trimmed.split(/\{[a-zA-Z0-9_]+\}/g);
        const placeholders = trimmed.match(/\{[a-zA-Z0-9_]+\}/g) || [];
        for (const seg of parts) {
          const cleanSeg = seg.trim();
          if (cleanSeg.length >= 6 && isPlausibleUiString(cleanSeg, { strongContext: true })) {
            exactMap.set(cleanSeg, (exactMap.get(cleanSeg) || 0) + 1);
          }
        }
        if (placeholders.length >= 1 && placeholders.length <= 3) {
          const cand = buildTemplateCandidate({ quasis: parts, exprs: placeholders });
          if (cand && !templateMap.has(cand.key)) templateMap.set(cand.key, cand);
        }
        return;
      }
      if (isPlausibleUiString(trimmed, { strongContext: true })) {
        exactMap.set(trimmed, (exactMap.get(trimmed) || 0) + 1);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) walkJsonVal(item, key, depth + 1);
      return;
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walkJsonVal(v, k, depth + 1);
    }
  };

  for (const anchor of anchors) {
    const anchorPos = buf.indexOf(anchor);
    if (anchorPos < 0) continue;
    const start = buf.lastIndexOf(Buffer.from('{\n  "base":'), anchorPos);
    if (start < 0 || parsedStarts.has(start)) continue;
    parsedStarts.add(start);

    const slice = buf.subarray(start, Math.min(buf.length, start + 500_000)).toString('utf8');
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = 0; i < slice.length; i += 1) {
      const ch = slice[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end <= 0) continue;
    try {
      const parsed = JSON.parse(stripJsoncCommentsAndTrailingCommas(slice.slice(0, end)));
      walkJsonVal(parsed);
    } catch {
      // Ignore malformed embedded JSON slice
    }
  }

  return {
    sourceName: 'ls:embedded-flags-json',
    createElementCount: 0,
    jsxChildrenCount: 0,
    exact: exactMap,
    templates: templateMap,
  };
}

function unescapeJsString(raw) {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n') { out += '\n'; i += 1; }
    else if (next === 'r') { out += '\r'; i += 1; }
    else if (next === 't') { out += '\t'; i += 1; }
    else if (next === '\\') { out += '\\'; i += 1; }
    else if (next === '"') { out += '"'; i += 1; }
    else if (next === "'") { out += "'"; i += 1; }
    else if (next === '`') { out += '`'; i += 1; }
    else if (next === '0') { out += '\0'; i += 1; }
    else if (next === 'x' && i + 3 < raw.length) {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
      } else {
        out += next;
        i += 1;
      }
    } else if (next === 'u') {
      if (raw[i + 2] === '{') {
        const close = raw.indexOf('}', i + 3);
        if (close > i + 3) {
          const cp = parseInt(raw.slice(i + 3, close), 16);
          if (Number.isFinite(cp) && cp <= 0x10ffff) {
            out += String.fromCodePoint(cp);
            i = close;
            continue;
          }
        }
      } else if (i + 5 < raw.length) {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
      }
      out += next;
      i += 1;
    } else if (next === '\n') {
      i += 1;
    } else if (next === '\r' && raw[i + 2] === '\n') {
      i += 2;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function isIdentStartCode(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

function isIdentPartCode(code) {
  return isIdentStartCode(code) || (code >= 48 && code <= 57);
}

/**
 * Single-pass JS lexer supporting regex literals inside both main code and `${...}` template expressions.
 */
export function tokenizeJs(src) {
  const tokens = [];
  const len = src.length;
  let i = 0;
  let canStartRegex = true;
  const parenRegexStack = [];
  let pendingRegexParenKw = '';

  function scanTemplate(startPos) {
    let idx = startPos + 1;
    const quasis = [];
    const exprs = [];
    let chunkStart = idx;

    while (idx < len) {
      const ch = src[idx];
      if (ch === '\\') {
        idx += 2;
        continue;
      }
      if (ch === '`') {
        quasis.push(unescapeJsString(src.slice(chunkStart, idx)));
        return {
          token: { type: 'template', quasis, exprs, pos: startPos },
          nextIdx: idx + 1,
        };
      }
      if (ch === '$' && src[idx + 1] === '{') {
        quasis.push(unescapeJsString(src.slice(chunkStart, idx)));
        idx += 2;
        const exprStart = idx;
        let depth = 1;
        let exprCanRegex = true;
        while (idx < len && depth > 0) {
          const ec = src[idx];
          if (ec === ' ' || ec === '\t' || ec === '\r' || ec === '\n') {
            idx += 1;
            continue;
          }
          if (ec === '"' || ec === "'") {
            const q = ec;
            idx += 1;
            while (idx < len) {
              if (src[idx] === '\\') { idx += 2; continue; }
              if (src[idx] === q) { idx += 1; break; }
              idx += 1;
            }
            exprCanRegex = false;
            continue;
          }
          if (ec === '`') {
            const nested = scanTemplate(idx);
            idx = nested.nextIdx;
            exprCanRegex = false;
            continue;
          }
          if (ec === '/' && src[idx + 1] === '*') {
            idx += 2;
            while (idx < len && !(src[idx] === '*' && src[idx + 1] === '/')) idx += 1;
            idx = Math.min(len, idx + 2);
            continue;
          }
          if (ec === '/' && src[idx + 1] === '/' && !exprCanRegex) {
            idx += 2;
            while (idx < len && src[idx] !== '\n') idx += 1;
            continue;
          }
          if (ec === '/' && exprCanRegex) {
            if (src[idx + 1] === '/') {
              idx += 2;
              while (idx < len && src[idx] !== '\n') idx += 1;
              continue;
            }
            let reEnd = idx + 1;
            let inCls = false;
            while (reEnd < len) {
              const rc = src[reEnd];
              if (rc === '\\') { reEnd += 2; continue; }
              if (rc === '[') inCls = true;
              else if (rc === ']') inCls = false;
              else if (rc === '/' && !inCls) {
                reEnd += 1;
                while (reEnd < len && /[a-z]/i.test(src[reEnd])) reEnd += 1;
                break;
              } else if (rc === '\n') {
                break;
              }
              reEnd += 1;
            }
            idx = reEnd;
            exprCanRegex = false;
            continue;
          }
          if (ec === '{') { depth += 1; exprCanRegex = true; idx += 1; continue; }
          if (ec === '}') {
            depth -= 1;
            if (depth > 0) { exprCanRegex = true; idx += 1; }
            continue;
          }
          if (isIdentStartCode(src.charCodeAt(idx))) {
            let wEnd = idx + 1;
            while (wEnd < len && isIdentPartCode(src.charCodeAt(wEnd))) wEnd += 1;
            const w = src.slice(idx, wEnd);
            exprCanRegex = REGEX_PRECEDING_KEYWORDS.has(w);
            idx = wEnd;
            continue;
          }
          if (ec >= '0' && ec <= '9') {
            while (idx < len && /[\w.]/.test(src[idx])) idx += 1;
            exprCanRegex = false;
            continue;
          }
          exprCanRegex = !(ec === ')' || ec === ']' || ec === '.');
          idx += 1;
        }
        exprs.push(src.slice(exprStart, idx));
        if (idx < len && src[idx] === '}') idx += 1;
        chunkStart = idx;
        continue;
      }
      idx += 1;
    }
    quasis.push(unescapeJsString(src.slice(chunkStart)));
    return {
      token: { type: 'template', quasis, exprs, pos: startPos },
      nextIdx: len,
    };
  }

  while (i < len) {
    const code = src.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff) {
      i += 1;
      continue;
    }
    if (code === 47) {
      const nextCode = src.charCodeAt(i + 1);
      if (nextCode === 47) {
        i += 2;
        while (i < len && src.charCodeAt(i) !== 10) i += 1;
        continue;
      }
      if (nextCode === 42) {
        i += 2;
        while (i < len && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i += 1;
        i = Math.min(len, i + 2);
        continue;
      }
      if (canStartRegex) {
        let end = i + 1;
        let inClass = false;
        while (end < len) {
          const rc = src[end];
          if (rc === '\\') { end += 2; continue; }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            end += 1;
            while (end < len && /[a-z]/i.test(src[end])) end += 1;
            break;
          } else if (rc === '\n') break;
          end += 1;
        }
        tokens.push({ type: 'regex', value: src.slice(i, end), pos: i });
        canStartRegex = false;
        pendingRegexParenKw = '';
        i = end;
        continue;
      }
    }

    if (code === 34 || code === 39) {
      const quote = src[i];
      let end = i + 1;
      while (end < len) {
        const sc = src[end];
        if (sc === '\\') { end += 2; continue; }
        if (sc === quote) break;
        end += 1;
      }
      const rawBody = src.slice(i + 1, end);
      tokens.push({ type: 'string', value: unescapeJsString(rawBody), pos: i });
      canStartRegex = false;
      pendingRegexParenKw = '';
      i = Math.min(len, end + 1);
      continue;
    }

    if (code === 96) {
      const res = scanTemplate(i);
      tokens.push(res.token);
      canStartRegex = false;
      pendingRegexParenKw = '';
      i = res.nextIdx;
      continue;
    }

    if (
      (code >= 48 && code <= 57) ||
      (code === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)
    ) {
      let end = i + 1;
      while (end < len && /[\da-fA-FxXoObBn._eE]/.test(src[end])) {
        if ((src[end] === 'e' || src[end] === 'E') && (src[end + 1] === '+' || src[end + 1] === '-')) {
          end += 2;
        } else {
          end += 1;
        }
      }
      tokens.push({ type: 'number', value: src.slice(i, end), pos: i });
      canStartRegex = false;
      pendingRegexParenKw = '';
      i = end;
      continue;
    }

    if (isIdentStartCode(code)) {
      let end = i + 1;
      while (end < len && isIdentPartCode(src.charCodeAt(end))) end += 1;
      const word = src.slice(i, end);
      const prev = tokens[tokens.length - 1];
      const afterDot = prev && prev.type === 'punct' && prev.value === '.';
      tokens.push({ type: 'ident', value: word, pos: i });
      if (!afterDot && (word === 'if' || word === 'while' || word === 'for' || word === 'with')) {
        pendingRegexParenKw = word;
      } else {
        pendingRegexParenKw = '';
      }
      canStartRegex = !afterDot && REGEX_PRECEDING_KEYWORDS.has(word);
      i = end;
      continue;
    }

    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==' || three === '>>>' || three === '...') {
      tokens.push({ type: 'punct', value: three, pos: i });
      canStartRegex = true;
      pendingRegexParenKw = '';
      i += 3;
      continue;
    }
    if (
      two === '&&' || two === '||' || two === '??' || two === '=>' ||
      two === '==' || two === '!=' || two === '<=' || two === '>=' ||
      two === '++' || two === '--' || two === '?.' || two === '+=' ||
      two === '-=' || two === '*=' || two === '/='
    ) {
      tokens.push({ type: 'punct', value: two, pos: i });
      canStartRegex = two !== '++' && two !== '--' && two !== '?.';
      pendingRegexParenKw = '';
      i += 2;
      continue;
    }

    const ch = src[i];
    tokens.push({ type: 'punct', value: ch, pos: i });
    if (ch === '(') {
      parenRegexStack.push(Boolean(pendingRegexParenKw));
      pendingRegexParenKw = '';
      canStartRegex = true;
    } else if (ch === ')') {
      canStartRegex = parenRegexStack.pop() ?? false;
      pendingRegexParenKw = '';
    } else if (ch === ']') {
      canStartRegex = false;
      pendingRegexParenKw = '';
    } else if (ch === '}') {
      canStartRegex = true;
      pendingRegexParenKw = '';
    } else if (ch === '.') {
      canStartRegex = false;
      pendingRegexParenKw = '';
    } else {
      canStartRegex = true;
      pendingRegexParenKw = '';
    }
    i += 1;
  }

  return tokens;
}

/**
 * Computes tight byte intervals belonging purely to embedded third-party vendor libraries
 * (ELKjs, Zod non-English locales, VS Code theme color metadata, KaTeX, Protobuf descriptors, Lexical).
 *
 * Uses surgical 4 KB windows with zero padding and NEVER excludes any window that contains
 * Antigravity React JSX calls (`.createElement(` or `children:`), preventing vendor code
 * adjacent to real UI settings components (e.g. KaTeX right after Appearance settings) from
 * ever wiping out real UI strings.
 */
function buildVendorExclusionIntervals(jsSource) {
  const chunkSize = 4_000;
  const excluded = [];
  for (let off = 0; off < jsSource.length; off += chunkSize) {
    const slice = jsSource.slice(off, off + chunkSize);
    if (slice.includes('.createElement(') || /\bchildren\s*:/.test(slice)) {
      continue;
    }
    let isVendor = false;
    for (const marker of VENDOR_REGION_MARKERS) {
      if (slice.includes(marker)) {
        isVendor = true;
        break;
      }
    }
    if (!isVendor) {
      // Detect Zod multi-locale bundle chunks (many non-ASCII diacritic error strings)
      const zodLocales =
        (slice.match(/expected:"|too_small|too_big|invalid_type/g) || []).length >= 5 &&
        (slice.match(NON_ENGLISH_SCRIPT_RE) || []).length > 0;
      if (zodLocales) isVendor = true;
    }
    if (!isVendor) {
      // Detect dense VS Code theme color description tables without JSX
      const themeDescHits =
        (slice.match(/(?:background|foreground|border)\s+color/gi) || []).length >= 6;
      if (themeDescHits) isVendor = true;
    }
    if (isVendor) {
      const start = off;
      const end = Math.min(jsSource.length, off + chunkSize);
      if (excluded.length > 0 && start <= excluded[excluded.length - 1][1]) {
        excluded[excluded.length - 1][1] = Math.max(excluded[excluded.length - 1][1], end);
      } else {
        excluded.push([start, end]);
      }
    }
  }
  return excluded;
}

function isPosInIntervals(pos, intervals) {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [s, e] = intervals[mid];
    if (pos < s) hi = mid - 1;
    else if (pos > e) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Strict filter separating real English Antigravity UI strings from vendor/code/CSS noise.
 */
export function isPlausibleUiString(raw, { strongContext = false } = {}) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length < 2 || s.length > 600) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]/.test(s)) return false;
  if (NON_ENGLISH_SCRIPT_RE.test(s) && !ALLOWED_ENGLISH_LOANWORDS_RE.test(s)) return false;
  if (PURE_SYMBOL_OR_NUM_RE.test(s)) return false;
  if (URL_OR_PATH_RE.test(s)) return false;
  if (MIME_OR_HEADER_RE.test(s)) return false;
  if (CSS_VALUE_RE.test(s)) return false;
  if (SVG_PATH_RE.test(s)) return false;
  if (PROTO_OR_CODE_RE.test(s)) return false;
  if (PURE_SHORTCUT_RE.test(s)) return false;
  if (DEBUG_LOG_PREFIX_RE.test(s)) return false;
  if (BRAND_ONLY_RE.test(s)) return false;
  if (VENDOR_SKIP_RE.test(s)) return false;
  if (VSCODE_THEME_DESC_RE.test(s)) return false;
  if (ELK_GRAPH_DESC_RE.test(s)) return false;

  // Reject all-uppercase keyword/tag lists like "ARTICLE SECTION NAV ... P HR ..."
  if (/^(?:[A-Z0-9_-]{1,}\s+){4,}[A-Z0-9_-]{1,}$/.test(s)) return false;

  // Reject HTML entity / JSX / code / JSON / CEL expression fragments
  if (s.includes('\n')) {
    if (s.split('\n').length > 4) return false;
    if (/[{};]|<\/?[a-z]+/i.test(s)) return false;
  }
  if (/<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)) return false;
  if (/^\s*\{.*\}\s*$/.test(s) || /^\s*\[.*\]\s*$/.test(s)) return false;
  if (/[{}<>]{2,}|=>|===|!==|\bfunction\s*\(|\bconst\s+\w+\s*=|&lt;|&gt;/.test(s)) return false;
  if (/^!?(?:is_|has_|can_|should_|get_|set_)[a-z0-9_]+\(/i.test(s)) return false;
  if (/^["']\s+[a-z]/.test(s)) return false;

  const words = s.split(/\s+/);
  if (words.length >= 2) {
    let twCount = 0;
    for (const w of words) {
      if (TAILWIND_TOKEN_RE.test(w)) twCount += 1;
    }
    if (twCount === words.length || (words.length >= 3 && twCount / words.length >= 0.7)) {
      return false;
    }
  } else {
    if (TAILWIND_TOKEN_RE.test(s) && /[-:[\]/!]/.test(s)) return false;
    if (IDENTIFIER_CASE_RE.test(s)) return false;
    if (/^[a-z]+$/.test(s)) {
      if (!strongContext) return false;
      if (s.length < 2 || s.length > 22) return false;
      if (
        /^(?:div|span|button|input|textarea|select|option|label|form|table|thead|tbody|tr|td|th|ul|ol|li|nav|main|aside|section|article|header|footer|img|svg|path|canvas|iframe|code|pre|strong|em|small|sub|sup|br|hr|dialog|menu|menuitem|listbox|combobox|tablist|tab|tabpanel|checkbox|radio|switch|slider|progressbar|alert|status|tooltip|presentation|none|auto|inherit|initial|unset|block|inline|flex|grid|hidden|visible|scroll|clip|normal|bold|italic|left|right|center|top|bottom|start|end|baseline|stretch|wrap|nowrap|row|column|relative|absolute|fixed|sticky|static|pointer|default|text|move|grab|grabbing|wait|help|crosshair|not-allowed|true|false|null|undefined|string|number|boolean|object|array|function|symbol|bigint|submit|reset|password|email|tel|url|date|time|file|range|color|primary|secondary|tertiary|ghost|outline|destructive|danger|warning|success|info|muted|accent|neutral|subtle|solid|soft|plain|minimal|compact|comfortable|dense|sm|md|lg|xl|xs|2xl|horizontal|vertical|both|ltr|rtl|eager|lazy|sync|async|utf8|hex|base64|binary|blob|json|yaml|toml|markdown|plaintext|light|dark|system|click|change|focus|blur|keydown|keyup|mousedown|mouseup|mousemove|wheel|resize|load|error|abort|open|close|message|ping|pong|start|end|data|item|items|value|values|index|key|keys|name|type|kind|mode|state|status|id|uid|uuid|ref|src|href|alt|rel|target|method|body|headers|query|params|path|host|port|origin|token|msg|err|ok|yes|no|on|off|all|any|one|two|new|old|raw|min|max|avg|sum|len|cnt|num|str|obj|arr|buf|ctx|env|cfg|opt|opts|arg|args|fn|cb|el|dom|api|cli|ide|app|web|uri|dir|doc|tmp|log|logs|dev|prod|test|spec|mock|stub|or|and|in|of|to|by|at|as|is|be|if|it|an|no|so|up|us|we|my|do|go|he|me)$/.test(
          s
        )
      ) {
        return false;
      }
    }
  }

  if (words.length === 1 && /^[a-z0-9_]+(?:[.:/][a-z0-9_-]+)+$/i.test(s)) {
    return false;
  }

  return true;
}

/**
 * Converts a JS template literal (`quasis`, `exprs`) into a safe anchored RegExp template.
 * Intelligently collapses English plural ternaries `${n===1?"":"s"}` into optional `s?`.
 */
function buildTemplateCandidate(tpl) {
  if (!tpl || !Array.isArray(tpl.quasis) || tpl.quasis.length < 2) return null;
  if (tpl.exprs.length > 3) return null;
  const staticCombined = tpl.quasis.join(' ').trim();
  if (!/[A-Za-z]{2,}/.test(staticCombined)) return null;
  if (staticCombined.length > 260) return null;
  if (staticCombined.includes('\n')) return null;
  if (NON_ENGLISH_SCRIPT_RE.test(staticCombined)) return null;
  if (VSCODE_THEME_DESC_RE.test(staticCombined) || ELK_GRAPH_DESC_RE.test(staticCombined)) return null;

  if (
    /^(?:https?:\/\/|ws:\/\/|wss:\/\/|\/|#|rgba?\(|hsla?\(|calc\(|var\(|translate|rotate|scale|CRON_TZ=|&lt;|!?(?:is_|has_)|ERR_|Malformed Worker RPC|fulfill is |(?:Key|Digit)$|(?:Subagent|Artifact|File|GoogleSymbol|Header)(?:Tab)?(?:Icon|Component)\(|(?:Array|Uint8Array)\(|(?:in_mdb|matches_principal)\(|transition-\[|width \d+ms var\(|\[SidebarLoad\]|TTIR:|Resize drag start)/i.test(
      tpl.quasis[0].trim()
    ) ||
    /var\(--|cubic-bezier\(|motion-reduce:/i.test(staticCombined)
  ) {
    return null;
  }
  const allStaticWords = staticCombined.split(/\s+/).filter(Boolean);
  if (allStaticWords.length > 0 && allStaticWords.every((w) => TAILWIND_TOKEN_RE.test(w))) {
    return null;
  }
  if (/[\x00-\x1f<>{}]/.test(staticCombined)) return null;

  const alphaChars = (staticCombined.match(/[A-Za-z]/g) || []).length;
  if (alphaChars < 3) return null;

  const escRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regexParts = '^';
  let displayKey = '';
  let hint = '';
  let captureCount = 0;

  for (let i = 0; i < tpl.quasis.length; i += 1) {
    const q = tpl.quasis[i];
    const cleanQ =
      i === 0 ? q.replace(/^\s+/, '') : i === tpl.quasis.length - 1 ? q.replace(/\s+$/, '') : q;
    regexParts += escRe(cleanQ);
    displayKey += cleanQ;
    const trimmedQ = cleanQ.trim();
    if (trimmedQ.length > hint.length && /[A-Za-z]{2,}/.test(trimmedQ)) {
      hint = trimmedQ;
    }
    if (i < tpl.exprs.length) {
      const expr = String(tpl.exprs[i] || '').trim();
      // Detect plural suffix ternaries: `n===1?"":"s"`, `n!==1?"s":""`, `n>1?"s":""`
      if (/\?\s*["']{2}\s*:\s*["']s["']$|\?\s*["']s["']\s*:\s*["']{2}$/.test(expr)) {
        regexParts += 's?';
        displayKey += '(s)';
        continue;
      }
      if (/\?\s*["']es["']\s*:\s*["']{2}$|\?\s*["']{2}\s*:\s*["']es["']$/.test(expr)) {
        regexParts += '(?:es)?';
        displayKey += '(es)';
        continue;
      }
      if (/\?\s*["']y["']\s*:\s*["']ies["']$|\?\s*["']ies["']\s*:\s*["']y["']$/.test(expr)) {
        regexParts += '(?:y|ies)';
        displayKey += '(y/ies)';
        continue;
      }
      // Reject adjacent unseparated captures `${a}${b}`
      if (i > 0 && cleanQ === '' && captureCount > 0) {
        return null;
      }
      captureCount += 1;
      const looksNumeric =
        /^(?:Math\.|Number\(|parseInt\(|[a-zA-Z_$][\w$.]*(?:length|size|count|seconds|minutes|hours|days|index|step|steps|total|num|pct|percent|ms)\b)/i.test(
          expr
        );
      regexParts += looksNumeric ? '(\\d+(?:\\.\\d+)?)' : '(.+?)';
      displayKey += `{${captureCount}}`;
    }
  }
  regexParts += '$';
  if (captureCount === 0) return null;

  try {
    // eslint-disable-next-line no-new
    new RegExp(regexParts);
  } catch {
    return null;
  }

  return {
    key: displayKey.trim(),
    source: regexParts,
    flags: '',
    hint: hint.slice(0, 32),
    captureCount,
  };
}

function findMatchingClose(tokens, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === openChar) depth += 1;
      else if (t.value === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function splitTopLevelCommas(tokens, start, end) {
  const ranges = [];
  let curStart = start;
  let paren = 0, brace = 0, bracket = 0;
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(') paren += 1;
      else if (t.value === ')') paren -= 1;
      else if (t.value === '{') brace += 1;
      else if (t.value === '}') brace -= 1;
      else if (t.value === '[') bracket += 1;
      else if (t.value === ']') bracket -= 1;
      else if (t.value === ',' && paren === 0 && brace === 0 && bracket === 0) {
        ranges.push([curStart, i]);
        curStart = i + 1;
      }
    }
  }
  if (curStart < end) ranges.push([curStart, end]);
  return ranges;
}

function extractFromExprRange(tokens, start, end, outExact, outTemplates, opts) {
  while (start < end && tokens[start].type === 'punct' && tokens[start].value === '(') {
    const close = findMatchingClose(tokens, start, '(', ')');
    if (close === end - 1) {
      start += 1;
      end -= 1;
    } else {
      break;
    }
  }
  if (start >= end) return;

  if (end - start === 1) {
    const tok = tokens[start];
    if (tok.type === 'string') {
      const s = tok.value.trim();
      if (isPlausibleUiString(s, opts)) outExact.set(s, (outExact.get(s) || 0) + 1);
      return;
    }
    if (tok.type === 'template') {
      if (tok.quasis.length === 1) {
        const s = tok.quasis[0].trim();
        if (isPlausibleUiString(s, opts)) outExact.set(s, (outExact.get(s) || 0) + 1);
      } else {
        const cand = buildTemplateCandidate(tok);
        if (cand && !outTemplates.has(cand.key)) outTemplates.set(cand.key, cand);
      }
      return;
    }
    return;
  }

  let paren = 0, brace = 0, bracket = 0;
  let qIdx = -1, colonIdx = -1, qDepth = 0;
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(') paren += 1;
    else if (t.value === ')') paren -= 1;
    else if (t.value === '{') brace += 1;
    else if (t.value === '}') brace -= 1;
    else if (t.value === '[') bracket += 1;
    else if (t.value === ']') bracket -= 1;
    else if (paren === 0 && brace === 0 && bracket === 0) {
      if (t.value === '?') {
        if (qIdx < 0) qIdx = i;
        qDepth += 1;
      } else if (t.value === ':' && qDepth > 0) {
        qDepth -= 1;
        if (qDepth === 0 && colonIdx < 0) {
          colonIdx = i;
          break;
        }
      }
    }
  }
  if (qIdx >= 0 && colonIdx > qIdx) {
    extractFromExprRange(tokens, qIdx + 1, colonIdx, outExact, outTemplates, opts);
    extractFromExprRange(tokens, colonIdx + 1, end, outExact, outTemplates, opts);
    return;
  }

  paren = 0; brace = 0; bracket = 0;
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(') paren += 1;
    else if (t.value === ')') paren -= 1;
    else if (t.value === '{') brace += 1;
    else if (t.value === '}') brace -= 1;
    else if (t.value === '[') bracket += 1;
    else if (t.value === ']') bracket -= 1;
    else if (paren === 0 && brace === 0 && bracket === 0) {
      if (t.value === '&&') {
        extractFromExprRange(tokens, i + 1, end, outExact, outTemplates, opts);
        return;
      }
      if (t.value === '||' || t.value === '??') {
        extractFromExprRange(tokens, start, i, outExact, outTemplates, opts);
        extractFromExprRange(tokens, i + 1, end, outExact, outTemplates, opts);
        return;
      }
    }
  }

  if (tokens[start].type === 'punct' && tokens[start].value === '[') {
    const close = findMatchingClose(tokens, start, '[', ']');
    if (close === end - 1) {
      for (const [elStart, elEnd] of splitTopLevelCommas(tokens, start + 1, close)) {
        extractFromExprRange(tokens, elStart, elEnd, outExact, outTemplates, opts);
      }
      return;
    }
  }

  if (tokens[start].type === 'punct' && tokens[start].value === '{') {
    const close = findMatchingClose(tokens, start, '{', '}');
    if (close === end - 1) {
      extractFromObjectLiteral(tokens, start, close, UI_PROP_KEYS, outExact, outTemplates);
      return;
    }
  }

  if (
    tokens[start].type === 'ident' &&
    tokens[start + 1]?.type === 'punct' &&
    tokens[start + 1].value === '.' &&
    tokens[start + 2]?.type === 'ident' &&
    tokens[start + 2].value === 'createElement'
  ) {
    return;
  }
  if (tokens[start].type === 'ident' && NON_UI_FUNC_CALLS.has(tokens[start].value)) {
    return;
  }

  paren = 0; brace = 0; bracket = 0;
  const plusIndices = [];
  for (let i = start; i < end; i += 1) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(') paren += 1;
    else if (t.value === ')') paren -= 1;
    else if (t.value === '{') brace += 1;
    else if (t.value === '}') brace -= 1;
    else if (t.value === '[') bracket += 1;
    else if (t.value === ']') bracket -= 1;
    else if (t.value === '+' && paren === 0 && brace === 0 && bracket === 0) {
      plusIndices.push(i);
    }
  }
  if (plusIndices.length > 0 && plusIndices.length <= 4) {
    const segs = [];
    let prev = start;
    for (const pIdx of [...plusIndices, end]) {
      segs.push([prev, pIdx]);
      prev = pIdx + 1;
    }
    const quasis = [];
    const exprs = [];
    let curQuasi = '';
    for (const [s0, s1] of segs) {
      if (s1 - s0 === 1 && tokens[s0].type === 'string') {
        curQuasi += tokens[s0].value;
      } else {
        quasis.push(curQuasi);
        curQuasi = '';
        exprs.push(tokens.slice(s0, s1).map((x) => x.value).join(''));
      }
    }
    quasis.push(curQuasi);
    if (exprs.length === 0) {
      const s = quasis[0].trim();
      if (isPlausibleUiString(s, opts)) outExact.set(s, (outExact.get(s) || 0) + 1);
    } else {
      const cand = buildTemplateCandidate({ quasis, exprs });
      if (cand && !outTemplates.has(cand.key)) outTemplates.set(cand.key, cand);
    }
  }
}

function extractFromObjectLiteral(tokens, openBrace, closeBrace, allowedKeys, outExact, outTemplates) {
  for (const [propStart, propEnd] of splitTopLevelCommas(tokens, openBrace + 1, closeBrace)) {
    if (propEnd - propStart < 3) continue;
    const keyTok = tokens[propStart];
    const colonTok = tokens[propStart + 1];
    if (colonTok?.type !== 'punct' || colonTok.value !== ':') continue;
    const keyName =
      keyTok.type === 'ident' || keyTok.type === 'string' ? keyTok.value : '';
    if (!keyName || NON_UI_PROP_KEYS.has(keyName)) continue;

    if (allowedKeys.has(keyName)) {
      extractFromExprRange(tokens, propStart + 2, propEnd, outExact, outTemplates, {
        strongContext: true,
      });
    } else if (
      keyName === 'options' ||
      keyName === 'items' ||
      keyName === 'tabs' ||
      keyName === 'actions' ||
      keyName === 'columns' ||
      keyName === 'sections' ||
      keyName === 'fields' ||
      keyName === 'steps' ||
      keyName === 'buttons' ||
      keyName === 'choices' ||
      keyName === 'menuItems' ||
      keyName === 'shortcuts'
    ) {
      extractFromExprRange(tokens, propStart + 2, propEnd, outExact, outTemplates, {
        strongContext: false,
      });
    }
  }
}

/**
 * Extracts all UI exact strings and dynamic templates from a JS bundle string.
 */
export function extractUiStringsFromJsSource(jsSource, { sourceName = 'main.js' } = {}) {
  const vendorIntervals = buildVendorExclusionIntervals(jsSource);
  const tokens = tokenizeJs(jsSource);
  const exactMap = new Map();
  const templateMap = new Map();
  let createElementCount = 0;
  let jsxChildrenCount = 0;

  // Record active UI byte anchors (every `createElement` or `children:` or `data-testid`)
  const uiAnchors = [];

  // Pass 1: Classic React `<ident>.createElement(tag, props, ...children)`
  // Never masked by `vendorIntervals` — vendor libraries don't render Antigravity React UI,
  // and per-string filtering (`isPlausibleUiString`) still guards every extracted literal.
  for (let i = 0; i < tokens.length - 4; i += 1) {
    if (
      tokens[i].type === 'ident' &&
      !DOM_CREATE_ELEMENT_RECEIVERS.has(tokens[i].value) &&
      tokens[i + 1].type === 'punct' &&
      tokens[i + 1].value === '.' &&
      tokens[i + 2].type === 'ident' &&
      tokens[i + 2].value === 'createElement' &&
      tokens[i + 3].type === 'punct' &&
      tokens[i + 3].value === '('
    ) {
      const closeParen = findMatchingClose(tokens, i + 3, '(', ')');
      if (closeParen < 0) continue;
      createElementCount += 1;
      uiAnchors.push(tokens[i].pos);

      const args = splitTopLevelCommas(tokens, i + 4, closeParen);
      if (args.length === 0) continue;

      const [tagStart, tagEnd] = args[0];
      if (tagEnd - tagStart === 1 && tokens[tagStart].type === 'string') {
        const tagName = tokens[tagStart].value;
        if (SKIP_CREATE_ELEMENT_TAGS.has(tagName) || tagName.startsWith('fe')) {
          continue;
        }
      }

      if (args.length >= 2) {
        const [pStart, pEnd] = args[1];
        if (tokens[pStart]?.type === 'punct' && tokens[pStart].value === '{') {
          const pClose = findMatchingClose(tokens, pStart, '{', '}');
          if (pClose > pStart && pClose < pEnd) {
            extractFromObjectLiteral(tokens, pStart, pClose, UI_PROP_KEYS, exactMap, templateMap);
          }
        }
      }

      for (let a = 2; a < args.length; a += 1) {
        const [cStart, cEnd] = args[a];
        extractFromExprRange(tokens, cStart, cEnd, exactMap, templateMap, {
          strongContext: true,
        });
      }
    }
  }

  // Pass 2: JSX automatic runtime `{ ..., children: ... }` + UI config objects
  for (let i = 0; i < tokens.length - 3; i += 1) {
    if (isPosInIntervals(tokens[i].pos, vendorIntervals)) continue;
    const tok = tokens[i];
    if (tok.type === 'ident' && tok.value === 'children' && tokens[i + 1]?.value === ':') {
      jsxChildrenCount += 1;
      uiAnchors.push(tok.pos);
    }
    if (tok.type === 'punct' && tok.value === '{') {
      const closeBrace = findMatchingClose(tokens, i, '{', '}');
      if (closeBrace > i && closeBrace - i < 800) {
        extractFromObjectLiteral(
          tokens,
          i,
          closeBrace,
          STRONG_OBJECT_UI_KEYS,
          exactMap,
          templateMap
        );
      }
    }
  }

  // Merge UI anchor windows (±25 KB around any React JSX call, outside vendor intervals)
  uiAnchors.sort((a, b) => a - b);
  const uiZones = [];
  for (const pos of uiAnchors) {
    const s = Math.max(0, pos - 25_000);
    const e = Math.min(jsSource.length, pos + 25_000);
    if (uiZones.length > 0 && s <= uiZones[uiZones.length - 1][1]) {
      uiZones[uiZones.length - 1][1] = Math.max(uiZones[uiZones.length - 1][1], e);
    } else {
      uiZones.push([s, e]);
    }
  }

  // Pass 3: High-recall sweep inside Antigravity's own UI zones (captures variables, ternaries,
  // switch returns, lookup maps, and toast/dialog strings not directly inlined in JSX props).
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.type !== 'string' && tok.type !== 'template') continue;
    if (isPosInIntervals(tok.pos, vendorIntervals)) continue;
    if (!isPosInIntervals(tok.pos, uiZones)) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    // Skip object property keys (`{ "foo": ... }` or `, "foo": ...`),
    // while PRESERVING ternary true branches (`cond ? "Foo" : "Bar"`)!
    if (
      next?.type === 'punct' &&
      next.value === ':' &&
      prev?.type === 'punct' &&
      (prev.value === '{' || prev.value === ',')
    ) {
      continue;
    }
    // Skip comparisons & switch cases (`=== "foo"`, `case "foo":`)
    if (
      prev?.value === '===' || prev?.value === '!==' || prev?.value === '==' || prev?.value === '!=' ||
      prev?.value === 'case' ||
      next?.value === '===' || next?.value === '!==' || next?.value === '==' || next?.value === '!='
    ) {
      continue;
    }
    // Skip non-UI prop values (`className: "..."`, `"data-testid": "..."`)
    if (prev?.type === 'punct' && prev.value === ':') {
      const propKey = tokens[i - 2];
      if (propKey && NON_UI_PROP_KEYS.has(propKey.value)) continue;
    }
    // Skip direct arguments to `new Error(...)`, `console.log(...)`, `jj(...)`, etc.
    if (prev?.type === 'punct' && prev.value === '(') {
      const callee = tokens[i - 2];
      if (callee && NON_UI_FUNC_CALLS.has(callee.value)) continue;
    }
    // Skip property bracket indexing `obj["foo"]`
    if (prev?.type === 'punct' && prev.value === '[' && next?.type === 'punct' && next.value === ']') {
      continue;
    }

    if (tok.type === 'string') {
      const s = tok.value.trim();
      const isMultiWordUi =
        /^(?:[A-Z]|\d+\s+[A-Za-z])/.test(s) &&
        (s.includes(' ') || /[.!?…]$/.test(s)) &&
        isPlausibleUiString(s, { strongContext: false });
      // Also capture single Title-Case UI option/button labels returned from switch/ternary/helpers
      // (e.g. `case 2: return "Strong"; default: return "Queue"`).
      const isSingleWordUiReturn =
        /^[A-Z][a-z]{2,20}$/.test(s) &&
        !NON_UI_SINGLE_TITLE_WORDS.has(s) &&
        (prev?.value === 'return' ||
          prev?.value === '?' ||
          prev?.value === ':' ||
          prev?.value === '||' ||
          prev?.value === '??') &&
        !(prev?.value === ':' && tokens[i - 2] && NON_UI_PROP_KEYS.has(tokens[i - 2].value)) &&
        isPlausibleUiString(s, { strongContext: true });
      if (isMultiWordUi || isSingleWordUiReturn) {
        exactMap.set(s, (exactMap.get(s) || 0) + 1);
      }
    } else if (tok.type === 'template' && tok.quasis.length > 1) {
      const cand = buildTemplateCandidate(tok);
      if (cand && /^[A-Z]|\{1\}\s+[a-zA-Z]/.test(cand.key) && !templateMap.has(cand.key)) {
        templateMap.set(cand.key, cand);
      }
    }
  }

  return {
    sourceName,
    createElementCount,
    jsxChildrenCount,
    exact: exactMap,
    templates: templateMap,
  };
}

export function discoverLocalAntigravitySources() {
  const lsCandidates = [];
  const jsCandidates = [];
  const home = homedir();

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    lsCandidates.push(
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
      join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')
    );
    jsCandidates.push(
      join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'out', 'jetskiAgent', 'main.js')
    );
  } else if (process.platform === 'darwin') {
    lsCandidates.push(
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server')
    );
    jsCandidates.push(
      '/Applications/Antigravity IDE.app/Contents/Resources/app/out/jetskiAgent/main.js'
    );
  } else {
    lsCandidates.push(
      '/opt/Antigravity/resources/bin/language_server',
      '/usr/share/antigravity/resources/bin/language_server'
    );
  }

  const dedupeExisting = (list) => {
    const seen = new Set();
    const out = [];
    for (const p of list) {
      if (!existsSync(p)) continue;
      const key = process.platform === 'win32' ? p.toLowerCase() : p;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  };

  return {
    lsBinaries: dedupeExisting(lsCandidates),
    jsFiles: dedupeExisting(jsCandidates),
  };
}

function parseCliArgs(argv) {
  const opts = { auto: false, lsPaths: [], jsPaths: [], outPath: DEFAULT_CATALOG_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--auto') opts.auto = true;
    else if (arg === '--ls' && argv[i + 1]) opts.lsPaths.push(resolve(argv[++i]));
    else if (arg === '--js' && argv[i + 1]) opts.jsPaths.push(resolve(argv[++i]));
    else if (arg === '--out' && argv[i + 1]) opts.outPath = resolve(argv[++i]);
  }
  return opts;
}

export function runHostStringExtraction({ lsPaths = [], jsPaths = [], outPath = '' } = {}) {
  const mergedExact = new Map();
  const mergedTemplates = new Map();
  const sourcesSummary = [];

  const absorb = (res) => {
    sourcesSummary.push({
      source: res.sourceName,
      createElementCount: res.createElementCount,
      jsxChildrenCount: res.jsxChildrenCount,
      exactCount: res.exact.size,
      templateCount: res.templates.size,
    });
    for (const [k, count] of res.exact.entries()) {
      mergedExact.set(k, (mergedExact.get(k) || 0) + count);
    }
    for (const [k, tpl] of res.templates.entries()) {
      if (!mergedTemplates.has(k)) mergedTemplates.set(k, tpl);
    }
  };

  for (const lsPath of lsPaths) {
    const embedded = extractEmbeddedWebJsFromLsBinary(lsPath);
    for (const item of embedded) {
      if (item.name.endsWith('.js')) {
        absorb(extractUiStringsFromJsSource(item.content, { sourceName: item.name }));
      }
    }
    const embeddedJson = extractEmbeddedJsonUiStringsFromLsBinary(lsPath);
    if (embeddedJson.exact.size > 0 || embeddedJson.templates.size > 0) {
      absorb(embeddedJson);
    }
  }

  for (const jsPath of jsPaths) {
    const raw = readFileSync(jsPath, 'utf8');
    const normPath = String(jsPath || '').replace(/\\/g, '/');
    const outMatch = normPath.match(/\/out\/(.+)$/i);
    const label = outMatch ? `ide:${outMatch[1]}` : `js:${basename(normPath)}`;
    absorb(extractUiStringsFromJsSource(raw, { sourceName: label }));
  }

  const exactList = Array.from(mergedExact.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const templateList = Array.from(mergedTemplates.values()).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b ? 1 : 0
  );

  const catalog = {
    schemaVersion: 1,
    extractedAt: new Date().toISOString(),
    sources: sourcesSummary,
    counts: {
      exact: exactList.length,
      templates: templateList.length,
    },
    exact: exactList,
    templates: templateList,
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  }

  return catalog;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.auto || (cli.lsPaths.length === 0 && cli.jsPaths.length === 0)) {
    const discovered = discoverLocalAntigravitySources();
    cli.lsPaths.push(...discovered.lsBinaries);
    cli.jsPaths.push(...discovered.jsFiles);
  }
  if (cli.lsPaths.length === 0 && cli.jsPaths.length === 0) {
    console.error('[extract-host-strings] No Antigravity frontend assets found. Pass --ls or --js.');
    process.exit(1);
  }
  const catalog = runHostStringExtraction(cli);
  console.log(
    `[extract-host-strings] Extracted ${catalog.counts.exact} exact UI strings + ${catalog.counts.templates} dynamic templates from ${catalog.sources.length} bundle(s) -> ${cli.outPath}`
  );
  for (const s of catalog.sources) {
    console.log(
      `  - ${s.source}: createElement=${s.createElementCount}, jsxChildren=${s.jsxChildrenCount}, exact=${s.exactCount}, templates=${s.templateCount}`
    );
  }
}
