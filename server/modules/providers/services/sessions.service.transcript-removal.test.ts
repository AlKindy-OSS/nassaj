/**
 * B-1596 (guard hit) — session force-delete with `deletedFromDisk` removes the
 * transcript only through the confined primitive, like project delete. Driven
 * through `sessionsService.deleteOrArchiveSessionById` as the owner; the row is
 * always settled, a refused file stays and `deletedFromDisk` is false.
 *
 * Sandbox: a /var/tmp HOME with members /1 and /10; victims live in /10.
 * Headers come from the redacted real Claude fixture (B-1520).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { sessionsService } from './sessions.service.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const FIXTURE = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share', 'claude.jsonl');
const FIXTURE_ID = '00000000-0000-4000-a000-000000000013';
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');

await initializeDatabase();
const ownerId = userDb.createUser('removal-owner', 'hash-o', 'user').id;
const projectPath = path.join(SANDBOX_HOME, 'workspaces', 'removal');
fs.mkdirSync(projectPath, { recursive: true });
const storedProjectPath = projectsDb.createProjectPath(projectPath, null, ownerId).project!.project_path;

let counter = 0;
const nextId = (): string => `00000000-0000-4000-b000-${String(++counter).padStart(12, '0')}`;
const claudeText = (id: string): string => fs.readFileSync(FIXTURE, 'utf8').replaceAll(FIXTURE_ID, id);
const memberClaude = (member: string, project: string, id: string): string =>
  path.join(USERS, member, '.claude', 'projects', project, `${id}.jsonl`);

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A session row of the owner's project recording `jsonlPath`. */
function recordSession(id: string, jsonlPath: string): void {
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(id, 'claude', storedProjectPath, jsonlPath);
  participantsDb.recordSpawn(id, ownerId);
}

async function forceDelete(id: string): Promise<boolean> {
  const result = await sessionsService.deleteOrArchiveSessionById(id, ownerId, { force: true, deletedFromDisk: true });
  assert.equal(result.action, 'deleted');
  assert.equal(sessionsDb.getSessionById(id), null, 'the row is always settled');
  return result.deletedFromDisk;
}

test('a legitimate transcript in member 1\'s tree is removed', async () => {
  const id = nextId();
  const file = write(memberClaude('1', '-legit', id), claudeText(id));
  recordSession(id, file);
  assert.equal(await forceDelete(id), true);
  assert.equal(fs.existsSync(file), false);
});

test('a forged path to member 10\'s transcript is not removed', async () => {
  const id = nextId();
  const victimId = nextId();
  const victim = write(memberClaude('10', '-victim', victimId), claudeText(victimId));
  recordSession(id, victim);
  assert.equal(await forceDelete(id), false);
  assert.equal(fs.readFileSync(victim, 'utf8'), claudeText(victimId));
});

test('a parent-directory link from /1 into /10 is not followed', async () => {
  const id = nextId();
  const victim = write(memberClaude('10', '-victim-dir', id), claudeText(id));
  fs.symlinkSync(path.dirname(victim), path.join(USERS, '1', '.claude', 'projects', '-dir-link'));
  recordSession(id, memberClaude('1', '-dir-link', id));
  assert.equal(await forceDelete(id), false);
  assert.equal(fs.readFileSync(victim, 'utf8'), claudeText(id));
});

type FsMethod = (...args: unknown[]) => Promise<unknown>;

/** Patches `fs.promises[name]` for the duration of `run`. */
async function withPatchedFs<T>(name: string, patch: (original: FsMethod) => FsMethod, run: () => Promise<T>): Promise<T> {
  const promises = fs.promises as unknown as Record<string, FsMethod>;
  const original = promises[name];
  promises[name] = patch((...args) => original.apply(fs.promises, args));
  try {
    return await run();
  } finally {
    promises[name] = original;
  }
}

const errno = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });
const isParked = (target: unknown): boolean => String(target).includes('nassaj-removing');
const isRetry = (error: unknown): boolean => error instanceof AppError && error.statusCode === 409
  && error.code === 'TRANSCRIPT_REMOVAL_RETRY';

/** Collects the structured `console.warn` payloads made while `run` executes. */
async function warningsOf(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const original = console.warn;
  const seen: Array<Record<string, unknown>> = [];
  console.warn = (...args: unknown[]) => { seen.push((args[1] ?? {}) as Record<string, unknown>); };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

const tryDelete = (id: string) => sessionsService.deleteOrArchiveSessionById(id, ownerId, { force: true, deletedFromDisk: true });

test('M4: an unlink failure after parking puts the file back at its name and keeps the row (409)', async () => {
  const id = nextId();
  const file = write(memberClaude('1', '-m4', id), claudeText(id));
  recordSession(id, file);
  let failures = 1; // one transient failure: the unlink of the parked name
  await withPatchedFs('unlink', (unlink) => async (...args) => {
    if (isParked(args[0]) && failures-- > 0) throw errno('EIO');
    return unlink(...args);
  }, () => assert.rejects(() => tryDelete(id), isRetry));
  assert.equal(fs.readFileSync(file, 'utf8'), claudeText(id), 'visible again at its own name');
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => isParked(name)), false, 'nothing left hidden');
  assert.notEqual(sessionsDb.getSessionById(id), null, 'row kept so the user can retry');
  assert.equal(await forceDelete(id), true, 'the retry removes it');
});

test('M5: a restore that cannot link back logs parked_left once and keeps the row (409)', async () => {
  const id = nextId();
  const file = write(memberClaude('1', '-m5', id), claudeText(id));
  recordSession(id, file);
  const warnings = await withPatchedFs('unlink', (unlink) => async (...args) => {
    if (isParked(args[0])) throw errno('EIO');
    return unlink(...args);
  }, () => withPatchedFs('link', () => async () => { throw errno('EEXIST'); },
    () => warningsOf(() => assert.rejects(() => tryDelete(id), isRetry))));
  const mine = warnings.filter((warning) => warning.sessionId === id);
  assert.deepEqual(mine.map((warning) => warning.reason), ['parked_left']);
  assert.equal(JSON.stringify(mine).includes(USERS), false, 'no path in the warning');
  assert.notEqual(sessionsDb.getSessionById(id), null);
});

test('M1: a transient admission failure (EIO) refuses with 409 and keeps row and file', async () => {
  const id = nextId();
  const file = write(memberClaude('1', '-m1', id), claudeText(id));
  recordSession(id, file);
  await withPatchedFs('open', (open) => async (...args) => {
    if (args[0] === file) throw errno('EIO');
    return open(...args);
  }, () => assert.rejects(() => tryDelete(id), isRetry));
  assert.notEqual(sessionsDb.getSessionById(id), null);
  assert.equal(fs.existsSync(file), true);
});

/** Runs `run` with `target` at `mode`, restoring 0o700/0o600 afterwards so the sandbox can be removed. */
async function withMode<T>(target: string, mode: number, run: () => Promise<T>): Promise<T> {
  const restore = fs.statSync(target).isDirectory() ? 0o700 : 0o600;
  fs.chmodSync(target, mode);
  try {
    return await run();
  } finally {
    fs.chmodSync(target, restore);
  }
}

for (const [label, pick, mode] of [
  ['the transcript chmod 000', (file: string) => file, 0o000],
  ['its directory chmod 000', (file: string) => path.dirname(file), 0o000],
  ['its directory read-only (0500)', (file: string) => path.dirname(file), 0o500],
] as const) {
  test(`N1: ${label} settles the row instead of a 409 forever; the file is kept`, async () => {
    const id = nextId();
    const file = write(memberClaude('1', `-n1-${mode}-${label.length}`, id), claudeText(id));
    recordSession(id, file);
    assert.equal(await withMode(pick(file), mode, () => forceDelete(id)), false);
    assert.equal(fs.readFileSync(file, 'utf8'), claudeText(id), 'the file is kept');
  });
}

test('N1/N6: permission denials and a host without /proc are security refusals, never retryable', async () => {
  const { isRetryableRefusal } = await import('../shared/session-transcript-removal.js');
  for (const reason of ['unreadable', 'unwritable', 'proc_unavailable'] as const) {
    assert.equal(isRetryableRefusal(reason), false, reason);
  }
  for (const reason of ['io_error', 'changed_during_open', 'unlink_failed'] as const) {
    assert.equal(isRetryableRefusal(reason), true, reason);
  }
});

test('B-1613: a transcript whose name leaves no room for a name-derived park name is still removed', async () => {
  // 230-byte id: `<id>.jsonl` is 236 bytes, legal (≤255), but `.<name>.nassaj-removing-<hex>`
  // would be 270 and rename(2) answered ENAMETOOLONG — a "retryable" 409 on every attempt.
  const id = `${nextId()}-${'x'.repeat(193)}`;
  assert.equal(id.length, 230);
  const file = write(memberClaude('1', '-long-name', id), claudeText(id));
  recordSession(id, file);
  assert.equal(await forceDelete(id), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [], 'no parked name is left behind');
});

const parkedIn = (dir: string): string[] => fs.readdirSync(dir).filter((name) => isParked(name));

/** Leaves `file` under its (B-1613 short) park name exactly as an M5 `parked_left` does. */
async function leaveParked(id: string): Promise<void> {
  await withPatchedFs('unlink', (unlink) => async (...args) => {
    if (isParked(args[0])) throw errno('EIO');
    return unlink(...args);
  }, () => withPatchedFs('link', () => async () => { throw errno('EEXIST'); },
    () => assert.rejects(() => tryDelete(id), isRetry)));
}

test('N2: a retry after parked_left restores the short-named parked file (bound by content) and removes it', async () => {
  const id = nextId();
  const file = write(memberClaude('1', '-n2', id), claudeText(id));
  recordSession(id, file);
  await leaveParked(id);
  assert.equal(fs.existsSync(file), false, 'the name is gone, the file is parked');
  assert.deepEqual(parkedIn(path.dirname(file)).map((name) => /^\.nassaj-removing-[0-9a-f]{16}$/.test(name)), [true]);
  assert.equal(await forceDelete(id), true, 'the retry finds the parked file and removes it');
  assert.deepEqual(parkedIn(path.dirname(file)), [], 'nothing left hidden');
});

test('N2: two parked files for one session (old B-1596 form) are ambiguous: parked_left again, row kept (409)', async () => {
  const id = nextId();
  const dir = path.dirname(write(memberClaude('1', '-n2-two', id), claudeText(id)));
  fs.renameSync(path.join(dir, `${id}.jsonl`), path.join(dir, `.${id}.jsonl.nassaj-removing-${'a'.repeat(16)}`));
  write(path.join(dir, `.${id}.jsonl.nassaj-removing-${'b'.repeat(16)}`), claudeText(id));
  recordSession(id, path.join(dir, `${id}.jsonl`));
  await assert.rejects(() => tryDelete(id), isRetry);
  assert.notEqual(sessionsDb.getSessionById(id), null);
  assert.equal(parkedIn(dir).length, 2, 'both are left for the boot cleaner');
});

test('N2: a short park name is restored only when its header binds it to the session', async () => {
  const id = nextId();
  const dir = path.dirname(write(memberClaude('1', '-n2-short', id), claudeText(id)));
  fs.renameSync(path.join(dir, `${id}.jsonl`), path.join(dir, '.nassaj-removing-0123456789abcdef'));
  const foreign = write(path.join(dir, '.nassaj-removing-fedcba9876543210'), claudeText(nextId()));
  recordSession(id, path.join(dir, `${id}.jsonl`));
  assert.equal(await forceDelete(id), true);
  assert.deepEqual(parkedIn(dir), [path.basename(foreign)], 'another session\'s parked file is not touched');
});

test('N2: a lone old-form park file of this name is restored and removed', async () => {
  const id = nextId();
  const dir = path.dirname(write(memberClaude('1', '-n2-old', id), claudeText(id)));
  fs.renameSync(path.join(dir, `${id}.jsonl`), path.join(dir, `.${id}.jsonl.nassaj-removing-${'c'.repeat(16)}`));
  recordSession(id, path.join(dir, `${id}.jsonl`));
  assert.equal(await forceDelete(id), true);
  assert.deepEqual(parkedIn(dir), []);
});

test('qa 2: only a verified park (unlink_failed) is ledgered for the boot sweep; a swapped one is not', async () => {
  const { readParkLedger } = await import('../shared/transcript-park-ledger.js');
  const id = nextId();
  const file = write(memberClaude('1', '-ledger', id), claudeText(id));
  recordSession(id, file);
  await leaveParked(id);
  const [left] = parkedIn(path.dirname(file));
  const ledgered = (await readParkLedger()).filter((entry) => entry.name === left);
  assert.equal(ledgered.length, 1, 'the unlink_failed park is ledgered');

  const swappedId = nextId();
  const swappedFile = write(memberClaude('1', '-ledger-swapped', swappedId), claudeText(swappedId));
  recordSession(swappedId, swappedFile);
  const before = (await readParkLedger()).length;
  await withPatchedFs('lstat', (lstat) => async (...args) => {
    const stat = await lstat(...args) as fs.BigIntStats;
    return isParked(args[0]) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n }) : stat;
  }, () => withPatchedFs('link', () => async () => { throw errno('EEXIST'); },
    () => assert.rejects(() => tryDelete(swappedId), isRetry)));
  assert.equal(parkedIn(path.dirname(swappedFile)).length, 1, 'the swapped entry is left parked');
  assert.equal((await readParkLedger()).length, before, 'and never ledgered');
});
