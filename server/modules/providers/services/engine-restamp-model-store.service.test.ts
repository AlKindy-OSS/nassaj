import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  engineRestampIntentsDb,
  engineRestampRequestSha256,
  initializeDatabase,
  type EngineRestampIntent,
} from '@/modules/database/index.js';

import {
  EngineRestampStoreError,
  type EngineRestampModelStoreTestDeps,
  withEngineRestampModelStoreBoundary,
} from './engine-restamp-model-store.service.js';
import { withEngineRestampModelStoreTestDeps } from './engine-restamp-model-store.test-harness.js';
import {
  releaseEngineRestamp,
  reserveEngineRestamp,
  resetEngineSwitchLivenessProbe,
  setEngineSwitchLivenessProbe,
} from './engine-switch-liveness.service.js';

const target = (home: string): string => path.join(home, '.cloudcli', 'provider-session-active-model-changes.json');
const lock = (home: string): string => path.join(home, '.cloudcli', '.provider-session-active-model-changes.lock');

function intent(sessionId: string): EngineRestampIntent {
  const value = {
    schema: 'nassaj-engine-restamp-intent/v1', operationId: '123e4567-e89b-42d3-a456-426614174000', sessionId,
    ownerProcess: { uid: process.getuid(), pid: process.pid, bootId: '12345678-1234-1234-1234-123456789012', startTicks: '1' },
    actor: { kind: 'jwt', userId: 1, authorizationGeneration: 1 },
    projectBinding: { kind: 'project', projectId: 'project-a', participantUserId: 1, controllerUserId: 1, authorityFenceSha256: 'a'.repeat(64) },
    fromPin: { engine: null, source: null }, toPin: { engine: 'anthropic', source: 'user_switch' },
    fromModel: { changed: false, model: null }, toModel: { changed: true, model: 'model-a' },
    turnsExported: 0, acknowledgedExport: false, phase: 'prepared', revision: 1,
    requestSha256: '0'.repeat(64), createdAt: '2026-09-24T12:00:00.000Z',
  } as EngineRestampIntent;
  value.requestSha256 = engineRestampRequestSha256(value);
  return value;
}

async function fixture<T>(callback: (home: string) => Promise<T>, overrides: Partial<EngineRestampModelStoreTestDeps> = {}): Promise<T> {
  const home = await mkdtemp('/var/tmp/nassaj-engine-store-');
  closeConnection(); process.env.DATABASE_PATH = path.join(home, 'db.sqlite'); await initializeDatabase();
  resetEngineSwitchLivenessProbe(); setEngineSwitchLivenessProbe(() => ({ busy: false, reason: null }));
  try {
    return await withEngineRestampModelStoreTestDeps({ home: () => home, now: Date.now, ...overrides }, () => callback(home));
  } finally {
    resetEngineSwitchLivenessProbe(); closeConnection(); delete process.env.DATABASE_PATH;
    await rm(home, { recursive: true, force: true });
  }
}

test('missing store is atomically promoted under an exact intent owner', () => fixture(async (home) => {
  await withEngineRestampModelStoreBoundary('session-a', async (boundary) => {
    const before = boundary.readOrdinary();
    const reservation = reserveEngineRestamp('session-a'); assert.ok(reservation);
    const prepared = intent('session-a'); const canonical = engineRestampIntentsDb.prepare(prepared);
    const owner = boundary.mintOwner(prepared, canonical, reservation);
    boundary.writeOwned(owner, { provider: 'claude', sessionId: 'session-a', entry: {
      provider: 'claude', sessionId: 'session-a', supported: true, changed: true,
      model: 'model-a', updatedAt: '2026-09-24T12:00:00.000Z',
    } }, before.digest);
    assert.equal(boundary.readOwned(owner).document.entries['claude:session-a']?.model, 'model-a');
    engineRestampIntentsDb.deleteExact('session-a', canonical); releaseEngineRestamp(reservation);
  });
  assert.equal(fs.statSync(path.dirname(target(home))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(target(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(lock(home)).mode & 0o777, 0o600);
}));

test('safe legacy 0755 directory is accepted without chmod', () => fixture(async (home) => {
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o755 });
  await withEngineRestampModelStoreBoundary('legacy', async (boundary) => {
    assert.deepEqual(boundary.readOrdinary().document.entries, {});
  });
  assert.equal(fs.statSync(path.join(home, '.cloudcli')).mode & 0o777, 0o755);
}));

for (const mode of [0o775, 0o777]) {
  test(`unsafe ${mode.toString(8)} directory fails closed`, () => fixture(async (home) => {
    fs.mkdirSync(path.join(home, '.cloudcli'), { mode }); fs.chmodSync(path.join(home, '.cloudcli'), mode);
    await assert.rejects(withEngineRestampModelStoreBoundary('unsafe', async () => undefined),
      (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_DIRECTORY_UNTRUSTED');
  }));
}

test('symlink target is never interpreted as an empty store', () => fixture(async (home) => {
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'outside'), '{}', { mode: 0o600 });
  fs.symlinkSync(path.join(home, 'outside'), target(home));
  await assert.rejects(withEngineRestampModelStoreBoundary('symlink', async (boundary) => boundary.readOrdinary()),
    (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_STORE_UNKNOWN');
}));

test('unresolved intent denies ordinary access before target observation', () => fixture(async (home) => {
  const prepared = intent('blocked'); const canonical = engineRestampIntentsDb.prepare(prepared);
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 }); fs.symlinkSync(path.join(home, 'missing'), target(home));
  await assert.rejects(withEngineRestampModelStoreBoundary('blocked', async (boundary) => boundary.readOrdinary()),
    (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_SESSION_BLOCKED');
  engineRestampIntentsDb.deleteExact('blocked', canonical);
}));

test('named lock replacement invalidates the retained descriptor', () => fixture(async (home) => {
  await assert.rejects(withEngineRestampModelStoreBoundary('replace-lock', async (boundary) => {
    boundary.readOrdinary(); fs.unlinkSync(lock(home)); fs.writeFileSync(lock(home), '', { mode: 0o600 });
    boundary.readOrdinary();
  }), (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_LOCK_REPLACED');
}));

test('released reservation permanently invalidates its owner', () => fixture(async () => {
  await withEngineRestampModelStoreBoundary('stale-owner', async (boundary) => {
    boundary.readOrdinary(); const reservation = reserveEngineRestamp('stale-owner'); assert.ok(reservation);
    const prepared = intent('stale-owner'); const canonical = engineRestampIntentsDb.prepare(prepared);
    const owner = boundary.mintOwner(prepared, canonical, reservation); releaseEngineRestamp(reservation);
    assert.throws(() => boundary.readOwned(owner), (error: unknown) =>
      error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_OWNER_REVOKED');
    engineRestampIntentsDb.deleteExact('stale-owner', canonical);
  });
}));

test('full-store CAS detects an uncooperative change before promotion', () => fixture(async (home) => {
  await withEngineRestampModelStoreBoundary('tamper', async (boundary) => {
    const before = boundary.readOrdinary(); const reservation = reserveEngineRestamp('tamper'); assert.ok(reservation);
    const prepared = intent('tamper'); const canonical = engineRestampIntentsDb.prepare(prepared);
    const owner = boundary.mintOwner(prepared, canonical, reservation);
    fs.writeFileSync(target(home), `${JSON.stringify({ version: 1, entries: {} }, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => boundary.writeOwned(owner, { provider: 'claude', sessionId: 'tamper', entry: null }, before.digest), (error: unknown) =>
      error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_STORE_CAS_MISMATCH');
    engineRestampIntentsDb.deleteExact('tamper', canonical); releaseEngineRestamp(reservation);
  });
}));

test('malformed and oversized stores fail closed', () => fixture(async (home) => {
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 });
  fs.writeFileSync(target(home), '{', { mode: 0o600 });
  await assert.rejects(withEngineRestampModelStoreBoundary('malformed', async (boundary) => boundary.readOrdinary()),
    (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_STORE_MALFORMED');
  fs.writeFileSync(target(home), Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(withEngineRestampModelStoreBoundary('oversized', async (boundary) => boundary.readOrdinary()),
    (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_STORE_TOO_LARGE');
}));

test('fixed flock launch has the reviewed executable, argv, fd and environment', () => {
  let captured: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  return fixture(async () => {
    await withEngineRestampModelStoreBoundary('launch-shape', async (boundary) => { boundary.readOrdinary(); });
    assert.ok(captured);
    assert.equal(captured.executable, '/usr/bin/flock');
    assert.deepEqual(captured.args, ['-x', '-E', '75', '-w', '1', '3']);
    assert.equal(captured.options.shell, false);
    assert.deepEqual(captured.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
    assert.equal(Array.isArray(captured.options.stdio), true);
    assert.equal(typeof (captured.options.stdio as unknown[])[3], 'number');
  }, { spawnFlock: (executable, args, options) => {
    captured = { executable, args, options: options ?? {} };
    return spawn(executable, args, options);
  } });
});

test('failure after temp fsync removes the exact owned temporary', () => fixture(async (home) => {
  await assert.rejects(withEngineRestampModelStoreBoundary('temp-fault', async (boundary) => {
    const before = boundary.readOrdinary(); const reservation = reserveEngineRestamp('temp-fault'); assert.ok(reservation);
    const prepared = intent('temp-fault'); const canonical = engineRestampIntentsDb.prepare(prepared);
    const owner = boundary.mintOwner(prepared, canonical, reservation);
    try { boundary.writeOwned(owner, { provider: 'claude', sessionId: 'temp-fault', entry: null }, before.digest); }
    finally { engineRestampIntentsDb.deleteExact('temp-fault', canonical); releaseEngineRestamp(reservation); }
  }), /injected-after-temp-fsync/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.cloudcli')).filter((name) => name.endsWith('.tmp')), []);
}, { afterTempFsync: () => { throw new Error('injected-after-temp-fsync'); } }));

test('temporary replacement is rejected and never deleted as the owned inode', () => {
  let replacementName = '';
  return fixture(async (home) => {
    await assert.rejects(withEngineRestampModelStoreBoundary('temp-replace', async (boundary) => {
      const before = boundary.readOrdinary(); const reservation = reserveEngineRestamp('temp-replace'); assert.ok(reservation);
      const prepared = intent('temp-replace'); const canonical = engineRestampIntentsDb.prepare(prepared);
      const owner = boundary.mintOwner(prepared, canonical, reservation);
      try { boundary.writeOwned(owner, { provider: 'claude', sessionId: 'temp-replace', entry: null }, before.digest); }
      finally { engineRestampIntentsDb.deleteExact('temp-replace', canonical); releaseEngineRestamp(reservation); }
    }), (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_TEMP_REPLACED');
    assert.equal(fs.readFileSync(path.join(home, '.cloudcli', replacementName), 'utf8'), 'replacement');
  }, { afterTempFsync: (tempPath) => {
    replacementName = path.basename(tempPath); fs.unlinkSync(tempPath);
    fs.writeFileSync(tempPath, 'replacement', { mode: 0o600 });
  } });
});

test('a second compliant process cannot pass the retained kernel flock', () => fixture(async (home) => {
  const directory = path.join(home, '.cloudcli'); fs.mkdirSync(directory, { mode: 0o700 });
  const lockFd = fs.openSync(lock(home), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const acquired = spawnSync('/usr/bin/flock', ['-x', '-n', '3'], {
    shell: false, stdio: ['ignore', 'ignore', 'ignore', lockFd],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  assert.equal(acquired.status, 0);
  try {
    await assert.rejects(withEngineRestampModelStoreBoundary('contended', async () => undefined),
      (error: unknown) => error instanceof EngineRestampStoreError
        && ['ENGINE_MODEL_LOCK_BUSY', 'ENGINE_MODEL_LOCK_TIMEOUT'].includes(error.code));
  } finally { fs.closeSync(lockFd); }
}));

test('FIFO admits exactly 128 waiters and rejects the 129th', () => {
  const immediateFlock = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  return fixture(async () => {
    let release!: () => void;
    const held = withEngineRestampModelStoreBoundary('fifo-holder', async () =>
      new Promise<void>((resolve) => { release = resolve; }));
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
    const admitted = Array.from({ length: 128 }, (_, index) =>
      withEngineRestampModelStoreBoundary(`fifo-${index}`, async () => undefined));
    await assert.rejects(withEngineRestampModelStoreBoundary('fifo-overflow', async () => undefined),
      (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_QUEUE_FULL');
    release(); await held; await Promise.all(admitted);
  }, { spawnFlock: immediateFlock as typeof spawn });
});

test('hard flock timeout sends SIGKILL and waits for close', () => {
  let killedWith: NodeJS.Signals | number | undefined;
  const delayedClose = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = (signal) => { killedWith = signal; setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; };
    return child;
  };
  return fixture(async () => {
    await assert.rejects(withEngineRestampModelStoreBoundary('flock-timeout', async () => undefined),
      (error: unknown) => error instanceof EngineRestampStoreError && error.code === 'ENGINE_MODEL_LOCK_TIMEOUT');
    assert.equal(killedWith, 'SIGKILL');
  }, { spawnFlock: delayedClose as typeof spawn });
});

test('a failed ordinary read cannot be upgraded into an owner', () => fixture(async (home) => {
  fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 });
  fs.writeFileSync(target(home), '{', { mode: 0o600 });
  await withEngineRestampModelStoreBoundary('failed-read', async (boundary) => {
    assert.throws(() => boundary.readOrdinary(), /ENGINE_MODEL_STORE_MALFORMED/);
    const reservation = reserveEngineRestamp('failed-read'); assert.ok(reservation);
    const prepared = intent('failed-read'); const canonical = engineRestampIntentsDb.prepare(prepared);
    try {
      assert.throws(() => boundary.mintOwner(prepared, canonical, reservation), /ENGINE_MODEL_OWNER_REVOKED/);
    } finally { engineRestampIntentsDb.deleteExact('failed-read', canonical); releaseEngineRestamp(reservation); }
  });
}));

test('an actual reservation for session B cannot mint a session A owner or touch its store', () => fixture(async (home) => {
  await withEngineRestampModelStoreBoundary('session-a', async (boundary) => {
    boundary.readOrdinary();
    const reservationB = reserveEngineRestamp('session-b'); assert.ok(reservationB);
    const preparedA = intent('session-a'); const canonicalA = engineRestampIntentsDb.prepare(preparedA);
    try {
      assert.throws(() => boundary.mintOwner(preparedA, canonicalA, reservationB), /ENGINE_MODEL_OWNER_REVOKED/);
      assert.equal(fs.existsSync(target(home)), false);
    } finally {
      engineRestampIntentsDb.deleteExact('session-a', canonicalA);
      assert.equal(releaseEngineRestamp(reservationB), true);
    }
  });
}));

test('an escaped owner stays invalid after release even when descriptor numbers are reused', () => fixture(async (home) => {
  let escapedBoundary: Parameters<Parameters<typeof withEngineRestampModelStoreBoundary>[1]>[0] | undefined;
  let escapedOwner: ReturnType<NonNullable<typeof escapedBoundary>['mintOwner']> | undefined;
  let liveReservation: NonNullable<ReturnType<typeof reserveEngineRestamp>> | undefined;
  let canonical = '';
  await withEngineRestampModelStoreBoundary('escaped-owner', async (boundary) => {
    boundary.readOrdinary(); liveReservation = reserveEngineRestamp('escaped-owner') ?? undefined; assert.ok(liveReservation);
    const prepared = intent('escaped-owner'); canonical = engineRestampIntentsDb.prepare(prepared);
    escapedBoundary = boundary; escapedOwner = boundary.mintOwner(prepared, canonical, liveReservation);
  });
  const reused = fs.openSync(path.join(home, 'fd-reuse'), fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
  try { assert.throws(() => escapedBoundary!.readOwned(escapedOwner!), /ENGINE_MODEL_LEASE_INACTIVE/); }
  finally {
    fs.closeSync(reused); engineRestampIntentsDb.deleteExact('escaped-owner', canonical);
    releaseEngineRestamp(liveReservation!);
  }
}));

for (const count of [50_000, 50_001]) {
  test(`model store entry boundary ${count}`, () => fixture(async (home) => {
    fs.mkdirSync(path.join(home, '.cloudcli'), { mode: 0o700 });
    const entries: Record<string, object> = {};
    for (let index = 0; index < count; index += 1) {
      const sessionId = index.toString(36);
      entries[`glm:${sessionId}`] = { provider: 'glm', sessionId, supported: false, changed: false,
        model: null, updatedAt: '2026-09-24T12:00:00.000Z' };
    }
    fs.writeFileSync(target(home), JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    const run = withEngineRestampModelStoreBoundary('entry-bound', async (boundary) => boundary.readOrdinary());
    if (count === 50_001) await assert.rejects(run, /ENGINE_MODEL_STORE_ENTRY_LIMIT/);
    else assert.equal(Object.keys((await run).document.entries).length, 50_000);
  }));
}

test('persistent temp identity uncertainty retains the blocker and reports the orphan', (t) => fixture(async (home) => {
  const originalFstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', ((fd: number, ...args: unknown[]) => {
    let name = ''; try { name = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* not a fixture descriptor */ }
    if (name.endsWith('.tmp')) throw Object.assign(new Error('persistent-temp-fstat'), { code: 'EIO' });
    return (originalFstat as (...input: unknown[]) => unknown)(fd, ...args);
  }) as typeof fs.fstatSync);
  let reservation: NonNullable<ReturnType<typeof reserveEngineRestamp>> | undefined;
  let canonical = '';
  await assert.rejects(withEngineRestampModelStoreBoundary('persistent-temp', async (boundary) => {
    const before = boundary.readOrdinary(); reservation = reserveEngineRestamp('persistent-temp') ?? undefined; assert.ok(reservation);
    const prepared = intent('persistent-temp'); canonical = engineRestampIntentsDb.prepare(prepared);
    const owner = boundary.mintOwner(prepared, canonical, reservation);
    boundary.writeOwned(owner, { provider: 'claude', sessionId: 'persistent-temp', entry: null }, before.digest);
  }), (error: unknown) => error instanceof AggregateError
    && (error.errors[0] as Error).message === 'persistent-temp-fstat'
    && error.errors[1] instanceof AggregateError);
  assert.equal(engineRestampIntentsDb.has('persistent-temp'), true);
  assert.equal(fs.readdirSync(path.join(home, '.cloudcli')).filter((name) => name.endsWith('.tmp')).length, 1);
  engineRestampIntentsDb.deleteExact('persistent-temp', canonical); releaseEngineRestamp(reservation!);
}));
