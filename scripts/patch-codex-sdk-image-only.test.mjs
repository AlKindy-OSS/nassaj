import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyCodexSdkImageOnly, verifyCodexSdkImageOnly, verifyCodexSdkImageOnlySync, CODEX_IMAGE_ONLY_PATCH } from './patch-codex-sdk-image-only.mjs';

const installed = await fs.readFile(fileURLToPath(import.meta.resolve('@openai/codex-sdk')), 'utf8');
const original = installed.replace(/    \/\/ B-990: preserve image-only input as an explicit empty positional prompt\.\n    if \(args\.input === "" && args\.images\?\.length > 0\) \{\n      commandArgs\.push\("--", ""\);\n    \}\n/u, '');
assert.equal(createHash('sha256').update(original).digest('hex'), CODEX_IMAGE_ONLY_PATCH.originalSha256);

async function fixture(run) {
  const root = await fs.mkdtemp('/var/tmp/b990-patch-test-');
  const packageRoot = path.join(root, 'node_modules/@openai/codex-sdk');
  const entry = path.join(packageRoot, 'dist/index.js');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-sdk', version: '0.153.2' }));
  await fs.writeFile(entry, original, { mode: 0o640 });
  try { await run({ root, packageRoot, entry }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function assertClean(packageRoot) {
  assert.deepEqual((await fs.readdir(packageRoot)).sort(), ['dist', 'package.json']);
  assert.deepEqual(await fs.readdir(path.join(packageRoot, 'dist')), ['index.js']);
}

test('read-only verification refuses original and does not change it', () => fixture(async ({ root, entry, packageRoot }) => {
  await assert.rejects(verifyCodexSdkImageOnly(root), /PATCH_HASH/u);
  assert.throws(() => verifyCodexSdkImageOnlySync(root), /PATCH_HASH/u);
  assert.equal(await fs.readFile(entry, 'utf8'), original);
  await assertClean(packageRoot);
}));

test('exact recipe is atomic, preserves mode and is idempotent', () => fixture(async ({ root, entry, packageRoot }) => {
  const before = await fs.stat(entry);
  const result = await applyCodexSdkImageOnly(root);
  assert.equal(result.patchedSha256, CODEX_IMAGE_ONLY_PATCH.patchedSha256);
  const after = await fs.stat(entry);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o640);
  assert.deepEqual(await applyCodexSdkImageOnly(root), await verifyCodexSdkImageOnly(root));
  assert.deepEqual(verifyCodexSdkImageOnlySync(root), await verifyCodexSdkImageOnly(root));
  assert.equal((await fs.stat(entry)).ino, after.ino);
  await assertClean(packageRoot);
}));

test('concurrent installers serialize and leave one valid patch without locks', () => fixture(async ({ root, packageRoot }) => {
  const results = await Promise.all(Array.from({ length: 12 }, () => applyCodexSdkImageOnly(root)));
  assert.ok(results.every(value => value.patchedSha256 === CODEX_IMAGE_ONLY_PATCH.patchedSha256));
  await verifyCodexSdkImageOnly(root);
  await assertClean(packageRoot);
}));

for (const [name, changed] of [['upstream drift', original + '\n'], ['partial patch', original.replace('const env = {};', 'const env = { B990: true };')]]) {
  test(`rejects ${name} and releases lock without changing bytes`, () => fixture(async ({ root, entry, packageRoot }) => {
    await fs.writeFile(entry, changed);
    await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_HASH/u);
    assert.equal(await fs.readFile(entry, 'utf8'), changed);
    await assertClean(packageRoot);
  }));
}

test('rejects package version drift', () => fixture(async ({ root, packageRoot }) => {
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-sdk', version: '0.154.0' }));
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_VERSION/u);
  await assertClean(packageRoot);
}));

test('rejects missing entry without creating one', () => fixture(async ({ root, entry, packageRoot }) => {
  await fs.unlink(entry);
  await assert.rejects(applyCodexSdkImageOnly(root), /ENOENT/u);
  assert.deepEqual(await fs.readdir(path.dirname(entry)), []);
  assert.deepEqual((await fs.readdir(packageRoot)).sort(), ['dist', 'package.json']);
}));

test('rejects symlink entry and never writes its referent', () => fixture(async ({ root, entry }) => {
  const target = path.join(root, 'untouched.js');
  await fs.rename(entry, target);
  await fs.symlink(target, entry);
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_UNSAFE_FILE/u);
  assert.equal(await fs.readFile(target, 'utf8'), original);
}));

test('rejects hard-linked entry', () => fixture(async ({ root, entry }) => {
  await fs.link(entry, path.join(root, 'hardlink.js'));
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_UNSAFE_FILE/u);
}));

test('rejects symlink installation root', () => fixture(async ({ root }) => {
  const alias = path.join(root, 'alias');
  await fs.symlink(root, alias);
  await assert.rejects(verifyCodexSdkImageOnly(alias), /PATCH_UNSAFE_DIRECTORY/u);
}));

test('rejects symlink package directory', () => fixture(async ({ root, packageRoot }) => {
  const target = path.join(root, 'sdk-copy');
  await fs.rename(packageRoot, target);
  await fs.symlink(target, packageRoot);
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_UNSAFE_DIRECTORY/u);
}));

test('rejects unsafe lock and leaves external target intact', () => fixture(async ({ root, packageRoot }) => {
  const target = path.join(root, 'untouched-lock');
  await fs.mkdir(target);
  await fs.symlink(target, path.join(packageRoot, '.nassaj-image-only.lock'));
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_UNSAFE_LOCK/u);
  assert.ok((await fs.stat(target)).isDirectory());
}));

test('occupied lock times out without stealing or removing it', () => fixture(async ({ root, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  await fs.mkdir(lock);
  const before = await fs.stat(lock);
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_LOCK_TIMEOUT/u);
  assert.equal((await fs.stat(lock)).ino, before.ino);
}));

test('tampering after successful apply cannot pass verification', () => fixture(async ({ root, entry, packageRoot }) => {
  await applyCodexSdkImageOnly(root);
  await fs.appendFile(entry, '// tampered\n');
  await assert.rejects(verifyCodexSdkImageOnly(root), /PATCH_HASH/u);
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_HASH/u);
  await assertClean(packageRoot);
}));

test('rechecks original bytes after acquiring a previously occupied lock', () => fixture(async ({ root, entry, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  await fs.mkdir(lock);
  const applying = applyCodexSdkImageOnly(root);
  const rejected = assert.rejects(applying, /PATCH_HASH/u);
  await new Promise(resolve => setTimeout(resolve, 75));
  await fs.appendFile(entry, '// concurrent drift\n');
  await fs.rmdir(lock);
  await rejected;
  assert.equal(await fs.readFile(entry, 'utf8'), original + '// concurrent drift\n');
  await assertClean(packageRoot);
}));

test('preserves original mode even under a restrictive installer umask', () => fixture(async ({ root, entry }) => {
  const previous = process.umask(0o077);
  try {
    await applyCodexSdkImageOnly(root);
    assert.equal((await fs.stat(entry)).mode & 0o777, 0o640);
  } finally { process.umask(previous); }
}));

test('retries a lock removed between EEXIST and inspection', t => fixture(async ({ root, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  await fs.mkdir(lock);
  const lstat = fs.lstat;
  let released = false;
  t.mock.method(fs, 'lstat', async filename => {
    if (filename === lock && !released) { released = true; await fs.rmdir(lock); }
    return lstat(filename);
  });
  await applyCodexSdkImageOnly(root);
  assert.equal(released, true);
  await assertClean(packageRoot);
}));

test('repeated disappearing locks retain one bounded deadline', t => fixture(async ({ root, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  const mkdir = fs.mkdir;
  const lstat = fs.lstat;
  let attempts = 0;
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(fs, 'mkdir', async (filename, options) => {
    if (filename !== lock) return mkdir(filename, options);
    attempts += 1;
    clock += 1000;
    throw Object.assign(new Error('competing installer'), { code: 'EEXIST' });
  });
  t.mock.method(fs, 'lstat', async filename => {
    if (filename !== lock) return lstat(filename);
    throw Object.assign(new Error('released lock'), { code: 'ENOENT' });
  });
  await assert.rejects(applyCodexSdkImageOnly(root), /PATCH_LOCK_TIMEOUT/u);
  assert.equal(attempts, 3);
  await assertClean(packageRoot);
}));

test('lock inspection retries ENOENT only and propagates other errors', t => fixture(async ({ root, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  await fs.mkdir(lock);
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async filename => {
    if (filename === lock) throw Object.assign(new Error('denied lock inspection'), { code: 'EACCES' });
    return lstat(filename);
  });
  await assert.rejects(applyCodexSdkImageOnly(root), { code: 'EACCES' });
  await fs.rmdir(lock);
  await assertClean(packageRoot);
}));

test('two coordinated installers read SDK bytes only under the lock and commit once', t => fixture(async ({ root, entry, packageRoot }) => {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  const rename = fs.rename;
  const mkdir = fs.mkdir;
  const lstat = fsSync.lstatSync;
  const enteredRename = Promise.withResolvers();
  const releaseRename = Promise.withResolvers();
  let protectPreLockRead = false;
  let renames = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (args[1] === entry) { renames += 1; enteredRename.resolve(); await releaseRename.promise; }
    return rename(...args);
  });
  t.mock.method(fsSync, 'lstatSync', (...args) => {
    if (args[0] === entry && protectPreLockRead) assert.fail('SDK bytes inspected before acquiring the lock');
    return lstat(...args);
  });
  t.mock.method(fs, 'mkdir', async (...args) => {
    try { return await mkdir(...args); }
    catch (error) {
      if (args[0] === lock && error.code === 'EEXIST') {
        protectPreLockRead = false;
        releaseRename.resolve();
      }
      throw error;
    }
  });
  const first = applyCodexSdkImageOnly(root);
  await enteredRename.promise;
  protectPreLockRead = true;
  try {
    const second = applyCodexSdkImageOnly(root);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(renames, 1);
    await verifyCodexSdkImageOnly(root);
    await assertClean(packageRoot);
  } finally { protectPreLockRead = false; releaseRename.resolve(); await first; }
}));
