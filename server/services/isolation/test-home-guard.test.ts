/**
 * test-home-guard.test — B-1771 acceptance A. A test run that keeps the real
 * account's HOME (an ad-hoc `node --test` outside run-isolated-node-tests.mjs)
 * must not reach any member credential tree: the roots every provider
 * credential is written under throw instead of resolving into the real home.
 * NASSAJ_TEST_REAL_HOME stands in for the passwd home so the real one is never
 * touched by this test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { assertNotRealHomeUnderTest, isUnderTestRunner } from './test-home-guard.js';
import { userConfigDir } from './provision-user-dirs.js';
import { setLocalModelSecret } from './provider-secrets-store.js';
import { getProviderSecretsKey, resetProviderSecretsKeyCacheForTests } from './provider-secrets-key-manager.js';

const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'real-home-'));
const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'other-home-'));
const saved = { HOME: process.env.HOME, REAL: process.env.NASSAJ_TEST_REAL_HOME };
after(() => {
  process.env.HOME = saved.HOME;
  if (saved.REAL === undefined) delete process.env.NASSAJ_TEST_REAL_HOME;
  else process.env.NASSAJ_TEST_REAL_HOME = saved.REAL;
  fs.rmSync(fakeRealHome, { recursive: true, force: true });
  fs.rmSync(otherHome, { recursive: true, force: true });
});

function asRealHome(): void {
  process.env.NASSAJ_TEST_REAL_HOME = fakeRealHome;
  process.env.HOME = fakeRealHome;
}

describe('test-home guard (B-1771)', () => {
  it('knows it runs under the node test runner', () => {
    assert.equal(isUnderTestRunner(), true);
    assert.equal(isUnderTestRunner({}, [], ['/usr/bin/node', '/srv/server/index.js']), false);
    assert.equal(isUnderTestRunner({ NODE_TEST_CONTEXT: 'child-v8' }, [], []), true);
    assert.equal(isUnderTestRunner({}, ['--test'], []), true);
    // qa B-1771 r1: `node file.test.mjs` sets neither marker; the entry file names it.
    assert.equal(isUnderTestRunner({}, [], ['/usr/bin/node', '/repo/server/x.test.ts']), true);
    assert.equal(isUnderTestRunner({}, [], ['/usr/bin/node', '/repo/server/x.test.mjs']), true);
    assert.equal(isUnderTestRunner({}, [], ['/usr/bin/node', '/repo/server/index.js']), false);
    assert.equal(isUnderTestRunner({}, [], ['/usr/bin/node']), false);
  });

  it('refuses a member tree when HOME is the real account home', () => {
    asRealHome();
    assert.throws(() => userConfigDir(1, '.claude'), /B-1771/u);
    assert.throws(() => assertNotRealHomeUnderTest(), /B-1771/u);
  });

  it('refuses the provider-secrets store and its key file under the real home', () => {
    asRealHome();
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    resetProviderSecretsKeyCacheForTests();
    assert.throws(() => setLocalModelSecret(1, 'srv-1', 'value'), /B-1771/u);
    delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    resetProviderSecretsKeyCacheForTests();
    assert.throws(() => getProviderSecretsKey(), /B-1771/u);
    assert.deepEqual(fs.readdirSync(fakeRealHome), [], 'nothing was written into the real home');
  });

  it('resolves normally once HOME is a sandbox', () => {
    process.env.NASSAJ_TEST_REAL_HOME = fakeRealHome;
    process.env.HOME = otherHome;
    assert.equal(userConfigDir(1, '.claude'), path.join(otherHome, '.nassaj-users', '1', '.claude'));
    assert.doesNotThrow(() => assertNotRealHomeUnderTest());
  });

  it('is inert outside a test runner, so production never throws', () => {
    asRealHome();
    assert.doesNotThrow(() => assertNotRealHomeUnderTest({
      env: { ...process.env, NODE_TEST_CONTEXT: undefined }, execArgv: [], argv: ['/usr/bin/node', '/srv/server/index.js'],
    }));
  });
});
