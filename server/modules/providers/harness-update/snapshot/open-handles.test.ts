import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import type { AppError } from '@/shared/utils.js';

import { hasErrorCode } from './errors.js';
import {
  assertNoStoreHolders,
  assertStoresPrivate,
  procFsReader,
  scanOpenHandles,
  startTimeOf,
  UNCHECKED_PROCESS_CAP,
  uncheckedDetailsOf,
  type LstatFn,
  type ProcReader,
} from './open-handles.js';
import { makeFixtureRoot, removeFixture, writeFixtureFile } from './__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const code = (c: Parameters<typeof hasErrorCode>[1]) => (e: unknown) => hasErrorCode(e, c);
const SELF = process.getuid!();

function eacces(): Error {
  return Object.assign(new Error('denied'), { code: 'EACCES' });
}

type FakePid = { uid: number; fds: Record<string, string> | 'denied'; comm?: string; start?: string };

/** Fake /proc: pid → {uid, fds | 'denied', comm, starttime}. */
function fakeProc(table: Record<string, FakePid>): ProcReader {
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
    readStartTime: (pid) => table[pid].start ?? '1',
  };
}

type SynthNode = { mode: number; uid?: number; kind?: 'dir' | 'file' | 'link' };

/**
 * Fully synthetic lstat over absolute paths, so the privacy proof never sees
 * the host's real ancestors (whose barriers would make refusals pass wrongly).
 * `/` defaults to a 0755 root-owned dir.
 */
function synthLstat(tree: Record<string, SynthNode>): LstatFn {
  const all: Record<string, SynthNode> = { '/': { mode: 0o755, uid: 0 }, ...tree };
  return (p) => {
    const n = all[p];
    if (!n) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const kind = n.kind ?? 'dir';
    return { uid: n.uid ?? SELF, mode: n.mode, isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' };
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
  fs.writeFileSync(path.join(proc, '42/stat'), '42 (co dex) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0\n');
  assert.equal(procFsReader(proc).readStartTime('42'), '4242');
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

test('B-1468: allowlisted non-dumpable system agents with unreadable fd dirs do not block', () => {
  const sleeps: number[] = [];
  const reader = fakeProc({
    11: { uid: SELF, fds: 'denied', comm: 'ssh-agent' },
    12: { uid: SELF, fds: 'denied', comm: 'gpg-agent' },
    13: { uid: SELF, fds: 'denied', comm: '(sd-pam)' },
    15: { uid: SELF, fds: 'denied', comm: 'systemd' },
    14: { uid: SELF, fds: {}, comm: 'opencode' },
  });
  assert.deepEqual(scanOpenHandles(['/s/a.db'], { reader, selfUid: SELF }).unreadableSameUid, []);
  assertNoStoreHolders(['/s/a.db'], { reader, selfUid: SELF, sleepMs: (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, []);
});

test('B-1468: unknown unreadable same-uid pid → STORE_ACCESS_UNPROVABLE naming pid + comm only', () => {
  const reader = fakeProc({
    11: { uid: SELF, fds: 'denied', comm: 'ssh-agent' },
    21: { uid: SELF, fds: 'denied', comm: 'node' },
  });
  let caught: unknown;
  try {
    assertNoStoreHolders(['/s/a.db'], { reader, selfUid: SELF, sleepMs: () => undefined });
  } catch (error) {
    caught = error;
  }
  assert.ok(hasErrorCode(caught, 'STORE_ACCESS_UNPROVABLE'));
  const details = (caught as AppError).details;
  const expected = { uncheckedProcesses: [{ pid: 21, comm: 'node', reason: 'fd_unreadable' }], uncheckedProcessCount: 1 };
  assert.deepEqual(details, expected);
  assert.deepEqual(uncheckedDetailsOf(details), expected);
  assert.equal(uncheckedDetailsOf({ uncheckedProcesses: [{ pid: 'x', comm: 1, reason: 'fd_unreadable' }] }), null);
  assert.equal(uncheckedDetailsOf({ uncheckedProcesses: [{ pid: 1, comm: 'a', reason: 'other' }] }), null);
  assert.equal(uncheckedDetailsOf(undefined), null);
});

test('B-1468 L4: the unchecked list is capped while the total count is kept', () => {
  const table: Record<string, { uid: number; fds: 'denied'; comm: string }> = {};
  const total = UNCHECKED_PROCESS_CAP + 7;
  for (let i = 0; i < total; i += 1) table[String(100 + i)] = { uid: SELF, fds: 'denied', comm: `p${i}` };
  let caught: unknown;
  try {
    assertNoStoreHolders(['/s/a.db'], { reader: fakeProc(table), selfUid: SELF, sleepMs: () => undefined });
  } catch (error) {
    caught = error;
  }
  const details = (caught as AppError).details as { uncheckedProcesses: unknown[]; uncheckedProcessCount: number };
  assert.equal(details.uncheckedProcesses.length, UNCHECKED_PROCESS_CAP);
  assert.equal(details.uncheckedProcessCount, total);
  const parsed = uncheckedDetailsOf(details);
  assert.equal(parsed?.uncheckedProcesses.length, UNCHECKED_PROCESS_CAP);
  assert.equal(parsed?.uncheckedProcessCount, total);
});

test('B-1468 L4: the parser caps an oversized list and never reports a count below the list', () => {
  const list = Array.from({ length: UNCHECKED_PROCESS_CAP + 3 }, (_, i) => ({ pid: i + 1, comm: 'x', reason: 'fd_unreadable' }));
  const parsed = uncheckedDetailsOf({ uncheckedProcesses: list, uncheckedProcessCount: 2 });
  assert.equal(parsed?.uncheckedProcesses.length, UNCHECKED_PROCESS_CAP);
  assert.equal(parsed?.uncheckedProcessCount, UNCHECKED_PROCESS_CAP + 3);
  assert.equal(uncheckedDetailsOf({ uncheckedProcesses: list.slice(0, 1), uncheckedProcessCount: 'many' })?.uncheckedProcessCount, 1);
});

test('B-1468: a visible holder is STORE_IN_USE even beside allowlisted and unknown unreadable pids', () => {
  const reader = fakeProc({
    11: { uid: SELF, fds: 'denied', comm: 'ssh-agent' },
    21: { uid: SELF, fds: 'denied', comm: 'node' },
    30: { uid: SELF, fds: { 5: '/s/a.db' }, comm: 'ssh-agent' },
  });
  assert.throws(() => assertNoStoreHolders(['/s/a.db'], { reader, selfUid: SELF, sleepMs: () => undefined }), code('STORE_IN_USE'));
});

test('B-1468: unreadable comm → "?" and still STORE_ACCESS_UNPROVABLE', () => {
  const base = fakeProc({ 21: { uid: SELF, fds: 'denied' } });
  const reader: ProcReader = { ...base, readComm: () => { throw eacces(); } };
  assert.throws(
    () => assertNoStoreHolders(['/s/a.db'], { reader, selfUid: SELF, sleepMs: () => undefined }),
    (e: unknown) => hasErrorCode(e, 'STORE_ACCESS_UNPROVABLE')
      && JSON.stringify((e as AppError).details) === JSON.stringify({
        uncheckedProcesses: [{ pid: 21, comm: '?', reason: 'fd_unreadable' }], uncheckedProcessCount: 1,
      }),
  );
});

test('B-1468 L2: an allowlisted comm on a reused pid (starttime changed or unreadable) still refuses', () => {
  let reads = 0;
  const base = fakeProc({ 11: { uid: SELF, fds: 'denied', comm: 'ssh-agent' } });
  const reused: ProcReader = { ...base, readStartTime: () => String((reads += 1)) };
  const unverified = [{ pid: 11, comm: 'ssh-agent', reason: 'identity_unverified' }];
  assert.deepEqual(scanOpenHandles(['/s/a.db'], { reader: reused, selfUid: SELF }).unreadableSameUid, unverified);
  const unknown: ProcReader = { ...base, readStartTime: () => { throw eacces(); } };
  assert.deepEqual(scanOpenHandles(['/s/a.db'], { reader: unknown, selfUid: SELF }).unreadableSameUid, unverified);
  assert.deepEqual(scanOpenHandles(['/s/a.db'], { reader: base, selfUid: SELF }).unreadableSameUid, []);
});

test('startTimeOf reads field 22 even when comm contains spaces and parens', () => {
  const tail = 'S 975 975 975 0 -1 4194624 58 0 0 0 0 0 0 0 20 0 1 0 678 25255936 196';
  assert.equal(startTimeOf(`983 ((sd-pam)) ${tail}`), '678');
  assert.equal(startTimeOf(`7 (a) b (c) ${tail}`), '678');
  assert.throws(() => startTimeOf('7 (x) S 1'));
});

test('startTimeOf: a stat line without a closing paren is EINVAL, never a shifted field', () => {
  const tail = 'S 975 975 975 0 -1 4194624 58 0 0 0 0 0 0 0 20 0 1 0 678 25255936 196';
  assert.throws(() => startTimeOf(`983 sd-pam ${tail}`), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EINVAL');
  assert.throws(() => startTimeOf(''), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EINVAL');
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
  const reader = fakeProc({ 1: { uid: 0, fds: 'denied' }, 2: { uid: SELF + 1, fds: 'denied' } });
  const paths = ['/srv/open/stores', '/srv/open/stores/opencode.db', '/srv/open/stores/opencode.db-wal'];
  assert.equal(scanOpenHandles(paths, { reader, selfUid: SELF }).unreadableOtherUid, 2);
  const tree = (dirMode: number, dbMode: number) => synthLstat({
    '/srv': { mode: 0o755, uid: 0 },
    '/srv/open': { mode: 0o755 },
    '/srv/open/stores': { mode: dirMode },
    '/srv/open/stores/opencode.db': { mode: dbMode, kind: 'file' },
  });
  assert.deepEqual(assertStoresPrivate(paths, SELF, tree(0o755, 0o640)), { ok: false, reason: 'group_or_other_access' });
  assert.throws(() => assertNoStoreHolders(paths, { reader, selfUid: SELF, lstat: tree(0o755, 0o640) }), code('STORE_ACCESS_UNPROVABLE'));
  assertNoStoreHolders(paths, { reader, selfUid: SELF, lstat: tree(0o700, 0o600) });
});

test('0644 store under a 0700 ancestor is private; all-traversable chain + 0644 is refused', () => {
  const tree = (homeMode: number) => synthLstat({
    '/home': { mode: 0o755, uid: 0 },
    '/home/user': { mode: homeMode },
    '/home/user/users': { mode: 0o775 },
    '/home/user/users/1': { mode: 0o755 },
    '/home/user/users/1/.codex': { mode: 0o775 },
    '/home/user/users/1/.codex/state_5.sqlite': { mode: 0o644, kind: 'file' },
  });
  const paths = ['/home/user/users/1/.codex', '/home/user/users/1/.codex/state_5.sqlite'];
  assert.deepEqual(assertStoresPrivate(paths, SELF, tree(0o700)), { ok: true });
  assert.deepEqual(assertStoresPrivate(paths, SELF, tree(0o755)), { ok: false, reason: 'group_or_other_access' });
});

test('ancestor chain: a symlinked ancestor is refused (real fs)', () => {
  const real = path.join(root, 'real-home');
  fs.mkdirSync(path.join(real, 'data'), { recursive: true, mode: 0o700 });
  writeFixtureFile(path.join(real, 'data', 'opencode.db'), 'x', 0o644);
  const via = path.join(root, 'via-link');
  fs.symlinkSync(real, via);
  assert.deepEqual(assertStoresPrivate([path.join(via, 'data', 'opencode.db')], SELF), { ok: false, reason: 'symlink' });
});

test('ancestor chain: a writable non-sticky dir above the topmost barrier is refused; sticky passes', () => {
  const tree = (realMode: number) => synthLstat({
    '/r': { mode: 0o755 },
    '/r/real-home': { mode: realMode },
    '/r/real-home/data': { mode: 0o700 },
    '/r/real-home/data/opencode.db': { mode: 0o644, kind: 'file' },
    '/r/link': { mode: 0o777, kind: 'link' },
    '/r/link/opencode.db': { mode: 0o600, kind: 'file' },
  });
  const db = ['/r/real-home/data/opencode.db'];
  assert.deepEqual(assertStoresPrivate(db, SELF, tree(0o770)), { ok: false, reason: 'group_or_other_access' });
  assert.deepEqual(assertStoresPrivate(db, SELF, tree(0o1770)), { ok: true });
  assert.deepEqual(assertStoresPrivate(['/r/link/opencode.db'], SELF, tree(0o700)), { ok: false, reason: 'symlink' });
});

test('B-1468: a writable dir between two barriers is unreachable (0700 ~ > 0775 .local > 0700 share)', () => {
  const tree = (homeMode: number) => synthLstat({
    '/home': { mode: 0o755, uid: 0 },
    '/home/user': { mode: homeMode },
    '/home/user/.local': { mode: 0o775 },
    '/home/user/.local/share': { mode: 0o700 },
    '/home/user/.local/share/opencode': { mode: 0o755 },
    '/home/user/.local/share/opencode/opencode.db': { mode: 0o644, kind: 'file' },
  });
  const paths = ['/home/user/.local/share/opencode', '/home/user/.local/share/opencode/opencode.db'];
  assert.deepEqual(assertStoresPrivate(paths, SELF, tree(0o700)), { ok: true });
  assert.deepEqual(assertStoresPrivate(paths, SELF, tree(0o755)), { ok: false, reason: 'group_or_other_access' });
});

test('synthetic chain: a foreign-owned ancestor is refused', () => {
  const lstat = synthLstat({ '/x': { mode: 0o700, uid: SELF + 1 }, '/x/a.db': { mode: 0o600, kind: 'file' } });
  assert.deepEqual(assertStoresPrivate(['/x/a.db'], SELF, lstat), { ok: false, reason: 'foreign_owner' });
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
    readStartTime: () => { throw gone; },
  };
  assert.deepEqual(scanOpenHandles(['/x'], { reader, selfUid: SELF }), { holders: [], unreadableSameUid: [], unreadableOtherUid: 0 });
  const broken: ProcReader = { ...reader, listFds: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
  assert.throws(() => scanOpenHandles(['/x'], { reader: broken, selfUid: SELF }));
});
