/**
 * ADR-219 P2 §8 ش-4: self-tests of the live harness safeguards. Each safeguard is
 * enforced by code; these prove the refusals without a server or a model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertDatabaseFence, createRunDir, LIVE_DATABASE_PATH, planCredentials, removeRunDir, sweepOrphanRunDirs,
  writeBaitFile, writeMemberHome, findValueInTree,
} from './safeguards.mjs';

const HOUR = 60 * 60 * 1000;

test('run dir: created 0700 under /var/tmp/peer-p2-*, owner pid recorded, removed on demand', () => {
  const run = createRunDir();
  try {
    assert.match(run.dir, /^\/var\/tmp\/peer-p2-[A-Za-z0-9]+$/u);
    assert.equal(fs.statSync(run.dir).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run.dir, 'owner.json'), 'utf8')).pid, process.pid);
  } finally {
    removeRunDir(run.dir);
  }
  assert.equal(fs.existsSync(run.dir), false);
});

test('removeRunDir refuses any path outside /var/tmp/peer-p2-*', () => {
  assert.throws(() => removeRunDir('/var/tmp'), /refused/u);
  assert.throws(() => removeRunDir('/home/user/.claude'), /refused/u);
  assert.throws(() => removeRunDir('/var/tmp/peer-p2-x/../other'), /refused/u);
});

test('orphan sweep: a dir whose recorded pid is dead is removed; a live one is kept', () => {
  const dead = createRunDir();
  const live = createRunDir();
  fs.writeFileSync(path.join(dead.dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  try {
    const removed = sweepOrphanRunDirs();
    assert.ok(removed.includes(dead.dir));
    assert.equal(fs.existsSync(dead.dir), false);
    assert.equal(fs.existsSync(live.dir), true, 'the current run survives the sweep');
  } finally {
    removeRunDir(live.dir);
    if (fs.existsSync(dead.dir)) removeRunDir(dead.dir);
  }
});

test('live-data fence: only a DB inside this run dir and not the operator DB is accepted', () => {
  const run = createRunDir();
  try {
    const ok = path.join(run.dir, 'db.sqlite');
    assert.equal(assertDatabaseFence(ok, run.dir), fs.realpathSync(run.dir) + '/db.sqlite');
    assert.throws(() => assertDatabaseFence(LIVE_DATABASE_PATH, run.dir), /live-data fence/u);
    assert.throws(() => assertDatabaseFence('/var/tmp/other.sqlite', run.dir), /live-data fence/u);
    const elsewhere = fs.mkdtempSync('/var/tmp/p2-elsewhere-');
    fs.writeFileSync(path.join(elsewhere, 'operator.sqlite'), '');
    fs.symlinkSync(path.join(elsewhere, 'operator.sqlite'), path.join(run.dir, 'evil.sqlite'));
    assert.throws(() => assertDatabaseFence(path.join(run.dir, 'evil.sqlite'), run.dir), /live-data fence/u,
      'a symlink out of the run dir is resolved and refused');
    assert.throws(() => assertDatabaseFence(path.join(run.dir, 'db.sqlite'), run.dir, path.join(run.dir, 'db.sqlite')),
      /live-data fence/u, 'the operator database itself is refused even inside the run dir');
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally {
    removeRunDir(run.dir);
  }
});

test('live-data fence: an operator DB whose directory does not exist is still compared, not a crash', () => {
  const run = createRunDir();
  try {
    const missing = path.join(run.dir, 'absent', 'deeper', 'db.sqlite');
    const ok = path.join(run.dir, 'db.sqlite');
    assert.equal(assertDatabaseFence(ok, run.dir, missing), fs.realpathSync(run.dir) + '/db.sqlite');
    assert.throws(() => assertDatabaseFence(missing, run.dir, missing), /live-data fence/u,
      'the operator database path is refused even before its directory exists');
  } finally {
    removeRunDir(run.dir);
  }
});

test('credentials: an env token wins and no file is copied', () => {
  const plan = planCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, sourceConfigDir: '/nonexistent', maxRunMs: HOUR });
  assert.equal(plan.mode, 'env');
  assert.equal(plan.fileContents, null);
});

test('credentials: the file copy is refused when the token expires within the run', () => {
  const run = createRunDir();
  try {
    const src = path.join(run.dir, 'src');
    fs.mkdirSync(src, { mode: 0o700 });
    const now = Date.now();
    const write = (expiresAt) => fs.writeFileSync(path.join(src, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } }), { mode: 0o600 });
    write(now + 10 * 60 * 1000);
    assert.throws(() => planCredentials({ env: {}, sourceConfigDir: src, maxRunMs: HOUR, now }), /expires before/u);
    write(now + 3 * HOUR);
    const before = fs.readFileSync(path.join(src, '.credentials.json'), 'utf8');
    const plan = planCredentials({ env: {}, sourceConfigDir: src, maxRunMs: HOUR, now });
    assert.equal(plan.mode, 'file');
    assert.equal(JSON.parse(plan.fileContents).claudeAiOauth.refreshToken, undefined,
      'the copy carries no refresh token, so no rotation can touch the original');
    assert.equal(fs.readFileSync(path.join(src, '.credentials.json'), 'utf8'), before, 'the original is untouched');
  } finally {
    removeRunDir(run.dir);
  }
});

test('member home: CLAUDE.md copied, credentials 0600, all inside the run dir', () => {
  const run = createRunDir();
  try {
    const gov = path.join(run.dir, 'gov.md');
    fs.writeFileSync(gov, '# governance');
    const home = writeMemberHome(run.dir, 'a', { governancePath: gov, credentials: { mode: 'file', fileContents: '{}' } });
    assert.ok(home.configDir.startsWith(run.dir + '/'));
    assert.equal(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8'), '# governance');
    assert.equal(fs.lstatSync(path.join(home.configDir, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.equal(fs.statSync(path.join(home.configDir, '.credentials.json')).mode & 0o777, 0o600);
    assert.throws(() => writeMemberHome(run.dir, '../x', { governancePath: gov, credentials: { mode: 'env' } }), /member/u);
  } finally {
    removeRunDir(run.dir);
  }
});

test('bait: 0600 file inside the run dir with a fresh 32-byte hex value, found by the scan', () => {
  const run = createRunDir();
  try {
    const bait = writeBaitFile(run.dir);
    assert.equal(bait.path, path.join(run.dir, 'bait', '.env'));
    assert.equal(fs.statSync(bait.path).mode & 0o777, 0o600);
    assert.match(bait.value, /^[0-9a-f]{64}$/u);
    assert.notEqual(writeBaitFile(run.dir).value, bait.value);
    fs.writeFileSync(path.join(run.dir, 'out.jsonl'), `{"x":"${bait.value}"}`);
    const hits = findValueInTree([run.dir], bait.value, { exclude: [path.join(run.dir, 'bait')] });
    assert.deepEqual(hits, [path.join(run.dir, 'out.jsonl')]);
  } finally {
    removeRunDir(run.dir);
  }
});
