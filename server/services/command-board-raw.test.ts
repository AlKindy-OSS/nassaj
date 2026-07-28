/**
 * command-board-raw tests (T-948 Phase 3 / ADR-070 / T-962) — the load-bearing
 * safety valves for "تنفيذ أي أمر" (raw-exec), built under a DOCUMENTED owner
 * override of qa-critic's veto. The guarantee the owner required — reliable human
 * review — rests entirely on these gates, so they are tested end-to-end through
 * the REAL express router with child_process.spawn MOCKED (no host command runs).
 *
 * Coverage:
 *   • flag OFF ⇒ reject (raw_exec_disabled), no exec
 *   • flag ON + role tier 'safe' ⇒ reject (config_denied), no exec
 *   • flag ON + role tier 'raw' ⇒ allowed (exec runs)
 *   • every class of Trojan-Source/control char rejected at INSERT and at EXECUTE
 *   • digest mismatch ⇒ reject, no exec
 *   • stored text mutated after display ⇒ digest mismatch ⇒ reject, no exec
 *   • the spawn env passed to spawn has NO JWT_SECRET/DATABASE_PATH/provider key
 *     (asserted on the ACTUAL options object handed to spawn)
 *   • cwd === APP_ROOT, cmd === bash -c
 *   • command length cap
 *   • audit written on every path (insert / reject / success)
 *   • T-966 multi-line: LF/TAB allowed → a multi-line script inserts, executes and
 *     reaches bash as one verbatim argv; CR/CRLF rejected (carriage_return_forbidden);
 *     VT/FF/NEL still forbidden; bidi/zero-width still forbidden inside a multi-line
 *     command; line cap enforced; digest + pre-exec rescan hold on multi-line text
 *
 * Framework: node:test + node:assert/strict via tsx. Env + spawn mock are set up
 * BEFORE any app module import (node:test mocks are not hoisted).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test, { after, mock } from 'node:test';

import express from 'express';
import * as realChildProcess from 'node:child_process';

// ── env: force auth.js down the JWT_SECRET path + a temp DB. A fake provider key
// is planted so the "no secret leaks into the spawn env" assertion is meaningful.
process.env.JWT_SECRET = 'cbr-raw-test-secret-0123456789abcdef';
process.env.NASSAJ_FAKE_PROVIDER_KEY = 'top-secret-provider-key-must-not-leak';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'cbr-raw-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

// ── spawn mock: capture cmd/args/OPTIONS and return a fake child that exits with
// a configurable code (default 0). Raw exec spawns exactly once per run.
type SpawnCall = { cmd: string; args: string[]; options: Record<string, any> };
let spawnCalls: SpawnCall[] = [];
let nextExitCode = 0;

function fakeChild(exitCode: number): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from('out-line\n'));
    child.stderr.emit('data', Buffer.from('err-line\n'));
    child.emit('close', exitCode);
  });
  return child;
}

const fakeSpawn = (cmd: string, args: string[], options: Record<string, any> = {}) => {
  spawnCalls.push({ cmd, args: [...args], options });
  return fakeChild(nextExitCode);
};

mock.module('child_process', {
  namedExports: { ...realChildProcess, spawn: fakeSpawn },
});

// ── import app modules AFTER env + mock are in place.
const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { auditLogDb, appConfigDb } = await import('@/modules/database/index.js');
const { APP_ROOT } = await import('@/services/server-actions.js');
const {
  validateRawCommand,
  computeDigest,
  findForbiddenControlChar,
  insertRawCommand,
  listRawCommands,
  redactSecretsForAudit,
  RAW_QUEUE_CONFIG_KEY,
  MAX_RAW_COMMAND_LEN,
  MAX_RAW_COMMAND_LINES,
} = await import('@/services/command-board-raw.js');
const { setCommandBoardConfig, getCommandBoardConfig, COMMAND_BOARD_CONFIG_KEY } = await import(
  '@/services/command-board-config.js'
);
const { default: systemRouter } = await import('../routes/system.js');

closeConnection();
await initializeDatabase();

// ── seed real user rows (audit_log.user_id → users.id FK).
type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };
const seedUser = getConnection().prepare(
  'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
);
for (const u of [OWNER, ADMIN]) seedUser.run(u.id, u.username, 'x', u.role);

// ── test express app: injectable req.user + fake WS server for broadcasts.
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

/** Enable raw-exec: flag armed + owner tier 'raw' (ADR-072: raw needs the 'raw'
 * tier explicitly — a migrated 'general'/'custom' owner is NOT implicitly raw). */
function enableRaw(): void {
  setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw' } });
}
/** Reset store + config to the fail-closed default (flag off, owner 'safe'). */
function resetState(): void {
  appConfigDb.set(RAW_QUEUE_CONFIG_KEY, JSON.stringify([]));
  appConfigDb.set(
    COMMAND_BOARD_CONFIG_KEY,
    JSON.stringify({
      roleModes: { owner: 'safe', admin: 'none', user: 'none' },
      disabledActions: [],
      rawExecEnabled: false,
    })
  );
}

/** Insert a raw row DIRECTLY into the store (bypassing the route) → its id. */
function seedRow(command: string): string {
  const id = crypto.randomUUID();
  appConfigDb.set(
    RAW_QUEUE_CONFIG_KEY,
    JSON.stringify([{ id, command, requestedBy: 'owner', requestedAt: new Date().toISOString() }])
  );
  return id;
}

after(async () => {
  server.close();
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── (1) config flag fail-closed ───────────────────────────────────────────────
test('1: rawExecEnabled defaults false and only an explicit boolean true enables it', () => {
  resetState();
  assert.equal(getCommandBoardConfig().rawExecEnabled, false);
  // corrupt / non-boolean stored value → false (fail-closed)
  appConfigDb.set(
    COMMAND_BOARD_CONFIG_KEY,
    JSON.stringify({ roleModes: { owner: 'general' }, rawExecEnabled: 'true' })
  );
  assert.equal(getCommandBoardConfig().rawExecEnabled, false);
  // setCommandBoardConfig rejects a non-boolean flag
  assert.equal(setCommandBoardConfig({ rawExecEnabled: 'yes' as any }).ok, false);
  enableRaw();
  assert.equal(getCommandBoardConfig().rawExecEnabled, true);
});

// ── (2) findForbiddenControlChar covers every mandated class ───────────────────
test('2: every Trojan-Source / control-char class is detected (unit)', () => {
  // clean strings — including legitimate Arabic (letters=Lo) with tashkeel
  // (harakat=Mn) and ordinary spaces (U+0020): none of these may be flagged.
  assert.equal(findForbiddenControlChar('echo hello'), null);
  assert.equal(findForbiddenControlChar('a b_c-1/x'), null);
  assert.equal(findForbiddenControlChar('echo "مرحبا بالعالم"'), null);
  assert.equal(findForbiddenControlChar('echo "مَرْحَبًا يا عالم"'), null);
  assert.equal(findForbiddenControlChar('git commit -m "أول إصدار"'), null);
  // T-966: LF (newline) and TAB are now PERMITTED layout controls — a multi-line
  // script and a tab-indented one must NOT be flagged.
  assert.equal(findForbiddenControlChar('echo one\necho two'), null);
  assert.equal(findForbiddenControlChar('if true; then\n\techo hi\nfi'), null);
  assert.equal(findForbiddenControlChar('echo\tindented'), null);
  const classes: Array<[string, number]> = [
    ['echo\rx', 0x0d], // CR (C0) — stays forbidden (no CRLF; LF only)
    ['echo\x0bx', 0x0b], // VT (C0) — stays forbidden
    ['echo\x0cx', 0x0c], // FF (C0) — stays forbidden
    ['echo\x7fx', 0x7f], // DEL
    ['echo\x85x', 0x85], // NEL (C1)
    ['echo؜x', 0x061c], // ALM (bidi, \p{Cf})
    ['echo​x', 0x200b], // ZWSP
    ['echo‎x', 0x200e], // LRM
    ['echo‮x', 0x202e], // RLO (override)
    ['echo⁦x', 0x2066], // LRI (isolate)
    ['echo⁩x', 0x2069], // PDI (isolate)
    ['echo﻿x', 0xfeff], // BOM
    // ── classes the old range list missed (T-962) ──
    ['echo⁠x', 0x2060], // WORD JOINER (zero-width, \p{Cf})
    ['echo⁡x', 0x2061], // FUNCTION APPLICATION (invisible math, \p{Cf})
    ['echo⁤x', 0x2064], // INVISIBLE PLUS (\p{Cf})
    ['echo x', 0x2028], // LINE SEPARATOR (\p{Zl})
    ['echo x', 0x2029], // PARAGRAPH SEPARATOR (\p{Zp})
    ['echo x', 0x00a0], // NBSP (\p{Zs})
    ['echo­x', 0x00ad], // SOFT HYPHEN (\p{Cf})
    ['echo x', 0x2009], // THIN SPACE (\p{Zs}, U+2000–200A block)
    ['echo x', 0x202f], // NARROW NO-BREAK SPACE (\p{Zs})
    ['echo x', 0x205f], // MEDIUM MATHEMATICAL SPACE (\p{Zs})
    ['echo　x', 0x3000], // IDEOGRAPHIC SPACE (\p{Zs})
    ['echo️x', 0xfe0f], // VARIATION SELECTOR-16 (Mn, listed explicitly)
  ];
  for (const [s, cp] of classes) {
    const hit = findForbiddenControlChar(s);
    assert.ok(hit, `expected a forbidden char in ${JSON.stringify(s)}`);
    assert.equal(hit!.codePoint, cp);
  }
});

// ── (3) validateRawCommand: caps + empty + control chars ──────────────────────
test('3: validateRawCommand rejects empty, over-length, and control chars', () => {
  assert.equal(validateRawCommand('').ok, false);
  assert.equal(validateRawCommand('   ').ok, false); // whitespace-only
  assert.equal(validateRawCommand('x'.repeat(MAX_RAW_COMMAND_LEN + 1)).ok, false);
  const bad = validateRawCommand('echo ‮evil');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error, 'forbidden_control_char');
    assert.equal(bad.position, 5);
  }
  const ok = validateRawCommand('echo hi | grep h');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.digest, computeDigest('echo hi | grep h'));
});

// ── (4) flag OFF ⇒ reject at insert AND execute ───────────────────────────────
test('4: flag OFF → insert and execute both 403 raw_exec_disabled, no spawn', async () => {
  resetState();
  spawnCalls = [];
  let r = await call('POST', '/api/system/command-board-raw', {
    user: OWNER,
    body: { command: 'echo hi' },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'raw_exec_disabled');

  // seed a row and try to execute with the flag still off
  const id = seedRow('echo hi');
  r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest('echo hi') },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'raw_exec_disabled');
  assert.equal(spawnCalls.length, 0);
});

// ── (5) flag ON but mode 'safe' ⇒ config_denied ───────────────────────────────
test('5: flag ON + owner mode safe → 403 config_denied, no spawn', async () => {
  resetState();
  setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'safe' } });
  spawnCalls = [];
  const r = await call('POST', '/api/system/command-board-raw', {
    user: OWNER,
    body: { command: 'echo hi' },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'config_denied');
  assert.equal(spawnCalls.length, 0);
});

// ── (6) the route floor follows the matrix, not the role name ─────────────────
// ADR-072 amended 2026-07-26 (owner decision): raw is grantable to ANY role, so
// the floor must derive from the granted tier. An admin WITHOUT the tier is still
// refused; the same admin WITH it passes — otherwise a hardcoded owner floor would
// silently override the matrix (the hidden-second-condition bug class of B-199).
test('6: an admin without the raw tier is rejected on every MUTATING raw route', async () => {
  resetState();
  enableRaw();
  // GET is deliberately excluded: it is the caller-scoped read that lets a client
  // discover its own tier (and lets the owner see a disarmed switch in order to
  // arm it). It withholds the command texts instead — asserted in 6d/6e.
  for (const [m, p] of [
    ['POST', '/api/system/command-board-raw'],
    ['POST', '/api/system/command-board-raw/x/execute'],
    ['DELETE', '/api/system/command-board-raw/x'],
  ] as const) {
    const r = await call(m, p, { user: ADMIN, body: {} });
    assert.equal(r.status, 403, `${m} ${p} must reject a role without the raw tier`);
  }
});

test('6b: an admin GRANTED the raw tier passes the floor and can insert + execute', async () => {
  resetState();
  setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw', admin: 'raw' } });
  nextExitCode = 0;
  spawnCalls = [];

  const list = await call('GET', '/api/system/command-board-raw', { user: ADMIN });
  assert.equal(list.status, 200, 'GET must accept an admin granted the raw tier');

  const ins = await call('POST', '/api/system/command-board-raw', {
    user: ADMIN,
    body: { command: 'echo admin-can-run' },
  });
  assert.equal(ins.status, 201, 'insert must accept an admin granted the raw tier');
  const row = (await ins.json()).command;
  assert.equal(row.requestedBy, ADMIN.username, 'the row must name the real actor');

  const run = await call('POST', `/api/system/command-board-raw/${row.id}/execute`, {
    user: ADMIN,
    body: { confirmationDigest: row.digest },
  });
  assert.equal(run.status, 200, 'execute must accept an admin granted the raw tier');
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['-c', 'echo admin-can-run']);
});

test('6d: GET is caller-scoped — readable while DISARMED so the owner can arm it', async () => {
  resetState(); // flag off, owner 'safe'
  const r = await call('GET', '/api/system/command-board-raw', { user: OWNER });
  assert.equal(r.status, 200, 'the arming UI reads its state here; gating it would be a dead end');
  const body = await r.json();
  assert.equal(body.rawExecEnabled, false);
  assert.deepEqual(body.commands, [], 'no tier ⇒ no queue rows leak');
  assert.deepEqual(body.rawExecBlockedReasons, []);
});

test('6e: GET tells a non-owner their own tier, and withholds the queue without it', async () => {
  resetState();
  setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw' } });
  await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command: 'echo queued' } });

  // admin has no raw tier → capability visible, rows withheld.
  const denied = await call('GET', '/api/system/command-board-raw', { user: ADMIN });
  assert.equal(denied.status, 200);
  const deniedBody = await denied.json();
  assert.notEqual(deniedBody.mode, 'raw');
  assert.deepEqual(deniedBody.commands, [], 'a role without the tier must not read command texts');

  // grant it → same endpoint now reports raw and returns the shared queue.
  setCommandBoardConfig({ roleModes: { admin: 'raw' } });
  const granted = await call('GET', '/api/system/command-board-raw', { user: ADMIN });
  const grantedBody = await granted.json();
  assert.equal(grantedBody.mode, 'raw', 'the client must be able to learn its own tier');
  assert.equal(grantedBody.commands.length, 1);
});

test('6c: disarming the master switch drops raw for EVERY granted role at once', async () => {
  resetState();
  setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw', admin: 'raw' } });
  setCommandBoardConfig({ rawExecEnabled: false });
  spawnCalls = [];
  for (const user of [OWNER, ADMIN]) {
    const r = await call('POST', '/api/system/command-board-raw', {
      user,
      body: { command: 'echo nope' },
    });
    assert.equal(r.status, 403, `${user.role} must lose raw when the ceiling drops`);
  }
  assert.equal(spawnCalls.length, 0);
});

// ── (7) happy path: insert → execute (WYSIWYG argv, secret-free env, cwd) ──────
test('7: flag ON + tier raw → insert then execute runs bash -c verbatim, secret-free env', async () => {
  resetState();
  enableRaw();
  nextExitCode = 0;
  spawnCalls = [];
  const command = 'echo hi && ls | wc -l';

  const ins = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
  assert.equal(ins.status, 201);
  const insBody = await ins.json();
  const { id, digest } = insBody.command;
  assert.equal(digest, computeDigest(command));
  assert.equal(spawnCalls.length, 0, 'insert never spawns');

  const exe = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: digest },
  });
  assert.equal(exe.status, 200);
  const exeBody = await exe.json();
  assert.equal(exeBody.status, 'success');
  assert.equal(exeBody.exitCode, 0);
  assert.equal(exeBody.stdout, 'out-line\n');
  assert.equal(exeBody.stderr, 'err-line\n');

  assert.equal(spawnCalls.length, 1, 'exactly one spawn for a raw exec');
  const c = spawnCalls[0]!;
  // (WYSIWYG) bash -c <verbatim command> — the command is a single argv element.
  assert.equal(c.cmd, 'bash');
  assert.deepEqual(c.args, ['-c', command]);
  // no shell wrapper, cwd is the repo root.
  assert.ok(!c.options.shell, 'raw exec must not add a second shell');
  assert.equal(c.options.cwd, APP_ROOT);
  // secret-free env — asserted on the ACTUAL object passed to spawn.
  assert.ok(c.options.env, 'an explicit env must be passed');
  assert.equal(c.options.env.PATH, process.env.PATH, 'PATH is passed through');
  assert.equal(c.options.env.JWT_SECRET, undefined, 'JWT_SECRET must NOT leak');
  assert.equal(c.options.env.DATABASE_PATH, undefined, 'DATABASE_PATH must NOT leak');
  assert.equal(c.options.env.NASSAJ_FAKE_PROVIDER_KEY, undefined, 'provider keys must NOT leak');

  // the row is consumed (claimed) — a second execute finds nothing.
  assert.equal(listRawCommands().length, 0);
});

// ── (8) digest mismatch ⇒ reject, no spawn ────────────────────────────────────
test('8: a wrong confirmationDigest → 400 digest_mismatch, no spawn, row kept', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  const id = seedRow('echo hi');
  const r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest('echo DIFFERENT') },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'digest_mismatch');
  assert.equal(spawnCalls.length, 0);
  assert.equal(listRawCommands().length, 1, 'a mismatched row is not consumed');
});

// ── (9) TOCTOU: stored text mutated after the digest was shown ⇒ mismatch ──────
test('9: mutating the stored command after display → digest_mismatch, no spawn', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  const shown = 'echo safe';
  const id = seedRow(shown);
  const shownDigest = computeDigest(shown);
  // attacker swaps the row content AFTER the human saw `shown`.
  appConfigDb.set(
    RAW_QUEUE_CONFIG_KEY,
    JSON.stringify([{ id, command: 'rm -rf /', requestedBy: 'x', requestedAt: 'now' }])
  );
  const r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: shownDigest },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'digest_mismatch');
  assert.equal(spawnCalls.length, 0, 'the swapped command must never run');
});

// ── (10) Trojan-Source rejected at INSERT (each class) ────────────────────────
test('10: each control-char class is rejected at INSERT with a position', async () => {
  resetState();
  enableRaw();
  const samples = ['echo‮x', 'echo⁦x', 'echo​x', 'echo\x0bx', 'echo﻿x'];
  for (const command of samples) {
    const r = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
    assert.equal(r.status, 400, `insert of ${JSON.stringify(command)} must be 400`);
    const body = await r.json();
    assert.equal(body.code, 'forbidden_control_char');
    assert.equal(typeof body.position, 'number');
  }
});

// ── (11) Trojan-Source rejected at EXECUTE too (defence in depth) ─────────────
test('11: a control char that reached the store is rejected at EXECUTE, no spawn', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  // simulate a row written by a parallel session / direct DB edit (bypassing insert).
  const command = 'echo ‮evil';
  const id = seedRow(command);
  const r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest(command) },
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.code, 'forbidden_control_char');
  assert.equal(typeof body.position, 'number');
  assert.equal(spawnCalls.length, 0, 'a forbidden-char command must never spawn');
});

// ── (12) length cap enforced at the route ─────────────────────────────────────
test('12: inserting an over-length command → 400 command_too_long, no spawn', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  const r = await call('POST', '/api/system/command-board-raw', {
    user: OWNER,
    body: { command: 'x'.repeat(MAX_RAW_COMMAND_LEN + 1) },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'command_too_long');
  assert.equal(spawnCalls.length, 0);
});

// ── (13) non-zero exit is surfaced as a failure + audited ─────────────────────
test('13: a non-zero exit → 500 exec_failed with the exitCode', async () => {
  resetState();
  enableRaw();
  nextExitCode = 3;
  spawnCalls = [];
  const command = 'exit 3';
  const id = seedRow(command);
  const r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest(command) },
  });
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.code, 'exec_failed');
  assert.equal(body.exitCode, 3);
  assert.equal(spawnCalls.length, 1);
  nextExitCode = 0;
});

// ── (14) audit trail on every path (insert / reject / success) ────────────────
test('14: insert, a reject, and a success each write a command_board_raw_exec audit row', async () => {
  resetState();
  enableRaw();
  nextExitCode = 0;
  const isRaw = (a: { action: string }) => a.action === 'command_board_raw_exec';
  const before = auditLogDb.recent(1000).filter(isRaw).length;

  // insert (result:'insert')
  const command = 'echo audited';
  const ins = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
  const { id, digest } = (await ins.json()).command;

  // a reject (digest mismatch)
  await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest('nope') },
  });

  // a success
  await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: digest },
  });

  const rows = auditLogDb.recent(1000).filter(isRaw);
  // FOUR rows, not three: the successful execute writes a STRICT pre-spawn
  // 'exec_start' record (auditRawExecStrict, routes/system.js:708,898) in
  // addition to its outcome row, so that an execution which could not be logged
  // is refused rather than run silently (routes/system.js:903-910). Expecting 3
  // here would be asserting the ABSENCE of that guard.
  assert.equal(rows.length - before, 4, 'insert + reject + exec_start + success = 4 audit rows');

  // recent() is `ORDER BY id DESC` (repositories/audit-log.ts:103), so the four
  // newest rows are the reverse of the order they were written in. Asserting the
  // exact ORDER — not just the set — is what proves 'exec_start' is a PRE-spawn
  // record: it must sit between the reject and the success, never after it.
  const metas = rows.slice(0, 4).map((a) => JSON.parse(a.metadata!));
  assert.deepEqual(
    metas.map((m) => m.result),
    ['success', 'exec_start', 'reject', 'insert'],
    'newest-first: success ← exec_start ← reject ← insert (exec_start precedes the spawn)'
  );
  const [successMeta, startMeta, rejectMeta, insertMeta] = metas;

  // every raw audit row records the actor.
  for (const a of rows.slice(0, 4)) {
    assert.equal(a.user_id, OWNER.id);
  }

  // ── payload per row, not just its label ────────────────────────────────────
  // insert: the queued command + the digest the human will be shown.
  assert.equal(insertMeta.command, command, 'the insert row records the full command');
  assert.equal(insertMeta.digest, digest);
  // reject: names the failing gate and carries no exit code (nothing ran).
  assert.equal(rejectMeta.reason, 'digest_mismatch');
  assert.equal(rejectMeta.id, id, 'the reject row names the row it refused');
  assert.equal(rejectMeta.exitCode, undefined, 'a rejected attempt has no exit code');
  // exec_start: binds THIS row id + digest + command, and is written before any
  // outcome is known, so it must not claim an exit code either.
  assert.equal(startMeta.id, id, 'exec_start identifies the row about to run');
  assert.equal(startMeta.digest, digest);
  assert.equal(startMeta.command, command);
  assert.equal(startMeta.exitCode, undefined, 'exec_start precedes the outcome');
  assert.equal(typeof startMeta.auditNonce, 'string', 'strict audit embeds a read-back nonce');
  // success: the outcome row carries the exit code.
  assert.equal(successMeta.command, command, 'the full command is recorded in the audit metadata');
  assert.equal(successMeta.digest, digest);
  assert.equal(successMeta.exitCode, 0);
});

// ── (15) not_found for an unknown id ──────────────────────────────────────────
test('15: executing an unknown id → 404 not_found, no spawn', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  const r = await call('POST', '/api/system/command-board-raw/does-not-exist/execute', {
    user: OWNER,
    body: { confirmationDigest: computeDigest('x') },
  });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'not_found');
  assert.equal(spawnCalls.length, 0);
});

// ── (16) T-962: the newly-covered invisible/space classes rejected end-to-end ──
test('16: word-joiner / U+2028-2029 / unicode spaces / soft hyphen / variation selector are rejected at INSERT and EXECUTE', async () => {
  resetState();
  enableRaw();
  // one representative code point per newly-covered class, via \u escapes so the
  // intent is unambiguous (not an invisible glyph in the source).
  const samples: Array<[string, string]> = [
    ['echo ⁠x', 'WORD JOINER U+2060 (Cf, zero-width)'],
    ['echo ⁡x', 'FUNCTION APPLICATION U+2061 (Cf, invisible math)'],
    ['echo ls', 'LINE SEPARATOR U+2028 (Zl)'],
    ['echo ls', 'PARAGRAPH SEPARATOR U+2029 (Zp)'],
    ['echo hi', 'NBSP U+00A0 (Zs)'],
    ['echo­hi', 'SOFT HYPHEN U+00AD (Cf)'],
    ['echo hi', 'THIN SPACE U+2009 (Zs)'],
    ['echo hi', 'NARROW NO-BREAK SPACE U+202F (Zs)'],
    ['echo hi', 'MEDIUM MATHEMATICAL SPACE U+205F (Zs)'],
    ['echo　hi', 'IDEOGRAPHIC SPACE U+3000 (Zs)'],
    ['echo hi️', 'VARIATION SELECTOR-16 U+FE0F (Mn)'],
  ];
  for (const [command, label] of samples) {
    spawnCalls = [];
    // rejected at INSERT (with a position)
    const ins = await call('POST', '/api/system/command-board-raw', {
      user: OWNER,
      body: { command },
    });
    assert.equal(ins.status, 400, `insert must reject ${label}`);
    const insBody = await ins.json();
    assert.equal(insBody.code, 'forbidden_control_char', `insert code for ${label}`);
    assert.equal(typeof insBody.position, 'number', `insert position for ${label}`);

    // and rejected again at EXECUTE (row planted directly, bypassing insert)
    const id = seedRow(command);
    const exe = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
      user: OWNER,
      body: { confirmationDigest: computeDigest(command) },
    });
    assert.equal(exe.status, 400, `execute must reject ${label}`);
    const exeBody = await exe.json();
    assert.equal(exeBody.code, 'forbidden_control_char', `execute code for ${label}`);
    assert.equal(typeof exeBody.position, 'number', `execute position for ${label}`);
    assert.equal(spawnCalls.length, 0, `${label} must never spawn`);
  }
});

// ── (17) no over-blocking: ordinary space + legitimate Arabic pass end-to-end ──
test('17: an ordinary-space + Arabic (incl. tashkeel) command inserts AND executes verbatim', async () => {
  resetState();
  enableRaw();
  nextExitCode = 0;
  spawnCalls = [];
  const command = 'echo "مَرْحَبًا يا عالم"'; // Arabic letters (Lo) + harakat (Mn) + U+0020
  assert.equal(findForbiddenControlChar(command), null, 'legitimate Arabic must be clean');

  const ins = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
  assert.equal(ins.status, 201, 'a legitimate Arabic command must insert');
  const { id, digest } = (await ins.json()).command;

  const exe = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: digest },
  });
  assert.equal(exe.status, 200, 'a legitimate Arabic command must execute');
  assert.equal(spawnCalls.length, 1, 'exactly one spawn');
  assert.deepEqual(spawnCalls[0]!.args, ['-c', command], 'executed VERBATIM (WYSIWYG), not stripped');
});

// ── (18) B-197 branch ٣: inline credentials are redacted in the AUDIT copy ────
//
// audit_log stores the FULL raw command so no execution is unlogged, but a raw
// command is the owner's own free-form shell and may carry an inline secret. The
// sink is owner-only yet long-lived and exported, so the labelled credential
// VALUES must not be written verbatim — while the EXECUTED bytes stay verbatim
// (WYSIWYG) and the digest keeps binding the original text.

test('18: redactSecretsForAudit masks labelled credential values, and only those (unit)', () => {
  const cases: [string, string][] = [
    ['psql "postgres://x" PGPASSWORD=hunter2', 'psql "postgres://x" PGPASSWORD=«redacted»'],
    ['curl -H "Authorization: Bearer eyJabc.def_ghi-123"', 'curl -H "Authorization: Bearer «redacted»"'],
    ['deploy --api-key=sk-live-abcdef123456', 'deploy --api-key=«redacted»'],
    ['deploy --token sk-live-abcdef123456', 'deploy --token «redacted»'],
    ['export MY_SECRET=abc123', 'export MY_SECRET=«redacted»'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSecretsForAudit(input), expected, `redaction of: ${input}`);
  }
  // No credential label ⇒ the command is preserved verbatim (forensic value).
  for (const clean of ['ls -la /tmp', 'npm run lint && git status', 'echo "مرحبا بالعالم"']) {
    assert.equal(redactSecretsForAudit(clean), clean);
  }
  assert.equal(redactSecretsForAudit(undefined as any), null);
});

test('18b: an executed command with an inline secret is stored+run verbatim but audited redacted', async () => {
  resetState();
  enableRaw();
  nextExitCode = 0;
  spawnCalls = [];
  const secret = 'hunter2-super-secret';
  const command = `echo start && MY_TOKEN=${secret} true`;

  const ins = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
  assert.equal(ins.status, 201);
  const { id, digest } = (await ins.json()).command;

  const run = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: digest },
  });
  assert.equal(run.status, 200);

  // WYSIWYG intact: bash received the ORIGINAL bytes, secret included.
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['-c', command]);

  // …but no audit row contains the raw secret.
  const rows = auditLogDb
    .recent(1000)
    .filter((a) => a.action === 'command_board_raw_exec' && typeof a.metadata === 'string');
  assert.ok(rows.length >= 3, 'insert + exec_start + success rows exist');
  for (const row of rows) {
    assert.equal(
      row.metadata!.includes(secret),
      false,
      `audit row must not carry the inline secret: ${row.metadata}`
    );
  }
  // The command SHAPE survives, so the trail is still useful.
  const withCommand = rows.filter((a) => (JSON.parse(a.metadata!).command ?? '').includes('echo start'));
  assert.ok(withCommand.length >= 1, 'the redacted command is still recorded');
});

// ── (19) T-966: a MULTI-LINE command inserts, executes, and reaches bash verbatim
test('19: a multi-line bash script inserts, executes, and reaches bash as one verbatim argv', async () => {
  resetState();
  enableRaw();
  nextExitCode = 0;
  spawnCalls = [];
  // a several-line script exactly as it would be pasted from a chat code block:
  // LF separators and a TAB indent — both now permitted.
  const command = 'set -e\nfor i in 1 2 3; do\n\techo "line $i"\ndone';
  assert.equal(findForbiddenControlChar(command), null, 'LF + TAB script must be clean');

  const ins = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
  assert.equal(ins.status, 201, 'a multi-line command must insert');
  const { id, digest } = (await ins.json()).command;
  assert.equal(digest, computeDigest(command), 'digest is over the full multi-line UTF-8 bytes');

  const exe = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: digest },
  });
  assert.equal(exe.status, 200, 'a multi-line command must execute');
  assert.equal(spawnCalls.length, 1, 'exactly one spawn — no second shell');
  // argv is ['-c', <the whole script verbatim, newlines and tab intact>].
  assert.deepEqual(spawnCalls[0]!.args, ['-c', command]);
  assert.ok(spawnCalls[0]!.args[1]!.includes('\n'), 'the newline survived to argv');
  assert.ok(spawnCalls[0]!.args[1]!.includes('\t'), 'the tab survived to argv');
});

// ── (20) T-966: CR (bare and CRLF) is rejected with a DISTINCT, clear code ─────
test('20: a bare CR and a CRLF paste are rejected (carriage_return_forbidden) at insert and execute', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];

  // unit: distinct code + position, at both validate boundaries.
  const bareCr = validateRawCommand('echo a\recho b');
  assert.equal(bareCr.ok, false);
  if (!bareCr.ok) {
    assert.equal(bareCr.error, 'carriage_return_forbidden');
    assert.equal(bareCr.position, 6);
  }
  const crlf = validateRawCommand('echo a\r\necho b');
  assert.equal(crlf.ok, false);
  if (!crlf.ok) assert.equal(crlf.error, 'carriage_return_forbidden');

  // route INSERT: both forms rejected 400 with the distinct code.
  for (const command of ['echo a\recho b', 'echo a\r\necho b']) {
    const r = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
    assert.equal(r.status, 400, `CR insert must be 400: ${JSON.stringify(command)}`);
    const body = await r.json();
    assert.equal(body.code, 'carriage_return_forbidden');
    assert.equal(typeof body.position, 'number');
  }

  // route EXECUTE: a CR planted directly in the store is still refused, no spawn.
  // (Defence-in-depth at execute is the generic control-char scan, so the code
  // there is forbidden_control_char — the point is it never runs.)
  const command = 'echo a\r\necho b';
  const id = seedRow(command);
  const exe = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest(command) },
  });
  assert.equal(exe.status, 400, 'a CR row must be refused at execute');
  const exeBody = await exe.json();
  assert.equal(exeBody.code, 'forbidden_control_char');
  assert.equal(spawnCalls.length, 0, 'a CR command must never spawn');
});

// ── (21) T-966: VT / FF / NEL stay forbidden even though LF/TAB are allowed ────
test('21: VT (U+000B), FF (U+000C) and NEL (U+0085) remain forbidden at insert', async () => {
  resetState();
  enableRaw();
  const samples: Array<[string, string]> = [
    ['echo\x0bx', 'VERTICAL TAB U+000B'],
    ['echo\x0cx', 'FORM FEED U+000C'],
    ['echo\x85x', 'NEL U+0085'],
  ];
  for (const [command, label] of samples) {
    const r = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
    assert.equal(r.status, 400, `insert must reject ${label}`);
    const body = await r.json();
    assert.equal(body.code, 'forbidden_control_char', `code for ${label}`);
    assert.equal(typeof body.position, 'number');
  }
});

// ── (22) T-966: bidi / zero-width chars stay forbidden inside a multi-line command
// (regression guard — allowing LF must NOT reopen the Trojan-Source surface).
test('22: a multi-line command carrying a bidi override / zero-width char is still rejected', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];
  const samples: Array<[string, string]> = [
    ['echo one\necho \u202Etwo', 'RLO U+202E on line 2'],
    ['echo one\necho\u200Btwo', 'ZWSP U+200B on line 2'],
    ['echo one\necho \u2028two', 'LINE SEPARATOR U+2028 (not the permitted LF)'],
    ['echo one\necho \u2029two', 'PARAGRAPH SEPARATOR U+2029 (not the permitted LF)'],
  ];
  for (const [command, label] of samples) {
    const r = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command } });
    assert.equal(r.status, 400, `insert must reject ${label}`);
    assert.equal((await r.json()).code, 'forbidden_control_char', `code for ${label}`);
  }
  assert.equal(spawnCalls.length, 0);
});

// ── (23) T-966: the line cap is enforced with its own code ────────────────────
test('23: a command exceeding MAX_RAW_COMMAND_LINES is rejected (too_many_lines)', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];

  // exactly at the cap: allowed. MAX lines = (MAX-1) newlines.
  const atCap = Array.from({ length: MAX_RAW_COMMAND_LINES }, (_, i) => `echo ${i}`).join('\n');
  const atCapRes = validateRawCommand(atCap);
  assert.equal(atCapRes.ok, true, 'a command at exactly the line cap is allowed');

  // one over the cap: rejected with the distinct code + counts.
  const overCap = Array.from({ length: MAX_RAW_COMMAND_LINES + 1 }, (_, i) => `echo ${i}`).join('\n');
  const overRes = validateRawCommand(overCap);
  assert.equal(overRes.ok, false);
  if (!overRes.ok) {
    assert.equal(overRes.error, 'too_many_lines');
    assert.equal((overRes as any).maxLines, MAX_RAW_COMMAND_LINES);
    assert.equal((overRes as any).lineCount, MAX_RAW_COMMAND_LINES + 1);
  }

  // and end-to-end at the route.
  const r = await call('POST', '/api/system/command-board-raw', { user: OWNER, body: { command: overCap } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'too_many_lines');
  assert.equal(spawnCalls.length, 0);
});

// ── (24) T-966: digest binding + pre-exec rescan hold on multi-line text ───────
test('24: swapping a stored multi-line row after display → digest_mismatch; planted control char caught pre-exec', async () => {
  resetState();
  enableRaw();
  spawnCalls = [];

  // (a) TOCTOU on a multi-line command: digest computed over the shown text must
  // not match a swapped multi-line body.
  const shown = 'echo safe\necho still-safe';
  const id = seedRow(shown);
  const shownDigest = computeDigest(shown);
  appConfigDb.set(
    RAW_QUEUE_CONFIG_KEY,
    JSON.stringify([{ id, command: 'echo evil\nrm -rf /tmp/x', requestedBy: 'x', requestedAt: 'now' }])
  );
  const r = await call('POST', `/api/system/command-board-raw/${id}/execute`, {
    user: OWNER,
    body: { confirmationDigest: shownDigest },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'digest_mismatch', 'a swapped multi-line row is refused');
  assert.equal(spawnCalls.length, 0);

  // (b) a forbidden char planted on line 2 AFTER insert is caught by the pre-exec
  // rescan (digest is honest here — it matches the planted bytes), never spawning.
  const planted = 'echo one\necho ‮two';
  const id2 = seedRow(planted);
  const r2 = await call('POST', `/api/system/command-board-raw/${id2}/execute`, {
    user: OWNER,
    body: { confirmationDigest: computeDigest(planted) },
  });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).code, 'forbidden_control_char', 'pre-exec rescan catches it');
  assert.equal(spawnCalls.length, 0, 'a planted control char must never spawn');
});
