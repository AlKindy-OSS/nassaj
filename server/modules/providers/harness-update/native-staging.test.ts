// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
/**
 * T-1873 (qa HIGH): kimi-code stages its update in `<bin dir>/.staging` and
 * swaps it in on the NEXT start of any kimi command. Nassaj must never let a
 * stage survive outside its own update window: a launch (agent turn, PTY) or a
 * version probe clears it first.
 *
 * The real-binary case copies the host's official kimi (read-only source
 * ~/.kimi-code/bin/kimi, never written) into this sandbox, fakes a stage
 * (no download, no network) and proves the guarded launch runs the unchanged
 * bytes with no swap. It is skipped on hosts without the official install.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireHarnessLease, releaseHarnessLease, _resetHarnessLeases } from './lease.js';
import {
  assertNoPendingNativeStage,
  clearNativeStaging,
  clearStaleNativeStageBeforeLaunch,
  clearStageBeforeProbe,
  nativeStagingDir,
  pendingNativeStage,
} from './native-staging.js';

const REAL_KIMI = path.join(os.userInfo().homedir, '.kimi-code', 'bin', 'kimi');

function sandboxBinary(name: string, body = '#!/bin/sh\necho kimi 2.1.1\n'): string {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, `${name}-`));
  const file = path.join(dir, 'bin', 'kimi');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function fakeStage(binary: string, extra: string[] = []): void {
  const staging = nativeStagingDir(binary);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'kimi-9.9.9'), '#!/bin/sh\necho kimi 9.9.9\n', { mode: 0o755 });
  fs.writeFileSync(path.join(staging, 'staged.json'), JSON.stringify({
    version: '9.9.9', exeFileName: 'kimi-9.9.9', sha256: '0'.repeat(64), manual: true,
  }));
  for (const entry of extra) fs.writeFileSync(path.join(staging, entry), '{}');
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('staging dir is <bin dir>/.staging; staged.json and swap claims are pending records', () => {
  const bin = sandboxBinary('records');
  assert.equal(nativeStagingDir(bin), path.join(path.dirname(bin), '.staging'));
  assert.deepEqual(pendingNativeStage(bin), []);
  fakeStage(bin, ['staged.json.swap-1234', 'swap.lock']);
  assert.deepEqual(pendingNativeStage(bin), ['staged.json', 'staged.json.swap-1234']);
  assert.throws(() => assertNoPendingNativeStage(bin), /stage still pending/);
  assert.equal(clearNativeStaging(bin), true);
  assert.deepEqual(pendingNativeStage(bin), []);
  assert.equal(clearNativeStaging(bin), false, 'nothing left to remove');
  assert.doesNotThrow(() => assertNoPendingNativeStage(bin));
});

test('a symlinked .staging is unlinked, never followed', () => {
  const bin = sandboxBinary('link');
  const outside = fs.mkdtempSync(path.join(SANDBOX_HOME, 'outside-'));
  fs.writeFileSync(path.join(outside, 'staged.json'), '{}');
  fs.symlinkSync(outside, nativeStagingDir(bin));
  assert.equal(clearNativeStaging(bin), true);
  assert.equal(fs.existsSync(nativeStagingDir(bin)), false);
  assert.equal(fs.existsSync(path.join(outside, 'staged.json')), true, 'the link target is untouched');
});

test('launch guard: removes a stale stage outside an update window, leaves it inside one', () => {
  _resetHarnessLeases();
  const bin = sandboxBinary('guard');
  fakeStage(bin);
  const held = acquireHarnessLease('kimi', 'update-in-progress');
  assert.ok('lease' in held);
  assert.equal(clearStaleNativeStageBeforeLaunch('kimi', bin), false, 'the update owns its own stage');
  assert.deepEqual(pendingNativeStage(bin), ['staged.json']);
  releaseHarnessLease('kimi', 'update-in-progress');
  assert.equal(clearStaleNativeStageBeforeLaunch('kimi', bin), true);
  assert.deepEqual(pendingNativeStage(bin), []);
});

test('probe guard: only staging harnesses are cleared', () => {
  const bin = sandboxBinary('probe');
  fakeStage(bin);
  clearStageBeforeProbe({ stagesNativeUpdate: false }, bin);
  assert.deepEqual(pendingNativeStage(bin), ['staged.json']);
  clearStageBeforeProbe({ stagesNativeUpdate: true }, bin);
  assert.deepEqual(pendingNativeStage(bin), []);
});

test('real kimi binary (sandbox copy): a guarded agent launch removes the stage and runs unswapped bytes', {
  skip: fs.existsSync(REAL_KIMI) ? false : 'no official kimi install on this host',
}, async () => {
  _resetHarnessLeases();
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'real-kimi-'));
  const copy = path.join(dir, 'bin', 'kimi');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(REAL_KIMI, copy); // read-only source; the copy lives in the sandbox
  fs.chmodSync(copy, 0o755);
  const before = sha256(copy);
  fakeStage(copy);

  const previous = process.env.KIMI_PATH;
  process.env.KIMI_PATH = copy;
  try {
    // eslint-disable-next-line boundaries/no-unknown -- the kimi launch seam is the unit under test.
    const { prepareKimiAgentLaunch } = await import('../../../kimi-agent-cli.js');
    const prepared = prepareKimiAgentLaunch(
      { userId: null, command: 'hi', model: 'kimi-k2.6', permissionMode: 'default', cwd: dir, baseEnv: { PATH: '/usr/bin:/bin' } },
      {
        resolveProviderEnv: (_u: unknown, _p: unknown, env: NodeJS.ProcessEnv) => ({ ...env }),
        verifyVendorBinaryDigest: (_id: string, file: string) => file,
        ensureVendorCliGovernance: (id: string, home: string) => ({ ok: true, vendorId: id, home, repaired: false }),
        isGovernanceExempt: () => false,
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({ cmd: spec.cmd, args: spec.args }),
      },
    );
    assert.equal(prepared.binaryPath, copy);
  } finally {
    if (previous === undefined) delete process.env.KIMI_PATH;
    else process.env.KIMI_PATH = previous;
  }
  assert.equal(fs.existsSync(nativeStagingDir(copy)), false, 'the stage was removed before launch');

  // The real binary now starts with nothing to swap: same bytes, no backup.
  const version = String(execFileSync(copy, ['--version'], {
    encoding: 'utf8', timeout: 30_000,
    env: { HOME: dir, PATH: '/usr/bin:/bin', KIMI_CODE_HOME: path.join(dir, '.kimi-code'), KIMI_CODE_NO_AUTO_UPDATE: '1' },
  })).trim();
  assert.match(version, /^\d+\.\d+\.\d+/u);
  assert.equal(sha256(copy), before, 'no swap happened');
  assert.equal(fs.existsSync(`${copy}.bak`), false);
});
