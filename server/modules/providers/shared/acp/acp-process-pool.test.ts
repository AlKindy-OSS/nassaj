/** T-2094: long-lived ACP process pool (per member, per session). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeAcpCapacity, createAcpProcessPool, drainProvider } from './acp-process-pool.js';

let pidSeq = 100;
/** A fake process handle; `exit()` simulates the child dying. */
function fakeHandle() {
  const exits: Array<() => void> = [];
  const h = {
    pid: pidSeq++,
    killed: [] as string[],
    kill(signal = 'SIGTERM') { h.killed.push(signal); exits.forEach((cb) => cb()); },
    onExit(cb: () => void) { exits.push(cb); },
    exit() { exits.forEach((cb) => cb()); },
  };
  return h;
}

const spec = (key: string, userId: number, fingerprint = 'f') => ({
  key, userId, fingerprint, cwd: `/p/${key}`, spawn: () => fakeHandle(),
});

test('lazy spawn, reuse on the same key + fingerprint, busy while in a turn', () => {
  const pool = createAcpProcessPool({ provider: 'test-a', capacity: () => 12 });
  const a = pool.acquire(spec('k', 1));
  assert.equal(a.status, 'spawned');
  assert.equal(pool.acquire(spec('k', 1)).status, 'busy');
  pool.release(a.entry);
  const b = pool.acquire(spec('k', 1));
  assert.equal(b.status, 'reused');
  assert.equal(b.entry.handle.pid, a.entry.handle.pid);
  pool.shutdown();
});

test('QA 3: a fingerprint change kills the process and spawns a new one', () => {
  const pool = createAcpProcessPool({ provider: 'test-b', capacity: () => 12 });
  const a = pool.acquire(spec('k', 1, 'f1'));
  pool.release(a.entry);
  const b = pool.acquire(spec('k', 1, 'f2'));
  assert.equal(b.status, 'spawned');
  assert.deepEqual(a.entry.handle.killed, ['SIGTERM']);
  assert.notEqual(b.entry.handle.pid, a.entry.handle.pid);
  pool.shutdown();
});

test('isolation: two members on the same session id get different processes', () => {
  const pool = createAcpProcessPool({ provider: 'test-c', capacity: () => 12 });
  const a = pool.acquire(spec('1:S', 1));
  const b = pool.acquire(spec('2:S', 2));
  assert.notEqual(a.entry.handle.pid, b.entry.handle.pid);
  assert.equal(pool.killMember(1), 1);
  assert.equal(a.entry.handle.killed.length, 1);
  assert.equal(b.entry.handle.killed.length, 0);
  pool.shutdown();
});

test('QA 4: full pool evicts the oldest idle; with none idle it reports full (caller falls back)', () => {
  let clock = 0;
  const pool = createAcpProcessPool({ provider: 'test-d', capacity: () => 2, now: () => clock });
  const a = pool.acquire(spec('a', 1)); clock = 1;
  const b = pool.acquire(spec('b', 2)); clock = 2;
  assert.equal(pool.acquire(spec('c', 3)).status, 'full');
  pool.release(b.entry); clock = 3;
  pool.release(a.entry); clock = 4;
  const c = pool.acquire(spec('c', 3));
  assert.equal(c.status, 'spawned');
  assert.equal(b.entry.handle.killed.length, 1, 'oldest idle (b) evicted');
  assert.equal(a.entry.handle.killed.length, 0);
  pool.shutdown();
});

test('QA 4: at most 3 processes per member', () => {
  const pool = createAcpProcessPool({ provider: 'test-e', capacity: () => 12 });
  for (const k of ['a', 'b', 'c']) pool.acquire(spec(k, 1));
  assert.equal(pool.acquire(spec('d', 1)).status, 'full');
  assert.equal(pool.acquire(spec('d', 2)).status, 'spawned');
  pool.shutdown();
});

test('capacity derives from available memory, clamped 1..12', () => {
  const gb = 1024 ** 3;
  assert.equal(computeAcpCapacity({ memAvailableBytes: 4 * gb, perProcessBytes: gb / 2 }), 4);
  assert.equal(computeAcpCapacity({ memAvailableBytes: 0, perProcessBytes: gb / 2 }), 1);
  assert.equal(computeAcpCapacity({ memAvailableBytes: 1000 * gb, perProcessBytes: gb / 2 }), 12);
  assert.equal(computeAcpCapacity({ memAvailableBytes: null, perProcessBytes: gb / 2 }), 1);
});

test('idle timeout kills an idle process; a busy one is never timed out', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = createAcpProcessPool({ provider: 'test-f', capacity: () => 12, idleTimeoutMs: 1000 });
  const a = pool.acquire(spec('a', 1));
  t.mock.timers.tick(5000);
  assert.equal(a.entry.handle.killed.length, 0);
  pool.release(a.entry);
  t.mock.timers.tick(999);
  assert.equal(a.entry.handle.killed.length, 0);
  t.mock.timers.tick(1);
  assert.equal(a.entry.handle.killed.length, 1);
  assert.equal(pool.size(), 0);
});

test('QA 2: drainProvider kills idle processes now and busy ones at release', () => {
  const pool = createAcpProcessPool({ provider: 'test-g', capacity: () => 12 });
  const idle = pool.acquire(spec('i', 1));
  pool.release(idle.entry);
  const busy = pool.acquire(spec('b', 1));
  assert.equal(drainProvider('test-g'), 1);
  assert.equal(idle.entry.handle.killed.length, 1);
  assert.equal(busy.entry.handle.killed.length, 0, 'a live turn is not killed by the drain');
  pool.release(busy.entry);
  assert.equal(busy.entry.handle.killed.length, 1, 'retired: killed when its turn ends');
  assert.equal(drainProvider('no-such-provider'), 0);
  pool.shutdown();
});

test('a dead child leaves the pool; rekey moves an entry; killKey (QA 5) and shutdown', () => {
  const pool = createAcpProcessPool({ provider: 'test-h', capacity: () => 12 });
  const a = pool.acquire(spec('tmp', 1));
  pool.rekey(a.entry, 'real');
  assert.equal(pool.get('tmp'), null);
  assert.equal(pool.get('real'), a.entry);
  (a.entry.handle as any).exit();
  assert.equal(pool.size(), 0);
  const b = pool.acquire(spec('x', 1));
  pool.release(b.entry);
  assert.equal(pool.killKey('x'), true);
  assert.equal(pool.killKey('x'), false);
  const c = pool.acquire(spec('y', 1));
  pool.shutdown();
  assert.equal(c.entry.handle.killed.length, 1);
  assert.equal(pool.size(), 0);
});

test('killMember can be limited to one project path', () => {
  const pool = createAcpProcessPool({ provider: 'test-i', capacity: () => 12 });
  const a = pool.acquire({ ...spec('a', 1), cwd: '/proj/one/sub' });
  const b = pool.acquire({ ...spec('b', 1), cwd: '/proj/two' });
  assert.equal(pool.killMember(1, { cwdPrefix: '/proj/one' }), 1);
  assert.equal(a.entry.handle.killed.length, 1);
  assert.equal(b.entry.handle.killed.length, 0);
  pool.shutdown();
});
