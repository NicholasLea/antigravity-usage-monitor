/**
 * @fileoverview Shared `file://` workspace URI decoding, encoding, and SQLite column parsing helpers.
 */

/**
 * Parses a SQLite `workspace_uris` column value (either a JSON string array or a single URI string).
 *
 * @param {unknown} rawVal
 * @returns {string[]}
 */
export function parseWorkspaceUrisColumn(rawVal) {
  const str = String(rawVal || '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch {
      // Fall back to single URI string
    }
  }
  return [str];
}

/**
 * Decodes a `file://` URI or raw filesystem path into a clean slash-normalized path string.
 * Strips the leading slash before Windows drive letters (`/F:/...` -> `F:/...`) while keeping POSIX leading `/`.
 *
 * @param {unknown} rawUri
 * @returns {string}
 */
export function decodeWorkspaceFileUriToPath(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) return '';
  let decoded = raw;
  if (/^file:\/\//i.test(decoded)) {
    decoded = decoded.replace(/^file:\/\//i, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      decoded = decoded.replace(/%3A/gi, ':');
    }
    if (/^\/[A-Za-z]:/.test(decoded)) {
      decoded = decoded.slice(1);
    }
  } else {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep original text when percent sequences are literal path chars
    }
  }
  return decoded.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Normalizes a workspace URI or local path for cross-platform equality comparison.
 *
 * @param {unknown} rawPath
 * @param {string} [platform=process.platform]
 * @returns {string}
 */
export function normalizePathForWorkspaceMatch(rawPath, platform = process.platform) {
  const clean = decodeWorkspaceFileUriToPath(rawPath).replace(/^\/+(?=[A-Za-z]:)/, '');
  return platform === 'win32' ? clean.toLowerCase() : clean;
}

/**
 * Converts a `file://` URI or local path into a clean unencoded `file://` URI (`ag-cli` style).
 *
 * @param {unknown} rawInput
 * @returns {string}
 */
export function toRawWorkspaceFileUri(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    let body = raw.replace(/^file:\/\/\/?/i, '');
    try {
      body = decodeURIComponent(body);
    } catch {
      body = body.replace(/%3A/gi, ':');
    }
    body = body.replace(/\\/g, '/').replace(/^\/+/, '');
    return `file:///${body}`;
  }
  const normalized = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

/**
 * Converts a `file://` URI or local path into Antigravity Desktop encoded URI form
 * (lowercase Windows drive letter + `%3A`).
 *
 * @param {unknown} rawInput
 * @returns {string}
 */
export function toDesktopEncodedWorkspaceUri(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return '';
  if (/^file:\/\/\/[a-z]%3A\//i.test(raw)) {
    return raw.replace(/^file:\/\/\/([a-zA-Z])%3A\//i, (_, d) => `file:///${d.toLowerCase()}%3A/`);
  }
  const unencoded = toRawWorkspaceFileUri(raw);
  const body = unencoded.replace(/^file:\/\/\//i, '');
  const winMatch = body.match(/^([a-zA-Z]):(.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2]
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : ''))
      .join('/');
    return `file:///${drive}%3A${rest}`;
  }
  const encodedPath = body
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/');
  return `file:///${encodedPath}`;
}

/**
 * Extracts a short project name and readable display path from a `file:///` URI.
 *
 * @param {unknown} rawUri
 * @returns {{ name: string, displayPath: string }}
 */
export function parseWorkspaceDisplayLabel(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) return { name: '', displayPath: '' };
  let decoded = raw.replace(/^file:\/\/\/?/i, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = decoded.replace(/%3A/gi, ':');
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!decoded) return { name: '', displayPath: '' };
  const parts = decoded.split('/').filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : decoded;
  return { name, displayPath: decoded };
}

const SSH_SAFE_USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const SSH_SAFE_HOST_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,252}$/;
const SSH_SAFE_IPV6_RE = /^\[[0-9A-Fa-f:.]{2,64}\]$/;

function decodeHexUtf8String(hexStr) {
  if (!hexStr || hexStr.length < 4 || hexStr.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hexStr)) {
    return '';
  }
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hexStr.slice(i, i + 2), 16);
  }
  if (typeof TextDecoder === 'function') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return '';
    }
  }
  let pct = '';
  for (let i = 0; i < bytes.length; i += 1) {
    pct += `%${bytes[i].toString(16).padStart(2, '0')}`;
  }
  try {
    return decodeURIComponent(pct);
  } catch {
    return '';
  }
}

function parseRawSshUserHostPort(spec) {
  const clean = String(spec || '').trim();
  if (!clean || /[\s\0-\x1f\x7f]/.test(clean)) return null;

  let user = '';
  let hostPort = clean;
  const atIdx = clean.lastIndexOf('@');
  if (atIdx >= 0) {
    user = clean.slice(0, atIdx).trim();
    hostPort = clean.slice(atIdx + 1).trim();
    if (!user || !SSH_SAFE_USER_RE.test(user)) return null;
  }

  let host = hostPort;
  let port = 0;
  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']');
    if (closeIdx < 0) return null;
    host = hostPort.slice(0, closeIdx + 1);
    const tail = hostPort.slice(closeIdx + 1);
    if (tail) {
      if (!/^:\d{1,5}$/.test(tail)) return null;
      port = Number(tail.slice(1));
    }
  } else {
    const colonIdx = hostPort.indexOf(':');
    if (colonIdx >= 0) {
      if (hostPort.indexOf(':', colonIdx + 1) >= 0) return null;
      host = hostPort.slice(0, colonIdx);
      const portStr = hostPort.slice(colonIdx + 1);
      if (!/^\d{1,5}$/.test(portStr)) return null;
      port = Number(portStr);
    }
  }

  if (port !== 0 && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return null;
  }
  const validHost = host.startsWith('[')
    ? SSH_SAFE_IPV6_RE.test(host)
    : SSH_SAFE_HOST_RE.test(host);
  if (!validHost) return null;

  return { user, host, port };
}

/**
 * Parses an Antigravity IDE / VS Code `ssh-remote+<authority>` identifier or `vscode-remote://` URI
 * across Plain (`ssh-remote+prod-box`), Percent-encoded (`ssh-remote+ubuntu%4010.0.0.8%3A2222`),
 * and Hex-encoded JSON (`ssh-remote+7b22686f73744e616d6522...`) representations.
 *
 * Strictly rejects non-SSH remote schemes (`wsl+`, `dev-container+`, `codespaces+`, `tunnel+`)
 * and leading-dash / metacharacter strings to prevent SSH option injection.
 *
 * @param {unknown} rawInput
 * @returns {{
 *   isSshRemote: boolean,
 *   rawAuthority: string,
 *   host: string,
 *   user: string,
 *   port: number,
 *   sshDestination: string,
 *   stableHostKey: string,
 *   displayLabel: string,
 * }}
 */
export function parseIdeRemoteAuthority(rawInput) {
  const empty = {
    isSshRemote: false,
    rawAuthority: '',
    host: '',
    user: '',
    port: 0,
    sshDestination: '',
    stableHostKey: '',
    displayLabel: '',
  };
  const text = String(rawInput || '').trim();
  if (!text) return empty;

  let authority = text;
  if (/^vscode-remote:\/\//i.test(authority)) {
    const withoutScheme = authority.replace(/^vscode-remote:\/\//i, '');
    const slashIdx = withoutScheme.indexOf('/');
    authority = slashIdx >= 0 ? withoutScheme.slice(0, slashIdx) : withoutScheme;
  } else {
    const cdnMatch = authority.match(
      /(?:^|\/\/)vscode-remote\+ssh-002dremote\+([A-Za-z0-9._%-]+?)\.vscode-resource\./i
    );
    if (cdnMatch && cdnMatch[1]) {
      const decodedCdnPayload = cdnMatch[1].replace(/-([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
      authority = `ssh-remote+${decodedCdnPayload}`;
    }
  }

  let decodedAuthority = authority;
  try {
    decodedAuthority = decodeURIComponent(authority);
  } catch {
    // Keep undecoded string if malformed percent sequence
  }

  let payload = '';
  if (/^ssh-remote\+/i.test(authority)) {
    payload = authority.slice('ssh-remote+'.length).trim();
  } else if (/^ssh-remote\+/i.test(decodedAuthority)) {
    payload = decodedAuthority.slice('ssh-remote+'.length).trim();
  } else {
    return empty;
  }
  if (!payload) return empty;

  let parsedSpec = null;
  const hexDecoded = decodeHexUtf8String(payload);
  if (hexDecoded && hexDecoded.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(hexDecoded);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const rawHost = String(obj.hostName || obj.host || obj.sshHost || '').trim();
        const rawUser = String(obj.user || obj.userName || '').trim();
        const rawPort = obj.port !== undefined && obj.port !== null && obj.port !== '' ? Number(obj.port) : 0;
        if (rawHost) {
          const normalizedHost =
            rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
          const combined = rawUser ? `${rawUser}@${normalizedHost}` : normalizedHost;
          const base = parseRawSshUserHostPort(combined);
          if (base) {
            if (rawPort !== 0) {
              if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) return empty;
              base.port = rawPort;
            }
            parsedSpec = base;
          }
        }
      }
    } catch {
      parsedSpec = null;
    }
    if (!parsedSpec) return empty;
  } else {
    let unescapedPayload = payload;
    try {
      unescapedPayload = decodeURIComponent(payload);
    } catch {
      // Ignore malformed percent escape
    }
    parsedSpec = parseRawSshUserHostPort(unescapedPayload);
  }

  if (!parsedSpec || !parsedSpec.host) {
    return empty;
  }

  const { user, host, port } = parsedSpec;
  const bareHost =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const sshDestination = user ? `${user}@${bareHost}` : bareHost;
  const portSuffix = port > 0 && port !== 22 ? `:${port}` : '';
  const displayPrefix = user ? `${user}@${host}` : host;
  const displayLabel = `${displayPrefix}${portSuffix}`;
  const stableHostKey = `${user ? `${user.toLowerCase()}@` : ''}${host.toLowerCase()}${portSuffix}`;

  return {
    isSshRemote: true,
    rawAuthority: `ssh-remote+${payload}`,
    host,
    user,
    port,
    sshDestination,
    stableHostKey,
    displayLabel,
  };
}
