/**
 * Opt-in REAL install of the committed dsh pin (T-2086 S4): `npm ci` from the
 * npm registry (~1 GB, ~1 min) into a sandbox HOME under /var/tmp, then the
 * full-tree manifest check, `dsh --version`, and tamper refusal. Skipped unless
 * NASSAJ_TEST_DSH_REAL_INSTALL=1 (network + disk); never touches a real home.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { assertDshTreeTrusted, DSH_LAUNCH_ERROR } from '../../list/dsh/dsh-launch.js';
import { _setInstallTestDeps, startHarnessInstall } from '../install.service.js';
import { getHarnessUpdateJob } from '../update-jobs.js';

import { DSH_NPM_LOCK_SOURCE } from './pins.js';
import { _resetNpmLockTrust, verifyNpmLockTreesAtBoot } from './trust.js';

const enabled = process.env.NASSAJ_TEST_DSH_REAL_INSTALL === '1';

test('real npm ci of the reviewed dsh pin installs, verifies and refuses a tampered tree', { skip: !enabled, timeout: 900_000 }, async () => {
  assert.ok(SANDBOX_HOME.startsWith('/var/tmp/'), SANDBOX_HOME);
  _setInstallTestDeps({ home: () => SANDBOX_HOME, isPlatform: () => false, serverEnv: () => ({}), audit: () => {} });
  const job = startHarnessInstall('dsh', { userId: 1 });
  await job.done;
  const done = getHarnessUpdateJob(job.jobId);
  assert.equal(done?.status, 'succeeded', JSON.stringify({ error: done?.error, log: done?.log.slice(-8) }));
  const pin = DSH_NPM_LOCK_SOURCE.reviewedPins.at(-1);
  const launcher = path.join(SANDBOX_HOME, '.local', 'bin', 'dsh');
  assert.equal(execFileSync(launcher, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX_HOME } }).trim(), pin);
  assert.doesNotThrow(() => assertDshTreeTrusted(launcher, { serverEnv: {} }));
  const victim = path.join(SANDBOX_HOME, '.local', 'share', 'dsh', 'versions', String(pin), 'node_modules', 'js-yaml', 'index.js');
  fs.appendFileSync(victim, '// tampered\n');
  _resetNpmLockTrust();
  await verifyNpmLockTreesAtBoot(SANDBOX_HOME);
  assert.throws(() => assertDshTreeTrusted(launcher, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_TAMPERED });
  _setInstallTestDeps(null);
});
