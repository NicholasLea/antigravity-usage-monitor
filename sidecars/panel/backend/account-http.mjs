/** @fileoverview Google account requests using the panel's system proxy transport. */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { detectSystemHttpsProxy, openCcProxyTunnelSocket } from './cloudcode-proxy.mjs';

export async function fetchGoogleAccount(url, { method = 'GET', body, headers = {}, signal } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/^(?:oauth2|www|cloudcode-pa|daily-cloudcode-pa(?:\.sandbox)?)\.googleapis\.com$/.test(target.hostname)) {
    throw new Error('Unsupported Google account endpoint');
  }
  signal?.throwIfAborted();
  const proxy = await detectSystemHttpsProxy(target.hostname);
  signal?.throwIfAborted();
  const socket = proxy
    ? await openCcProxyTunnelSocket({ http, https, net, tls }, target.hostname, 443, proxy, { timeoutMs: 4500 })
    : null;
  if (signal?.aborted) {
    socket?.destroy();
    signal.throwIfAborted();
  }
  const textBody = body === undefined ? undefined : String(body);
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body instanceof URLSearchParams) requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  if (textBody !== undefined) requestHeaders['Content-Length'] = Buffer.byteLength(textBody);
  let socketConsumed = false;
  const agent = socket ? new https.Agent({ keepAlive: false }) : null;
  if (agent) {
    agent.createConnection = () => {
      socketConsumed = true;
      return socket;
    };
  }
  const onAbort = () => {
    if (!socketConsumed) socket?.destroy();
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  return new Promise((resolve, reject) => {
    const request = https.request(target, { method, headers: requestHeaders, signal, ...(agent ? { agent } : {}) }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) return request.destroy(new Error('Account response too large'));
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode || 0;
        resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(raw) });
      });
    });
    request.on('error', (err) => {
      if (!socketConsumed) socket?.destroy();
      reject(err);
    });
    request.on('close', () => {
      signal?.removeEventListener?.('abort', onAbort);
      agent?.destroy();
    });
    request.end(textBody);
  });
}
