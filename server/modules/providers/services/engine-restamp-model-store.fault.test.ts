import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { after, test, type TestContext } from 'node:test';

import type { EngineRestampIntent } from '@/modules/database/index.js';

import type {
  EngineRestampModelStoreBoundary,
  EngineRestampModelStoreTestDeps,
} from './engine-restamp-model-store.service.js';

// Establish synthetic storage before any database-bearing dynamic import.
const root = fs.mkdtempSync(path.resolve('.artifacts/e2-fault-'));
const priorDb = process.env.DATABASE_PATH, priorTemp = process.env.TMPDIR;
process.env.TMPDIR = root;
process.env.DATABASE_PATH = path.join(root, 'synthetic.sqlite');
fs.writeFileSync(process.env.DATABASE_PATH, '', { mode: 0o600, flag: 'wx' });
const db = await import('@/modules/database/index.js');
const store = await import('./engine-restamp-model-store.service.js');
const { withEngineRestampModelStoreTestDeps } = await import('./engine-restamp-model-store.test-harness.js');
const live = await import('./engine-switch-liveness.service.js');
await db.initializeDatabase();
after(() => { db.closeConnection(); if (priorDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = priorDb; if (priorTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTemp; fs.rmSync(root, { recursive: true, force: true }); });
const TARGET = 'provider-session-active-model-changes.json';
const LOCK = '.provider-session-active-model-changes.lock';
const fail = () => Object.assign(new Error('injected IO seam'), { code: 'EIO' });
const fdName = (fd: number): string => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } };
const ownedFds = (home: string): string[] => fs.readdirSync('/proc/self/fd').flatMap(name => {
  const resolved = fdName(Number(name)); return resolved.startsWith(home + '/') || resolved === home ? [`${name}:${resolved}`] : [];
});

function makeIntent(sessionId: string): EngineRestampIntent {
  const value = { schema: 'nassaj-engine-restamp-intent/v1', operationId: '123e4567-e89b-42d3-a456-426614174000', sessionId,
    ownerProcess: { uid: process.getuid(), pid: process.pid, bootId: '12345678-1234-1234-1234-123456789012', startTicks: '1' },
    actor: { kind: 'jwt', userId: 1, authorizationGeneration: 1 },
    projectBinding: { kind: 'project', projectId: 'fixture', participantUserId: 1, controllerUserId: 1, authorityFenceSha256: 'a'.repeat(64) },
    fromPin: { engine: null, source: null }, toPin: { engine: 'anthropic', source: 'user_switch' },
    fromModel: { changed: false, model: null }, toModel: { changed: true, model: 'test-model' }, turnsExported: 0,
    acknowledgedExport: false, phase: 'prepared', revision: 1, requestSha256: '0'.repeat(64), createdAt: '2026-09-24T12:00:00.000Z' } as EngineRestampIntent;
  value.requestSha256 = db.engineRestampRequestSha256(value); return value;
}

type FsOperation = 'openSync' | 'fstatSync' | 'writeFileSync' | 'fsyncSync' | 'renameSync' | 'readSync' | 'unlinkSync';
function inject(t: TestContext, operation: FsOperation, matches: (args: any[]) => boolean, persistent = false): () => number {
  const original = fs[operation] as (...args: any[]) => any;
  let faults = 0;
  t.mock.method(fs, operation, ((...args: any[]) => {
    if ((persistent || faults === 0) && matches(args)) { faults++; throw fail(); }
    return original(...args);
  }) as any);
  return () => faults;
}

async function fixture(t: TestContext, callback: (home: string, children: ChildProcess[]) => Promise<void>, deps: Partial<EngineRestampModelStoreTestDeps> = {}) {
  const home = fs.mkdtempSync(path.join(root, 'home-')), children: ChildProcess[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    const timer = originalSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer); return timer;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((timer: NodeJS.Timeout) => { timers.delete(timer); originalClearTimeout(timer); }) as typeof clearTimeout);
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 });
  live.resetEngineSwitchLivenessProbe(); live.setEngineSwitchLivenessProbe(() => ({ busy: false, reason: null }));
  try {
    await withEngineRestampModelStoreTestDeps({ home: () => home, now: Date.now,
      spawnFlock: (...args: Parameters<typeof spawn>) => { const child = spawn(...args); children.push(child); return child; }, ...deps }, () => callback(home, children));
  } finally {
    // Observe before fixture repair; repair never turns a census failure into PASS.
    const descriptors = ownedFds(home);
    const alive = children.filter(child => child.exitCode === null && child.signalCode === null);
    const listeners = children.map(child => child.eventNames().filter(name => ['error', 'close'].includes(String(name))).map(name => [name, child.listenerCount(name)]));
    for (const child of alive) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    live.resetEngineSwitchLivenessProbe();
    assert.equal(timers.size, 0, 'all acquisition timers must be cleared');
    assert.deepEqual(descriptors, [], 'all fixture descriptors must close');
    assert.equal(alive.length, 0, 'all helper children must be reaped before boundary settles');
    assert.deepEqual(listeners.flat(), [], 'all helper error/close listeners must be removed');
  }
}

const acquireFaults: Array<[string, FsOperation, (args: any[]) => boolean]> = [
  ['home open', 'openSync', args => String(args[0]).includes('/home-') && !String(args[0]).includes('.cloudcli')],
  ['directory open', 'openSync', args => String(args[0]).endsWith('/.cloudcli')],
  ['lock open', 'openSync', args => String(args[0]).endsWith(LOCK)],
  ['lock fstat', 'fstatSync', args => fdName(args[0]).endsWith(LOCK)],
  ['named lock probe', 'openSync', args => String(args[0]).endsWith(LOCK) && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)],
];
for (const [name, op, predicate] of acquireFaults) test(`ER29 ${name} fault closes all retained resources`, t => fixture(t, async () => {
  const faults = inject(t, op, predicate);
  await assert.rejects(store.withEngineRestampModelStoreBoundary('acquire', async () => assert.fail('callback after failed acquisition')));
  assert.equal(faults(), 1);
}));

test('ER29 callback throw closes retained resources and preserves the primary error', t => fixture(t, async () => {
  const primary = fail();
  await assert.rejects(store.withEngineRestampModelStoreBoundary('callback', async () => { throw primary; }), error => error === primary);
}));

const promotionFaults: Array<[string, FsOperation, (args: any[]) => boolean]> = [
  ['target open', 'openSync', args => String(args[0]).endsWith('/' + TARGET)],
  ['temp open', 'openSync', args => String(args[0]).endsWith('.tmp') && Boolean(args[1] & fs.constants.O_CREAT)],
  ['temp fstat', 'fstatSync', args => fdName(args[0]).endsWith('.tmp')],
  ['temp write', 'writeFileSync', args => typeof args[0] === 'number' && fdName(args[0]).endsWith('.tmp')],
  ['temp fsync', 'fsyncSync', args => fdName(args[0]).endsWith('.tmp')],
  ['pre-rename temp probe', 'openSync', args => String(args[0]).endsWith('.tmp') && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)],
  ['rename', 'renameSync', args => String(args[0]).endsWith('.tmp')],
];
async function writeWithIntent(session: string, installFault: () => void) {
  let reservation: ReturnType<typeof live.reserveEngineRestamp>;
  try {
    await store.withEngineRestampModelStoreBoundary(session, async boundary => {
      const before = boundary.readOrdinary(); reservation = live.reserveEngineRestamp(session); assert.ok(reservation);
      const intent = makeIntent(session), canonical = db.engineRestampIntentsDb.prepare(intent);
      const owner = boundary.mintOwner(intent, canonical, reservation);
      installFault();
      boundary.writeOwned(owner, { provider: 'claude', sessionId: session, entry: null }, before.digest);
    });
  } finally { if (reservation) live.releaseEngineRestamp(reservation); }
}
for (const [name, op, predicate] of promotionFaults) test(`ER29 ${name} fault retains blocker without orphan temp or FD`, t => fixture(t, async home => {
  const session = `promotion-${name}`, faults = { count: () => 0 };
  await assert.rejects(writeWithIntent(session, () => { faults.count = inject(t, op, predicate); }));
  assert.equal(faults.count(), 1);
  assert.equal(db.engineRestampIntentsDb.has(session), true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.cloudcli')).filter(name => name.endsWith('.tmp')), []);
}));

test('ER29 persistent temp fstat uncertainty closes the descriptor and retains the blocker', t => fixture(t, async home => {
  const session = 'persistent-temp-fstat'; let faults = () => 0;
  await assert.rejects(writeWithIntent(session, () => {
    faults = inject(t, 'fstatSync', args => fdName(args[0]).endsWith('.tmp'), true);
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'injected IO seam');
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.equal(error.errors[1].message, 'ENGINE_MODEL_TEMP_FSTAT_UNCERTAIN');
    return true;
  });
  assert.equal(faults(), 3);
  assert.equal(db.engineRestampIntentsDb.has(session), true);
  assert.equal(fs.readdirSync(path.join(home, '.cloudcli')).filter(name => name.endsWith('.tmp')).length, 1);
  assert.deepEqual(ownedFds(home), []);
}));

for (const persistent of [false, true]) test(`ER29 cleanup unlink ${persistent ? 'persistent aggregation' : 'one-shot retry'}`, t => fixture(t, async home => {
  const session = `cleanup-unlink-${persistent}`;
  let count = () => 0;
  await assert.rejects(writeWithIntent(session, () => { count = inject(t, 'unlinkSync', args => String(args[0]).endsWith('.tmp'), persistent); }), error => {
    if (!persistent) return error instanceof Error && error.message === 'primary temp fault';
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].message, 'primary temp fault'); assert.equal(error.errors[1].code, 'ENGINE_MODEL_TEMP_CLEANUP_FAILED'); return true;
  });
  assert.equal(count(), persistent ? 2 : 1);
  assert.equal(db.engineRestampIntentsDb.has(session), true);
  assert.equal(fs.readdirSync(path.join(home, '.cloudcli')).filter(name => name.endsWith('.tmp')).length, persistent ? 1 : 0);
}, { afterTempFsync: () => { throw new Error('primary temp fault'); } }));

for (const persistent of [false, true]) test(`ER29 cleanup directory fsync ${persistent ? 'aggregates both failures' : 'retries once'}`, t => fixture(t, async home => {
  const session = `cleanup-fsync-${persistent}`; let count = () => 0;
  await assert.rejects(writeWithIntent(session, () => {
    count = inject(t, 'fsyncSync', args => fdName(args[0]).endsWith('/.cloudcli'), persistent);
  }), error => {
    if (!persistent) return error instanceof Error && error.message === 'primary temp fault';
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].message, 'primary temp fault');
    assert.ok(error.errors[1] instanceof AggregateError); assert.equal(error.errors[1].errors.length, 2); return true;
  });
  assert.equal(count(), persistent ? 2 : 1);
  assert.equal(db.engineRestampIntentsDb.has(session), true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.cloudcli')).filter(name => name.endsWith('.tmp')), []);
}, { afterTempFsync: () => { throw new Error('primary temp fault'); } }));

for (const persistent of [false, true]) test(`ER29 promotion directory fsync ${persistent ? 'fails with durable blocker' : 'recovers one-shot fault'}`, t => fixture(t, async home => {
  const session = `promotion-fsync-${persistent}`; let count = () => 0;
  const run = writeWithIntent(session, () => { count = inject(t, 'fsyncSync', args => fdName(args[0]).endsWith('/.cloudcli'), persistent); });
  if (persistent) await assert.rejects(run, error => error instanceof AggregateError && error.errors.length === 2);
  else await run;
  assert.equal(count(), persistent ? 2 : 1);
  assert.equal(db.engineRestampIntentsDb.has(session), true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.cloudcli')).filter(name => name.endsWith('.tmp')), []);
}));

test('ER29 promoted readback failure retains blocker and closes every descriptor', t => fixture(t, async () => {
  let renamed = false, faults = () => 0;
  await assert.rejects(writeWithIntent('readback', () => {
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', ((...args: Parameters<typeof fs.renameSync>) => { rename(...args); renamed = true; }) as typeof fs.renameSync);
    faults = inject(t, 'readSync', args => renamed && fdName(args[0]).endsWith('/' + TARGET));
  }));
  assert.equal(faults(), 1); assert.equal(db.engineRestampIntentsDb.has('readback'), true);
}));

for (const seam of ['parse', 'target-fstat', 'target-read']) test(`ER29 ${seam} refuses unknown state without resource leaks`, t => fixture(t, async home => {
  fs.writeFileSync(path.join(home, '.cloudcli', TARGET), seam === 'parse' ? '{' : JSON.stringify({ version: 1, entries: {} }, null, 2) + '\n', { mode: 0o600 });
  let faults = () => 1;
  if (seam !== 'parse') faults = inject(t, seam === 'target-fstat' ? 'fstatSync' : 'readSync', args => fdName(args[0]).endsWith('/' + TARGET));
  await assert.rejects(store.withEngineRestampModelStoreBoundary(seam, async boundary => boundary.readOrdinary()));
  assert.equal(faults(), 1);
}));

test('ER29 synchronous flock spawn throw releases retained descriptors', t => fixture(t, async () => {
  await assert.rejects(store.withEngineRestampModelStoreBoundary('spawn-throw', async () => assert.fail()), /ENGINE_MODEL_LOCK_UNCERTAIN/);
}, { spawnFlock: (() => { throw fail(); }) as typeof spawn }));

for (const failure of ['exit', 'signal', 'error', 'hard-timeout']) test(`ER29 helper ${failure} leaves zero live children and listeners`, t => {
  let observed: ChildProcess[] = [];
  return fixture(t, async (_home, children) => {
    observed = children;
    await assert.rejects(store.withEngineRestampModelStoreBoundary(`helper-${failure}`, async () => assert.fail()),
      /ENGINE_MODEL_LOCK_(UNCERTAIN|TIMEOUT)/);
  }, { spawnFlock: (() => {
    const program = failure === 'exit' ? 'process.exit(2)' : failure === 'signal' ? 'process.kill(process.pid,"SIGTERM")' : 'setInterval(()=>{},1000)';
    const child = spawn(process.execPath, ['-e', program], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    observed.push(child);
    if (failure === 'error') child.once('spawn', () => child.emit('error', new Error('synthetic child error while still alive')));
    return child;
  }) as typeof spawn });
});

for (const elapsed of [3000, 3001]) test(`combined acquisition ${elapsed}ms exact boundary`, t => {
  let clock = 0;
  return fixture(t, async () => {
    const run = store.withEngineRestampModelStoreBoundary('time-bound', async boundary => boundary.readOrdinary());
    if (elapsed === 3001) await assert.rejects(run, /ENGINE_MODEL_ACQUIRE_TIMEOUT/); else await run;
  }, { now: () => { const result = clock; clock = elapsed; return result; } });
});

for (const size of [256, 257]) test(`session UTF-8 ${size} byte boundary`, t => fixture(t, async () => {
  const run = store.withEngineRestampModelStoreBoundary('s'.repeat(size), async boundary => boundary.readOrdinary());
  if (size === 257) await assert.rejects(run, /ENGINE_MODEL_SESSION_INVALID/); else await run;
}));

function entry(sessionId: string, model: string) {
  return { provider: 'claude', sessionId, supported: true, changed: true, model, updatedAt: '2026-09-24T12:00:00.000Z' };
}
for (const bytes of [512, 513]) test(`model UTF-8 ${bytes} byte boundary`, t => fixture(t, async home => {
  const session = 'model-bound';
  fs.writeFileSync(path.join(home, '.cloudcli', TARGET), JSON.stringify({ version: 1,
    entries: { [`claude:${session}`]: entry(session, 'x'.repeat(bytes)) } }, null, 2) + '\n', { mode: 0o600 });
  const run = store.withEngineRestampModelStoreBoundary(session, async boundary => boundary.readOrdinary());
  if (bytes === 513) await assert.rejects(run, /ENGINE_MODEL_STORE_MALFORMED/); else await run;
}));

function exactSizedDocument(bytes: number): string {
  const entries: Record<string, ReturnType<typeof entry>> = {};
  for (let index = 0; index < 12000; index++) { const sid = `s${index}`; entries[`claude:${sid}`] = entry(sid, 'x'); }
  const encode = () => JSON.stringify({ version: 1, entries }, null, 2) + '\n';
  let remaining = bytes - Buffer.byteLength(encode());
  assert.ok(remaining >= 0);
  for (const value of Object.values(entries)) { const addition = Math.min(511, remaining); value.model += 'x'.repeat(addition); remaining -= addition; }
  assert.equal(remaining, 0);
  const canonical = encode(); assert.equal(Buffer.byteLength(canonical), bytes); return canonical;
}
for (const bytes of [8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) test(`canonical model store ${bytes} byte boundary`, t => fixture(t, async home => {
  fs.writeFileSync(path.join(home, '.cloudcli', TARGET), exactSizedDocument(bytes), { mode: 0o600 });
  const run = store.withEngineRestampModelStoreBoundary('size-bound', async boundary => boundary.readOrdinary());
  if (bytes > 8 * 1024 * 1024) await assert.rejects(run, /ENGINE_MODEL_STORE_TOO_LARGE/);
  else { const result = await run; assert.equal(Object.keys(result.document.entries).length, 12000); }
}));

test('lease close fault preserves callback primary, invalidates access, and withholds FIFO handoff', t => fixture(t, async home => {
  let escaped: EngineRestampModelStoreBoundary | undefined;
  const originalClose = fs.closeSync;
  let injected = false;
  const primary = new Error('callback-primary');
  await assert.rejects(store.withEngineRestampModelStoreBoundary('close-fault', async boundary => {
    escaped = boundary; boundary.readOrdinary();
    t.mock.method(fs, 'closeSync', ((fd: number) => {
      if (!injected && fdName(fd).endsWith(LOCK)) { injected = true; throw fail(); }
      return originalClose(fd);
    }) as typeof fs.closeSync);
    throw primary;
  }), error => error instanceof AggregateError
    && error.errors[0] === primary
    && (error.errors[1] as Error).message === 'ENGINE_MODEL_FD_CLOSE_RETRIED');
  assert.equal(injected, true);
  assert.throws(() => escaped!.readOrdinary(), /ENGINE_MODEL_LEASE_INACTIVE/);
  assert.deepEqual(ownedFds(home), []);
}));
