import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { hasErrorCode } from './errors.js';
import { assertNoStoreHolders, assertStoresPrivate, procFsReader, scanOpenHandles, type ProcReader } from './open-handles.js';
import { makeFixtureRoot, removeFixture, writeFixtureFile } from './__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const code = (c: Parameters<typeof hasErrorCode>[1]) => (e: unknown) => hasErrorCode(e, c);
const SELF = process.getuid!();

function eacces(): Error {
  return Object.assign(new Error('denied'), { code: 'EACCES' });
}

/** Fake /proc: pid → {uid, fds | 'denied'}. */
function fakeProc(table: Record<string, { uid: number; fds: Record<string, string> | 'denied'; comm?: string }>): ProcReader {
  return {
    listPids: () => Object.keys(table),
    ownerUid: (pid) => table[pid].uid,
    listFds: (pid) => {
      const fds = table[pid].fds;
      if (fds === 'denied') throw eacces();
      return Object.keys(fds);
    },
    readFdLink: (pid, fd) => (table[pid].fds as Record<string, string>)[fd],
    readComm: (pid) => table[pid].comm ?? 'proc',
  };
}

test('real /proc: this process holding a fixture store is found (pid, comm, uid only)', () => {
  const db = path.join(root, 'held.sqlite');
  writeFixtureFile(db, 'x', 0o600);
  const fd = fs.openSync(db, 'r');
  try {
    const scan = scanOpenHandles([db]);
    const me = scan.holders.find((h) => h.pid === process.pid);
    assert.ok(me);
    assert.deepEqual(Object.keys(me).sort(), ['comm', 'pid', 'uid']);
    assert.equal(me.uid, SELF);
    assert.throws(() => assertNoStoreHolders([db], { selfUid: SELF }), code('STORE_IN_USE'));
  } finally {
    fs.closeSync(fd);
  }
});

test('fixture proc root via procFsReader: fd link match incl. "(deleted)" suffix', () => {
  const proc = path.join(root, 'proc');
  fs.mkdirSync(path.join(proc, '42/fd'), { recursive: true });
  fs.writeFileSync(path.join(proc, '42/comm'), 'codex\n');
  fs.symlinkSync('/store/a.sqlite-wal (deleted)', path.join(proc, '42/fd/7'));
  fs.mkdirSync(path.join(proc, 'self'));
  const scan = scanOpenHandles(['/store/a.sqlite-wal'], { reader: procFsReader(proc), selfUid: SELF });
  assert.deepEqual(scan.holders, [{ pid: 42, comm: 'codex', uid: SELF }]);
});

test('the scanner never reads cmdline (source contains no cmdline access)', () => {
  const src = fs.readFileSync(new URL('./open-handles.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(src.includes('cmdline'), false);
});

test('unreadable same-uid fd dir: retried once after 1 s, then STORE_ACCESS_UNPROVABLE', () => {
  const sleeps: number[] = [];
  const reader = fakeProc({ 10: { uid: SELF, fds: 'denied' } });
  assert.throws(
    () => assertNoStoreHolders(['/s/a.db'], { reader, selfUid: SELF, sleepMs: (ms) => sleeps.push(ms) }),
    code('STORE_ACCESS_UNPROVABLE'),
  );
  assert.deepEqual(sleeps, [1000]);
});

test('same-uid dir readable on retry → passes; holder on retry → STORE_IN_USE', () => {
  let calls = 0;
  const base = fakeProc({ 10: { uid: SELF, fds: {} } });
  const flaky: ProcReader = { ...base, listFds: (pid) => { calls += 1; if (calls === 1) throw eacces(); return base.listFds(pid); } };
  assertNoStoreHolders(['/s/a.db'], { reader: flaky, selfUid: SELF, sleepMs: () => undefined });
  calls = 0;
  const later = fakeProc({ 10: { uid: SELF, fds: { 3: '/s/a.db' } } });
  const flaky2: ProcReader = { ...later, listFds: (pid) => { calls += 1; if (calls === 1) throw eacces(); return later.listFds(pid); } };
  assert.throws(() => assertNoStoreHolders(['/s/a.db'], { reader: flaky2, selfUid: SELF, sleepMs: () => undefined }), code('STORE_IN_USE'));
});

test('other-uid unreadable pids: reachable group-readable store → refuse; private store → accept', () => {
  // Every ancestor traversable (fixture root opened to 0755) → no barrier.
  const open = path.join(root, 'open');
  const dir = path.join(open, 'stores');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(root, 0o755);
  fs.chmodSync(open, 0o755);
  fs.chmodSync(dir, 0o700);
  const db = path.join(dir, 'opencode.db');
  writeFixtureFile(db, 'x', 0o640);
  try {
    const reader = fakeProc({ 1: { uid: 0, fds: 'denied' }, 2: { uid: SELF + 1, fds: 'denied' } });
    const scan = scanOpenHandles([dir, db], { reader, selfUid: SELF });
    assert.equal(scan.unreadableOtherUid, 2);
    fs.chmodSync(dir, 0o755);
    assert.deepEqual(assertStoresPrivate([dir, db], SELF), { ok: false, reason: 'group_or_other_access' });
    assert.throws(() => assertNoStoreHolders([dir, db], { reader, selfUid: SELF }), code('STORE_ACCESS_UNPROVABLE'));
    fs.chmodSync(db, 0o600);
    fs.chmodSync(dir, 0o700);
    assertNoStoreHolders([dir, db, path.join(dir, 'opencode.db-wal')], { reader, selfUid: SELF });
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

test('0644 store under a 0700 ancestor is private; all-traversable chain + 0644 is refused', () => {
  const home = path.join(root, 'home-0700');
  const store = path.join(home, 'users', '1', '.codex');
  fs.mkdirSync(store, { recursive: true });
  fs.chmodSync(path.join(home, 'users'), 0o775);
  fs.chmodSync(path.join(home, 'users', '1'), 0o755);
  fs.chmodSync(store, 0o775);
  const db = path.join(store, 'state_5.sqlite');
  writeFixtureFile(db, 'x', 0o644);
  fs.chmodSync(root, 0o755);
  try {
    fs.chmodSync(home, 0o700);
    assert.deepEqual(assertStoresPrivate([store, db], SELF), { ok: true });
    fs.chmodSync(home, 0o755);
    assert.deepEqual(assertStoresPrivate([store, db], SELF), { ok: false, reason: 'group_or_other_access' });
  } finally {
    fs.chmodSync(home, 0o700);
    fs.chmodSync(root, 0o700);
  }
});

test('ancestor chain: a symlinked ancestor or a writable non-sticky dir above the barrier is refused', () => {
  const real = path.join(root, 'real-home');
  fs.mkdirSync(path.join(real, 'data'), { recursive: true, mode: 0o700 });
  const db = path.join(real, 'data', 'opencode.db');
  writeFixtureFile(db, 'x', 0o644);
  const via = path.join(root, 'via-link');
  fs.symlinkSync(real, via);
  assert.deepEqual(assertStoresPrivate([path.join(via, 'data', 'opencode.db')], SELF), { ok: false, reason: 'symlink' });
  // barrier = data (0700); real-home above it is group-writable without sticky.
  fs.chmodSync(path.join(real, 'data'), 0o700);
  fs.chmodSync(real, 0o770);
  try {
    assert.deepEqual(assertStoresPrivate([db], SELF), { ok: false, reason: 'group_or_other_access' });
    fs.chmodSync(real, 0o1770);
    assert.deepEqual(assertStoresPrivate([db], SELF), { ok: true });
  } finally {
    fs.chmodSync(real, 0o700);
  }
});

test('assertStoresPrivate: symlink and foreign owner are refused', () => {
  const link = path.join(root, 'link.db');
  fs.symlinkSync('/nonexistent', link);
  assert.deepEqual(assertStoresPrivate([link], SELF), { ok: false, reason: 'symlink' });
  const own = path.join(root, 'own.db');
  writeFixtureFile(own, 'x', 0o600);
  assert.deepEqual(assertStoresPrivate([own], SELF + 1), { ok: false, reason: 'foreign_owner' });
});

test('vanished pids and closed fds are skipped; unexpected errors propagate', () => {
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
  const reader: ProcReader = {
    listPids: () => ['1', '2', '3'],
    ownerUid: (pid) => { if (pid === '1') throw gone; return SELF; },
    listFds: (pid) => { if (pid === '2') throw gone; return ['0']; },
    readFdLink: () => { throw gone; },
    readComm: () => { throw gone; },
  };
  assert.deepEqual(scanOpenHandles(['/x'], { reader, selfUid: SELF }), { holders: [], unreadableSameUid: [], unreadableOtherUid: 0 });
  const broken: ProcReader = { ...reader, listFds: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
  assert.throws(() => scanOpenHandles(['/x'], { reader: broken, selfUid: SELF }));
});
