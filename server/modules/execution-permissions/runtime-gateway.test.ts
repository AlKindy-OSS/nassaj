import assert from 'node:assert/strict';
import test from 'node:test';

import artifact from './fixtures/permission-capabilities.v1.json' with { type: 'json' };
import { evaluateParity } from './parity.js';
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import { createRuntimeCandidateResolver, processAlive } from './runtime-gateway.js';

const context = Object.freeze({
  launchId: 'launch-1', principalId: 'user:1', sessionId: null,
  projectId: 'project-1', workspacePath: '/workspace/project', provider: 'openai',
  body: 'codex', engine: 'sdk', entrypoint: 'ws.chat', purpose: 'sdk_turn' as const,
});

test('runtime resolver re-measures identity on every admission and detects in-process drift', () => {
  let calls = 0;
  const measuredCodex = artifact.candidates.find(candidate => candidate.body === 'codex')!;
  const resolver = createRuntimeCandidateResolver({
    resolveClaude: () => { throw new Error('not used'); },
    resolveAntigravity: () => { throw new Error('not used'); },
    resolveCodex: () => {
      calls += 1;
      return {
        buildFingerprint: calls === 1
          ? measuredCodex.evidence.measuredBuildFingerprint
          : `sha256:${'f'.repeat(64)}`,
      };
    },
    now: () => measuredCodex.evidence.measuredAt,
  });
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, resolver(context)).kind, 'parity');
  const drifted = evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, resolver(context));
  assert.equal(drifted.kind, 'deny');
  if (drifted.kind === 'deny') assert.ok(drifted.reasonCodes.includes('BINARY_DRIFT'));
  assert.equal(calls, 2);
});

test('T-1593: the boot gate is fatal only for external unknowns or live owners', async () => {
  const { isPermissionReconciliationFatal } = await import('./runtime-gateway.js');
  assert.equal(isPermissionReconciliationFatal({ unknownExternal: 0, stillActive: 0 }), false);
  assert.equal(isPermissionReconciliationFatal({ unknownExternal: 1, stillActive: 0 }), true);
  assert.equal(isPermissionReconciliationFatal({ unknownExternal: 0, stillActive: 1 }), true);
});

test('T-1593: runtime reconciliation keeps every in-process unknown scope-fenced and never blocks the generation', async () => {
  const {
    getConnection, closeConnection, migratePermissionExecution,
    createPermissionAdmission, claimPermissionLease, settlePermissionEffect,
  } = await import('@/modules/database/index.js');
  const { reconcileRuntimePermissionExecutions } = await import('./runtime-gateway.js');
  const database = getConnection();
  try {
    database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, password_hash TEXT,
      password_changed_at INTEGER, role TEXT, status TEXT, is_active INTEGER);
      INSERT INTO users VALUES (1, 'hash', NULL, 'user', 'active', 1)`);
    migratePermissionExecution(database);
    const purposes = ['spawn', 'sdk_turn', 'catalog', 'external_agent_dispatch'] as const;
    for (const [index, purpose] of purposes.entries()) {
      const id = `runtime-${index}`;
      createPermissionAdmission(database, {
        decisionId: id, leaseId: id, userId: 1, principalId: 'user:1', authenticationKind: 'session',
        authorizationGeneration: 1, launchId: id, projectId: 'project',
        workspaceDigest: '1234567890123456', provider: 'codex', body: 'codex', engine: 'sdk',
        entrypoint: 'ws.chat', purpose, requestedProfile: 'full_delegation', contractVersion: 'v1',
        profileDigest: 'profile', capabilityDigest: 'capability', releaseBuild: 'development-unsealed',
        protocolGeneration: index + 1, ownerId: 'old-server', ownerPid: 123,
        ownerBootId: 'previous-kernel-boot', ownerStartTicks: '1', effectIdentity: id,
        expiresAtMs: 20, nowMs: 1,
      });
      claimPermissionLease(database, id, 1, 2);
      settlePermissionEffect(database, id, 'reconciled_unknown', 2, 3);
    }
    const before = database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all();
    assert.deepEqual(reconcileRuntimePermissionExecutions(),
      { notStarted: 0, unknownLocal: 0, unknownExternal: 0, unknown: 0, stillActive: 0, blocked: 0, orphans: [] });
    assert.deepEqual(database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all(), before);
    // Each settled unknown fenced only its own scope; nothing blocks the generation or readiness.
    assert.equal(database.prepare('SELECT COUNT(*) FROM permission_generation_blocks').pluck().get(), 0);
    assert.equal(database.prepare('SELECT COUNT(*) FROM permission_effect_fences').pluck().get(), 4);
  } finally { closeConnection(); }
});

for (const code of ['EPERM', 'EACCES', 'EIO', 'ENOENT', 'ESRCH']) {
  test(`T-1593: kernel identity errors ${code} preserve uncertainty`, () => {
    const owner = { pid: 123, bootId: 'boot', startTicks: '100' };
    const dependencies = { kill: (() => true) as typeof process.kill,
      readFile: () => { throw Object.assign(new Error('unreadable'), { code }); } };
    assert.equal(processAlive('boot', owner, dependencies), !['ENOENT', 'ESRCH'].includes(code));
    assert.equal(processAlive('boot-unavailable', owner, dependencies), true);
    assert.equal(processAlive('new-boot', owner, dependencies), false);
    assert.equal(processAlive('boot', owner, { ...dependencies, kill: () => { throw Object.assign(new Error('kill'), { code }); } }), !['ENOENT', 'ESRCH'].includes(code));
  });
}
test('T-1593: exact start ticks distinguish PID reuse and unreadable stat', () => {
  const owner = { pid: 123, bootId: 'boot', startTicks: '100' };
  const dependencies = { kill: (() => true) as typeof process.kill, readFile: () => 'bad' };
  assert.equal(processAlive('boot', owner, dependencies), true);
  const stat = (ticks: string) => '123 (child) ' + [...Array(19).fill('0'), ticks].join(' ');
  assert.equal(processAlive('boot', owner, { ...dependencies, readFile: () => stat('100') }), true);
  assert.equal(processAlive('boot', owner, { ...dependencies, readFile: () => stat('101') }), false);
});

test('T-1593: actual index boot gate executes split counters and permits the reconciled retry', async () => {
  const fs = await import('node:fs');
  const { isPermissionReconciliationFatal } = await import('./runtime-gateway.js');
  const source = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (isPermissionReconciliationFatal(permissionReconciliation))');
  assert.ok(start > 0);
  const end = source.indexOf('\n        }', start) + '\n        }'.length;
  const gate = new Function('permissionReconciliation', 'isPermissionReconciliationFatal', source.slice(start, end));
  assert.doesNotThrow(() => gate({ unknownLocal: 1, unknownExternal: 0, stillActive: 0 }, isPermissionReconciliationFatal));
  assert.throws(() => gate({ unknownLocal: 0, unknownExternal: 1, stillActive: 0 }, isPermissionReconciliationFatal), /PERMISSION_RECONCILIATION_BLOCKED/);
  assert.doesNotThrow(() => gate({ unknownLocal: 0, unknownExternal: 0, stillActive: 0 }, isPermissionReconciliationFatal));
});

test('T-1593/B-1074: actual broker start records the validated wrapper kernel identity', async () => {
  const fs = await import('node:fs');
  const ts = await import('typescript');
  const source = fs.readFileSync(new URL('../../services/isolation/managed-claude-launch-broker.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const start = javascript.indexOf('function start(');
  const end = javascript.indexOf('function settle(', start);
  assert.ok(start >= 0 && end > start);
  const recorded: unknown[][] = [];
  const record = {};
  const item = { registration: record, expiresAt: Date.now() + 1000, started: false,
    execution: { consume() {}, markStarted(...args: unknown[]) { recorded.push(args); } } };
  const { readRuntimeProcessIdentity } = await import('./adapter.js');
  const identity = readRuntimeProcessIdentity(process.pid);
  assert.ok(identity, 'the fixture process must have a readable kernel identity');
  const run = new Function('validate', 'pending', 'fail', 'readRuntimeProcessIdentity', javascript.slice(start, end) + '; return start;')(
    () => process.pid, new Map([['launch', item]]), (code: string) => { throw new Error(code); }, readRuntimeProcessIdentity);
  assert.deepEqual(run(record, process.pid, 'wrapper-ticks', 'launch'), { ok: true });
  assert.deepEqual(recorded, [[identity]]);
  assert.deepEqual((item as typeof item & { identity: unknown }).identity, identity);
  assert.throws(() => run(record, process.pid, 'wrapper-ticks', 'launch'), /BROKER_LAUNCH_INVALID/);
  assert.equal(recorded.length, 1, 'a retry must not record another process');
  assert.equal(item.started, true);
});
