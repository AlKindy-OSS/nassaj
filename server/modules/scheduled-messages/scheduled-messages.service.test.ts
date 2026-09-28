import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTANCE_UNOBSERVED,
  MAINTENANCE_REFUND_WINDOW_MS,
  MAX_CONCURRENT_SCHEDULED,
  MAX_CONCURRENT_SCHEDULED_PER_USER,
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

// B-1390: a deferred provider turn whose acceptance and completion the test controls.
function controlledTurn() {
  let accept!: (verdict: { success: boolean; retryable: boolean; errorCode?: string }) => void;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const accepted = new Promise<{ success: boolean; retryable: boolean; errorCode?: string; completion: Promise<void> }>(
    (resolve) => { accept = (verdict) => resolve({ ...verdict, completion }); },
  );
  return { accepted, accept, finish, completion };
}

// A claimDue fake that honours the busy-session and saturated-user exclusions like the SQL does.
function queueHarness(dispatch: (message: Row) => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  const h = harness({
    canWriteSession: () => true,
    dispatch: (message: Row) => dispatch(message),
    ...overrides,
  });
  const claimCalls: string[][] = [];
  const userExclusions: number[][] = [];
  let tokens = 0;
  h.repository.claimDue = ((
    _now: string, _lease: number, exclude: readonly string[] = [], excludeUsers: readonly number[] = [],
  ) => {
    claimCalls.push([...exclude]);
    userExclusions.push([...excludeUsers]);
    const next = [...h.rows.values()]
      .filter((item) => item.status === 'pending' && !exclude.includes(item.sessionId)
        && !excludeUsers.includes(item.userId))
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt))[0];
    if (!next) return null;
    tokens += 1;
    Object.assign(next, { status: 'running', attempts: next.attempts + 1, leaseToken: `lease-${tokens}` });
    return next;
  }) as never;
  return { ...h, claimCalls, userExclusions };
}

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('B-1390: a long accepted turn in session A does not block a due message in session B', async () => {
  const turns = new Map<string, ReturnType<typeof controlledTurn>>();
  const h = queueHarness(async (message) => {
    const turn = controlledTurn();
    turns.set(message.id, turn);
    return turn.accepted;
  });
  h.rows.set('a-1', row({ id: 'a-1', sessionId: 'session-a', availableAt: '2026-09-03T08:00:00.000Z' }));

  const first = h.service.tick();
  turns.get('a-1')!.accept({ success: true, retryable: false });
  await first;
  // Accepted: settled as sent while the turn is still running.
  assert.equal(h.rows.get('a-1')?.status, 'sent');

  h.rows.set('b-1', row({ id: 'b-1', sessionId: 'session-b', availableAt: '2026-09-03T08:01:00.000Z' }));
  const second = h.service.tick();
  assert.ok(turns.has('b-1'), 'session B was blocked behind session A turn');
  turns.get('b-1')!.accept({ success: true, retryable: false });
  await second;
  assert.equal(h.rows.get('b-1')?.status, 'sent');
  assert.deepEqual(h.audits.map((entry) => entry.action), ['scheduled_message_dispatched', 'scheduled_message_dispatched']);
  turns.get('a-1')!.finish();
  turns.get('b-1')!.finish();
});

test('B-1390: tick resolves at acceptance even while the turn itself never finishes', async () => {
  const turn = controlledTurn();
  const h = queueHarness(async () => turn.accepted);
  h.rows.set('slow', row({ id: 'slow', sessionId: 'session-a' }));

  const pending = h.service.tick();
  turn.accept({ success: true, retryable: false });
  await pending;
  await h.service.stop();
  assert.equal(h.rows.get('slow')?.status, 'sent');
});

test('B-1390: a slow acceptance in one session does not stop later polls claiming other sessions', async () => {
  const turns = new Map<string, ReturnType<typeof controlledTurn>>();
  const h = queueHarness(async (message) => {
    const turn = controlledTurn();
    turns.set(message.id, turn);
    return turn.accepted;
  });
  h.rows.set('a-1', row({ id: 'a-1', sessionId: 'session-a' }));
  const stuck = h.service.tick();
  await flush();

  h.rows.set('b-1', row({ id: 'b-1', sessionId: 'session-b' }));
  const next = h.service.tick();
  await flush();
  assert.ok(turns.has('b-1'));
  assert.deepEqual(h.claimCalls.at(-2), ['session-a']);
  turns.get('b-1')!.accept({ success: true, retryable: false });
  await next;
  assert.equal(h.rows.get('b-1')?.status, 'sent');
  turns.get('a-1')!.accept({ success: true, retryable: false });
  await stuck;
  turns.forEach((turn) => turn.finish());
});

test('B-1390: same-session messages stay ordered — the next waits for the running turn to complete', async () => {
  const turns = new Map<string, ReturnType<typeof controlledTurn>>();
  const order: string[] = [];
  const h = queueHarness(async (message) => {
    order.push(message.id);
    const turn = controlledTurn();
    turns.set(message.id, turn);
    return turn.accepted;
  });
  h.rows.set('s-1', row({ id: 's-1', sessionId: 'session-a', availableAt: '2026-09-03T08:00:00.000Z' }));
  h.rows.set('s-2', row({ id: 's-2', sessionId: 'session-a', availableAt: '2026-09-03T08:01:00.000Z' }));

  const first = h.service.tick();
  turns.get('s-1')!.accept({ success: true, retryable: false });
  await first;
  assert.deepEqual(order, ['s-1'], 'the second same-session message ran concurrently');
  assert.equal(h.rows.get('s-2')?.status, 'pending');

  await h.service.tick();
  assert.deepEqual(order, ['s-1'], 'the session was released before its turn completed');

  turns.get('s-1')!.finish();
  await flush();
  const third = h.service.tick();
  assert.deepEqual(order, ['s-1', 's-2']);
  turns.get('s-2')!.accept({ success: true, retryable: false });
  await third;
  turns.get('s-2')!.finish();
});

test('B-1390: failure before acceptance keeps the retry and failed paths and frees the session', async () => {
  let verdict: { success: boolean; retryable: boolean; errorCode?: string } = {
    success: false, retryable: true, errorCode: 'session_busy',
  };
  const h = queueHarness(async () => verdict);
  h.rows.set('r-1', row({ id: 'r-1', sessionId: 'session-a' }));

  await h.service.tick();
  assert.equal(h.rows.get('r-1')?.status, 'pending');
  assert.equal(h.settlements[0].outcome.retryAt, new Date(NOW + 30_000).toISOString());

  verdict = { success: false, retryable: false, errorCode: 'provider_failed' };
  h.rows.set('r-2', row({ id: 'r-2', sessionId: 'session-a', availableAt: '2026-09-03T09:59:00.000Z' }));
  h.rows.get('r-1')!.availableAt = '2026-09-03T10:00:00.000Z';
  await h.service.tick();
  assert.equal(h.rows.get('r-2')?.status, 'failed', 'a refused turn must not hold the session busy');
  assert.equal(h.audits.at(-1)?.action, 'scheduled_message_failed');
});

test('B-1390: concurrent ticks never dispatch the same row twice across sessions', async () => {
  const turns: Array<ReturnType<typeof controlledTurn>> = [];
  const dispatched: string[] = [];
  const h = queueHarness(async (message) => {
    dispatched.push(message.id);
    const turn = controlledTurn();
    turns.push(turn);
    return turn.accepted;
  });
  for (const id of ['x-1', 'y-1', 'x-2']) {
    h.rows.set(id, row({ id, sessionId: id.startsWith('x') ? 'session-x' : 'session-y' }));
  }

  const ticks = [h.service.tick(), h.service.tick(), h.service.tick()];
  await flush();
  const again = h.service.tick();
  await flush();
  assert.deepEqual([...dispatched].sort(), ['x-1', 'y-1']);
  turns.forEach((turn) => turn.accept({ success: true, retryable: false }));
  await Promise.all([...ticks, again]);
  assert.deepEqual([...dispatched].sort(), ['x-1', 'y-1']);
  turns.forEach((turn) => turn.finish());
});

// Deferred turns keyed by message id, so a test can accept/finish each one.
function turnBook() {
  const turns = new Map<string, ReturnType<typeof controlledTurn>>();
  const dispatch = async (message: Row) => {
    const turn = controlledTurn();
    turns.set(message.id, turn);
    return turn.accepted;
  };
  const acceptAll = () => turns.forEach((turn) => turn.accept({ success: true, retryable: false }));
  const finishAll = () => turns.forEach((turn) => turn.finish());
  return { turns, dispatch, acceptAll, finishAll };
}

test('B-1390: a global cap bounds concurrent scheduled turns across users and sessions', async () => {
  const book = turnBook();
  const h = queueHarness(book.dispatch);
  for (let index = 0; index < 10; index += 1) {
    h.rows.set(`g-${index}`, row({ id: `g-${index}`, userId: 100 + index, sessionId: `session-g${index}` }));
  }

  const first = h.service.tick();
  await flush();
  assert.equal(book.turns.size, MAX_CONCURRENT_SCHEDULED, 'more turns launched than the global cap');
  book.acceptAll();
  await first;

  // Accepted but still running turns keep their slots: a new poll launches nothing.
  await h.service.tick();
  assert.equal(book.turns.size, MAX_CONCURRENT_SCHEDULED);

  book.finishAll();
  await flush();
  const second = h.service.tick();
  await flush();
  assert.equal(book.turns.size, MAX_CONCURRENT_SCHEDULED * 2);
  book.acceptAll();
  await second;
  book.finishAll();
});

test('B-1390: a per-user cap stops one user monopolising the pool without blocking other users', async () => {
  const book = turnBook();
  const h = queueHarness(book.dispatch);
  for (let index = 0; index < 5; index += 1) {
    h.rows.set(`u-${index}`, row({
      id: `u-${index}`, userId: 1, sessionId: `session-u${index}`,
      availableAt: `2026-09-03T08:0${index}:00.000Z`,
    }));
  }
  h.rows.set('other', row({ id: 'other', userId: 2, sessionId: 'session-other', availableAt: '2026-09-03T08:59:00.000Z' }));

  const pending = h.service.tick();
  await flush();
  const launched = [...book.turns.keys()].sort();
  assert.equal(MAX_CONCURRENT_SCHEDULED_PER_USER, 2);
  assert.deepEqual(launched, ['other', 'u-0', 'u-1'], 'user 1 exceeded its cap or starved user 2');
  assert.ok(h.userExclusions.some((users) => users.includes(1)), 'the saturated user was never excluded');
  book.acceptAll();
  await pending;
  book.finishAll();
});

test('B-1390: an unobserved acceptance settles sent once, is not retried, and keeps the session busy', async () => {
  let resolveLate!: (value: { success: boolean; retryable: boolean; completion: Promise<void> }) => void;
  let finishLate!: () => void;
  const lateCompletion = new Promise<void>((resolve) => { finishLate = resolve; });
  const h = queueHarness(() => new Promise((resolve) => { resolveLate = resolve; }), { acceptanceTimeoutMs: 20 });
  h.rows.set('hang-1', row({ id: 'hang-1', sessionId: 'session-h' }));
  h.rows.set('hang-2', row({ id: 'hang-2', sessionId: 'session-h', availableAt: '2026-09-03T09:59:00.000Z' }));

  await h.service.tick();
  assert.equal(h.rows.get('hang-1')?.status, 'sent');
  assert.equal(h.rows.get('hang-1')?.lastErrorCode, ACCEPTANCE_UNOBSERVED);
  assert.deepEqual(h.settlements.map((entry) => entry.outcome), [
    { success: true, retryable: false, errorCode: ACCEPTANCE_UNOBSERVED },
  ]);
  assert.deepEqual(h.audits.at(-1)?.metadata, {
    scheduledMessageId: 'hang-1', sessionId: 'session-h', attempt: 1, marker: ACCEPTANCE_UNOBSERVED,
  });

  // The turn may still be running: its session must not get the next message.
  await h.service.tick();
  assert.equal(h.rows.get('hang-2')?.status, 'pending');

  resolveLate({ success: true, retryable: false, completion: lateCompletion });
  finishLate();
  await flush();
  await flush();
  await h.service.tick();
  assert.equal(h.rows.get('hang-2')?.status, 'sent', 'the session was never released after the late turn ended');
  assert.equal(h.settlements.length, 2, 'the unobserved row was retried');
});

test('B-1390: an unobserved acceptance logs once that the concurrency slot stays held (ids only)', async () => {
  const errors: unknown[][] = [];
  const h = queueHarness(() => new Promise(() => {}), {
    acceptanceTimeoutMs: 20,
    logger: { error: (...args: unknown[]) => { errors.push(args); } },
  });
  h.rows.set('hung-1', row({ id: 'hung-1', sessionId: 'session-hung', content: 'secret prompt' }));

  await h.service.tick();

  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /slot stays held/);
  assert.deepEqual(errors[0][1], { scheduledMessageId: 'hung-1', sessionId: 'session-hung' });
  assert.ok(!JSON.stringify(errors).includes('secret prompt'), 'message content leaked into the log');
});

const MAINTENANCE_REFUSAL = {
  success: false, retryable: true, errorCode: 'update_maintenance_active', refundAttempt: true,
};

/** Queue harness whose settle mirrors the DB: refund gives the attempt back, exhaustion fails. */
function maintenanceHarness(clock: { now: number }) {
  const h = queueHarness(async () => MAINTENANCE_REFUSAL, { now: () => clock.now });
  h.repository.settle = ((id: string, leaseToken: string, outcome: {
    success: boolean; retryable: boolean; errorCode?: string; retryAt?: string; refundAttempt?: boolean;
  }) => {
    h.settlements.push({ id, leaseToken, outcome });
    const found = h.rows.get(id)!;
    if (found.leaseToken !== leaseToken) return false;
    if (outcome.refundAttempt) found.attempts -= 1;
    found.status = found.attempts >= found.maxAttempts ? 'failed' : 'pending';
    found.lastErrorCode = outcome.errorCode ?? null;
    found.leaseToken = null;
    return true;
  }) as never;
  return h;
}

test('B-1390: a persistent (MANUAL-like) maintenance refusal is audited once, not per poll', async () => {
  const clock = { now: NOW };
  const h = maintenanceHarness(clock);
  h.rows.set('m-1', row({ id: 'm-1', scheduledFor: new Date(NOW).toISOString() }));

  for (let poll = 0; poll < 6; poll += 1) {
    clock.now += 60_000;
    await h.service.tick();
  }

  assert.equal(h.settlements.length, 6);
  assert.equal(h.rows.get('m-1')?.status, 'pending');
  assert.equal(h.rows.get('m-1')?.attempts, 0, 'a refusal within the window spent an attempt');
  assert.deepEqual(h.audits.map((entry) => entry.action), ['scheduled_message_failed']);
});

test('B-1390: past the refund window a maintenance refusal counts, so max_attempts ends it', async () => {
  const clock = { now: NOW + MAINTENANCE_REFUND_WINDOW_MS + 1 };
  const h = maintenanceHarness(clock);
  h.rows.set('m-2', row({
    id: 'm-2', scheduledFor: new Date(NOW).toISOString(), lastErrorCode: 'update_maintenance_active',
  }));

  for (let poll = 0; poll < 5; poll += 1) {
    clock.now += 60_000;
    await h.service.tick();
  }

  assert.equal(h.settlements.length, 3, 'the row kept retrying past max_attempts');
  assert.ok(h.settlements.every((entry) => !('refundAttempt' in entry.outcome)));
  assert.equal(h.rows.get('m-2')?.status, 'failed');
  assert.equal(h.audits.length, 3, 'a counted attempt must always be audited');
});

test('B-1390: pause stops new claims, including mid-poll, and start resumes', async () => {
  const book = turnBook();
  const h = queueHarness(book.dispatch);
  h.rows.set('p-1', row({ id: 'p-1', sessionId: 'session-p1' }));
  h.rows.set('p-2', row({ id: 'p-2', sessionId: 'session-p2' }));

  h.service.pause();
  await h.service.tick();
  assert.equal(h.claimCalls.length, 0, 'a paused queue claimed a row');

  const claim = h.repository.claimDue;
  h.repository.claimDue = ((...args: Parameters<typeof claim>) => {
    const claimed = claim(...args);
    h.service.pause();
    return claimed;
  }) as never;
  (h.service as unknown as { start(): void }).start();
  await flush();
  assert.equal(book.turns.size, 1, 'a drain-time pause did not stop the claim loop');
  book.acceptAll();
  await h.service.stop();
  book.finishAll();
});

test('B-1390: stop waits for pre-acceptance deliveries but not for accepted turns', async () => {
  const book = turnBook();
  const h = queueHarness(book.dispatch);
  h.rows.set('st-1', row({ id: 'st-1', sessionId: 'session-st' }));

  const pending = h.service.tick();
  await flush();
  let stopped = false;
  const stopping = h.service.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, 'stop returned while a delivery was still pre-acceptance');

  book.acceptAll();
  await Promise.all([pending, stopping]);
  assert.equal(stopped, true, 'stop waited for the accepted turn to finish');
  assert.equal(h.rows.get('st-1')?.status, 'sent');
  h.rows.set('st-2', row({ id: 'st-2', sessionId: 'session-other' }));
  await h.service.tick();
  assert.equal(h.rows.get('st-2')?.status, 'pending', 'a stopped queue kept claiming');
  book.finishAll();
});

test('B-1390: the claim lease is renewed while waiting for acceptance, and only then', async () => {
  const book = turnBook();
  const renewals: string[] = [];
  const h = queueHarness(book.dispatch, { leaseMs: 3_000 });
  h.repository.renewLease = ((id: string) => { renewals.push(id); return true; }) as never;
  h.rows.set('lease-1', row({ id: 'lease-1', sessionId: 'session-lease' }));

  const pending = h.service.tick();
  await new Promise((resolve) => { setTimeout(resolve, 1_150); });
  assert.deepEqual(renewals, ['lease-1'], 'the claim was not renewed before acceptance');
  book.acceptAll();
  await pending;
  await new Promise((resolve) => { setTimeout(resolve, 1_150); });
  assert.deepEqual(renewals, ['lease-1'], 'renewal continued after acceptance');
  book.finishAll();
});

test('B-1390: a transient settle failure is retried once before the delivery gives up', async () => {
  const errors: unknown[] = [];
  const h = queueHarness(async () => ({ success: true, retryable: false }), {
    logger: { error: (...args: unknown[]) => { errors.push(args); } },
  });
  const settle = h.repository.settle;
  let failures = 1;
  h.repository.settle = ((...args: Parameters<typeof settle>) => {
    if (failures > 0) { failures -= 1; throw new Error('database is locked'); }
    return settle(...args);
  }) as never;
  h.rows.set('retry-settle', row({ id: 'retry-settle', sessionId: 'session-rs' }));

  await h.service.tick();
  assert.equal(h.rows.get('retry-settle')?.status, 'sent');
  assert.equal(h.audits.at(-1)?.action, 'scheduled_message_dispatched');
  assert.equal(errors.length, 1);
});

test('B-1390: a failure after acceptance is audited with its code only, never content', async () => {
  const h = queueHarness(async () => ({
    success: true, retryable: false, completion: Promise.resolve({ success: false, errorCode: 'late_failure' }),
  }));
  h.rows.set('late', row({ id: 'late', sessionId: 'session-late', content: 'secret prompt' }));

  await h.service.tick();
  await flush();
  const failed = h.audits.find((entry) => entry.action === 'scheduled_message_turn_failed');
  assert.deepEqual(failed?.metadata, {
    scheduledMessageId: 'late', sessionId: 'session-late', attempt: 1, errorCode: 'late_failure',
  });
  assert.equal(h.rows.get('late')?.status, 'sent', 'a post-acceptance failure must not reopen the row');
});
