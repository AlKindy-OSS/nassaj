/** T-1910 S2: durable run tag and exact (never substring) child lookup by tag. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

import {
  PERMISSION_PROCESS_TAG_ENV,
  environHasExactPair,
  findDirectChildByProcessTag,
  permissionProcessTag,
  scanServiceProcessesForTags,
} from './process-tag-identity.js';

const environ = (...pairs: string[]) => Buffer.from(`${pairs.join('\0')}\0`, 'utf8');

const startTagged = (tag: string): ChildProcess => spawn('sleep', ['30'], {
  env: { PATH: process.env.PATH, [PERMISSION_PROCESS_TAG_ENV]: tag }, stdio: 'ignore',
});

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
};

test('the durable tag names the decision and refuses non-token ids', () => {
  assert.equal(permissionProcessTag('0b8f6a52-6f1e-4c33-9b1d-3c1d0f9e2a10'), 'pe-0b8f6a52-6f1e-4c33-9b1d-3c1d0f9e2a10');
  for (const bad of [undefined, null, '', 'a b', 'x\0y', 'a=b', 42, 'x'.repeat(129)]) {
    assert.equal(permissionProcessTag(bad), null, String(bad));
  }
});

test('environ matching is exact per NUL-delimited entry, never a substring', () => {
  const key = PERMISSION_PROCESS_TAG_ENV;
  assert.equal(environHasExactPair(environ('A=1', `${key}=pe-1`, 'B=2'), key, 'pe-1'), true);
  assert.equal(environHasExactPair(environ(`${key}=pe-12`), key, 'pe-1'), false, 'longer value');
  assert.equal(environHasExactPair(environ(`X${key}=pe-1`), key, 'pe-1'), false, 'longer key');
  assert.equal(environHasExactPair(environ(`OTHER=${key}=pe-1`), key, 'pe-1'), false, 'inside a value');
  assert.equal(environHasExactPair(Buffer.from(`${key}=pe-1`), key, 'pe-1'), true, 'no trailing NUL');
  assert.equal(environHasExactPair(Buffer.alloc(0), key, 'pe-1'), false);
});

test('finds exactly this server\'s tagged direct child, and not a prefix-sharing sibling', async () => {
  const tag = `pe-${process.pid}-${Date.now()}`;
  const wanted = startTagged(tag);
  const sibling = startTagged(`${tag}0`);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const identity = findDirectChildByProcessTag(tag);
    assert.equal(identity?.pid, wanted.pid);
    assert.match(identity?.startTicks ?? '', /^\d+$/u);
    assert.equal(findDirectChildByProcessTag(`pe-absent-${Date.now()}`), null);
  } finally {
    await stop(wanted);
    await stop(sibling);
  }
});

test('unreadable, vanished or duplicated candidates prove nothing', () => {
  const identity = (pid: number) => ({ pid, bootId: 'boot', startTicks: '7' });
  const tagged = environ(`${PERMISSION_PROCESS_TAG_ENV}=pe-x`);
  const deps = (readEnviron: (pid: number) => Buffer, pids = ['11']) => ({
    ownPid: 1,
    listPids: () => pids,
    readFile: (file: string) => (file.endsWith('/stat')
      ? Buffer.from(`${file.split('/')[2]} (x) S 1 0`)
      : readEnviron(Number(file.split('/')[2]))),
    readIdentity: identity,
  });
  const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(findDirectChildByProcessTag('pe-x', deps(fail('EACCES'))), null);
  assert.equal(findDirectChildByProcessTag('pe-x', deps(fail('ESRCH'))), null);
  assert.deepEqual(findDirectChildByProcessTag('pe-x', deps(() => tagged)), identity(11));
  assert.equal(findDirectChildByProcessTag('pe-x', deps(() => tagged, ['11', '12'])), null, 'duplicate');
  let reads = 0;
  const churn = { ...deps(() => tagged), readIdentity: (pid: number) => ({ ...identity(pid), startTicks: String(++reads) }) };
  assert.equal(findDirectChildByProcessTag('pe-x', churn), null, 'pid reused across the read');
});

test('S4 service scan finds a tagged process of our uid that is not a direct child', async () => {
  const tag = `pe-s4-${process.pid}-${Date.now()}`;
  // A detached grandchild (sh exits, sleep is reparented) is outside findDirectChildByProcessTag.
  const shell = spawn('sh', ['-c', 'sleep 30 </dev/null >/dev/null 2>&1 & echo $!'], {
    env: { PATH: process.env.PATH, [PERMISSION_PROCESS_TAG_ENV]: tag }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  shell.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  await new Promise((resolve) => shell.once('close', resolve));
  const orphanPid = Number(out.trim());
  assert.ok(Number.isSafeInteger(orphanPid) && orphanPid > 0, out);
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    assert.equal(findDirectChildByProcessTag(tag), null, 'not a direct child');
    assert.equal(scanServiceProcessesForTags([`pe-absent-${Date.now()}`, tag], Date.now()), 'present');
  } finally {
    try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('S4 service scan: other uids skipped, unreadable own-uid is uncertain, vanished is not', () => {
  const tagged = environ(`${PERMISSION_PROCESS_TAG_ENV}=pe-x`);
  const fail = (code: string) => { throw Object.assign(new Error(code), { code }); };
  const deps = (files: Record<string, Buffer | string>, pids = ['11']) => ({
    ownPid: 1,
    ownUid: 1000,
    listPids: () => pids,
    readFile: (file: string) => {
      const value = files[file];
      if (value === undefined) return fail('ENOENT');
      if (typeof value === 'string' && value.startsWith('!')) return fail(value.slice(1));
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    },
  });
  const NOW = 1_000_000_000_000;
  const ours = 'Name:\tx\nUid:\t1000\t1000\t1000\t1000\n';
  const theirs = 'Name:\tx\nUid:\t0\t0\t0\t0\n';
  assert.equal(scanServiceProcessesForTags([], NOW, deps({})), 'absent');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({ '/proc/11/status': ours, '/proc/11/environ': tagged })), 'present');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({
    '/proc/11/status': ours, '/proc/11/environ': environ(`${PERMISSION_PROCESS_TAG_ENV}=pe-xy`),
  })), 'absent', 'never a prefix match');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({ '/proc/11/status': theirs, '/proc/11/environ': tagged })), 'absent');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({ '/proc/11/status': ours, '/proc/11/environ': '!EACCES' })), 'hidden');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({ '/proc/11/status': 'Name:\tx\n' })), 'uncertain');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({ '/proc/11/status': '!EACCES' })), 'uncertain');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, deps({})), 'absent', 'vanished pid');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, { ...deps({}), ownUid: -1 }), 'uncertain');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, { ...deps({}), listPids: () => fail('EACCES') }), 'uncertain');
  assert.equal(scanServiceProcessesForTags(['pe-x'], Number.NaN, deps({})), 'uncertain');
  // Non-dumpable process of our uid: older than the decision (minus slack) cannot descend from it.
  const bootSeconds = (NOW - 3_600_000) / 1000;
  const aged = (startMs: number) => deps({
    '/proc/stat': `cpu 1\nbtime ${bootSeconds}\n`,
    '/proc/11/status': ours,
    '/proc/11/environ': '!EACCES',
    '/proc/11/stat': `11 (ssh-agent) S 1 ${'0 '.repeat(17)}${(startMs - NOW + 3_600_000) / 10} 0`,
  });
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, aged(NOW - 120_000)), 'absent', 'started before');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, aged(NOW - 30_000)), 'hidden', 'inside slack');
  assert.equal(scanServiceProcessesForTags(['pe-x'], NOW, aged(NOW + 5_000)), 'hidden', 'started after');
});
