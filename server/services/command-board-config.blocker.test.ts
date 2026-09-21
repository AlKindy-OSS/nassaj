/**
 * command-board-config env-blocker tests (B-197 / ADR-072).
 *
 * VITE_IS_PLATFORM=true voids the human-review guarantee behind raw exec (every
 * session authenticates as the owner). IS_PLATFORM is a MODULE-LOAD-TIME constant
 * (constants/config.js reads process.env.VITE_IS_PLATFORM === 'true'), so this
 * lives in its own file where the env var is set BEFORE any app module import.
 *
 * Asserts the guard forces the ceiling to 'custom' regardless of what is stored:
 *   • getCommandBoardConfig() reads rawExecEnabled=false even for a stored true.
 *   • capabilityForRole/canRoleRunRawExec cannot reach 'raw' even for owner=raw.
 *   • setCommandBoardConfig refuses to ARM (raw_exec_blocked) but still allows off.
 *   • enforceRawExecEnvironmentGuard persists the drop of a stored true.
 *   • toPublicCommandBoardConfig surfaces rawExecBlockedReasons=['is_platform'].
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// MUST precede the app-module imports below (IS_PLATFORM is captured at load).
process.env.VITE_IS_PLATFORM = 'true';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'cbc-blocker-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { closeConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { appConfigDb } = await import('@/modules/database/index.js');
const {
  getCommandBoardConfig,
  setCommandBoardConfig,
  canRoleRunRawExec,
  capabilityForRole,
  enforceRawExecEnvironmentGuard,
  toPublicCommandBoardConfig,
  rawExecEnvironmentBlockers,
  RAW_EXEC_BLOCKER_IS_PLATFORM,
  COMMAND_BOARD_CONFIG_KEY,
} = await import('@/services/command-board-config.js');

closeConnection();
await initializeDatabase();

after(async () => {
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.VITE_IS_PLATFORM;
});

test('blocker is active in platform mode', () => {
  assert.deepEqual(rawExecEnvironmentBlockers(), [RAW_EXEC_BLOCKER_IS_PLATFORM]);
});

test('a stored rawExecEnabled:true is read as false (ceiling forced to custom)', () => {
  appConfigDb.set(
    COMMAND_BOARD_CONFIG_KEY,
    JSON.stringify({ roleModes: { owner: 'raw' }, rawExecEnabled: true, disabledActions: [] })
  );
  const cfg = getCommandBoardConfig();
  assert.equal(cfg.rawExecEnabled, false, 'the armed flag must read false under the blocker');
  // even with owner granted 'raw', the ceiling is custom → raw unreachable.
  assert.equal(capabilityForRole('owner', cfg), 'custom');
  assert.equal(canRoleRunRawExec('owner', cfg), false);
});

test('setCommandBoardConfig refuses to ARM while blocked, but allows disarming', () => {
  const armed = setCommandBoardConfig({ rawExecEnabled: true });
  assert.equal(armed.ok, false);
  assert.match(String(armed.error), /^raw_exec_blocked:/);
  assert.deepEqual(armed.blockers, [RAW_EXEC_BLOCKER_IS_PLATFORM]);
  // disarming is always allowed.
  assert.equal(setCommandBoardConfig({ rawExecEnabled: false }).ok, true);
});

test('enforceRawExecEnvironmentGuard persists the drop of a stored true', () => {
  appConfigDb.set(
    COMMAND_BOARD_CONFIG_KEY,
    JSON.stringify({ roleModes: { owner: 'raw' }, rawExecEnabled: true, disabledActions: [] })
  );
  const result = enforceRawExecEnvironmentGuard();
  assert.deepEqual(result.blockers, [RAW_EXEC_BLOCKER_IS_PLATFORM]);
  assert.equal(result.dropped, true);
  // the STORED bytes now say false — the settings UI cannot show a misleading true.
  assert.equal(JSON.parse(appConfigDb.get(COMMAND_BOARD_CONFIG_KEY)!).rawExecEnabled, false);
});

test('toPublicCommandBoardConfig surfaces the blocker reason', () => {
  const pub = toPublicCommandBoardConfig();
  assert.equal(pub.rawExecEnabled, false);
  assert.deepEqual(pub.rawExecBlockedReasons, [RAW_EXEC_BLOCKER_IS_PLATFORM]);
});
