/**
 * dsh-local-corrector — the per-turn loopback hop between a DeepSeek Harness turn
 * and the member's local model server (ADR-227 "DSH local corrector", T-2108).
 *
 * One listener per local DSH turn, inside the nassaj process, on 127.0.0.1 and an
 * ephemeral port, open only while the turn runs:
 *   - DSH authenticates with a per-turn 32-byte token in `x-api-key`, compared in
 *     constant time; anything else is 401. Only an origin-form `POST /v1/messages`
 *     (query kept) is served; every other method or target (absolute-form, `//host`,
 *     dot segments) is 404, and the upstream URL is built from the vetted origin
 *     alone. Request body cap (413).
 *   - Forward to the vetted literal origin (no DNS, no proxy, no redirect follow:
 *     an upstream 3xx is a 502). The inbound credentials, Host and hop-by-hop
 *     headers are dropped; the server key, when there is one, goes in
 *     `Authorization: Bearer`; `accept-encoding: identity`. The server key never
 *     reaches DSH, its env or its files.
 *   - The only change to the reply is dsh-local-sse-fix.js. A compressed reply
 *     passes untouched. Nothing is logged or cached.
 *   - Connect timeout, idle timeout, a client that leaves aborts upstream, and
 *     `close()` ends every connection and upstream request.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { LOCAL_API_TIMEOUT_MS } from './apply-claude-local-engine-env.js';
import { DSH_SSE_MAX_LINE_BYTES, createSseToolUseFixer, fixMessageJson } from './dsh-local-sse-fix.js';

/** Default limits; each may be lowered per corrector (tests). */
export const DSH_CORRECTOR_LIMITS = Object.freeze({
  maxBodyBytes: 32 * 1024 * 1024,
  maxJsonBytes: 32 * 1024 * 1024,
  maxLineBytes: DSH_SSE_MAX_LINE_BYTES,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: Number(LOCAL_API_TIMEOUT_MS),
});

const HOP_BY_HOP = Object.freeze(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DROPPED_REQUEST_HEADERS = new Set([...HOP_BY_HOP, 'host', 'x-api-key', 'authorization', 'content-length',
  'accept-encoding']);
const DROPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'content-length']);

/** The only request target served (origin-form). */
const MESSAGES_PATH = '/v1/messages';

/**
 * The query of an origin-form `POST /v1/messages` target, or null for anything else.
 * The raw target is compared (no URL parsing): an absolute-form (`http://host/...`),
 * a `//host` authority, a dot-segment path or a relative target is never served,
 * so the upstream URL can only ever be built on the vetted origin (T-2108 qa CRIT 1).
 * @param {string|undefined} target req.url
 * @returns {string|null} '' or '?…'
 */
export function messagesTargetQuery(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
  const at = target.indexOf('?');
  const pathPart = at < 0 ? target : target.slice(0, at);
  return pathPart === MESSAGES_PATH ? (at < 0 ? '' : target.slice(at)) : null;
}

/** sha256 of a presented value; both sides are hashed so the compare is length-blind. */
const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

/**
 * Ends a reply with `status` when nothing was sent yet; otherwise cuts the socket.
 * @param {http.ServerResponse} res
 * @param {number} status
 */
function fail(res, status) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = status;
  res.end();
}

/**
 * The upstream request headers: inbound minus credentials, Host and hop-by-hop.
 * @param {http.IncomingHttpHeaders} inbound
 * @param {string} secret the server key ('' for none)
 * @param {number} length body length
 * @returns {Record<string, string|string[]>}
 */
function upstreamHeaders(inbound, secret, length) {
  const headers = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
  }
  headers['accept-encoding'] = 'identity';
  headers['content-length'] = String(length);
  if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
}

/**
 * Reads the request body up to `max` bytes; null when it is larger.
 * @param {http.IncomingMessage} req
 * @param {number} max
 * @returns {Promise<Buffer|null>}
 */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        resolve(null);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Buffers a JSON reply (capped), applies the fix and sends it.
 * @param {http.IncomingMessage} up
 * @param {http.ServerResponse} res
 * @param {number} max
 */
function relayJson(up, res, max) {
  const chunks = [];
  let size = 0;
  up.on('data', (chunk) => {
    size += chunk.length;
    if (size > max) {
      up.destroy();
      fail(res, 502);
      return;
    }
    chunks.push(chunk);
  });
  up.on('end', () => {
    if (res.writableEnded) return;
    const body = fixMessageJson(Buffer.concat(chunks));
    res.setHeader('content-length', String(body.length));
    res.end(body);
  });
}

/**
 * Relays one upstream reply: status and headers (set lazily, so an early failure
 * can still answer 502), then the body through the only transform.
 * @param {http.IncomingMessage} up
 * @param {http.ServerResponse} res
 * @param {typeof DSH_CORRECTOR_LIMITS} limits
 */
function relayResponse(up, res, limits) {
  const status = up.statusCode ?? 502;
  if (status >= 300 && status < 400) {
    up.resume();
    fail(res, 502);
    return;
  }
  res.statusCode = status;
  for (const [name, value] of Object.entries(up.headers)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
  }
  up.on('error', () => fail(res, 502));
  const encoded = String(up.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity';
  const type = String(up.headers['content-type'] ?? '').toLowerCase();
  if (!encoded && type.includes('text/event-stream')) {
    const fixer = createSseToolUseFixer({ maxLineBytes: limits.maxLineBytes });
    fixer.on('error', () => { up.destroy(); fail(res, 502); });
    up.pipe(fixer).pipe(res);
  } else if (!encoded && type.includes('application/json')) {
    relayJson(up, res, limits.maxJsonBytes);
  } else {
    up.pipe(res);
  }
}

/**
 * Sends the body to the vetted origin and relays the reply.
 * @param {{ target: URL, secret: string, limits: typeof DSH_CORRECTOR_LIMITS, agents: object,
 *   active: Set<http.ClientRequest> }} ctx
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Buffer} body
 * @param {string} query the vetted query of the request target
 */
function forward(ctx, req, res, body, query) {
  const url = new URL(`${MESSAGES_PATH}${query}`, ctx.target);
  const secure = url.protocol === 'https:';
  const upstream = (secure ? https : http).request(url, {
    method: 'POST', headers: upstreamHeaders(req.headers, ctx.secret, body.length),
    agent: secure ? ctx.agents.https : ctx.agents.http,
  });
  ctx.active.add(upstream);
  const connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), ctx.limits.connectTimeoutMs);
  upstream.on('socket', (socket) => {
    if (!socket.connecting) clearTimeout(connectTimer);
    else socket.once('connect', () => clearTimeout(connectTimer));
  });
  upstream.setTimeout(ctx.limits.idleTimeoutMs, () => upstream.destroy(new Error('idle timeout')));
  upstream.on('response', (up) => relayResponse(up, res, ctx.limits));
  upstream.on('error', () => fail(res, 502));
  upstream.on('close', () => { clearTimeout(connectTimer); ctx.active.delete(upstream); });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  upstream.end(body);
}

/**
 * Handles one inbound request: token, route, body cap, then forward.
 * @param {object} ctx see forward, plus `tokenDigest`
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(ctx, req, res) {
  if (!crypto.timingSafeEqual(ctx.tokenDigest, digest(req.headers['x-api-key']))) {
    req.resume();
    fail(res, 401);
    return;
  }
  const query = messagesTargetQuery(req.url);
  if (req.method !== 'POST' || query === null) {
    req.resume();
    fail(res, 404);
    return;
  }
  const body = await readBody(req, ctx.limits.maxBodyBytes).catch(() => null);
  if (body === null) {
    res.setHeader('connection', 'close');
    fail(res, 413);
    return;
  }
  forward(ctx, req, res, body, query);
}

/**
 * Opens the corrector for one local DSH turn.
 * @param {{ connectOrigin: string, secret?: string } & Partial<typeof DSH_CORRECTOR_LIMITS>} input
 *   `connectOrigin` is the vetted literal origin (resolveLocalEngine); `secret` the server key
 * @returns {Promise<{ origin: string, port: number, token: string, close: () => Promise<void> }>}
 */
export async function openDshLocalCorrector({ connectOrigin, secret = '', ...overrides }) {
  const limits = { ...DSH_CORRECTOR_LIMITS, ...overrides };
  const token = crypto.randomBytes(32).toString('hex');
  const ctx = {
    target: new URL(connectOrigin), secret, limits, tokenDigest: digest(token), active: new Set(),
    agents: { http: new http.Agent({ keepAlive: false }), https: new https.Agent({ keepAlive: false }) },
  };
  const server = http.createServer((req, res) => { void handle(ctx, req, res); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  let closing = null;
  const close = () => {
    closing ??= new Promise((resolve) => {
      for (const upstream of ctx.active) upstream.destroy();
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });
    return closing;
  };
  return { origin: `http://127.0.0.1:${port}`, port, token, close };
}
