import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-without-core.sh');
const repositoryRoot = path.dirname(path.dirname(script));
const testRoot = path.resolve(process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR ?? '/var/tmp');

test('run-without-core disables core dumps for the executed process', () => {
  const result = spawnSync('bash', [script, 'bash', '-c', 'ulimit -S -c'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0');
});

test('run-without-core preserves argv without shell evaluation', () => {
  const value = 'literal value; $(must-not-run)';
  const result = spawnSync('bash', [script, 'node', '-e', 'process.stdout.write(process.argv[1])', value], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
});

test('run-without-core leaves no artifact when a child aborts', () => {
  const fixture = fs.mkdtempSync(path.join(testRoot, 'nassaj-no-core-abort-'));
  try {
    const result = spawnSync('bash', [script, 'node', '-e', 'process.abort()'], {
      cwd: fixture,
      encoding: 'utf8',
    });

    assert.equal(result.signal, 'SIGABRT');
    assert.deepEqual(fs.readdirSync(fixture), []);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('run-without-core rejects an empty command', () => {
  const result = spawnSync('bash', [script], { encoding: 'utf8' });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/);
});

test('test:scripts owns one mktemp root per run and cleans only that exact root', () => {
  const command = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
    .scripts['test:scripts'];
  assert.match(command, /scratch=\$\(mktemp -d \"\$PWD\/\.test-scripts-scratch\.XXXXXX\"\)/);
  assert.match(command, /cleanup-test-scratch\.mjs \"\$scratch\"/);
  assert.doesNotMatch(command, /mkdir -p \"\$scratch\"/);
  assert.doesNotMatch(command, /rm -rf [^\"]*\.test-scripts-scratch\*/);
});

test('test:scripts cleanup removes read-only capsule fixtures only inside its owned root', () => {
  const cleanup = path.join(repositoryRoot, 'scripts', 'cleanup-test-scratch.mjs');
  const scratch = fs.mkdtempSync(path.join(repositoryRoot, '.test-scripts-scratch.'));
  const outside = fs.mkdtempSync(path.join(testRoot, 'nassaj-cleanup-refusal-'));
  const outsideFile = path.join(outside, 'outside-read-only');
  const capsule = path.join(scratch, 'oid-capsule', '.nassaj-local-preview', 'oid-snapshots', 'a'.repeat(40));
  fs.mkdirSync(capsule, { recursive: true });
  fs.writeFileSync(path.join(capsule, 'package.json'), '{}', { mode: 0o444 });
  fs.writeFileSync(outsideFile, 'outside', { mode: 0o444 });
  fs.linkSync(outsideFile, path.join(capsule, 'external-hardlink'));
  fs.chmodSync(capsule, 0o555);

  const result = spawnSync(process.execPath, [cleanup, scratch], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
  assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o444);

  try {
    const refused = spawnSync(process.execPath, [cleanup, outside], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(refused.status, 64);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('test:scripts cleanup refuses a symlink masquerading as its owned root', () => {
  const cleanup = path.join(repositoryRoot, 'scripts', 'cleanup-test-scratch.mjs');
  const outside = fs.mkdtempSync(path.join(testRoot, 'nassaj-cleanup-symlink-target-'));
  const scratch = fs.mkdtempSync(path.join(repositoryRoot, '.test-scripts-scratch.'));
  fs.rmSync(scratch, { recursive: true });
  fs.symlinkSync(outside, scratch, 'dir');
  try {
    const refused = spawnSync(process.execPath, [cleanup, scratch], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.lstatSync(scratch).isSymbolicLink(), true);
  } finally {
    fs.rmSync(scratch, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
