/**
 * Unit tests for server/services/server-actions.js (ADR-066, T-944).
 *
 * This module is PURE (no DB, no spawn) so tests run without any setup or
 * isolation helper. Focus is on security-critical behaviour:
 *   - SERVER_ACTIONS allowlist shape and immutability
 *   - getAction fail-closed semantics for unknown types
 *   - buildPendingAction input validation (sessionId pattern, reason cap)
 *   - toPublic safe projection — cmd/args/gateArgs must NEVER be exposed
 *
 * Framework: node:test + node:assert/strict via tsx (matches the server suite).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVER_ACTIONS,
  getAction,
  isAllowedAction,
  listActionTypes,
  buildPendingAction,
  toPublic,
  toPublicCatalog,
  needsKillConfirmation,
} from './server-actions.js';

// ── SERVER_ACTIONS shape ────────────────────────────────────────────────────

test('SERVER_ACTIONS contains exactly the two seeded restart keys', () => {
  const keys = Object.keys(SERVER_ACTIONS).sort();
  assert.deepEqual(keys, ['force-restart', 'safe-restart'],
    `only the two restart actions must be registered; found: ${keys.join(', ')}`);
});

test('SERVER_ACTIONS does not contain any pm2 direct-restart key', () => {
  const keys = Object.keys(SERVER_ACTIONS);
  const pm2Keys = keys.filter((k) => k.toLowerCase().includes('pm2'));
  assert.deepEqual(pm2Keys, [], `pm2 must NOT appear as an action key (found: ${pm2Keys.join(', ')})`);
});

test('SERVER_ACTIONS.safe-restart has the expected static argv fields', () => {
  const action = SERVER_ACTIONS['safe-restart'];
  assert.equal(action.cmd, 'bash');
  assert.ok(Array.isArray(action.args), 'args must be an array');
  assert.ok(
    action.args.some((a) => a.includes('safe-restart.sh')),
    'args must reference safe-restart.sh'
  );
  assert.ok(
    typeof action.commandPreview === 'string' && action.commandPreview.length > 0,
    'commandPreview must be a non-empty string'
  );
});

test('SERVER_ACTIONS top-level object is frozen — mutation throws in strict mode', () => {
  assert.throws(
    () => { (SERVER_ACTIONS as Record<string, unknown>)['injection'] = {}; },
    TypeError,
    'adding a new key to the frozen object must throw'
  );
});

test('SERVER_ACTIONS.safe-restart entry is frozen — mutation throws in strict mode', () => {
  assert.throws(
    () => { (SERVER_ACTIONS['safe-restart'] as Record<string, unknown>).cmd = 'sh'; },
    TypeError,
    'mutating a frozen action entry must throw'
  );
});

// ── getAction ───────────────────────────────────────────────────────────────

test('getAction returns the definition for an allowlisted actionType', () => {
  const action = getAction('safe-restart');
  assert.ok(action !== null, 'getAction must return a non-null definition for safe-restart');
  assert.equal(action.cmd, 'bash');
});

test('getAction returns null for an unknown actionType (fail-closed)', () => {
  assert.equal(getAction('pm2-restart'), null);
  assert.equal(getAction('anything-else'), null);
  assert.equal(getAction(''), null);
  assert.equal(getAction('safe-restart; rm -rf /'), null);
  // Prototype-pollution attempt
  assert.equal(getAction('__proto__'), null);
  assert.equal(getAction('constructor'), null);
});

test('getAction returns null for non-string inputs', () => {
  assert.equal(getAction(null as unknown as string), null);
  assert.equal(getAction(undefined as unknown as string), null);
  assert.equal(getAction(42 as unknown as string), null);
  assert.equal(getAction({} as unknown as string), null);
});

// ── isAllowedAction ──────────────────────────────────────────────────────────

test('isAllowedAction is true only for allowlisted types', () => {
  assert.equal(isAllowedAction('safe-restart'), true);
  assert.equal(isAllowedAction('pm2-restart'), false);
  assert.equal(isAllowedAction('safe-restart; rm -rf /'), false);
  assert.equal(isAllowedAction(''), false);
});

// ── listActionTypes ──────────────────────────────────────────────────────────

test('listActionTypes returns the allowlisted keys', () => {
  const types = listActionTypes();
  assert.ok(Array.isArray(types));
  assert.ok(types.includes('safe-restart'));
  assert.ok(!types.includes('pm2-restart'));
});

// ── buildPendingAction ───────────────────────────────────────────────────────

test('buildPendingAction succeeds with minimal valid input', () => {
  const result = buildPendingAction({ actionType: 'safe-restart' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.actionType, 'safe-restart');
  assert.equal(result.value.sessionId, null);
  assert.equal(result.value.reason, null);
  assert.equal(result.value.requestedBy, null);
  assert.ok(typeof result.value.id === 'string' && result.value.id.length > 0);
});

test('buildPendingAction succeeds with all optional fields populated', () => {
  const expectedServerBuildId = 'a'.repeat(64);
  const result = buildPendingAction({
    actionType: 'safe-restart',
    sessionId: 'session.abc-123',
    reason: 'deploying new version',
    requestedBy: 'coordinator',
    expectedServerBuildId,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sessionId, 'session.abc-123');
  assert.equal(result.value.reason, 'deploying new version');
  assert.equal(result.value.requestedBy, 'coordinator');
  assert.equal(result.value.expectedServerBuildId, expectedServerBuildId);
});

test('buildPendingAction validates expectedServerBuildId as safe-restart-only lowercase sha256', () => {
  assert.equal(buildPendingAction({
    actionType: 'safe-restart', expectedServerBuildId: 'b'.repeat(64),
  }).ok, true);
  for (const invalid of ['b'.repeat(63), 'B'.repeat(64), '../' + 'b'.repeat(61), 42]) {
    assert.equal(buildPendingAction({
      actionType: 'safe-restart', expectedServerBuildId: invalid as string,
    }).ok, false);
  }
  const custom = buildPendingAction(
    { actionType: 'custom', expectedServerBuildId: 'b'.repeat(64) },
    { isAllowed: (type) => type === 'custom' },
  );
  assert.equal(custom.ok, false, 'custom actions must not accept server build control data');
});

test('buildPendingAction rejects an unknown actionType', () => {
  const result = buildPendingAction({ actionType: 'pm2-restart' });
  assert.equal(result.ok, false, 'pm2-restart must be rejected');
  if (result.ok) return;
  assert.ok(result.error.includes('pm2-restart'), 'error message must name the rejected type');
});

test('buildPendingAction rejects null/undefined/numeric actionType', () => {
  assert.equal(buildPendingAction({ actionType: null as unknown as string }).ok, false);
  assert.equal(buildPendingAction({ actionType: undefined as unknown as string }).ok, false);
  assert.equal(buildPendingAction({ actionType: 42 as unknown as string }).ok, false);
  assert.equal(buildPendingAction({} as { actionType: string }).ok, false);
});

test('buildPendingAction rejects sessionId that fails ^[\\w.-]{1,128}$ pattern', () => {
  const invalidIds = [
    'has space',
    'has/slash',
    'has@at',
    'has$dollar',
    'a'.repeat(129), // too long (129 chars)
  ];
  for (const sid of invalidIds) {
    const r = buildPendingAction({ actionType: 'safe-restart', sessionId: sid });
    assert.equal(r.ok, false, `sessionId="${sid.slice(0, 30)}" should be rejected but was accepted`);
  }
});

test('buildPendingAction accepts valid sessionId values', () => {
  const validIds = [
    'abc123',
    'session.id-123',
    'a'.repeat(128), // max length
    'a_b.c-d',
    'A',
  ];
  for (const sid of validIds) {
    const r = buildPendingAction({ actionType: 'safe-restart', sessionId: sid });
    assert.equal(r.ok, true, `sessionId="${sid.slice(0, 30)}" should be accepted but was rejected`);
  }
});

test('buildPendingAction accepts null and undefined sessionId (no-session coordinator request)', () => {
  const r1 = buildPendingAction({ actionType: 'safe-restart', sessionId: null });
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.value.sessionId, null);

  const r2 = buildPendingAction({ actionType: 'safe-restart' });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.value.sessionId, null);
});

test('buildPendingAction truncates reason to 300 characters', () => {
  const longReason = 'x'.repeat(500);
  const result = buildPendingAction({ actionType: 'safe-restart', reason: longReason });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.reason!.length, 300, 'reason must be capped at 300 chars');
  assert.equal(result.value.reason, 'x'.repeat(300));
});

test('buildPendingAction sets reason to null for blank/whitespace/null input', () => {
  for (const r of ['', '   ', null, undefined] as const) {
    const result = buildPendingAction({ actionType: 'safe-restart', reason: r as string });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.reason, null, `reason should be null for input ${JSON.stringify(r)}`);
    }
  }
});

test('buildPendingAction produces a unique id on each call', () => {
  const a = buildPendingAction({ actionType: 'safe-restart' });
  const b = buildPendingAction({ actionType: 'safe-restart' });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.value.id, b.value.id, 'each call must produce a unique id');
});

test('buildPendingAction does not interpolate sessionId into any command field', () => {
  const result = buildPendingAction({
    actionType: 'safe-restart',
    sessionId: 'malicious.session',
    reason: 'reason; rm -rf /',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The value object must only carry symbolic fields — no cmd/argv
  const keys = Object.keys(result.value);
  assert.ok(!keys.includes('cmd'), 'value must not carry cmd');
  assert.ok(!keys.includes('args'), 'value must not carry args');
  assert.ok(!keys.includes('argv'), 'value must not carry argv');
});

// ── toPublic ─────────────────────────────────────────────────────────────────

test('toPublic returns safe projection without cmd/args/gateArgs', () => {
  const row = {
    id: 'test-id-1',
    actionType: 'safe-restart',
    sessionId: 'sess-abc',
    reason: 'rolling restart',
    status: 'pending' as const,
    error: null,
    requestedAt: new Date().toISOString(),
    requestedBy: 'coordinator',
    executedAt: null,
    expectedServerBuildId: 'c'.repeat(64),
  };
  const pub = toPublic(row);
  assert.ok(pub !== null, 'toPublic must return an object for a valid row');
  assert.equal(pub!.id, row.id);
  assert.equal(pub!.actionType, row.actionType);
  assert.equal(pub!.sessionId, row.sessionId);
  assert.equal(pub!.status, row.status);
  assert.equal(pub!.reason, row.reason);
  assert.equal(pub!.error, null);
  assert.equal(pub!.expectedServerBuildId, row.expectedServerBuildId);
  assert.ok(typeof pub!.requestedAt === 'string');

  // SECURITY: these fields MUST NOT be present in the public shape.
  const keys = Object.keys(pub as object);
  for (const forbidden of ['cmd', 'args', 'argv', 'gateArgs', 'requestedBy', 'executedAt']) {
    assert.ok(!keys.includes(forbidden), `"${forbidden}" must not be exposed in toPublic output`);
  }
});

test('toPublic fills label and commandPreview from the allowlist (not from the row)', () => {
  const row = {
    id: 'y',
    actionType: 'safe-restart',
    sessionId: null,
    reason: null,
    status: 'pending' as const,
    error: null,
    requestedAt: new Date().toISOString(),
    requestedBy: null,
    executedAt: null,
  };
  const pub = toPublic(row);
  const action = getAction('safe-restart');
  assert.ok(action !== null);
  // commandPreview comes from the static definition, never from user input.
  assert.equal(pub!.commandPreview, action!.commandPreview);
  assert.equal(pub!.label, action!.labelKey);
});

test('toPublic returns null for non-object input', () => {
  assert.equal(toPublic(null as unknown as Parameters<typeof toPublic>[0]), null);
  assert.equal(toPublic(undefined as unknown as Parameters<typeof toPublic>[0]), null);
  assert.equal(toPublic(42 as unknown as Parameters<typeof toPublic>[0]), null);
});

test('toPublic handles an unknown actionType gracefully (label falls back to actionType)', () => {
  const row = {
    id: 'z',
    actionType: 'old-removed-action',
    sessionId: null,
    reason: null,
    status: 'failed' as const,
    error: 'unknown_action',
    requestedAt: new Date().toISOString(),
    requestedBy: null,
    executedAt: null,
  };
  const pub = toPublic(row);
  assert.ok(pub !== null);
  // label falls back to the actionType string when the action is no longer allowlisted
  assert.equal(pub!.label, 'old-removed-action');
  assert.equal(pub!.commandPreview, null);
});

// ── minRole (allowlist field) ────────────────────────────────────────────────

test('every SERVER_ACTIONS entry carries a minRole (default owner) that is frozen', () => {
  for (const [key, def] of Object.entries(SERVER_ACTIONS)) {
    assert.ok(
      typeof (def as { minRole?: unknown }).minRole === 'string' && (def as { minRole: string }).minRole.length > 0,
      `action "${key}" must declare a non-empty minRole`
    );
    assert.throws(
      () => { (def as Record<string, unknown>).minRole = 'user'; },
      TypeError,
      `minRole on "${key}" must be frozen (immutable)`
    );
  }
});

test('safe-restart is owner-only (minRole=owner) — not widened without a qa-critic veto', () => {
  assert.equal(SERVER_ACTIONS['safe-restart'].minRole, 'owner');
});

// ── toPublicCatalog ──────────────────────────────────────────────────────────

test('toPublicCatalog lists every allowlisted action with symbolic + display fields only', () => {
  const catalog = toPublicCatalog();
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.length, Object.keys(SERVER_ACTIONS).length);

  const restart = catalog.find((a) => a.actionType === 'safe-restart');
  assert.ok(restart, 'safe-restart must be present in the catalog');
  assert.equal(restart!.label, SERVER_ACTIONS['safe-restart'].labelKey);
  assert.equal(restart!.commandPreview, SERVER_ACTIONS['safe-restart'].commandPreview);
  assert.equal(restart!.minRole, 'owner');
});

test('toPublicCatalog NEVER exposes cmd/args/gateArgs/detachExec/cwd (no executable detail)', () => {
  const catalog = toPublicCatalog();
  for (const entry of catalog) {
    const keys = Object.keys(entry);
    for (const forbidden of ['cmd', 'args', 'argv', 'gateArgs', 'detachExec', 'cwd', 'description']) {
      assert.ok(!keys.includes(forbidden), `catalog entry must not expose "${forbidden}"`);
    }
    // Positive: exactly the public fields, nothing more. (commandPreview is an
    // intentional human-readable string; requiresConfirmation is a boolean UI
    // hint — the SECURITY property is that the structured cmd/args/gateArgs
    // FIELDS are absent, asserted above.)
    assert.deepEqual(
      keys.sort(),
      ['actionType', 'commandPreview', 'label', 'minRole', 'requiresConfirmation'].sort(),
      'catalog entry must carry exactly the public display fields'
    );
  }
});

// ── force-restart (ADR-066, T-1677) ──────────────────────────────────────────

test('SERVER_ACTIONS.force-restart has the expected static argv + confirmation flags', () => {
  const action = SERVER_ACTIONS['force-restart'];
  assert.ok(action, 'force-restart must be registered');
  assert.equal(action.cmd, 'bash');
  assert.equal(action.minRole, 'owner', 'force-restart must be owner-only');
  assert.equal(action.detachExec, true);
  assert.equal(action.globalIdempotent, true);
  assert.equal(action.requiresConfirmation, true, 'force-restart drives the two-step confirm');
  // SAME exec command as safe-restart — the kill is delivered by env var, NOT argv.
  assert.deepEqual([...action.args], ['scripts/preview-safe-restart.sh', '--exec']);
  assert.ok(!action.args.includes('--kill-sessions'),
    'kill must NOT be an argv flag (env-var channel only — see server-actions.js)');
  // Confirmation gate = the MUTABLE-ROOT safe-restart.sh --json session detector
  // (not preview-safe-restart.sh, which refuses --json under an OID request).
  assert.deepEqual([...action.gateArgs], ['scripts/safe-restart.sh', '--json']);
});

test('force-restart argv arrays are frozen (immutable allowlist)', () => {
  const action = SERVER_ACTIONS['force-restart'];
  assert.ok(Object.isFrozen(action));
  assert.ok(Object.isFrozen(action.args));
  assert.ok(Object.isFrozen(action.gateArgs));
});

test('toPublicCatalog surfaces requiresConfirmation per action', () => {
  const catalog = toPublicCatalog();
  const force = catalog.find((a) => a.actionType === 'force-restart');
  const safe = catalog.find((a) => a.actionType === 'safe-restart');
  assert.ok(force && safe);
  assert.equal(force!.requiresConfirmation, true, 'force-restart requiresConfirmation must be true');
  assert.equal(safe!.requiresConfirmation, false, 'safe-restart requiresConfirmation must be false');
  assert.equal(force!.minRole, 'owner');
});

test('buildPendingAction accepts a valid expectedServerBuildId for force-restart', () => {
  const buildId = 'a'.repeat(64);
  const result = buildPendingAction({ actionType: 'force-restart', expectedServerBuildId: buildId });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.expectedServerBuildId, buildId);
});

test('buildPendingAction rejects a malformed expectedServerBuildId for force-restart', () => {
  const result = buildPendingAction({ actionType: 'force-restart', expectedServerBuildId: 'NOT-HEX' });
  assert.equal(result.ok, false);
});

test('force-restart is valid with no expectedServerBuildId (plain path)', () => {
  const result = buildPendingAction({ actionType: 'force-restart' });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.expectedServerBuildId, null);
});

// ── needsKillConfirmation: the two-step confirm decision (T-1677) ─────────────

test('needsKillConfirmation asks when the client did not confirm', () => {
  assert.equal(needsKillConfirmation({ confirmKill: false, confirmedCount: 3, currentCount: 3 }), true);
  assert.equal(needsKillConfirmation({ confirmKill: undefined, confirmedCount: 0, currentCount: 0 }), true);
});

test('needsKillConfirmation asks when no valid confirmed count is supplied', () => {
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: null, currentCount: 2 }), true);
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: -1, currentCount: 2 }), true);
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 1.5, currentCount: 2 }), true);
});

test('needsKillConfirmation REJECTS a stale confirmed count lower than reality', () => {
  // Owner confirmed 2, but 3 sessions are now live → must NOT silently kill more.
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 2, currentCount: 3 }), true);
});

test('needsKillConfirmation proceeds when confirmed and the set did not grow', () => {
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 3, currentCount: 3 }), false);
  // Some sessions ended since the prompt → fewer than confirmed → proceed.
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 3, currentCount: 1 }), false);
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 0, currentCount: 0 }), false);
});

test('needsKillConfirmation fail-closed when currentCount is unknown', () => {
  // A non-integer current count (unparseable gate) is treated as +Infinity → ask.
  assert.equal(needsKillConfirmation({ confirmKill: true, confirmedCount: 5, currentCount: NaN }), true);
});
