/**
 * command-board-custom tests (T-948 / ADR-067 Phase 2) — qa-critic veto gate.
 *
 * Covers the 23 mandated cases for owner-defined custom commands: the frozen
 * executable/interpreter/argv gates, the definition validator, execution-time
 * fail-closed resolution, the config authorization matrix, and — the load-bearing
 * regressions — the SECRET-FREE spawn env (item 1) and the B-192 no-side-effect
 * pre-insert config gate (item 2), plus the CRUD audit trail.
 *
 * Framework: node:test + node:assert/strict via tsx (the repo's server test
 * runner — see `npm run test`). Route cases exercise the REAL express router
 * (server/routes/system.js) with child_process.spawn MOCKED so no host command
 * ever runs; the fake child always exits 0 (custom commands have no gate, so the
 * only spawn a test reaches is the foreground exec). Env + mock are registered
 * BEFORE any app module is imported (node:test mocks are not hoisted).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';
import * as realChildProcess from 'node:child_process';

// ── env: force auth.js down the JWT_SECRET path + a temp DB. A fake provider key
// is planted in process.env so the "no secret leaks into the spawn env" assertion
// (case 16) is meaningful.
process.env.JWT_SECRET = 'cbc-custom-test-secret-0123456789abcdef';
process.env.NASSAJ_FAKE_PROVIDER_KEY = 'top-secret-provider-key-must-not-leak';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'cbc-custom-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

// ── spawn mock: capture cmd/args/OPTIONS (the options are the whole point of
// cases 16/17) and return a fake child that exits 0. Custom commands have no
// pre-flight gate, so a foreground exec is the only spawn any test reaches.
type SpawnCall = { cmd: string; args: string[]; options: Record<string, any> };
let spawnCalls: SpawnCall[] = [];

function fakeExitZeroChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    unref: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  process.nextTick(() => child.emit('close', 0));
  return child;
}

const fakeSpawn = (cmd: string, args: string[], options: Record<string, any> = {}) => {
  spawnCalls.push({ cmd, args: [...args], options });
  return fakeExitZeroChild();
};

mock.module('child_process', {
  namedExports: { ...realChildProcess, spawn: fakeSpawn },
});

// ── import app modules AFTER env + mock are in place.
const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { pendingServerActionsDb, auditLogDb, appConfigDb } = await import(
  '@/modules/database/index.js'
);
const { roleSatisfies } = await import('@/middleware/auth.js');
const { getAction, APP_ROOT } = await import('@/services/server-actions.js');
const {
  validateExecutable,
  validateCustomCommandDefinition,
  createCustomCommand,
  getCustomAction,
  resolveAction,
  MAX_CUSTOM_COMMANDS,
  CUSTOM_COMMANDS_CONFIG_KEY,
} = await import('@/services/command-board-custom.js');
const {
  canRoleRunAction,
  setCommandBoardConfig,
  COMMAND_BOARD_CONFIG_KEY,
} = await import('@/services/command-board-config.js');
const { default: systemRouter } = await import('../routes/system.js');

closeConnection();
await initializeDatabase();

// ── seed real user rows (audit_log.user_id → users.id FK, foreign_keys=ON).
type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };
const USER: TestUser = { id: 3, username: 'usr', role: 'user' };
const seedUser = getConnection().prepare(
  'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
);
for (const u of [OWNER, ADMIN, USER]) seedUser.run(u.id, u.username, 'x', u.role);

// ── test express app: injectable req.user + a fake WS server for broadcasts.
let currentUser: TestUser = OWNER;
const app = express();
app.use(express.json());
app.locals.wss = { clients: new Set([{ readyState: 1, send: () => {} }]) };
app.use(
  '/api/system',
  (req, _res, next) => {
    (req as express.Request & { user: TestUser }).user = currentUser;
    next();
  },
  systemRouter
);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Unique cf-connecting-ip per call → distinct rate-limit bucket (loopback peer is
// trusted, so clientIp uses cf-connecting-ip). Keeps the 5/min restart limiter
// from tripping across the suite.
let ipCounter = 0;
async function call(
  method: string,
  urlPath: string,
  opts: { user?: TestUser; body?: unknown } = {}
): Promise<{ status: number; json: () => Promise<any> }> {
  if (opts.user) currentUser = opts.user;
  ipCounter += 1;
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': `10.${Math.floor(ipCounter / 250)}.0.${(ipCounter % 250) + 1}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: () => res.json() };
}

/** Reset stored custom commands + config to the fail-closed default. */
function resetState(): void {
  appConfigDb.set(CUSTOM_COMMANDS_CONFIG_KEY, JSON.stringify([]));
  appConfigDb.set(
    COMMAND_BOARD_CONFIG_KEY,
    JSON.stringify({
      roleModes: { owner: 'safe', admin: 'none', user: 'none' },
      disabledActions: [],
    })
  );
}

const LINT = { cmd: 'npm', args: ['run', 'lint'] } as const; // an existing, non-denylisted script

/** Narrow a definition result to its error code (undefined when ok). */
function defErr(r: ReturnType<typeof validateCustomCommandDefinition>): string | undefined {
  return r.ok ? undefined : r.error;
}

after(async () => {
  server.close();
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── (1) interpreter denylist precedes the allowlist check ─────────────────────
test('1: interpreters are rejected as interpreter_forbidden BEFORE cmd_not_allowlisted', () => {
  // 'bash' with a flag arg: the interpreter gate fires first (before the allowlist
  // lookup AND before the argv loop), proving check ordering.
  assert.equal(validateExecutable('bash', ['-c', 'x']).error, 'interpreter_forbidden:bash');
  assert.equal(validateExecutable('python3', ['x']).error, 'interpreter_forbidden:python3');
  assert.ok(validateExecutable('node', []).error!.startsWith('interpreter_forbidden'));
});

// ── (2) non-interpreter, non-allowlisted executable ───────────────────────────
test('2: a non-allowlisted executable → cmd_not_allowlisted', () => {
  assert.equal(validateExecutable('ls', []).error, 'cmd_not_allowlisted:ls');
});

// ── (3) npm without `run` ─────────────────────────────────────────────────────
test('3: npm with a non-run subcommand or wrong shape is rejected', () => {
  assert.equal(validateExecutable('npm', ['exec', 'x']).error, 'npm_subcommand_must_be_run');
  assert.equal(validateExecutable('npm', ['x']).error, 'npm_args_shape');
});

// ── (4) npm run <missing script> ──────────────────────────────────────────────
test('4: npm run <script not in package.json> → npm_script_missing', () => {
  const r = validateExecutable('npm', ['run', 'this-script-does-not-exist-xyz']);
  assert.equal(r.error, 'npm_script_missing:this-script-does-not-exist-xyz');
});

// ── (5) npm run <denylisted> (incl. build:client) ─────────────────────────────
test('5: denylisted scripts (dev/start/postinstall/build:client) → denylisted', () => {
  for (const s of ['dev', 'start', 'postinstall', 'build:client']) {
    const r = validateExecutable('npm', ['run', s]);
    assert.ok(
      typeof r.error === 'string' && r.error.startsWith('npm_script_denylisted:'),
      `${s} must be denylisted, got ${r.error}`
    );
  }
});

// ── (6) npm run lint → ok ─────────────────────────────────────────────────────
test('6: npm run lint (exists, not denylisted) → ok with normalizedArgs=[run,lint]', () => {
  const r = validateExecutable('npm', ['run', 'lint']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalizedArgs, ['run', 'lint']);
  assert.equal(r.preview, 'npm run lint');
});

// ── (7) flag arg ──────────────────────────────────────────────────────────────
test('7: an arg starting with "-" → flag_arg_forbidden', () => {
  assert.equal(validateExecutable('npm', ['run', '-x']).error, 'flag_arg_forbidden');
});

// ── (8) shell metacharacters / whitespace ─────────────────────────────────────
test('8: args with whitespace/;/$ → invalid_arg', () => {
  assert.equal(validateExecutable('npm', ['run', 'a b']).error, 'invalid_arg');
  assert.equal(validateExecutable('npm', ['run', 'a;b']).error, 'invalid_arg');
  assert.equal(validateExecutable('npm', ['run', 'a$b']).error, 'invalid_arg');
});

// ── (9) too many args / arg too long ──────────────────────────────────────────
test('9: > MAX_ARGS → too_many_args; arg length > MAX_ARG_LEN → invalid_arg', () => {
  assert.equal(
    validateExecutable('npm', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).error,
    'too_many_args'
  );
  assert.equal(validateExecutable('npm', ['run', 'x'.repeat(65)]).error, 'invalid_arg');
});

// ── (10) dangerous / reserved keys ────────────────────────────────────────────
test('10: __proto__/constructor → invalid_key; a static key → key_reserved', () => {
  const base = { label: 'X', cmd: 'npm', args: ['run', 'lint'] };
  assert.equal(defErr(validateCustomCommandDefinition({ ...base, key: '__proto__' })), 'invalid_key');
  assert.equal(defErr(validateCustomCommandDefinition({ ...base, key: 'constructor' })), 'invalid_key');
  assert.equal(defErr(validateCustomCommandDefinition({ ...base, key: 'safe-restart' })), 'key_reserved');
});

// ── (11) label rejection ──────────────────────────────────────────────────────
test('11: labels with angle brackets/quotes/control chars → invalid_label', () => {
  for (const label of ['<b>', 'a"b', 'ab']) {
    assert.equal(
      defErr(validateCustomCommandDefinition({ key: 'lbl', label, cmd: 'npm', args: ['run', 'lint'] })),
      'invalid_label'
    );
  }
});

// ── (12) minRole ──────────────────────────────────────────────────────────────
test('12: invalid minRole → invalid_min_role; absent → defaults to owner', () => {
  assert.equal(
    defErr(
      validateCustomCommandDefinition({
        key: 'mr1',
        label: 'L',
        cmd: 'npm',
        args: ['run', 'lint'],
        minRole: 'root',
      })
    ),
    'invalid_min_role'
  );
  const ok = validateCustomCommandDefinition({ key: 'mr2', label: 'L', ...LINT });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.minRole, 'owner');
});

// ── (13) cap ──────────────────────────────────────────────────────────────────
test('13: exceeding MAX_CUSTOM_COMMANDS → too_many_commands', () => {
  resetState();
  for (let i = 0; i < MAX_CUSTOM_COMMANDS; i++) {
    assert.equal(createCustomCommand({ key: `cap${i}`, label: `L${i}`, ...LINT }).ok, true);
  }
  assert.equal(createCustomCommand({ key: 'capX', label: 'LX', ...LINT }).error, 'too_many_commands');
});

// ── (14) execution-time fail-closed ───────────────────────────────────────────
test('14: a stored command whose script no longer exists → getCustomAction null', () => {
  resetState();
  // Bypass the create validator to simulate a script later removed from package.json.
  appConfigDb.set(
    CUSTOM_COMMANDS_CONFIG_KEY,
    JSON.stringify([
      { key: 'stalecmd', label: 'Stale', cmd: 'npm', args: ['run', 'ghost-removed-xyz'], minRole: 'owner' },
    ])
  );
  assert.equal(getCustomAction('stalecmd'), null);
});

// ── (15) static wins over custom on key overlap ───────────────────────────────
test('15: resolveAction returns the STATIC action even if a custom shadows the key', () => {
  resetState();
  appConfigDb.set(
    CUSTOM_COMMANDS_CONFIG_KEY,
    JSON.stringify([
      { key: 'safe-restart', label: 'Shadow', cmd: 'npm', args: ['run', 'lint'], minRole: 'user' },
    ])
  );
  const resolved = resolveAction('safe-restart');
  assert.equal(resolved, getAction('safe-restart')); // same frozen static object
  assert.equal(resolved!.cmd, 'bash');
  assert.equal(getCustomAction('safe-restart'), null); // custom never shadows static
});

// ── (16) CRITICAL regression: secret-free spawn env ───────────────────────────
// ── (17) spawn without a shell, cwd === APP_ROOT ──────────────────────────────
test('16+17: a custom exec spawns with cwd=APP_ROOT, no shell, and a secret-free env', async () => {
  resetState();
  assert.equal(createCustomCommand({ key: 'runlint', label: 'Run Lint', minRole: 'owner', ...LINT }).ok, true);
  setCommandBoardConfig({ roleModes: { owner: 'general' } }); // custom commands need 'general'
  spawnCalls = [];

  const res = await call('POST', '/api/system/actions/runlint/run', { user: OWNER, body: {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'success');

  assert.equal(spawnCalls.length, 1, 'exactly one spawn (custom commands have no gate)');
  const c = spawnCalls[0]!;
  assert.equal(c.cmd, 'npm');
  assert.deepEqual(c.args, ['run', 'lint']);

  // (17) no shell, cwd is the repo root.
  assert.ok(!c.options.shell, 'a custom command must never run through a shell');
  assert.equal(c.options.cwd, APP_ROOT);

  // (16) an EXPLICIT env is passed (regression: the old code passed none → the
  // child inherited process.env), and it carries ONLY the curated passthrough.
  assert.ok(c.options.env, 'the spawn MUST receive an explicit env (secret-free passthrough)');
  assert.equal(c.options.env.PATH, process.env.PATH, 'PATH is passed through');
  assert.equal(c.options.env.JWT_SECRET, undefined, 'JWT_SECRET must NOT leak');
  assert.equal(c.options.env.DATABASE_PATH, undefined, 'DATABASE_PATH must NOT leak');
  assert.equal(c.options.env.NASSAJ_FAKE_PROVIDER_KEY, undefined, 'provider keys must NOT leak');
});

// ── (18) custom command config matrix (canRoleRunAction) ──────────────────────
test('18: a custom command needs general: safe⇒false, general⇒true, disabled⇒false, unknown⇒false', () => {
  resetState();
  assert.equal(createCustomCommand({ key: 'cust18', label: 'C', minRole: 'user', ...LINT }).ok, true);
  const cfg = (mode: string, disabled: string[] = []) => ({
    roleModes: { owner: 'safe' as const, admin: 'none' as const, user: mode },
    disabledActions: disabled,
  });
  assert.equal(canRoleRunAction('user', 'cust18', cfg('safe') as any), false);
  assert.equal(canRoleRunAction('user', 'cust18', cfg('general') as any), true);
  assert.equal(canRoleRunAction('user', 'cust18', cfg('general', ['cust18']) as any), false);
  assert.equal(canRoleRunAction('user', 'no-such-key', cfg('general') as any), false);
});

// ── (19) user, mode none, minRole user → config_denied ────────────────────────
test('19: mode=none + minRole=user → 403 action_disabled (config_denied), no exec, row retryable', async () => {
  resetState();
  assert.equal(createCustomCommand({ key: 'cu_user', label: 'CU', minRole: 'user', ...LINT }).ok, true);
  setCommandBoardConfig({ roleModes: { user: 'none' } });
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'cu_user', sessionId: 's19' });
  spawnCalls = [];

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: USER });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'action_disabled');
  assert.equal(pendingServerActionsDb.getById(id)!.status, 'pending'); // valid, reset for a higher grant
  assert.equal(spawnCalls.length, 0, 'a config-denied action must never spawn');
});

// ── (20) user, mode general, minRole owner → insufficient_role ────────────────
test('20: mode=general + minRole=owner → 403 insufficient_role (minRole gate wins), no exec', async () => {
  resetState();
  assert.equal(createCustomCommand({ key: 'cu_owner', label: 'CO', minRole: 'owner', ...LINT }).ok, true);
  setCommandBoardConfig({ roleModes: { user: 'general' } });
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'cu_owner', sessionId: 's20' });
  spawnCalls = [];

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: USER });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'insufficient_role');
  assert.equal(spawnCalls.length, 0);
});

// ── (21) user, mode general, minRole user → allowed ───────────────────────────
test('21: mode=general + minRole=user → allowed (200 success, exec runs)', async () => {
  resetState();
  assert.equal(createCustomCommand({ key: 'cu_ok', label: 'OK', minRole: 'user', ...LINT }).ok, true);
  setCommandBoardConfig({ roleModes: { user: 'general' } });
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'cu_ok', sessionId: 's21' });
  spawnCalls = [];

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: USER });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'success');
  assert.equal(spawnCalls.length, 1);
});

// ── (22) B-192: disabled static action via /actions/:type/run → no side effect ─
test('22: /actions/:type/run for a DISABLED static action → 4xx with NO row inserted', async () => {
  resetState();
  setCommandBoardConfig({ disabledActions: ['safe-restart'] });
  const before = pendingServerActionsDb.countActionable();
  spawnCalls = [];

  const res = await call('POST', '/api/system/actions/safe-restart/run', { user: OWNER, body: {} });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.equal((await res.json()).code, 'action_disabled');
  assert.equal(
    pendingServerActionsDb.countActionable(),
    before,
    'a config-denied run MUST NOT enqueue a row (no side effect — B-192)'
  );
  assert.equal(spawnCalls.length, 0, 'nothing may spawn for a config-denied run');
});

// ── (23) CRUD audit trail ─────────────────────────────────────────────────────
test('23: create/update/delete each write one command_board_custom_updated audit row (actor + op)', async () => {
  resetState();
  const isMut = (a: { action: string }) => a.action === 'command_board_custom_updated';
  const before = auditLogDb.recent(500).filter(isMut).length;

  let r = await call('POST', '/api/system/command-board-custom', {
    user: OWNER,
    body: { key: 'aud1', label: 'A1', ...LINT },
  });
  assert.equal(r.status, 201);
  r = await call('PUT', '/api/system/command-board-custom/aud1', {
    user: OWNER,
    body: { label: 'A1b', ...LINT },
  });
  assert.equal(r.status, 200);
  r = await call('DELETE', '/api/system/command-board-custom/aud1', { user: OWNER });
  assert.equal(r.status, 200);

  const records = auditLogDb.recent(500).filter(isMut);
  assert.equal(records.length - before, 3, 'exactly three audit rows for create+update+delete');
  for (const op of ['create', 'update', 'delete']) {
    const rec = records.find((a) => {
      try {
        return JSON.parse(a.metadata!).op === op;
      } catch {
        return false;
      }
    });
    assert.ok(rec, `an audit row for op=${op} must exist`);
    assert.equal(rec!.user_id, OWNER.id, `op=${op} must record the acting userId`);
  }
});
