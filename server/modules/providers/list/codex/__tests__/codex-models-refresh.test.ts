import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';

import {
  CODEX_MODELS_CACHE_MAX_AGE_MS,
  codexModelsCacheStaleness,
  createCodexModelsRefresher,
  isOlderCodexVersion,
  ownCodexRefreshTarget,
  runCodexModelsRefreshProcess,
  type CodexModelsCacheMeta,
  type CodexRefreshTarget,
} from '../codex-models-refresh.js';

const target = (codexHome: string): CodexRefreshTarget => ({ codexHome, env: { CODEX_HOME: codexHome } });
/** readMeta that reports `before` until the refresh ran, then a freshly fetched file. */
const metaAfterRun = (before: CodexModelsCacheMeta | null) => {
  const state = { ran: false };
  return {
    state,
    readMeta: async () => (state.ran ? { fetchedAt: NOW, clientVersion: '0.156.0' } : before),
  };
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const fresh: CodexModelsCacheMeta = { fetchedAt: NOW - 60_000, clientVersion: '0.156.0' };

test('staleness: missing, old, older client version, fresh', () => {
  assert.equal(codexModelsCacheStaleness(null, '0.156.0', NOW), 'missing');
  assert.equal(codexModelsCacheStaleness({ ...fresh, fetchedAt: null }, '0.156.0', NOW), 'old');
  assert.equal(codexModelsCacheStaleness(
    { ...fresh, fetchedAt: NOW - CODEX_MODELS_CACHE_MAX_AGE_MS - 1 }, '0.156.0', NOW), 'old');
  assert.equal(codexModelsCacheStaleness({ ...fresh, clientVersion: '0.153.2' }, '0.156.0', NOW),
    'client_version');
  assert.equal(codexModelsCacheStaleness(fresh, '0.156.0', NOW), null);
  assert.equal(codexModelsCacheStaleness(fresh, null, NOW), null, 'unknown installed version');
});

test('version comparison is numeric per component', () => {
  assert.equal(isOlderCodexVersion('0.99.0', '0.156.0'), true);
  assert.equal(isOlderCodexVersion('1.0.0', '0.156.0'), false);
  assert.equal(isOlderCodexVersion('0.156.0', '0.156.0'), false);
  assert.equal(isOlderCodexVersion(null, '0.156.0'), true);
  assert.equal(isOlderCodexVersion('garbage', '0.156.0'), true);
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('fresh cache does not spawn', async () => {
  let runs = 0;
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => { runs += 1; },
    readMeta: async () => fresh,
    readInstalledVersion: () => '0.156.0',
    now: () => NOW,
  });
  await refresher.ensureFresh(1, target('/home/user/.codex'));
  assert.equal(runs, 0);
});

test('single-flight: concurrent callers share one refresh; success invalidates', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const invalidated: Array<string | number> = [];
  const meta = metaAfterRun(null);
  const refresher = createCodexModelsRefresher({
    runRefresh: async (t) => { calls.push(t.codexHome); await gate.promise; meta.state.ran = true; },
    readMeta: meta.readMeta,
    readInstalledVersion: () => '0.156.0',
    onRefreshed: (userId) => { invalidated.push(userId); },
    now: () => NOW,
  });
  const first = refresher.ensureFresh(7, target('/home/owner/.codex'));
  const second = refresher.ensureFresh(7, target('/home/owner/.codex'));
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['/home/owner/.codex'], 'own CODEX_HOME, one spawn');
  assert.deepEqual(invalidated, [7]);
});

test('failure is logged, degrades silently, and backs off before retrying', async () => {
  let clock = NOW;
  let runs = 0;
  const logs: string[] = [];
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => { runs += 1; throw new Error('exit 1'); },
    readMeta: async () => null,
    readInstalledVersion: () => '0.156.0',
    now: () => clock,
    backoffMs: 600_000,
    log: (message) => logs.push(message),
  });
  await refresher.ensureFresh(3, target('/h'));
  await refresher.ensureFresh(3, target('/h'));
  assert.equal(runs, 1, 'no retry inside backoff');
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /refresh failed user=3 reason=missing/u);
  clock += 600_001;
  await refresher.ensureFresh(3, target('/h'));
  assert.equal(runs, 2, 'retries after backoff');
});

test('bounded wait: caller returns at waitMs; late success still invalidates', async () => {
  const gate = deferred();
  const invalidated: Array<string | number> = [];
  const meta = metaAfterRun({ ...fresh, clientVersion: '0.153.2' });
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => { await gate.promise; meta.state.ran = true; },
    readMeta: meta.readMeta,
    readInstalledVersion: () => '0.156.0',
    onRefreshed: (userId) => { invalidated.push(userId); },
    now: () => NOW,
    waitMs: 5,
  });
  await refresher.ensureFresh(1, target('/h'));
  assert.deepEqual(invalidated, [], 'returned before refresh completed');
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(invalidated, [1]);
});

test('service invalidation drops only that user catalog entry', async () => {
  const dir = mkdtempSync(path.join('/var/tmp', 'codex-models-refresh-test-'));
  try {
    let version = 1;
    const service = createProviderModelsService({
      cachePath: path.join(dir, 'cache.json'),
      runCatalogProbe: async (_provider, _userId, _principal, load) => load(),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => ({ OPTIONS: [{ value: `m${version}`, label: 'm' }], DEFAULT: `m${version}` }),
        },
      }) as never,
    });
    assert.equal((await service.getProviderModels('codex', {}, 1)).models.DEFAULT, 'm1');
    assert.equal((await service.getProviderModels('codex', {}, 2)).models.DEFAULT, 'm1');
    version = 2;
    await service.invalidateProviderModels('codex', 1);
    assert.equal((await service.getProviderModels('codex', {}, 1)).models.DEFAULT, 'm2');
    assert.equal((await service.getProviderModels('codex', {}, 2)).models.DEFAULT, 'm1', 'user 2 untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('success without a cache update backs off and does not invalidate', async () => {
  let runs = 0;
  const invalidated: Array<string | number> = [];
  const logs: string[] = [];
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => { runs += 1; },
    readMeta: async () => ({ ...fresh, fetchedAt: NOW - CODEX_MODELS_CACHE_MAX_AGE_MS - 1 }),
    readInstalledVersion: () => '0.156.0',
    onRefreshed: (userId) => { invalidated.push(userId); },
    now: () => NOW,
    log: (message) => logs.push(message),
  });
  await refresher.ensureFresh(4, target('/h4'));
  await refresher.ensureFresh(4, target('/h4'));
  assert.equal(runs, 1, 'backed off');
  assert.deepEqual(invalidated, []);
  assert.match(logs[0] ?? '', /not updated/u);
});

test('global cap: over cap returns without spawning; failed run releases its permit', async () => {
  const gates = [deferred(), deferred()];
  const started: string[] = [];
  const refresher = createCodexModelsRefresher({
    runRefresh: (t) => { started.push(t.codexHome); return gates[started.length - 1]!.promise; },
    readMeta: async () => null,
    readInstalledVersion: () => '0.156.0',
    now: () => NOW,
    waitMs: 1,
    maxConcurrent: 2,
    log: () => {},
  });
  await refresher.ensureFresh(1, target('/a'));
  await refresher.ensureFresh(2, target('/b'));
  await refresher.ensureFresh(3, target('/c'));
  assert.deepEqual(started, ['/a', '/b'], 'third home not spawned over cap');
  gates[0]!.reject(new Error('boom'));
  await new Promise((resolve) => setImmediate(resolve));
  gates.push(deferred());
  await refresher.ensureFresh(3, target('/c'));
  assert.deepEqual(started, ['/a', '/b', '/c'], 'permit released after failure');
});

test('single-flight and backoff are keyed by CODEX_HOME, not user id', async () => {
  let runs = 0;
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => { runs += 1; throw new Error('exit 1'); },
    readMeta: async () => null,
    readInstalledVersion: () => '0.156.0',
    now: () => NOW,
    log: () => {},
  });
  await refresher.ensureFresh(1, target('/shared'));
  await refresher.ensureFresh(2, target('/shared'));
  assert.equal(runs, 1);
});

test('ownCodexRefreshTarget: only the user own isolated home', () => {
  const own = (id: string | number) => ({ CODEX_HOME: `/users/${id}/.codex` });
  const deps = { isIsolated: () => true, resolveOwnEnv: own };
  assert.deepEqual(ownCodexRefreshTarget(5, own(5), deps), { codexHome: '/users/5/.codex', env: own(5) });
  assert.equal(ownCodexRefreshTarget(5, own(9), deps), null, 'grant: grantor home');
  assert.equal(ownCodexRefreshTarget(5, own(5), { ...deps, isIsolated: () => false }), null, 'shared');
  assert.equal(ownCodexRefreshTarget(5, {}, deps), null, 'operator home');
  for (const id of [null, undefined, '']) {
    assert.equal(ownCodexRefreshTarget(id, own(5), deps), null, `no user ${String(id)}`);
  }
});

const fakeChild = () => Object.assign(new EventEmitter(), { killed: [] as string[] }, {
  kill(signal: string) { this.killed.push(signal); return true; },
});

test('refresh process: target env and args reach the spawn; exit codes map', async () => {
  const child = fakeChild();
  const seen: Array<{ env: NodeJS.ProcessEnv; args: string[]; cwd: unknown }> = [];
  const run = runCodexModelsRefreshProcess(target('/users/5/.codex'), {
    identityFor: async () => ({ id: 'x' }),
    spawnReserved: (_identity, env, args, options) => { seen.push({ env, args, cwd: options.cwd }); return child; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0]?.env.CODEX_HOME, '/users/5/.codex');
  assert.deepEqual(seen[0]?.args, ['debug', 'models']);
  assert.equal(seen[0]?.cwd, '/users/5/.codex');
  child.emit('exit', 0, null);
  await run;
  const failing = fakeChild();
  const failed = runCodexModelsRefreshProcess(target('/h'), {
    identityFor: async () => ({}), spawnReserved: () => failing,
  });
  await new Promise((resolve) => setImmediate(resolve));
  failing.emit('error', new Error('spawn EACCES'));
  await assert.rejects(failed, /EACCES/u);
});

test('refresh process: SIGKILL after the hard timeout', async () => {
  const child = fakeChild();
  const run = runCodexModelsRefreshProcess(target('/h'), {
    identityFor: async () => ({}), spawnReserved: () => child, hardTimeoutMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(child.killed, ['SIGKILL']);
  child.emit('exit', null, 'SIGKILL');
  await assert.rejects(run, /signal=SIGKILL/u);
});

test('refresh process: identity failure never spawns', async () => {
  let spawned = 0;
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    identityFor: async () => { throw new Error('incompatible'); },
    spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), /incompatible/u);
  assert.equal(spawned, 0);
});
