import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createConnectorCredentialRetentionService } from './connector-credential-retention.js';

test('retention runs bounded candidate cleanup independently of feature flags', () => {
  const calls: number[] = [];
  const service = createConnectorCredentialRetentionService({
    purgeExpiredCredentialCandidates: limit => { calls.push(limit); return 3; },
  });
  assert.deepEqual(service.runOnce(), { removedCandidates: 3 });
  assert.deepEqual(calls, [25]);
  assert.throws(() => service.runOnce(101), /cleanup_limit_invalid/);
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
