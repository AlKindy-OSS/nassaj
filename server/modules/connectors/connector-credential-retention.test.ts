import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  connectorRetentionFailureCode,
  createConnectorCredentialRetentionService,
  OWNER_AUTH_SESSION_RETENTION_MS,
} from './connector-credential-retention.js';

test('retention runs bounded candidate cleanup independently of feature flags', () => {
  const calls: number[] = [];
  const sessionCalls: Array<[number, number]> = [];
  const service = createConnectorCredentialRetentionService({
    purgeExpiredCredentialCandidates: limit => { calls.push(limit); return 3; },
    purgeExpiredOwnerAuthSessions: (cutoffMs, limit) => { sessionCalls.push([cutoffMs, limit]); return 2; },
  }, { now: () => 100_000_000 });
  assert.deepEqual(service.runOnce(), { removedCandidates: 3, removedOwnerSessions: 2 });
  assert.deepEqual(calls, [25]);
  assert.deepEqual(sessionCalls, [[100_000_000 - OWNER_AUTH_SESSION_RETENTION_MS, 100]]);
  assert.equal(OWNER_AUTH_SESSION_RETENTION_MS, 24 * 60 * 60 * 1_000);
  assert.throws(() => service.runOnce(101), /cleanup_limit_invalid/);
});

test('every retention delete runs inside the injected write executor (the runtime fence)', () => {
  let open = false;
  const trace: string[] = [];
  const guarded = (name: string) => {
    trace.push(`${name}:${open ? 'fenced' : 'raw'}`);
    if (!open) throw new Error('connector_runtime_fence_required');
    return 1;
  };
  const service = createConnectorCredentialRetentionService({
    purgeExpiredCredentialCandidates: () => guarded('candidates'),
    purgeExpiredOwnerAuthSessions: () => guarded('sessions'),
  }, {
    now: () => 100_000_000,
    executeWrite: effect => { open = true; try { return effect(); } finally { open = false; } },
  });
  assert.deepEqual(service.runOnce(), { removedCandidates: 1, removedOwnerSessions: 1 });
  assert.deepEqual(trace, ['candidates:fenced', 'sessions:fenced']);
});

test('retention failures are logged as fixed codes only', () => {
  assert.equal(connectorRetentionFailureCode(new Error('connector_runtime_fence_required')),
    'connector_runtime_fence_required');
  assert.equal(connectorRetentionFailureCode(new Error('SQLITE_BUSY: /home/x/db.sqlite locked')),
    'connector_retention_failed');
  assert.equal(connectorRetentionFailureCode('raw string'), 'connector_retention_failed');
});

test('startup retention is isolated: it catches, logs a code, and keeps the timer', () => {
  const source = readFileSync('server/modules/connectors/connector-user-grant.production.ts', 'utf8');
  const hook = source.slice(source.indexOf('export const runConnectorCredentialRetentionAtStartup'));
  const body = hook.slice(0, hook.indexOf('\n};\n'));
  assert.match(body, /catch \(error\)/u);
  assert.doesNotMatch(body, /\.runOnce\(/u, 'every tick goes through runRetentionSafely');
  assert.match(source, /executeWrite: effect => executeConnectorPolicyV2SynchronousWrite\(effect\)/u);
});

test('official server startup invokes retention independently of distribution', () => {
  const source = readFileSync('server/index.js', 'utf8');
  const databaseIndex = source.indexOf('await initializeDatabase();');
  const reconciliationIndex = source.indexOf('reconcileRuntimePermissionExecutions();');
  const retentionIndex = source.indexOf('runConnectorCredentialRetentionAtStartup();');
  assert.ok(databaseIndex >= 0 && databaseIndex < reconciliationIndex);
  assert.ok(reconciliationIndex < retentionIndex);
  const calls = [...source.matchAll(/if \([^\n]+\) runConnectorCredentialRetentionAtStartup\(\);/gu)];
  assert.equal(calls.length, 2);
  assert.equal(source.match(/runConnectorCredentialRetentionAtStartup\(\);/gu)?.length, calls.length,
    'every retention invocation must remain inside a reviewed startup guard');
  const openGate = source.indexOf('await OID_PAIR_BOOTSTRAP.waitForOpen(');
  assert.ok(calls[0].index! < openGate && openGate < calls[1].index!);
  const invoke = calls.map(call => new Function('forwardStartup', 'OID_PAIR_BOOTSTRAP',
    'runConnectorCredentialRetentionAtStartup', call[0]));
  for (const [forward, oid, early, total] of [
    [false, false, 1, 1], [true, false, 0, 0], [false, true, 0, 1], [true, true, 0, 1],
  ] as const) {
    let count = 0;
    invoke[0](forward, oid, () => count++);
    assert.equal(count, early, `retention before open: forward=${forward}, oid=${oid}`);
    invoke[1](forward, oid, () => count++);
    assert.equal(count, total, `retention after open: forward=${forward}, oid=${oid}`);
  }
});
