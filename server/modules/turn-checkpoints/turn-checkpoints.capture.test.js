import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  git, makeOverlay, makeRepository, recordingWriter, removeRepository, turnContext,
} from './checkpoint-fixture.test.js';
import { storeGitSpawnCount } from './checkpoint-git.js';

import {
  checkpointStorePath,
  listTurnCheckpoints,
  readTurnCheckpointDiff,
  withTurnCheckpoint,
} from './index.js';

const storeGit = (store, ...args) => execFileSync('git', ['--git-dir', store, ...args], { encoding: 'utf8' }).trim();
const commonDir = (repo) => fs.realpathSync(path.join(repo, '.git'));
const storeOf = (repo, binding, principalId = 7) => checkpointStorePath({
  commonGitDir: commonDir(repo), principalId: String(principalId), overlayId: binding.overlayId,
});

async function turn(binding, work, { writer = recordingWriter(), principalId = 7, options } = {}) {
  await withTurnCheckpoint(turnContext(binding, writer, principalId), work, options).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  return writer.checkpoint();
}

test('store lives under the common git dir, keyed by the principal digest, mode 0700, one-way alternates', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'a.ts'), 'changed\n'));
    const store = storeOf(repo, binding);
    const digest = crypto.createHash('sha256').update('7').digest('hex').slice(0, 32);
    assert.equal(store, path.join(commonDir(repo), 'nassaj-checkpoints', 'v1', digest, `${binding.overlayId}.git`));
    assert.equal(fs.statSync(store).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(store, 'objects/info/alternates'), 'utf8').trim(), path.join(commonDir(repo), 'objects'));
    assert.equal(storeGit(store, 'config', 'core.fsmonitor'), 'false');
    assert.equal(storeGit(store, 'config', 'core.hooksPath'), '/dev/null');
    assert.equal(fs.existsSync(path.join(commonDir(repo), 'objects', 'info', 'alternates')), false);
  } finally { removeRepository(repo); }
});

test('the main repository refs and shared index are never touched', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const refsBefore = git(repo, 'for-each-ref', 'refs/');
    const overlayIndex = git(binding.cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const mainIndexStat = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
    const overlayIndexStat = fs.statSync(overlayIndex).mtimeMs;
    const event = await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'new.ts'), 'x\n'));
    assert.equal(event.status, 'captured');
    assert.equal(git(repo, 'for-each-ref', 'refs/'), refsBefore);
    assert.equal(fs.statSync(path.join(repo, '.git', 'index')).mtimeMs, mainIndexStat);
    assert.equal(fs.statSync(overlayIndex).mtimeMs, overlayIndexStat);
  } finally { removeRepository(repo); }
});

test('the stored blob is exactly the scanned bytes even when the file is swapped mid-capture', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const target = path.join(binding.cwd, 'swap.txt');
    const options = { hooks: { afterRead: (relative) => {
      if (relative === 'swap.txt') fs.writeFileSync(target, `token = "${['sk', 'ant', 'api03', 'Swapped0Secret1' + 'Value2Abc3Def4Ghi5'].join('-')}"\n`);
    } } };
    const event = await turn(binding, async () => fs.writeFileSync(target, 'clean scanned bytes\n'), { options });
    assert.equal(event.status, 'captured');
    const store = storeOf(repo, binding);
    const post = storeGit(store, 'rev-parse', `refs/checkpoints/${String(event.turnSeq).padStart(8, '0')}/post`);
    assert.equal(storeGit(store, 'show', `${post}:swap.txt`), 'clean scanned bytes');
    assert.equal(execFileSync('git', ['--git-dir', store, 'cat-file', '--batch-all-objects', '--batch']).includes('Swapped0Secret'), false);
  } finally { removeRepository(repo); }
});

test('symlinks are stored as link text, nested repositories and hardlinks are not captured', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const event = await turn(binding, async () => {
      fs.symlinkSync('/etc/passwd', path.join(binding.cwd, 'link'));
      fs.mkdirSync(path.join(binding.cwd, 'nested'));
      git(path.join(binding.cwd, 'nested'), 'init', '-q');
      fs.writeFileSync(path.join(binding.cwd, 'nested', 'inner.txt'), 'inner\n');
      fs.writeFileSync(path.join(binding.cwd, 'original.txt'), 'linked bytes\n');
      fs.linkSync(path.join(binding.cwd, 'original.txt'), path.join(binding.cwd, 'hard.txt'));
    });
    const store = storeOf(repo, binding);
    const post = `refs/checkpoints/${String(event.turnSeq).padStart(8, '0')}/post`;
    const tree = storeGit(store, 'ls-tree', '-r', post);
    assert.match(tree, /^120000 blob [0-9a-f]+\tlink$/m);
    assert.equal(storeGit(store, 'cat-file', '-p', `${post}:link`), '/etc/passwd');
    assert.doesNotMatch(tree, /nested/);
    assert.doesNotMatch(tree, /hard\.txt|original\.txt/);
    const reasons = Object.fromEntries(JSON.parse(storeGit(store, 'log', '-1', '--format=%B', post)).withheld
      .map((entry) => [entry.path, entry.reason]));
    assert.equal(reasons['hard.txt'], 'hardlink');
    assert.equal(reasons['original.txt'], 'hardlink');
  } finally { removeRepository(repo); }
});

test('a planted fsmonitor in the shared .git/config is never executed', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const marker = path.join(repo, 'fsmonitor-ran');
    const hook = path.join(repo, 'fsmonitor.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(repo, 'config', 'core.fsmonitor', hook);
    git(repo, 'config', 'core.hooksPath', path.join(repo, 'planted-hooks'));
    const event = await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'a.ts'), 'edit\n'));
    assert.equal(event.status, 'captured');
    assert.equal(fs.existsSync(marker), false);
  } finally { removeRepository(repo); }
});

test('the store stays complete after the main repository gc --prune=now', async () => {
  const repo = makeRepository({ 'a.ts': 'one\n', 'keep.ts': 'keep\n' });
  try {
    const binding = makeOverlay(repo);
    git(repo, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'side.ts'), 'side branch only\n');
    git(repo, 'add', 'side.ts');
    git(repo, 'commit', '-q', '-m', 'chore: side');
    await turn(binding, async () => {
      fs.writeFileSync(path.join(binding.cwd, 'side.ts'), 'side branch only\n');
      fs.writeFileSync(path.join(binding.cwd, 'a.ts'), 'two\n');
    });
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-D', 'side');
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '-q', '--prune=now');
    const store = storeOf(repo, binding);
    execFileSync('git', ['--git-dir', store, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    assert.equal(storeGit(store, 'show', 'refs/checkpoints/00000001/post:side.ts'), 'side branch only');
  } finally { removeRepository(repo); }
});

test('two overlays capture concurrently into separate stores', async () => {
  const repo = makeRepository();
  try {
    const first = makeOverlay(repo, { sessionId: 'first' });
    const second = makeOverlay(repo, { sessionId: 'second' });
    const [one, two] = await Promise.all([
      turn(first, async () => fs.writeFileSync(path.join(first.cwd, 'one.ts'), '1\n')),
      turn(second, async () => fs.writeFileSync(path.join(second.cwd, 'two.ts'), '2\n')),
    ]);
    assert.equal(one.status, 'captured');
    assert.equal(two.status, 'captured');
    assert.match(storeGit(storeOf(repo, first), 'ls-tree', '-r', '--name-only', 'refs/checkpoints/00000001/post'), /one\.ts/);
    assert.doesNotMatch(storeGit(storeOf(repo, first), 'ls-tree', '-r', '--name-only', 'refs/checkpoints/00000001/post'), /two\.ts/);
  } finally { removeRepository(repo); }
});

test('a throwing turn still records its post checkpoint and rethrows', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const writer = recordingWriter();
    await assert.rejects(withTurnCheckpoint(turnContext(binding, writer), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'partial.ts'), 'half\n');
      throw new Error('provider aborted');
    }), /provider aborted/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.checkpoint().status, 'captured');
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    assert.deepEqual(listed.turns[0].files, [{ path: 'partial.ts', status: 'A' }]);
  } finally { removeRepository(repo); }
});

test('a closed socket never breaks the turn', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const value = await withTurnCheckpoint(turnContext(binding, recordingWriter({ closed: true })), async () => 'done');
    assert.equal(value, 'done');
  } finally { removeRepository(repo); }
});

test('skip reasons: no principal, not the owner, timeout; the turn still runs', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    assert.equal((await turn(binding, async () => {}, { principalId: null })).reason, 'no_principal');
    assert.equal((await turn(binding, async () => {}, { principalId: 8 })).reason, 'not_owner');
    assert.equal(fs.existsSync(storeOf(repo, binding, 8)), false);
    const timedOut = await turn(binding, async () => {}, { options: { budgetMs: 1 } });
    assert.equal(timedOut.status, 'skipped');
    assert.equal(timedOut.reason, 'timeout');
  } finally { removeRepository(repo); }
});

test('caps: oversize files report their size, extra paths beyond the cap are withheld as budget', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const options = { limits: { fileBytes: 16, checkpointBytes: 1024, checkpointPaths: 2 } };
    const event = await turn(binding, async () => {
      fs.writeFileSync(path.join(binding.cwd, 'big.txt'), 'x'.repeat(40));
      for (const name of ['p1.txt', 'p2.txt', 'p3.txt']) fs.writeFileSync(path.join(binding.cwd, name), 'ok\n');
    }, { options });
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    const files = listed.turns.find((entry) => entry.turnSeq === event.turnSeq).files;
    const big = files.find((file) => file.path === 'big.txt');
    assert.deepEqual(big, { path: 'big.txt', status: 'withheld', reason: 'too_large', size: 40 });
    assert.equal(files.filter((file) => file.status === 'A').length, 2);
    assert.equal(files.filter((file) => file.reason === 'budget').length, 1);
  } finally { removeRepository(repo); }
});

test('withheld paths are reported as withheld, never unchanged, and diff refuses them', async () => {
  const repo = makeRepository({ 'settings.json': '{"a":1}\n' });
  try {
    const binding = makeOverlay(repo);
    const key = ['sk', 'ant', 'api03', 'Wh1thheld2Val' + 'ue3Abc4Def5Ghi6Jkl7'].join('-');
    const event = await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'settings.json'), `{"apiKey":"${key}"}\n`));
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    assert.deepEqual(listed.turns[0].files, [{ path: 'settings.json', status: 'withheld', reason: 'secret_content' }]);
    const diff = await readTurnCheckpointDiff({ binding, principalId: 7, turnSeq: event.turnSeq, path: 'settings.json' });
    assert.deepEqual(diff, { path: 'settings.json', withheld: true, reason: 'secret_content' });
    const manifest = storeGit(storeOf(repo, binding), 'log', '-1', '--format=%B', 'refs/checkpoints/00000001/post');
    const entry = JSON.parse(manifest).withheld.find((item) => item.path === 'settings.json');
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'reason'], 'no hash recorded for the withheld file');
  } finally { removeRepository(repo); }
});

test('manifest carries digests only: no prompt, no raw principal, pre parent is the previous post', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo, { principalId: 'user:secret-principal' });
    await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'x.ts'), '1\n'), { principalId: 'user:secret-principal' });
    await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'x.ts'), '2\n'), { principalId: 'user:secret-principal' });
    const store = storeOf(repo, binding, 'user:secret-principal');
    const message = storeGit(store, 'log', '-1', '--format=%B', 'refs/checkpoints/00000002/pre');
    const manifest = JSON.parse(message);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.phase, 'pre');
    assert.equal(manifest.turnSeq, 2);
    assert.doesNotMatch(message, /secret-principal|cm-1/);
    assert.equal(storeGit(store, 'rev-parse', 'refs/checkpoints/00000002/pre^'), storeGit(store, 'rev-parse', 'refs/checkpoints/00000001/post'));
    assert.equal(storeGit(store, 'rev-parse', 'refs/checkpoints/00000001/pre^'), binding.baseOid);
  } finally { removeRepository(repo); }
});

test('M3: 1500 new files cost a fixed number of git processes, blobs byte-identical', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const writer = recordingWriter();
    let postStarted = 0;
    let spawnsBefore = 0;
    const started = Date.now();
    await withTurnCheckpoint(turnContext(binding, writer), async () => {
      for (let index = 0; index < 1500; index += 1) {
        const dir = path.join(binding.cwd, 'gen', String(index % 30));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `f${index}.ts`), `export const v${index} = ${index};\n`);
      }
      postStarted = Date.now();
      spawnsBefore = storeGitSpawnCount();
    }, { budgetMs: 60_000 });
    const postMs = Date.now() - postStarted;
    const postSpawns = storeGitSpawnCount() - spawnsBefore;
    await new Promise((resolve) => setImmediate(resolve));
    console.log(`[M3] pre+turn ${postStarted - started} ms, post capture of 1500 files ${postMs} ms, ${postSpawns} git spawns`);
    assert.ok(postSpawns < 30, `post spawned ${postSpawns} git processes; must not scale with file count`);
    assert.equal(writer.checkpoint().status, 'captured', JSON.stringify(writer.checkpoint()));
    assert.equal(writer.checkpoint().counts.added, 1500);
    const store = storeOf(repo, binding);
    assert.equal(storeGit(store, 'show', 'refs/checkpoints/00000001/post:gen/7/f1237.ts'), 'export const v1237 = 1237;');
    execFileSync('git', ['--git-dir', store, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    assert.equal(fs.readdirSync(path.join(store, 'objects')).filter((name) => /^[0-9a-f]{2}$/.test(name)).length, 0,
      'no loose objects remain after the capture is packed');
  } finally { removeRepository(repo); }
});
