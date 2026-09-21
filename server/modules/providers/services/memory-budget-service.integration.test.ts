/** C1 service source integration with real budgets/transport and synthetic SQL/filesystem boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createCurrentSourceHistory } from '../../../../tests/helpers/memory-c0-current-source.mjs';
import { createCandidateFixtures, seedCandidateSql, CURRENT_SESSION } from '../../../../tests/helpers/memory-c0-candidate-current-fixtures.mjs';

import * as budget from './history-budget.service.js';
import * as response from './history-response.service.js';

type Provider = 'claude' | 'codex';
type Reply = { status: number; body: any };
async function fixture(provider: Provider, run: (state: any) => Promise<void>, sidecar = false, bindings: Record<string, unknown> = {}, configOptions: Record<string, unknown> = {}, transportSetup?: (outgoing: http.ServerResponse, sink: response.HistoryHttpSink) => void) {
  const root = path.resolve(import.meta.dirname, '../../../../');
  const scratch = await fs.mkdtemp(path.join(root, '.memory-c0-c1-service-'));
  const sockets = new Set<Socket>(); const tasks: Promise<unknown>[] = [];
  let app: any, server: http.Server | undefined, reads = 0, legacyReads = 0, secretCreates = 0, secretReads = 0, revoke = false;
  try {
    const source = await createCandidateFixtures(scratch, provider, { sidecar });
    app = createCurrentSourceHistory(scratch, {
      ...configOptions, onSecretCreate() { secretCreates++; }, onSecretRead() { secretReads++; },
      databaseFactory: () => new Database(':memory:'),
      onLegacySessionRead() { legacyReads++; },
      bindings: { ...budget, ...response, AbortController, AbortSignal, setTimeout, clearTimeout, ...bindings },
      onProviderResult() { reads++; if (revoke) app.db.prepare('DELETE FROM participants WHERE user_id=?').run(1); },
    });
    seedCandidateSql(app, scratch, provider, source, 'wide-scalars');
    app.db.prepare('INSERT INTO participants VALUES(?,?)').run(CURRENT_SESSION, 2);
    server = http.createServer((request, outgoing) => {
      const sink = new response.HistoryHttpSink(outgoing);
      transportSetup?.(outgoing, sink);
      const query = new URL(request.url ?? '/', 'http://fixture').searchParams;
      const userId = Number(query.get('user')), cursor = query.get('cursor') ?? undefined;
      const task = app.service.withHistoryLease(CURRENT_SESSION, userId, { limit: sidecar ? 2 : 1, cursor }, sink)
        .catch((error: unknown) => sink.sendFailure(error));
      tasks.push(task); void task.catch(() => {});
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const call = (user: number, cursor?: string): Promise<Reply> => new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: (server!.address() as AddressInfo).port, path: `/?user=${user}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, agent: false }, incoming => {
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > budget.HISTORY_LIMITS.responseBytes) request.destroy(new Error('test response cap')); else chunks.push(chunk); });
        incoming.once('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        incoming.once('error', reject);
      });
      request.once('error', reject); request.setTimeout(3000, () => request.destroy(new Error('test timeout')));
    });
    await run({ app, source, scratch, call, reads: () => reads, legacyReads: () => legacyReads, secretCreates: () => secretCreates, secretReads: () => secretReads, revokeAfterRead: () => { revoke = true; } });
    await Promise.all(tasks);
    assert.equal(budget.historyAdmission.active, 0); assert.equal(budget.historyAdmission.queued, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await Promise.allSettled(tasks); app?.close(); await fs.rm(scratch, { recursive: true, force: true });
  }
}

test('memory service retains its reader and response through an HTTP error until socket close', { timeout: 5000 }, async () => {
  let releaseClose: (() => void) | undefined, retained = 0, transport: response.HistoryHttpSink | undefined;
  let errorReached!: () => void;
  const errored = new Promise<void>(resolve => { errorReached = resolve; });
  try {
    await fixture('claude', async ({ call }) => {
      const request = call(1).catch(() => null);
      try {
        await errored;
        assert.ok(retained > 0); assert.ok(transport!.retainedBytes > 0);
        assert.equal(budget.historyAdmission.active, 1, 'the errored response still owns its reader before close');
        releaseClose!(); await request;
      } finally { releaseClose?.(); }
    }, false, {}, {}, (outgoing, sink) => {
      transport = sink;
      const end = outgoing.end.bind(outgoing), destroy = outgoing.destroy.bind(outgoing);
      // Keep actual Node socket output buffered while injecting its write error and delayed close acknowledgement.
      const socket = outgoing.socket!, write = socket._write, writev = socket._writev;
      const pending: Array<() => void> = [];
      socket._write = (_chunk, _encoding, callback) => { pending.push(callback); };
      socket._writev = (_chunks, callback) => { pending.push(callback); };
      outgoing.destroy = (() => { releaseClose = () => {
        outgoing.destroy = destroy; socket._write = write; socket._writev = writev;
        destroy(); pending.splice(0).forEach(callback => callback());
      }; errorReached(); return outgoing; }) as typeof outgoing.destroy;
      outgoing.end = ((body: Buffer, ...args: any[]) => {
        retained = body.length; end(body, ...args); throw new Error('synthetic response write failure');
      }) as typeof outgoing.end;
    });
  } finally { releaseClose?.(); }
});

for (const provider of ['claude', 'codex'] as const) {
  test(`memory ${provider} service denies an outsider before provider IO`, async () => fixture(provider, async ({ call, reads }) => {
    const result = await call(3);
    assert.equal(result.status, 404); assert.equal(result.body.error.code, 'SESSION_NOT_FOUND'); assert.equal(reads(), 0);
  }));
  test(`memory ${provider} service rechecks authorization after provider loading`, async () => fixture(provider, async ({ call, reads, revokeAfterRead }) => {
    revokeAfterRead(); const result = await call(1);
    assert.equal(reads(), 1); assert.equal(result.status, 404); assert.equal(result.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(result.body.messages, undefined);
  }));
  test(`memory ${provider} service bypasses cached results while preserving owned history`, async () => fixture(provider, async ({ call, reads, source }) => {
    const first = await call(1), second = await call(1);
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(reads(), 2);
    assert.equal(first.body.total, source.expectedTotal); assert.equal(second.body.messages[0].content, source.lastText);
    assert.deepEqual(first.body, second.body);
  }));
}

test('memory Claude service keeps native receipt ownership isolated between participants', async () => fixture('claude', async ({ call }) => {
  const owner = await call(1), participant = await call(2);
  assert.equal(owner.status, 200); assert.equal(participant.status, 200);
  assert.equal(owner.body.messages[0].clientMsgId, 'owner-receipt');
  assert.equal(participant.body.messages[0].clientMsgId, undefined);
}));

test('memory Claude service discovers authorized subagent sources and preserves their joined result', async () => fixture('claude', async ({ call }) => {
  const result = await call(1);
  assert.equal(result.status, 200); assert.equal(result.body.total, 129);
  assert.equal(result.body.messages[0].subagentTools[0].toolResult.content[0], 's');
}, true));


test('memory Claude bounds repeated structured tool result copies before fanout allocation', async () => {
  let copies = 0;
  class SmallFixtureLease extends budget.HistoryReadLease {
    constructor(signal: AbortSignal) { super(signal); }
    stringify(value: unknown): string {
      const selected = Array.isArray(value) && value[0]?.text === 'synthetic-fanout:' + 'x'.repeat(512);
      // Simulate a nearly exhausted owned reservation without allocating large real buffers.
      if (selected && copies === 0) this.charge('retainedBytes', this.limits.retainedBytes - (this.counts.retainedBytes ?? 0) - 4096);
      const encoded = super.stringify(value);
      if (selected) copies++;
      return encoded;
    }
  }
  await fixture('claude', async ({ call, scratch, source }) => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ sessionId: CURRENT_SESSION, uuid: `tool-${index}`, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'duplicate-tool', name: 'Read', input: {} }] } }));
    const result = { sessionId: CURRENT_SESSION, uuid: 'result', type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'duplicate-tool', content: [{ type: 'text', text: 'synthetic-fanout:' + 'x'.repeat(512) }] },
    ] } };
    await fs.writeFile(path.join(scratch, source.main), [...rows, result].map(row => JSON.stringify(row)).join('\n') + '\n');
    const reply = await call(1);
    assert.equal(reply.status, 413); assert.equal(reply.body.error.code, 'HISTORY_BUDGET_EXCEEDED');
    assert.ok(copies > 0 && copies < 5, `only ${copies} bounded copies may precede rejection, never twenty`);
  }, false, { HistoryReadLease: SmallFixtureLease });
});

for (const age of ['recent', 'old'] as const) test(`memory Claude accepts an ignored ${age} workflow journal as metadata-only source`, async () => {
  await fixture('claude', async ({ call, scratch, source }) => {
    const stopped = new Date(Date.now() - 120000).toISOString();
    await fs.writeFile(path.join(scratch, source.main), JSON.stringify({ sessionId: CURRENT_SESSION, uuid: 'stopped', timestamp: stopped,
      type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<status>stopped</status>' } }) + '\n');
    const folder = path.join(scratch, CURRENT_SESSION, 'subagents', 'workflows', 'wf_synthetic');
    await fs.mkdir(folder, { recursive: true });
    const journal = path.join(folder, 'journal.jsonl');
    await fs.writeFile(journal, '{"type":"started","key":"a"}\n{"type":"result","key":"a"}\n');
    const time = new Date(Date.now() - (age === 'recent' ? 0 : 180000)); await fs.utimes(journal, time, time);
    const reply = await call(1); assert.equal(reply.status, 200);
    assert.ok(!reply.body.messages.some((message: any) => message.kind === 'task_reconcile'));
  });
});


for (const provider of ['claude', 'codex'] as const) {
  test(`memory ${provider} locator omits oversized unrelated custom_name without a full-row lookup`, async () => fixture(provider, async ({ app, call, legacyReads }) => {
    app.db.exec('ALTER TABLE sessions ADD COLUMN custom_name TEXT');
    app.db.prepare('UPDATE sessions SET custom_name=? WHERE session_id=?').run('x'.repeat(2 * 1024 * 1024), CURRENT_SESSION);
    const reply = await call(1); assert.equal(reply.status, 200); assert.equal(legacyReads(), 0);
    assert.equal(reply.body.custom_name, undefined);
  }));
  test(`memory ${provider} oversized locator is private to outsiders and bounded for its owner`, async () => fixture(provider, async ({ app, call, reads, legacyReads }) => {
    app.db.prepare('UPDATE sessions SET jsonl_path=? WHERE session_id=?').run('x'.repeat(8192), CURRENT_SESSION);
    const denied = await call(3), owner = await call(1);
    assert.equal(denied.status, 404); assert.equal(denied.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(owner.status, 413); assert.equal(owner.body.error.code, 'HISTORY_BUDGET_EXCEEDED');
    assert.equal(reads(), 0); assert.equal(legacyReads(), 0);
  }));
}


test('memory Codex leased cursor uses existing authority without invoking its secret factory', async () => fixture('codex', async ({ call, secretCreates, secretReads }) => {
  const first = await call(1); assert.equal(first.status, 200); assert.equal(typeof first.body.nextCursor, 'string');
  const next = await call(1, first.body.nextCursor); assert.equal(next.status, 200);
  assert.notEqual(next.body.messages[0].id, first.body.messages[0].id);
  assert.equal(secretCreates(), 0); assert.ok(secretReads() >= 2);
}));

test('memory Codex missing cursor authority fails closed without creating a secret', async () => fixture('codex', async ({ call, secretCreates, secretReads }) => {
  const result = await call(1); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'HISTORY_SOURCE_UNAVAILABLE');
  assert.equal(secretCreates(), 0); assert.ok(secretReads() >= 1);
}, false, {}, { jwtSecret: null }));
