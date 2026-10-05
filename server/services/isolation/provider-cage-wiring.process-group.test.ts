/**
 * T-1910 S2: an admitted caged Claude spawn runs in its own process group and hands its child to
 * the caller once, synchronously, so the exact identity is recorded at the spawn seam.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { after, test } from 'node:test';

import { readRuntimeProcessIdentity } from '@/modules/execution-permissions/index.js';

import { buildCagedSdkSpawn } from './provider-cage-wiring.js';

const ORIGINAL_FLAG = process.env.NASSAJ_PROVIDER_CAGE;
after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NASSAJ_PROVIDER_CAGE;
  else process.env.NASSAJ_PROVIDER_CAGE = ORIGINAL_FLAG;
});

const cageDeps = (spawnImpl: typeof spawn) => ({
  spawn: spawnImpl,
  resolveBwrapPath: () => '/opt/codex/bwrap',
  homedir: () => '/home/op',
  existsSync: () => true,
  lstatSync: (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }) as never,
  isProviderIsolated: () => true,
});

const processGroupOf = (pid: number): number => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
};

test('processGroup spawns detached and onSpawn receives the child exactly once', () => {
  process.env.NASSAJ_PROVIDER_CAGE = 'true';
  const calls: Array<Record<string, unknown>> = [];
  const fakeChild = { pid: 4242 } as unknown as ChildProcess;
  const fakeSpawn = ((_cmd: string, _args: string[], options: Record<string, unknown>) => {
    calls.push(options);
    return fakeChild;
  }) as unknown as typeof spawn;
  const seen: unknown[] = [];
  const grouped = buildCagedSdkSpawn({ userId: 1, cwd: '/w', processGroup: true, onSpawn: (child) => seen.push(child) },
    cageDeps(fakeSpawn));
  assert.ok(grouped);
  assert.equal(grouped({ command: 'claude', args: [], env: {} }), fakeChild);
  assert.equal(calls[0].detached, true);
  assert.deepEqual(seen, [fakeChild]);

  const plain = buildCagedSdkSpawn({ userId: 1, cwd: '/w' }, cageDeps(fakeSpawn));
  plain?.({ command: 'claude', args: [], env: {} });
  assert.equal('detached' in calls[1], false, 'unadmitted spawns keep the stock options');
});

test('a throwing onSpawn never breaks the spawn', () => {
  process.env.NASSAJ_PROVIDER_CAGE = 'true';
  const child = { pid: 1 } as unknown as ChildProcess;
  const hook = buildCagedSdkSpawn({ userId: 1, cwd: '/w', processGroup: true, onSpawn: () => { throw new Error('x'); } },
    cageDeps((() => child) as unknown as typeof spawn));
  assert.equal(hook?.({ command: 'claude', args: [], env: {} }), child);
});

test('a real grouped child leads its own process group and has a recordable identity', async () => {
  process.env.NASSAJ_PROVIDER_CAGE = 'true';
  // Run a harmless process in place of bwrap, keeping the hook's spawn options.
  const realSpawn = ((_cmd: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn('sleep', ['30'], { ...options, stdio: 'ignore' })) as unknown as typeof spawn;
  let identity: ReturnType<typeof readRuntimeProcessIdentity> = null;
  const hook = buildCagedSdkSpawn({ userId: 1, cwd: '/w', processGroup: true,
    onSpawn: (spawned) => { identity = readRuntimeProcessIdentity(spawned.pid as number); } }, cageDeps(realSpawn));
  const child = hook?.({ command: 'claude', args: [], env: { PATH: process.env.PATH } }) as unknown as ChildProcess;
  try {
    assert.ok(child.pid);
    assert.equal(processGroupOf(child.pid), child.pid, 'the child leads its own process group');
    assert.notEqual(processGroupOf(child.pid), processGroupOf(process.pid));
    assert.deepEqual(identity && { pid: (identity as { pid: number }).pid }, { pid: child.pid });
  } finally {
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
  }
});
