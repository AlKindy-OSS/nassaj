/**
 * T-1381: server/bin/claude must fail closed in production when the compiled
 * launcher is missing, instead of silently running TypeScript source through
 * tsx. Development keeps the source path.
 *
 * The real script is copied into a throwaway root under /var/tmp with stub
 * compiled/tsx entries, so nothing from the real install runs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude');
const COMPILED = 'dist-server/server/services/isolation/managed-claude-launcher.js';

let sandbox = '';

before(() => {
  sandbox = fs.mkdtempSync(path.join('/var/tmp', 'bin-claude-'));
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A fake install root holding a copy of the real launcher and a tsx stub. */
function makeRoot(name, { compiled }) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(path.join(root, 'server', 'bin'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'server', 'bin', 'claude'));
  fs.chmodSync(path.join(root, 'server', 'bin', 'claude'), 0o755);
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  fs.writeFileSync(tsx, '#!/usr/bin/env bash\necho "ran-source $*"\n');
  fs.chmodSync(tsx, 0o755);
  if (compiled) {
    fs.mkdirSync(path.dirname(path.join(root, COMPILED)), { recursive: true });
    fs.writeFileSync(path.join(root, COMPILED), "process.stdout.write('ran-compiled ' + process.argv.slice(2).join(' '));\n");
  }
  return root;
}

/** Runs the copied launcher with a given NODE_ENV (undefined = unset). */
function run(root, nodeEnv) {
  const env = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  return spawnSync(path.join(root, 'server', 'bin', 'claude'), ['--version'], { env, encoding: 'utf8' });
}

test('production with the compiled launcher runs compiled output', () => {
  const result = run(makeRoot('prod-ok', { compiled: true }), 'production');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ran-compiled --version');
});

test('production without the compiled launcher fails closed and never runs source', () => {
  const result = run(makeRoot('prod-missing', { compiled: false }), 'production');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('ran-source'), false);
  assert.match(result.stderr, /compiled Claude launcher is missing/);
});

test('development keeps the source path even when dist-server exists', () => {
  for (const nodeEnv of [undefined, 'development']) {
    const result = run(makeRoot(`dev-${nodeEnv ?? 'unset'}`, { compiled: true }), nodeEnv);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^ran-source --tsconfig .* --version\n$/);
  }
});
