#!/usr/bin/env node
/**
 * The defect this entry exists for (ADR-156, WI-9): PM2 loads a fork-mode script
 * from inside its own container, so `process.argv[1]` is never the loaded module
 * and the launcher's self-execution guard stays false. The tests reproduce that
 * load shape with a harness module that imports the target instead of being it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SCRIPTS, 'pm2-entry.mjs');
const LAUNCHER = path.join(SCRIPTS, 'nassaj-release-launcher.mjs');
const ABSENT_ROOT = '/var/tmp/nassaj-pm2-entry-absent-deploy-root';

/** A stand-in for PM2's ProcessContainerFork: it imports the target, so argv[1] is this file. */
function container(t) {
  const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'pm2-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'container.mjs');
  writeFileSync(file, 'await import(process.env.NASSAJ_TEST_TARGET_URL);\n');
  return file;
}

function loadThrough(file, target, args = []) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NASSAJ_TEST_TARGET_URL: pathToFileURL(target).href,
      NASSAJ_DEPLOY_ROOT: '',
    },
  });
}

test('the entry invokes the launcher even when argv[1] is the container', (t) => {
  const result = loadThrough(container(t), ENTRY, ['--deploy-root', ABSENT_ROOT]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { failureCode: 'runtime_root_invalid' });
});

test('the launcher alone stays inert under the same container load', (t) => {
  const result = loadThrough(container(t), LAUNCHER, ['--deploy-root', ABSENT_ROOT]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('the entry behaves identically when executed directly', () => {
  const result = spawnSync(process.execPath, [ENTRY, '--deploy-root', ABSENT_ROOT], {
    encoding: 'utf8',
    env: { ...process.env, NASSAJ_DEPLOY_ROOT: '' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { failureCode: 'runtime_root_invalid' });
});

test('the deploy root falls back to the environment the ecosystem file exports', (t) => {
  const file = container(t);
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NASSAJ_TEST_TARGET_URL: pathToFileURL(ENTRY).href,
      NASSAJ_DEPLOY_ROOT: ABSENT_ROOT,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { failureCode: 'runtime_root_invalid' });
});

test('the pinned launcher digest matches the launcher in this tree', () => {
  const pinned = readFileSync(ENTRY, 'utf8').match(/EXPECTED_LAUNCHER_SHA256 = '([0-9a-f]{64})'/)?.[1];
  const actual = createHash('sha256').update(readFileSync(LAUNCHER)).digest('hex');
  assert.equal(pinned, actual,
    'nassaj-release-launcher.mjs changed: update EXPECTED_LAUNCHER_SHA256 in scripts/pm2-entry.mjs in the same commit');
});

test('an entry paired with a foreign launcher refuses to supervise it', (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'pm2-entry-pair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(ENTRY, path.join(root, 'pm2-entry.mjs'));
  writeFileSync(path.join(root, 'nassaj-release-launcher.mjs'),
    `${readFileSync(LAUNCHER, 'utf8')}\n// a launcher from another release\n`);
  const result = spawnSync(process.execPath, [path.join(root, 'pm2-entry.mjs'), '--deploy-root', ABSENT_ROOT], {
    encoding: 'utf8',
    env: { ...process.env, NASSAJ_DEPLOY_ROOT: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paired with a different launcher: expected [0-9a-f]{64}, found [0-9a-f]{64}/);
  assert.deepEqual(JSON.parse(result.stderr.trim().split('\n').at(-1)), { failureCode: 'runtime_entry_launcher_mismatch' });
});

test('a read-only or unknown mode is refused instead of being supervised', (t) => {
  const file = container(t);
  for (const mode of ['status', 'bogus']) {
    const result = loadThrough(file, ENTRY, ['--mode', mode]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr), { failureCode: 'runtime_operation_failed' });
  }
});
