import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createScheduledMessagesRouter } from './scheduled-messages.routes.js';

async function withServer(run: (origin: string, calls: Array<Record<string, unknown>>) => Promise<void>) {
  const calls: Array<Record<string, unknown>> = [];
  const sample = {
    id: 'scheduled-route-1', sessionId: 'session/a?b', content: 'later', options: {},
    scheduledFor: '2026-09-04T09:00:00.000Z', status: 'pending' as const, attempts: 0,
    maxAttempts: 3, lastErrorCode: null, sentAt: null,
    createdAt: '2026-09-03T09:00:00.000Z', updatedAt: '2026-09-03T09:00:00.000Z',
  };
  const service = {
    list(userId: number, filters: Record<string, unknown>) {
      calls.push({ operation: 'list', userId, filters });
      return { messages: [sample], total: 1, limit: filters.limit, offset: filters.offset, hasMore: false, nextOffset: null };
    },
    summary(userId: number) { calls.push({ operation: 'summary', userId }); return { counts: { pending: 1, running: 0, failed: 2 } }; },
    create(userId: number, input: Record<string, unknown>) { calls.push({ operation: 'create', userId, input }); return sample; },
    update(userId: number, id: string, input: Record<string, unknown>) { calls.push({ operation: 'update', userId, id, input }); return sample; },
    cancel(userId: number, id: string) { calls.push({ operation: 'cancel', userId, id }); },
    async tick() {}, start() {}, async stop() {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as express.Request & { user: { id: number } }).user = { id: 77 }; next(); });
  app.use('/api/scheduled-messages', createScheduledMessagesRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('HTTP contract scopes calls to authenticated user and preserves list/create/update/cancel payloads', async () => {
  await withServer(async (origin, calls) => {
    const list = await fetch(`${origin}/api/scheduled-messages?sessionId=session%2Fa%3Fb&status=pending`);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { messages: unknown[] }).messages.length, 1);

    const summary = await fetch(`${origin}/api/scheduled-messages/summary`);
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), { counts: { pending: 1, running: 0, failed: 2 } });

    const create = await fetch(`${origin}/api/scheduled-messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session/a?b', content: 'later', scheduledFor: '2026-09-04T09:00:00.000Z' }),
    });
    assert.equal(create.status, 201);

    const update = await fetch(`${origin}/api/scheduled-messages/scheduled-route-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'changed' }),
    });
    assert.equal(update.status, 200);
    const cancel = await fetch(`${origin}/api/scheduled-messages/scheduled-route-1`, { method: 'DELETE' });
    assert.equal(cancel.status, 204);

    assert.deepEqual(calls, [
      { operation: 'list', userId: 77, filters: { sessionId: 'session/a?b', status: 'pending', limit: 200, offset: 0 } },
      { operation: 'summary', userId: 77 },
      { operation: 'create', userId: 77, input: { sessionId: 'session/a?b', content: 'later', scheduledFor: '2026-09-04T09:00:00.000Z' } },
      { operation: 'update', userId: 77, id: 'scheduled-route-1', input: { content: 'changed' } },
      { operation: 'cancel', userId: 77, id: 'scheduled-route-1' },
    ]);
  });
});

test('HTTP list exposes bounded pagination and rejects malformed bounds', async () => {
  await withServer(async (origin, calls) => {
    const response = await fetch(`${origin}/api/scheduled-messages?status=failed&limit=25&offset=50`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ operation: 'list', userId: 77, filters: { status: 'failed', limit: 25, offset: 50 } }]);

    for (const query of ['limit=201', 'limit=0', 'limit=-1', 'offset=10001', 'offset=1.5']) {
      const invalid = await fetch(`${origin}/api/scheduled-messages?${query}`);
      assert.equal(invalid.status, 400);
    }
    assert.equal(calls.length, 1);
  });
});

test('HTTP contract rejects invalid status before invoking the service', async () => {
  await withServer(async (origin, calls) => {
    const response = await fetch(`${origin}/api/scheduled-messages?status=owned-by-attacker`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_status', code: 'invalid_status' });
    assert.deepEqual(calls, []);
  });
});
