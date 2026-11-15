/**
 * ADR-227 "DSH local corrector" / T-2108 — the per-turn loopback corrector between
 * a DeepSeek Harness turn and the member's local model server, in the owner's
 * terms:
 *   - my server sees only its own key: no DSH token, no x-api-key, no Host of the
 *     corrector, no compression request; nothing else is forwarded;
 *   - a wrong or missing token is 401; any other path or method is 404; an
 *     oversized request is 413; an upstream redirect is never followed (502);
 *   - the ONLY change is `"input":{}` on a tool_use block start that lacks it, in a
 *     stream (any chunking, Arabic text, CRLF) and in a plain JSON reply; a reply
 *     that already has `input` passes byte-identical; a line over 1 MiB is a 502;
 *   - closing the corrector leaves no open port and aborts the upstream request;
 *     a member who leaves mid-reply aborts the upstream request too.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { openDshLocalCorrector } from './dsh-local-corrector.js';
import { createSseToolUseFixer, fixMessageJson } from './dsh-local-sse-fix.js';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Upstream = { port: number; seen: Seen[]; aborted: number; close: () => Promise<void> };

const servers: Array<() => Promise<void>> = [];
after(async () => { for (const close of servers) await close(); });

/** A fake local model server: records each request and answers with `respond`. */
async function upstream(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  const state: Upstream = { port: 0, seen: [], aborted: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      state.seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.on('close', () => { if (!res.writableFinished) state.aborted += 1; });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  servers.push(state.close);
  return state;
}

/** Sends one request to the corrector and collects the raw reply. */
function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/v1/messages',
      headers: options.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body ?? '{}');
  });
}

const SERVER_KEY = 'LOCAL-SERVER-KEY-T2108';
const sse = (events: object[]) => events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
const TOOL_START_NO_INPUT = { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write' } };
const TOOL_START_WITH_INPUT = { ...TOOL_START_NO_INPUT, content_block: { ...TOOL_START_NO_INPUT.content_block, input: {} } };

async function corrector(up: Upstream, secret = SERVER_KEY, limits = {}) {
  const opened = await openDshLocalCorrector({ connectOrigin: `http://127.0.0.1:${up.port}`, secret, ...limits });
  servers.push(opened.close);
  return opened;
}
const auth = (token: string) => ({ 'x-api-key': token, 'content-type': 'application/json' });

/** True when something still accepts connections on the port. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

describe('the corrector listener (T-2108)', () => {
  it('listens on 127.0.0.1 only, with a 32-byte per-turn token', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up);
    assert.match(c.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(Buffer.from(c.token, 'hex').length, 32);
  });

  it('a wrong or missing token is 401; nothing reaches my server', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up);
    assert.equal((await send(c.port, { headers: auth('wrong') })).status, 401);
    assert.equal((await send(c.port, { headers: { authorization: `Bearer ${c.token}` } })).status, 401);
    assert.equal((await send(c.port)).status, 401);
    assert.equal(up.seen.length, 0);
  });

  it('any other path or method is 404, query kept on /v1/messages', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up);
    for (const [method, path] of [['GET', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['POST', '/models'], ['PUT', '/v1/messages']]) {
      assert.equal((await send(c.port, { method, path, headers: auth(c.token) })).status, 404, `${method} ${path}`);
    }
    assert.equal(up.seen.length, 0);
    assert.equal((await send(c.port, { path: '/v1/messages?beta=true', headers: auth(c.token) })).status, 200);
    assert.equal(up.seen[0].url, '/v1/messages?beta=true');
  });

  it('qa CRIT 1: an absolute-form or //host request target is 404 and never reaches another server', async () => {
    const mine = await upstream((_req, res) => res.end('{}'));
    const other = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(mine);
    for (const target of [`http://127.0.0.1:${other.port}/v1/messages`, `//127.0.0.1:${other.port}/v1/messages`,
      `http://127.0.0.1:${mine.port}/v1/messages`, '/v1/messages/../messages']) {
      assert.equal((await send(c.port, { path: target, headers: auth(c.token) })).status, 404, target);
    }
    // A target Node's parser itself rejects never reaches the handler (the socket is cut).
    assert.equal(await send(c.port, { path: 'v1/messages', headers: auth(c.token) }).then(({ status }) => status, () => 'cut'), 'cut');
    assert.equal(other.seen.length, 0, 'nothing reached the other server');
    assert.equal(mine.seen.length, 0);
    await send(c.port, { path: '/v1/messages?beta=true', headers: auth(c.token) });
    assert.equal(mine.seen[0].url, '/v1/messages?beta=true', 'the upstream path comes from the vetted origin only');
  });

  it('an oversized request body is 413', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up, SERVER_KEY, { maxBodyBytes: 1024 });
    const reply = await send(c.port, { headers: auth(c.token), body: Buffer.alloc(4096, 0x61) }).catch(() => ({ status: 413 }));
    assert.equal(reply.status, 413);
    assert.equal(up.seen.length, 0);
  });

  it('header echo: my server sees only its own key, no token, no x-api-key, no corrector Host, identity encoding', async () => {
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    const c = await corrector(up);
    await send(c.port, { headers: { ...auth(c.token), 'accept-encoding': 'gzip, br', connection: 'keep-alive', 'anthropic-version': '2023-06-01' },
      body: '{"model":"m"}' });
    const seen = up.seen[0];
    assert.equal(seen.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(seen.headers['x-api-key'], undefined);
    assert.equal(seen.headers['accept-encoding'], 'identity');
    assert.equal(seen.headers.host, `127.0.0.1:${up.port}`);
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.ok(!JSON.stringify(seen).includes(c.token), 'the token never reaches my server');
    assert.equal(seen.body, '{"model":"m"}');
  });

  it('a server without a key gets no Authorization at all', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up, '');
    await send(c.port, { headers: auth(c.token) });
    assert.equal(up.seen[0].headers.authorization, undefined);
  });

  it('an upstream redirect is not followed (502)', async () => {
    const up = await upstream((_req, res) => { res.writeHead(307, { location: 'http://198.51.100.7/v1/messages' }); res.end(); });
    const c = await corrector(up);
    assert.equal((await send(c.port, { headers: auth(c.token) })).status, 502);
    assert.equal(up.seen.length, 1);
  });

  it('an unreachable server is 502', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    await up.close();
    const c = await corrector(up);
    assert.equal((await send(c.port, { headers: auth(c.token) })).status, 502);
  });
});

describe('the only transform: "input":{} on a tool_use block start (T-2108)', () => {
  it('stream: adds input where it is missing; every other byte passes unchanged', async () => {
    const body = `event: message_start\ndata: {"type":"message_start"}\n\n${sse([TOOL_START_NO_INPUT])}: comment\n\n`;
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(body); });
    const c = await corrector(up);
    const reply = (await send(c.port, { headers: auth(c.token) })).body.toString('utf8');
    assert.equal(reply, body.replace(JSON.stringify(TOOL_START_NO_INPUT), JSON.stringify(TOOL_START_WITH_INPUT)));
  });

  it('acceptance (7): a stream that already has input passes byte-identical', async () => {
    const body = `${sse([{ type: 'message_start' }, TOOL_START_WITH_INPUT, { type: 'content_block_delta', delta: { text: 'مرحبا' } }])}`;
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(body); });
    const c = await corrector(up);
    assert.deepEqual((await send(c.port, { headers: auth(c.token) })).body, Buffer.from(body));
  });

  it('JSON reply: the same fix on content[]; with input already present it is byte-identical', async () => {
    const missing = { content: [{ type: 'text', text: 'مرحبا' }, { type: 'tool_use', id: 't', name: 'read' }] };
    const present = Buffer.from('{ "content": [ {"type":"tool_use","id":"t","name":"read","input":{"a":1}} ] }');
    let next: Buffer = Buffer.from(JSON.stringify(missing));
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(next); });
    const c = await corrector(up);
    const fixed = JSON.parse((await send(c.port, { headers: auth(c.token) })).body.toString('utf8'));
    assert.deepEqual(fixed.content[1].input, {});
    assert.equal(fixed.content[0].text, 'مرحبا');
    next = present;
    assert.deepEqual((await send(c.port, { headers: auth(c.token) })).body, present);
  });

  it('a compressed reply passes untouched (content-encoding passthrough)', async () => {
    const raw = Buffer.from(sse([TOOL_START_NO_INPUT]));
    const up = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'x-test' }); res.end(raw); });
    const c = await corrector(up);
    assert.deepEqual((await send(c.port, { headers: auth(c.token) })).body, raw);
  });

  it('a line over 1 MiB ends the response with 502', async () => {
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${'x'.repeat(1024 * 1024 + 10)}`); });
    const c = await corrector(up);
    assert.equal((await send(c.port, { headers: auth(c.token) })).status, 502);
  });
});

/** Runs `input` through the stream fixer in the given chunks. */
async function runFixer(chunks: Buffer[]): Promise<Buffer> {
  const fixer = createSseToolUseFixer();
  const out: Buffer[] = [];
  fixer.on('data', (chunk: Buffer) => out.push(chunk));
  const done = new Promise((resolve, reject) => { fixer.on('end', resolve); fixer.on('error', reject); });
  for (const chunk of chunks) fixer.write(chunk);
  fixer.end();
  await done;
  return Buffer.concat(out);
}

describe('the stream fixer, byte level (T-2108 qa condition 3)', () => {
  const arabic = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'مرحبا بالعالم' } };
  const input = Buffer.from(`${sse([arabic, TOOL_START_NO_INPUT, arabic])}`);
  const expected = Buffer.from(input.toString('utf8').replace(JSON.stringify(TOOL_START_NO_INPUT), JSON.stringify(TOOL_START_WITH_INPUT)));

  it('byte-by-byte chunking (Arabic split mid-character) gives the same bytes as one chunk', async () => {
    const single = await runFixer([input]);
    const bytes = await runFixer([...input].map((byte) => Buffer.from([byte])));
    assert.deepEqual(single, expected);
    assert.deepEqual(bytes, expected);
  });

  it('accepts CRLF line ends and keeps them', async () => {
    const crlf = Buffer.from(`data: ${JSON.stringify(TOOL_START_NO_INPUT)}\r\n\r\n`);
    assert.equal((await runFixer([crlf])).toString('utf8'), `data: ${JSON.stringify(TOOL_START_WITH_INPUT)}\r\n\r\n`);
  });

  it('a multi-line data: event passes unchanged', async () => {
    const text = JSON.stringify(TOOL_START_NO_INPUT);
    const multi = Buffer.from(`data: ${text.slice(0, 20)}\ndata: ${text.slice(20)}\n\n`);
    assert.deepEqual(await runFixer([multi]), multi);
  });

  it('flushes a trailing partial line (fixed when it is a whole event)', async () => {
    const tail = Buffer.from(`data: ${JSON.stringify(TOOL_START_NO_INPUT)}`);
    assert.equal((await runFixer([tail])).toString('utf8'), `data: ${JSON.stringify(TOOL_START_WITH_INPUT)}`);
  });

  it('a line over 1 MiB is an error', async () => {
    await assert.rejects(runFixer([Buffer.alloc(1024 * 1024 + 1, 0x61)]), /line too long/u);
  });

  it('fixMessageJson leaves invalid JSON and non-message JSON untouched', () => {
    for (const raw of ['not json', '[]', '{"content":"x"}']) assert.deepEqual(fixMessageJson(Buffer.from(raw)), Buffer.from(raw));
  });
});

describe('lifecycle (T-2108 qa condition 4)', () => {
  it('acceptance (4): after close no port is open and the upstream request is aborted', async () => {
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write('data: {}\n\n'); });
    const c = await corrector(up);
    const pending = send(c.port, { headers: auth(c.token) }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await c.close();
    await pending;
    assert.equal(await portOpen(c.port), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(up.aborted, 1);
  });

  it('a member who leaves mid-reply aborts the upstream request', async () => {
    const up = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write('data: {}\n\n'); });
    const c = await corrector(up);
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/v1/messages', headers: auth(c.token), agent: false },
        (res) => res.once('data', () => { req.destroy(); resolve(); }));
      req.on('error', () => {});
      req.end('{}');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(up.aborted, 1);
  });

  it('close is idempotent', async () => {
    const up = await upstream((_req, res) => res.end('{}'));
    const c = await corrector(up);
    await c.close();
    await c.close();
  });
});
