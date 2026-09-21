import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { makeShortSocketDir } from './lib/short-socket-dir.mjs';

const root = path.resolve(import.meta.dirname, '..');
// tsx opens an IPC pipe under TMPDIR, which a deep checkout's scratch dir pushes past sun_path.
const tsxTmp = makeShortSocketDir('ccd-', 'tsx-1000/4194304.pipe');
after(() => rmSync(tsxTmp, { recursive: true, force: true }));
const run = (script, args = [], input) => spawnSync(process.execPath,
  [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', input });
const runDoctor = (cwd, databasePath) => {
  const env = { ...process.env, DATABASE_PATH: databasePath, TMPDIR: tsxTmp };
  return spawnSync(path.join(root, 'node_modules', '.bin', 'tsx'),
    ['--tsconfig', path.join(root, 'server', 'tsconfig.json'),
      path.join(root, 'scripts', 'connectors-doctor.mjs'), '--json'],
    { cwd, encoding: 'utf8', env });
};

test('headless setup contracts expose help and never claim an unsupported mutation succeeded', () => {
  for (const script of ['connectors-setup.mjs', 'connectors-trust.mjs', 'connectors-profile.mjs']) {
    const help = run(script, ['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/u);
  }
  const trust = run('connectors-trust.mjs', ['--import', '-', '--non-interactive'], '{}');
  assert.equal(trust.status, 2); assert.match(trust.stdout, /CONNECTOR_HEADLESS_OWNER_AUTH_REQUIRED/u);
});

test('profile secrets never appear and permissive or symlink files are rejected before parsing', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-connector-cli-');
  try {
    const file = path.join(directory, 'secrets.json'); const secret = 'never-print-this-secret';
    writeFileSync(file, JSON.stringify({ token: secret })); chmodSync(file, 0o644);
    const result = run('connectors-profile.mjs', ['github', '--secrets-file', file, '--non-interactive']);
    assert.equal(result.status, 2); assert.match(result.stdout, /CONNECTOR_SECRETS_FILE_PERMISSIONS/u);
    assert.equal(result.stdout.includes(secret), false); assert.equal(result.stderr.includes(secret), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('doctor resolves the canonical database independently of the current working directory', () => {
  const directory = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-connector-doctor-'));
  const databasePath = path.join(directory, 'auth.db');
  try {
    writeFileSync(databasePath, '');
    for (const cwd of [root, path.join(root, 'server')]) {
      const result = runDoctor(cwd, databasePath);
      assert.equal(result.status, 2);
      const report = JSON.parse(result.stdout);
      assert.equal(report.code, undefined);
      assert.equal(report.readyForAccountLinking, false);
      assert.deepEqual(report.checks[0], {
        id: 'substrate', status: 'blocked', code: 'CONNECTOR_SUBSTRATE_UNAVAILABLE',
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
