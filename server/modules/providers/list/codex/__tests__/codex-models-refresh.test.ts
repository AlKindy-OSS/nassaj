import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';

import type { CatalogLaunchScope } from '@/modules/execution-permissions/catalog-launch-scope.js';
import { runInCatalogLaunchScope } from '@/modules/execution-permissions/catalog-launch-scope.js';

import {
  CODEX_MODELS_CACHE_MAX_AGE_MS,
  CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS,
  CODEX_MODELS_REFRESH_PERMIT_ENDED,
  CODEX_MODELS_REFRESH_WAIT_MS,
  CODEX_MODELS_REFRESH_PERMIT_REQUIRED,
  codexModelsCacheStaleness,
  createCodexModelsRefresher,
  isCodexRefreshPermitEnded,
  isOlderCodexVersion,
  ownCodexRefreshTarget,
  runCodexModelsRefreshProcess,
  type CodexModelsCacheMeta,
  type CodexRefreshTarget,
} from '../codex-models-refresh.js';

const target = (codexHome: string): CodexRefreshTarget => ({ codexHome, env: { CODEX_HOME: codexHome } });

/** A catalog permit scope stand-in: the execution's identity fields plus a controllable end signal. */
const permitScope = (launchIdentity: unknown = { id: 'permit-identity' }, launchIdentityError: Error | null = null) => {
  const controller = new AbortController();
  const scope = {
    execution: { launchIdentity, launchIdentityError } as unknown as CatalogLaunchScope['execution'],
    signal: controller.signal,
  } as CatalogLaunchScope;
  return { scope, end: () => controller.abort() };
};
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
    scope: permitScope().scope,
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
    scope: permitScope().scope, identityFor: async () => ({}), spawnReserved: () => failing,
  });
  await new Promise((resolve) => setImmediate(resolve));
  failing.emit('error', new Error('spawn EACCES'));
  await assert.rejects(failed, /EACCES/u);
});

test('refresh process: SIGKILL after the hard timeout', async () => {
  const child = fakeChild();
  const run = runCodexModelsRefreshProcess(target('/h'), {
    scope: permitScope().scope, identityFor: async () => ({}), spawnReserved: () => child, hardTimeoutMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(child.killed, ['SIGKILL']);
  child.emit('exit', null, 'SIGKILL');
  await assert.rejects(run, /signal=SIGKILL/u);
});

test('refresh process: identity failure never spawns', async () => {
  let spawned = 0;
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    scope: permitScope().scope,
    identityFor: async () => { throw new Error('incompatible'); },
    spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), /incompatible/u);
  assert.equal(spawned, 0);
});

// ---------------- B-1414: bound to the caller's catalog permit ----------------

test('B-1414: outside a catalog permit scope the refresh refuses and never spawns', async () => {
  let spawned = 0;
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    identityFor: async () => ({}),
    spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), new RegExp(CODEX_MODELS_REFRESH_PERMIT_REQUIRED, 'u'));
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    scope: null,
    identityFor: async () => ({}),
    spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), new RegExp(CODEX_MODELS_REFRESH_PERMIT_REQUIRED, 'u'));
  assert.equal(spawned, 0);
});

test('B-1414: the identity comes from the caller\'s permit, never re-acquired', async () => {
  const { scope } = permitScope();
  const seenScopes: unknown[] = [];
  const seenIdentities: unknown[] = [];
  const child = fakeChild();
  const run = runCodexModelsRefreshProcess(target('/h'), {
    scope,
    identityFor: async (given) => { seenScopes.push(given); return { from: 'permit' }; },
    spawnReserved: (identity) => { seenIdentities.push(identity); return child; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('exit', 0, null);
  await run;
  assert.deepEqual(seenScopes, [scope], 'identityFor is handed the caller scope');
  assert.deepEqual(seenIdentities, [{ from: 'permit' }]);
});

test('B-1414: a permit without a launch identity rethrows the permit error and never spawns', async () => {
  let spawned = 0;
  const { scope } = permitScope(null, Object.assign(new Error('machine cli missing'), { code: 'X' }));
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    scope,
    spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), /machine cli missing/u);
  assert.equal(spawned, 0);
});

test('B-1414: the child is SIGKILLed the moment the permit ends', async () => {
  const { scope, end } = permitScope();
  const child = fakeChild();
  const run = runCodexModelsRefreshProcess(target('/h'), {
    scope, identityFor: async () => ({}), spawnReserved: () => child, hardTimeoutMs: 60_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.killed, [], 'alive while the permit holds');
  end();
  assert.deepEqual(child.killed, ['SIGKILL'], 'killed synchronously on permit end');
  child.emit('exit', null, 'SIGKILL');
  await assert.rejects(run, new RegExp(CODEX_MODELS_REFRESH_PERMIT_ENDED, 'u'));
});

test('B-1414: a permit that ended before the spawn means no spawn at all', async () => {
  const { scope, end } = permitScope();
  let spawned = 0;
  end();
  await assert.rejects(runCodexModelsRefreshProcess(target('/h'), {
    scope, identityFor: async () => ({}), spawnReserved: () => { spawned += 1; return fakeChild(); },
  }), new RegExp(CODEX_MODELS_REFRESH_PERMIT_ENDED, 'u'));
  assert.equal(spawned, 0);
});

test('B-1414: inside runInCatalogLaunchScope the refresh picks up that scope and dies when the probe settles', async () => {
  const execution = { launchIdentity: { id: 'p' }, launchIdentityError: null } as unknown as CatalogLaunchScope['execution'];
  const child = fakeChild();
  let refresh: Promise<void> | undefined;
  await runInCatalogLaunchScope(execution, async () => {
    refresh = runCodexModelsRefreshProcess(target('/h'), {
      identityFor: async () => ({}), spawnReserved: () => child, hardTimeoutMs: 60_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(child.killed, [], 'alive while the probe runs');
  });
  assert.deepEqual(child.killed, ['SIGKILL'], 'the probe settled, so its permit-bound child is killed');
  child.emit('exit', null, 'SIGKILL');
  await assert.rejects(refresh!, new RegExp(CODEX_MODELS_REFRESH_PERMIT_ENDED, 'u'));
});

// ---------------- B-1414 round 2: the wait covers the whole refresh ----------------

test('B-1414: the default wait outlasts the hard timeout, and both stay inside the 30 s permit lease', () => {
  assert.ok(CODEX_MODELS_REFRESH_WAIT_MS > CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS,
    'the caller (and its permit) must outlive the child, so the permit never cuts it short');
  assert.ok(CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS >= 20_000 && CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS <= 25_000);
  assert.ok(CODEX_MODELS_REFRESH_WAIT_MS < 30_000, 'under the default permit lease');
});

test('B-1414: a hard-timeout kill is a failure, a permit-end kill is not', async () => {
  const timedOut = fakeChild();
  const timeoutRun = runCodexModelsRefreshProcess(target('/h'), {
    scope: permitScope().scope, identityFor: async () => ({}), spawnReserved: () => timedOut, hardTimeoutMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  timedOut.emit('exit', null, 'SIGKILL');
  await assert.rejects(timeoutRun, (error: unknown) => !isCodexRefreshPermitEnded(error));

  const { scope, end } = permitScope();
  const cut = fakeChild();
  const cutRun = runCodexModelsRefreshProcess(target('/h'), {
    scope, identityFor: async () => ({}), spawnReserved: () => cut, hardTimeoutMs: 60_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  end();
  cut.emit('exit', null, 'SIGKILL');
  await assert.rejects(cutRun, (error: unknown) => isCodexRefreshPermitEnded(error));
});

test('B-1414: a refresh stopped by its permit records NO backoff; the next caller retries at once', async () => {
  let runs = 0;
  const logs: string[] = [];
  const refresher = createCodexModelsRefresher({
    runRefresh: async () => {
      runs += 1;
      throw Object.assign(new Error(CODEX_MODELS_REFRESH_PERMIT_ENDED), { code: CODEX_MODELS_REFRESH_PERMIT_ENDED });
    },
    readMeta: async () => null,
    readInstalledVersion: () => '0.156.0',
    now: () => NOW,
    backoffMs: 600_000,
    log: (message) => logs.push(message),
  });
  await refresher.ensureFresh(3, target('/h'));
  await refresher.ensureFresh(3, target('/h'));
  assert.equal(runs, 2, 'no 10-minute backoff after a permit-end stop');
  assert.ok(logs.every((line) => !/refresh failed/u.test(line)), 'not reported as a failure');
  assert.match(logs[0] ?? '', /stopped with its permit/u);
});

test('B-1414: with the default wait, the starting caller is still waiting when the refresh finishes', async () => {
  let finish: (() => void) | undefined;
  let invalidated = 0;
  let ran = false;
  const refresher = createCodexModelsRefresher({
    runRefresh: () => new Promise<void>((resolve) => { finish = () => { ran = true; resolve(); }; }),
    readMeta: async () => (ran ? { fetchedAt: NOW, clientVersion: '0.156.0' } : null),
    readInstalledVersion: () => '0.156.0',
    now: () => NOW,
    onRefreshed: () => { invalidated += 1; },
  });
  let returned = false;
  const waiting = refresher.ensureFresh(3, target('/h')).then(() => { returned = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(returned, false, 'the caller holds on while the refresh runs');
  finish!();
  await waiting;
  assert.equal(invalidated, 1);
});
