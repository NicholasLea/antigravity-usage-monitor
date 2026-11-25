/**
 * @fileoverview 受控的 Antigravity 宿主语言包 HTTPS 拉取器。
 *
 * - 严格限制仅允许官方白名单域名（`raw.githubusercontent.com` / `cdn.jsdelivr.net`）；
 * - 复用 `cloudcode-proxy.mjs` 的系统 HTTPS 代理检测与 CONNECT 隧道，兼容代理环境；
 * - 主源超时或 5xx/网络失败时自动回退至 jsDelivr CDN 镜像；
 * - 响应体严格限制大小上限，避免异常大载荷撑爆内存。
 */

import { detectSystemHttpsProxy, openCcProxyTunnelSocket } from '../cloudcode-proxy.mjs';

export const HOST_I18N_ALLOWED_HOSTS = Object.freeze([
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
]);
export const HOST_I18N_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const HOST_I18N_DEFAULT_TIMEOUT_MS = 8_000;
const HOST_I18N_MAX_REDIRECTS = 3;

let hostI18nNetModulesPromise = null;

async function loadHostI18nNetModules() {
  if (!hostI18nNetModulesPromise) {
    hostI18nNetModulesPromise = Promise.all([
      import('node:http'),
      import('node:https'),
      import('node:net'),
      import('node:tls'),
    ]).then(([httpMod, httpsMod, netMod, tlsMod]) => ({
      http: httpMod.default || httpMod,
      https: httpsMod.default || httpsMod,
      net: netMod.default || netMod,
      tls: tlsMod.default || tlsMod,
    }));
  }
  return hostI18nNetModulesPromise;
}

/**
 * 校验下载 URL 是否属于允许的 HTTPS 白名单源。
 *
 * @param {string} rawUrl
 * @returns {URL}
 */
export function assertAllowedHostI18nUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Invalid host-i18n download URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Unsupported host-i18n protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!HOST_I18N_ALLOWED_HOSTS.includes(host)) {
    throw new Error(`Disallowed host-i18n host: ${host}`);
  }
  return parsed;
}

/**
 * 通过原生 `https` + 系统 HTTPS 代理隧道拉取单个白名单 URL 的 UTF-8 文本。
 *
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, maxBytes?: number, redirectCount?: number }} [options]
 * @returns {Promise<{ ok: boolean, status: number, text: string, url: string }>}
 */
async function fetchAllowedUrlViaNodeHttps(
  rawUrl,
  {
    timeoutMs = HOST_I18N_DEFAULT_TIMEOUT_MS,
    maxBytes = HOST_I18N_MAX_RESPONSE_BYTES,
    redirectCount = 0,
  } = {}
) {
  const target = assertAllowedHostI18nUrl(rawUrl);
  const mods = await loadHostI18nNetModules();
  const { http, https, net, tls } = mods;

  const proxy = await detectSystemHttpsProxy(target.hostname).catch(() => null);
  const socket = proxy
    ? await openCcProxyTunnelSocket(
        { http, https, net, tls },
        target.hostname,
        Number(target.port || 443),
        proxy,
        { timeoutMs: Math.min(timeoutMs, 5_000) }
      )
    : null;

  let socketConsumed = false;
  const agent = socket ? new https.Agent({ keepAlive: false }) : null;
  if (agent) {
    agent.createConnection = () => {
      socketConsumed = true;
      return socket;
    };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socketConsumed) {
        try {
          socket?.destroy();
        } catch {
          // 忽略关闭异常
        }
      }
      try {
        agent?.destroy();
      } catch {
        // 忽略关闭异常
      }
      if (ok) resolve(value);
      else reject(value);
    };

    const req = https.request(
      target,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain;q=0.9',
          'Cache-Control': 'no-cache',
          'User-Agent': 'antigravity-usage-monitor-host-i18n/1.0',
        },
        ...(agent ? { agent } : {}),
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        if (
          (status === 301 || status === 302 || status === 307 || status === 308) &&
          res.headers?.location &&
          redirectCount < HOST_I18N_MAX_REDIRECTS
        ) {
          res.resume();
          let nextUrl = '';
          try {
            nextUrl = new URL(String(res.headers.location), target).href;
            assertAllowedHostI18nUrl(nextUrl);
          } catch (err) {
            finish(false, err);
            return;
          }
          clearTimeout(timer);
          fetchAllowedUrlViaNodeHttps(nextUrl, {
            timeoutMs,
            maxBytes,
            redirectCount: redirectCount + 1,
          }).then(
            (val) => finish(true, val),
            (err) => finish(false, err)
          );
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            req.destroy(new Error(`host-i18n response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err) => finish(false, err));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          finish(true, {
            ok: status >= 200 && status < 300,
            status,
            text,
            url: target.href,
          });
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new Error(`host-i18n request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    req.on('error', (err) => finish(false, err));
    req.end();
  });
}

/**
 * 依次尝试多个白名单候选 URL（主源 GitHub Raw -> 备用 jsDelivr CDN），返回首个成功的文本响应。
 *
 * @param {string[]} urls
 * @param {{
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   fetchImpl?: ((url: string, init?: object) => Promise<{ ok: boolean, status?: number, text: () => Promise<string> }>)|null,
 * }} [options]
 * @returns {Promise<{ text: string, url: string, status: number }>}
 */
export async function fetchHostI18nTextWithFallback(
  urls,
  {
    timeoutMs = HOST_I18N_DEFAULT_TIMEOUT_MS,
    maxBytes = HOST_I18N_MAX_RESPONSE_BYTES,
    fetchImpl = null,
  } = {}
) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (list.length === 0) {
    throw new Error('No host-i18n candidate URLs configured');
  }

  const errors = [];
  for (const rawUrl of list) {
    const validated = assertAllowedHostI18nUrl(rawUrl);
    try {
      if (typeof fetchImpl === 'function') {
        const res = await fetchImpl(validated.href, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          signal:
            typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? AbortSignal.timeout(timeoutMs)
              : undefined,
        });
        const status = Number(res?.status || (res?.ok ? 200 : 500));
        if (!res?.ok) {
          throw new Error(`HTTP ${status}`);
        }
        const text = await res.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
          throw new Error(`host-i18n response exceeds ${maxBytes} bytes`);
        }
        return { text, url: validated.href, status };
      }

      const res = await fetchAllowedUrlViaNodeHttps(validated.href, { timeoutMs, maxBytes });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { text: res.text, url: res.url, status: res.status };
    } catch (err) {
      errors.push(`${validated.hostname}: ${err?.message || 'request failed'}`);
    }
  }

  throw new Error(`Failed to fetch host-i18n asset (${errors.join('; ')})`);
}
