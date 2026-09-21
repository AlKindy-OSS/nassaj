import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-crash-artifacts.mjs');
const testRoot = path.resolve(process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR ?? '/var/tmp');

function withFixture(run) {
  const fixture = fs.mkdtempSync(path.join(testRoot, 'nassaj-crash-guard-'));
  try {
    return run(fixture);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test('crash guard reports a clean tree', () => withFixture((fixture) => {
  fs.writeFileSync(path.join(fixture, 'ordinary.txt'), 'ok');
  const result = spawnSync(process.execPath, [script, `--root=${fixture}`], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
}));

test('crash guard detects ignored-style core artifacts in nested worktrees', () => withFixture((fixture) => {
  const nested = path.join(fixture, '.worktrees', 'feature');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'core.1234'), 'sensitive');
  const result = spawnSync(process.execPath, [script, `--root=${fixture}`], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.artifacts.map((artifact) => artifact.path), ['.worktrees/feature/core.1234']);
}));

test('crash guard does not follow symlinks or generated dependency trees', () => withFixture((fixture) => {
  const outside = fs.mkdtempSync(path.join(testRoot, 'nassaj-crash-guard-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'core.8'), 'outside');
    fs.symlinkSync(outside, path.join(fixture, 'linked'));
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    fs.writeFileSync(path.join(fixture, 'node_modules', 'core.9'), 'generated');
    const result = spawnSync(process.execPath, [script, `--root=${fixture}`], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).artifacts, []);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));
