#!/usr/bin/env node
/** Reproducible B-990 correction for an installer-owned isolated candidate.
 * Writers must share this lock protocol. Symlink/type checks reject unsafe
 * snapshots; they do not defend against hostile parent-directory replacement
 * or other writers operating outside the installer protocol.
 */
import fs from 'node:fs/promises';
import fsSync, { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CODEX_IMAGE_ONLY_PATCH = Object.freeze({
  version: '0.153.2',
  originalSha256: 'd62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f',
  patchedSha256: 'f0741050088c636aef4ee970fd25e582ab1c961c18499702c26ae7962fe025d2',
  upstreamIntegrity: 'sha512-If4CYvo+Zpf6CCKxhuoyhgNbaS93UI9pYfscWr529CxCQK5fhlLQA29efutQVwuj8w9EcMhNM4rjn7zu67S+/w==',
});
const MARKER = '    const env = {};';
const ADDITION = '    // B-990: preserve image-only input as an explicit empty positional prompt.\n'
  + '    if (args.input === "" && args.images?.length > 0) {\n'
  + '      commandArgs.push("--", "");\n    }\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(`CODEX_IMAGE_ONLY_PATCH_${reason}`); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function assertDirectories(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fsSync.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  }
  return absolute;
}

function readRegular(filename) {
  const before = fsSync.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('UNSAFE_FILE');
  const handle = fsSync.openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fsSync.fstatSync(handle);
    if (!sameFile(before, opened)) fail('TARGET_CHANGED');
    const bytes = fsSync.readFileSync(handle);
    const after = fsSync.fstatSync(handle);
    if (!sameFile(after, fsSync.lstatSync(filename)) || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail('TARGET_CHANGED');
    return { bytes, stat: after };
  } finally { fsSync.closeSync(handle); }
}

function inspectTarget(root) {
  const installationRoot = assertDirectories(root);
  const packageRoot = assertDirectories(path.join(installationRoot, 'node_modules', '@openai', 'codex-sdk'));
  const metadata = readRegular(path.join(packageRoot, 'package.json'));
  const manifest = JSON.parse(metadata.bytes.toString('utf8'));
  if (manifest.name !== '@openai/codex-sdk' || manifest.version !== CODEX_IMAGE_ONLY_PATCH.version) fail('VERSION');
  assertDirectories(path.join(packageRoot, 'dist'));
  const sdkEntry = path.join(packageRoot, 'dist', 'index.js');
  return { sdkEntry, packageRoot };
}

function inspect(root) {
  const target = inspectTarget(root);
  const entry = readRegular(target.sdkEntry);
  return { ...entry, ...target, hash: digest(entry.bytes) };
}

function evidence(entry) {
  return { ...CODEX_IMAGE_ONLY_PATCH, sdkEntry: entry.sdkEntry };
}

/** Read-only synchronous guard for build pipelines; never launches or modifies anything. */
export function verifyCodexSdkImageOnlySync(root) {
  const entry = inspect(root);
  if (entry.hash !== CODEX_IMAGE_ONLY_PATCH.patchedSha256) fail('HASH');
  return evidence(entry);
}

/** Read-only release/build guard for the explicitly selected installation root. */
export async function verifyCodexSdkImageOnly(root) {
  return verifyCodexSdkImageOnlySync(root);
}

async function acquireLock(packageRoot) {
  const lock = path.join(packageRoot, '.nassaj-image-only.lock');
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      return { lock, stat: await fs.lstat(lock) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let occupied;
      try { occupied = await fs.lstat(lock); }
      catch (inspectionError) { if (inspectionError.code !== 'ENOENT') throw inspectionError; }
      if (occupied && (!occupied.isDirectory() || occupied.isSymbolicLink())) fail('UNSAFE_LOCK');
      if (Date.now() >= deadline) fail('LOCK_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function writePatched(root, original) {
  const content = original.bytes.toString('utf8');
  if (content.split(MARKER).length !== 2) fail('MARKER');
  const patched = content.replace(MARKER, ADDITION + MARKER);
  if (digest(patched) !== CODEX_IMAGE_ONLY_PATCH.patchedSha256) fail('RECIPE');
  const temporary = `${original.sdkEntry}.b990-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW, original.stat.mode & 0o777);
    await handle.chmod(original.stat.mode & 0o777);
    await handle.writeFile(patched);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await inspect(root);
    if (current.hash !== CODEX_IMAGE_ONLY_PATCH.originalSha256 || !sameFile(original.stat, current.stat)) fail('TARGET_CHANGED');
    await fs.rename(temporary, original.sdkEntry);
    const directory = await fs.open(path.dirname(original.sdkEntry), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

/** Apply the one exact recipe under a bounded cooperative installer lock. */
export async function applyCodexSdkImageOnly(root) {
  const initial = inspectTarget(root);
  const held = await acquireLock(initial.packageRoot);
  try {
    const entry = await inspect(root);
    if (entry.hash === CODEX_IMAGE_ONLY_PATCH.patchedSha256) return evidence(entry);
    if (entry.hash !== CODEX_IMAGE_ONLY_PATCH.originalSha256) fail('HASH');
    await writePatched(root, entry);
    return await verifyCodexSdkImageOnly(root);
  } finally {
    const current = await fs.lstat(held.lock);
    if (!sameFile(current, held.stat) || current.isSymbolicLink()) fail('LOCK_CHANGED');
    await fs.rmdir(held.lock);
  }
}

async function main(args) {
  const mode = args.shift();
  if (!['--check', '--apply'].includes(mode)) fail('USAGE');
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--root' || !args[1]) fail('USAGE');
    root = path.resolve(args[1]);
  }
  const result = await (mode === '--check' ? verifyCodexSdkImageOnly(root) : applyCodexSdkImageOnly(root));
  process.stdout.write(`${JSON.stringify({ event: 'codex_image_only_patch', mode, ...result })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ event: 'codex_image_only_patch_failed', error: error.message })}\n`);
    process.exitCode = 1;
  });
}
