import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_OPEN_SCHEDULED_PER_USER,
  MAX_SCHEDULED_CONTENT_BYTES,
  MAX_SCHEDULE_DELAY_MS,
  MIN_SCHEDULE_DELAY_MS,
  ScheduledMessageError,
  createScheduledMessagesService,
  normalizeScheduledOptions,
} from './scheduled-messages.service.js';

type Row = {
  id: string; userId: number; sessionId: string; content: string;
  options: Record<string, unknown>; scheduledFor: string;
  availableAt: string;
  status: 'pending' | 'running' | 'sent' | 'failed' | 'cancelled';
  attempts: number; maxAttempts: number; leaseToken: string | null;
  leaseExpiresAt: string | null; lastErrorCode: string | null;
  sentAt: string | null; createdAt: string; updatedAt: string;
};

const NOW = Date.parse('2026-09-03T09:00:00.000Z');

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'scheduled-1', userId: 1, sessionId: 'session-1', content: 'follow up',
    options: {}, scheduledFor: new Date(NOW + MIN_SCHEDULE_DELAY_MS).toISOString(),
    availableAt: new Date(NOW + MIN_SCHEDULE_DELAY_MS).toISOString(),
    status: 'pending', attempts: 0, maxAttempts: 3, leaseToken: null,
    leaseExpiresAt: null, lastErrorCode: null, sentAt: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string, statusCode: number): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ScheduledMessageError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

function harness(overrides: Record<string, unknown> = {}) {
  const rows = new Map<string, Row>();
  const claimed: Row[] = [];
  const settlements: Array<{ id: string; leaseToken: string; outcome: { success: boolean; retryable: boolean; errorCode?: string; retryAt?: string } }> = [];
  const repository = {
    create(input: Pick<Row, 'userId' | 'sessionId' | 'content' | 'options' | 'scheduledFor'>) {
      const created = row({ ...input, id: `scheduled-${rows.size + 1}` });
      rows.set(created.id, created);
      return created;
    },
    getOwned(id: string, userId: number) {
      const found = rows.get(id);
      return found?.userId === userId ? found : null;
    },
    listOwned(userId: number, filters: { sessionId?: string; status?: Row['status'] } = {}) {
      return [...rows.values()].filter((item) => item.userId === userId
        && (!filters.sessionId || item.sessionId === filters.sessionId)
        && (!filters.status || item.status === filters.status));
    },
    listAccessibleOwned(userId: number, filters: { sessionId?: string; status?: Row['status']; limit: number; offset: number }) {
      const accessible = [...rows.values()].filter((item) => item.userId === userId
        && (!filters.sessionId || item.sessionId === filters.sessionId)
        && (!filters.status || item.status === filters.status)
        && (overrides.canWriteSession as ((sessionId: string, userId: number) => boolean) | undefined
          ?? ((sessionId: string, ownerId: number) => sessionId === 'session-1' && ownerId === 1))(item.sessionId, userId));
      return { messages: accessible.slice(filters.offset, filters.offset + filters.limit), total: accessible.length };
    },
    countAccessibleActionable(userId: number) {
      const writable = (overrides.canWriteSession as ((sessionId: string, userId: number) => boolean) | undefined)
        ?? ((sessionId: string, ownerId: number) => sessionId === 'session-1' && ownerId === 1);
      const counts = { pending: 0, running: 0, failed: 0 };
      for (const item of rows.values()) {
        if (item.userId === userId && writable(item.sessionId, userId)
          && (item.status === 'pending' || item.status === 'running' || item.status === 'failed')) {
          counts[item.status] += 1;
        }
      }
      return counts;
    },
    countOpenForUser(userId: number) {
      return [...rows.values()].filter((item) => item.userId === userId
        && (item.status === 'pending' || item.status === 'running')).length;
    },
    failExpiredExhausted() { return []; },
    updateOwned(id: string, userId: number, input: Pick<Row, 'content' | 'options' | 'scheduledFor'>) {
      const found = rows.get(id);
      if (!found || found.userId !== userId || !['pending', 'failed'].includes(found.status)) return null;
      Object.assign(found, input, { status: 'pending', attempts: 0 });
      return found;
    },
    cancelOwned(id: string, userId: number) {
      const found = rows.get(id);
      if (!found || found.userId !== userId) return 'not_found' as const;
      if (!['pending', 'failed', 'cancelled'].includes(found.status)) return 'conflict' as const;
      found.status = 'cancelled';
      return 'cancelled' as const;
    },
    claimDue() { return claimed.shift() ?? null; },
    renewLease(id: string, leaseToken: string, leaseExpiresAt: string) {
      const found = rows.get(id);
      if (!found || found.leaseToken !== leaseToken) return false;
      found.leaseExpiresAt = leaseExpiresAt;
      return true;
    },
    settle(id: string, leaseToken: string, outcome: { success: boolean; retryable: boolean; errorCode?: string; retryAt?: string }) {
      settlements.push({ id, leaseToken, outcome });
      const found = rows.get(id);
      if (!found || found.leaseToken !== leaseToken) return false;
      found.status = outcome.success ? 'sent' : outcome.retryable ? 'pending' : 'failed';
      found.lastErrorCode = outcome.errorCode ?? null;
      if (outcome.retryAt) found.availableAt = outcome.retryAt;
      found.leaseToken = null;
      return true;
    },
  };
  const audits: Array<{ action: string; metadata: Record<string, unknown>; userId: number }> = [];
  const deps = {
    repository,
    getActiveUser: (userId: number) => ({ id: userId, role: 'user', authorization_generation: 1 }),
    sessionExists: (sessionId: string) => sessionId === 'session-1',
    canWriteSession: (sessionId: string, userId: number) => sessionId === 'session-1' && userId === 1,
    dispatch: async () => ({ success: true, retryable: false }),
    audit: (action: string, metadata: Record<string, unknown>, userId: number) => audits.push({ action, metadata, userId }),
    now: () => NOW,
    ...overrides,
  };
  return { rows, claimed, settlements, repository, audits, service: createScheduledMessagesService(deps as never) };
}

test('ownership is fail-closed for list, update, and cancel without revealing a cross-user row', () => {
  const { rows, service } = harness();
  rows.set('foreign', row({ id: 'foreign', userId: 2 }));

  assert.deepEqual(service.list(1, {}).messages, []);
  // A list filtered by a session the requester cannot write is an empty page,
  // not a 404 — cross-user rows can never surface because listAccessibleOwned
  // is scoped to user_id. Only the mutating paths stay fail-closed below.
  assert.deepEqual(service.list(1, { sessionId: 'session-owned-by-someone-else' }).messages, []);
  expectCode(() => service.update(1, 'foreign', { content: 'steal' }), 'scheduled_message_not_found', 404);
  expectCode(() => service.cancel(1, 'foreign'), 'scheduled_message_not_found', 404);
  assert.equal(rows.get('foreign')?.content, 'follow up');
  assert.equal(rows.get('foreign')?.status, 'pending');
});

test('global list and summary omit rows after session write access is revoked', () => {
  let writable = true;
  const h = harness({ canWriteSession: () => writable });
  h.rows.set('revoked', row({ id: 'revoked', status: 'failed' }));

  assert.deepEqual(h.service.list(1, {}).messages.map((message) => message.id), ['revoked']);
  assert.deepEqual(h.service.summary(1), { counts: { pending: 0, running: 0, failed: 1 } });

  writable = false;
  assert.deepEqual(h.service.list(1, {}).messages, []);
  assert.deepEqual(h.service.summary(1), { counts: { pending: 0, running: 0, failed: 0 } });
  expectCode(() => h.service.cancel(1, 'revoked'), 'session_not_found', 404);
});

test('list of a not-yet-persisted session is an empty page, not a load error (B-1044)', () => {
  // Reproduces the panel bug: a conversation still being processed has no
  // `sessions` row yet, so sessionExists is false. The list must resolve to an
  // empty page so the client renders the empty state, never errors.load.
  const h = harness();
  const page = h.service.list(1, { sessionId: 'brand-new-unpersisted-session' });
  assert.deepEqual(page.messages, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, null);
});

test('list reports truncation explicitly with stable offset metadata', () => {
  const h = harness();
  for (let index = 0; index < 3; index += 1) {
    h.rows.set(`page-${index}`, row({ id: `page-${index}` }));
  }

  const page = h.service.list(1, { limit: 2, offset: 0 });
  assert.equal(page.messages.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
});

test('due execution reauthorizes both actor and session instead of trusting creation-time access', async () => {
  let active = true;
  let writable = true;
  let dispatches = 0;
  const h = harness({
    getActiveUser: () => active ? ({ id: 1, role: 'user', authorization_generation: 9 }) : undefined,
    canWriteSession: () => writable,
    dispatch: async () => { dispatches += 1; return { success: true, retryable: false }; },
  });
  const first = row({ id: 'revoked-actor', leaseToken: 'lease-a', status: 'running', attempts: 1 });
  const second = row({ id: 'revoked-session', leaseToken: 'lease-b', status: 'running', attempts: 1 });
  h.rows.set(first.id, first);
  h.rows.set(second.id, second);

  active = false;
  h.claimed.push(first);
  await h.service.tick();
  assert.equal(first.status, 'failed');
  assert.equal(first.lastErrorCode, 'actor_revoked');
  assert.equal(dispatches, 0);

  active = true;
  writable = false;
  h.claimed.push(second);
  await h.service.tick();
  assert.equal(second.status, 'failed');
  assert.equal(second.lastErrorCode, 'session_write_revoked');
  assert.equal(dispatches, 0);
});

test('creation enforces UTF-8 byte, time-window, option allowlist, enum, and open-row quota bounds', () => {
  const h = harness();
  const valid = { sessionId: 'session-1', content: 'رسالة', scheduledFor: new Date(NOW + MIN_SCHEDULE_DELAY_MS).toISOString() };

  assert.equal(h.service.create(1, { ...valid, options: { model: ' gpt-5 ', effort: 'high', permissionMode: 'plan' } }).options.model, 'gpt-5');
  expectCode(() => h.service.create(1, { ...valid, content: '🙂'.repeat(Math.floor(MAX_SCHEDULED_CONTENT_BYTES / 4) + 1) }), 'content_too_large', 413);
  expectCode(() => h.service.create(1, { ...valid, scheduledFor: new Date(NOW + MIN_SCHEDULE_DELAY_MS - 1).toISOString() }), 'scheduled_for_too_soon', 400);
  expectCode(() => h.service.create(1, { ...valid, scheduledFor: new Date(NOW + MAX_SCHEDULE_DELAY_MS + 1).toISOString() }), 'scheduled_for_too_far', 400);
  expectCode(() => normalizeScheduledOptions({ shell: 'rm', model: 'x' }), 'unsupported_option', 400);
  expectCode(() => normalizeScheduledOptions({ permissionMode: 'bypassPermissions' }), 'invalid_permissionMode', 400);

  for (let index = h.rows.size; index < MAX_OPEN_SCHEDULED_PER_USER; index += 1) {
    h.rows.set(`quota-${index}`, row({ id: `quota-${index}` }));
  }
  expectCode(() => h.service.create(1, valid), 'scheduled_message_limit_reached', 409);
});

test('overlapping ticks share one in-flight drain and cannot dispatch the same claim twice', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let dispatches = 0;
  const h = harness({ dispatch: async () => { dispatches += 1; await gate; return { success: true, retryable: false }; } });
  const due = row({ status: 'running', attempts: 1, leaseToken: 'lease-one' });
  h.rows.set(due.id, due);
  h.claimed.push(due);

  const firstTick = h.service.tick();
  const overlappingTick = h.service.tick();
  assert.equal(dispatches, 1);
  release();
  await Promise.all([firstTick, overlappingTick]);
  assert.equal(dispatches, 1);
  assert.equal(due.status, 'sent');
});

test('retryable dispatch receives exponential backoff instead of being immediately reclaimed', async () => {
  const h = harness({ dispatch: async () => { throw new Error('temporarily unavailable'); } });
  const due = row({ status: 'running', attempts: 2, leaseToken: 'lease-retry' });
  h.rows.set(due.id, due);
  h.claimed.push(due);

  await h.service.tick();

  assert.equal(h.settlements.length, 1);
  assert.deepEqual(h.settlements[0].outcome, {
    success: false,
    retryable: true,
    errorCode: 'dispatch_unavailable',
    retryAt: new Date(NOW + 60_000).toISOString(),
  });
});

test('a stale worker that lost its lease cannot emit a false terminal audit', async () => {
  const h = harness({ dispatch: async () => ({ success: true, retryable: false }) });
  const due = row({ status: 'running', attempts: 1, leaseToken: 'stale-lease' });
  h.rows.set(due.id, due);
  h.claimed.push(due);
  h.repository.settle = () => false;

  await h.service.tick();

  assert.deepEqual(h.audits, []);
});

test('a transient repository failure is contained and a later poll can continue', async () => {
  const errors: unknown[] = [];
  const h = harness({ logger: { error: (...args: unknown[]) => { errors.push(args); } } });
  h.repository.claimDue = () => { throw new Error('database temporarily unavailable'); };

  await assert.doesNotReject(() => h.service.tick());
  assert.equal(errors.length, 1);

  h.repository.claimDue = () => null;
  await assert.doesNotReject(() => h.service.tick());
});
