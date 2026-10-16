/**
 * free-form-shell-gate tests (T-2037): the admission decision for a composer
 * shell one-shot, the per-user caps and the consumed-runId ledger.
 *
 * Framework: node:test + node:assert/strict via tsx, fresh SQLite per group.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { setCommandBoardConfig } from '@/services/command-board-config.js';
import {
  createOneShotLimiter,
  DEFAULT_ONESHOT_LIFETIME_MS,
  evaluateFreeFormShellAdmission,
  evaluateOneShotAttach,
  isValidRunId,
  oneShotBrakeFor,
  oneShotLifetimeMs,
  rawExecBrakeFor,
} from '@/services/free-form-shell-gate.js';

const RUN_ID = '0b6f3c1e-2d4a-4c8e-9f10-1a2b3c4d5e6f';

async function withDb(runTest: () => void | Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'ffsg-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function armRaw(): void {
  const result = setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw', admin: 'raw' } });
  assert.equal(result.ok, true);
}

function admit(overrides: Record<string, unknown> = {}) {
  return evaluateFreeFormShellAdmission({
    role: 'owner',
    command: 'git status',
    isPlainShell: true,
    hasSession: false,
    runId: RUN_ID,
    ...overrides,
  } as Parameters<typeof evaluateFreeFormShellAdmission>[0]);
}

function refusalCode(result: ReturnType<typeof admit>): string | null {
  return result.ok ? null : result.code;
}

test('admits an owner one-shot only with every brake open', async () => {
  await withDb(() => {
    armRaw();
    const result = admit();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.command, 'git status');
      assert.match(result.value.digest, /^[0-9a-f]{64}$/);
      assert.equal(result.value.runId, RUN_ID);
    }
    assert.equal(admit({ role: 'admin' }).ok, true);
  });
});

test('refuses each gate condition with its own code', async () => {
  await withDb(() => {
    assert.equal(refusalCode(admit()), 'raw_exec_disabled', 'flag off by default');
    armRaw();
    assert.equal(refusalCode(admit({ role: 'user' })), 'forbidden');
    assert.equal(refusalCode(admit({ role: null })), 'forbidden');
    assert.equal(refusalCode(admit({ isPlainShell: false })), 'oneshot_shape_invalid');
    assert.equal(refusalCode(admit({ isPlainShell: 'true' })), 'oneshot_shape_invalid');
    assert.equal(refusalCode(admit({ hasSession: true })), 'oneshot_shape_invalid');
    assert.equal(refusalCode(admit({ hasSession: undefined })), 'oneshot_shape_invalid');
    assert.equal(refusalCode(admit({ runId: 'not-a-uuid' })), 'oneshot_shape_invalid');
    assert.equal(refusalCode(admit({ runId: undefined })), 'oneshot_shape_invalid');
    assert.match(refusalCode(admit({ command: 'pm2 restart nassaj-dev' })) ?? '', /^denied_command:/);
    assert.match(refusalCode(admit({ command: 'pm2 kill' })) ?? '', /^denied_command:/);
    assert.equal(refusalCode(admit({ command: 'ls\r\nid' })), 'carriage_return_forbidden');
    assert.equal(refusalCode(admit({ command: 'echo ‮abc' })), 'forbidden_control_char');
    assert.equal(refusalCode(admit({ command: 'x'.repeat(4097) })), 'command_too_long');
    assert.equal(refusalCode(admit({ command: Array(101).fill('true').join('\n') })), 'too_many_lines');

    // Admin keeps raw only while its tier says so.
    setCommandBoardConfig({ roleModes: { admin: 'custom' } });
    assert.equal(refusalCode(admit({ role: 'admin' })), 'config_denied');
  });
});

test('rawExecBrakeFor reflects live config changes', async () => {
  await withDb(() => {
    assert.equal(rawExecBrakeFor('owner'), 'raw_exec_disabled');
    armRaw();
    assert.equal(rawExecBrakeFor('owner'), null);
    setCommandBoardConfig({ roleModes: { owner: 'custom' } });
    assert.equal(rawExecBrakeFor('owner'), 'config_denied');
    setCommandBoardConfig({ rawExecEnabled: false });
    assert.equal(rawExecBrakeFor('owner'), 'raw_exec_disabled');
  });
});

test('isValidRunId accepts UUIDs only', () => {
  assert.equal(isValidRunId(RUN_ID), true);
  assert.equal(isValidRunId(RUN_ID.toUpperCase()), true);
  assert.equal(isValidRunId(`${RUN_ID}x`), false);
  assert.equal(isValidRunId('../etc'), false);
  assert.equal(isValidRunId(42), false);
});

test('oneShotLifetimeMs honours a positive override only', () => {
  const prev = process.env.NASSAJ_ONESHOT_LIFETIME_MS;
  try {
    delete process.env.NASSAJ_ONESHOT_LIFETIME_MS;
    assert.equal(oneShotLifetimeMs(), DEFAULT_ONESHOT_LIFETIME_MS);
    process.env.NASSAJ_ONESHOT_LIFETIME_MS = '1500';
    assert.equal(oneShotLifetimeMs(), 1500);
    process.env.NASSAJ_ONESHOT_LIFETIME_MS = '-1';
    assert.equal(oneShotLifetimeMs(), DEFAULT_ONESHOT_LIFETIME_MS);
    process.env.NASSAJ_ONESHOT_LIFETIME_MS = 'abc';
    assert.equal(oneShotLifetimeMs(), DEFAULT_ONESHOT_LIFETIME_MS);
  } finally {
    if (prev === undefined) delete process.env.NASSAJ_ONESHOT_LIFETIME_MS;
    else process.env.NASSAJ_ONESHOT_LIFETIME_MS = prev;
  }
});

test('limiter: 3 live per user, released slots are reusable, release is idempotent', () => {
  const limiter = createOneShotLimiter();
  const slots = [1, 2, 3].map(() => limiter.reserve(7));
  assert.ok(slots.every((slot) => slot.ok));
  assert.deepEqual(limiter.reserve(7), { ok: false, code: 'oneshot_limit' });
  assert.equal(limiter.reserve(8).ok, true, 'caps are per user');
  const first = slots[0]!;
  if (first.ok) {
    first.release();
    first.release();
  }
  assert.equal(limiter.liveCount(7), 2);
  assert.equal(limiter.reserve(7).ok, true);
  assert.equal(limiter.reserve(7).ok, false);
});

test('limiter: 10 starts per rolling minute', () => {
  let clock = 1_000_000;
  const limiter = createOneShotLimiter({ maxLive: 100, now: () => clock });
  for (let i = 0; i < 10; i += 1) {
    const slot = limiter.reserve(1);
    assert.equal(slot.ok, true);
    if (slot.ok) slot.release();
  }
  assert.deepEqual(limiter.reserve(1), { ok: false, code: 'oneshot_limit' });
  clock += 60_001;
  assert.equal(limiter.reserve(1).ok, true);
});

test('attach-only admission needs the role and shape, never the raw-exec brakes', async () => {
  await withDb(() => {
    const attach = (overrides: Record<string, unknown> = {}) => evaluateOneShotAttach({
      role: 'owner', isPlainShell: true, hasSession: false, runId: RUN_ID.toUpperCase(), ...overrides,
    } as Parameters<typeof evaluateOneShotAttach>[0]);
    assert.deepEqual(attach(), { ok: true, value: { runId: RUN_ID } }, 'raw exec is off, attach still admitted');
    assert.deepEqual(attach({ role: 'user' }), { ok: false, code: 'forbidden' });
    assert.deepEqual(attach({ hasSession: true }), { ok: false, code: 'oneshot_shape_invalid' });
    assert.deepEqual(attach({ isPlainShell: false }), { ok: false, code: 'oneshot_shape_invalid' });
    assert.deepEqual(attach({ runId: 'x' }), { ok: false, code: 'oneshot_shape_invalid' });
  });
});

test('oneShotBrakeFor uses the current role first, then the raw-exec brakes', async () => {
  await withDb(() => {
    armRaw();
    assert.equal(oneShotBrakeFor('owner'), null);
    assert.equal(oneShotBrakeFor('admin'), null);
    assert.equal(oneShotBrakeFor('user'), 'forbidden', 'a demoted admin is stopped');
    assert.equal(oneShotBrakeFor(null), 'forbidden', 'a missing/disabled user is stopped');
    setCommandBoardConfig({ rawExecEnabled: false });
    assert.equal(oneShotBrakeFor('owner'), 'raw_exec_disabled');
  });
});
