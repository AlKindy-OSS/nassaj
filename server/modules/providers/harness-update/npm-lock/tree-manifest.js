/**
 * Full-tree sha256 manifest of an `npm ci` install (T-2086 S4, ADR-224).
 *
 * The manifest committed next to a reviewed lockfile
 * (server/harness-locks/<harness>/<version>/tree-manifest.json) is the root of
 * trust of that install tree: every regular file (size, sha256, exec bit),
 * every symlink (literal target) and every directory under the version dir is
 * one line, sorted by path. `treeSha256` hashes all lines; `packages` holds one
 * digest per lock package so a mismatch can name where the tree changed.
 * A planted, removed or edited file anywhere changes `treeSha256`.
 *
 * Plain JS with no path aliases: the generator script (scripts/
 * harness-lock-manifest.mjs) and the server import the same code.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Manifest schema version. */
export const TREE_MANIFEST_SCHEMA = 1;

const HASH_CONCURRENCY = 16;

/** Walks `root` (never following symlinks); returns entries sorted by relative path. */
async function walkTree(root) {
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop();
    const dirents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const full = path.join(root, childRel);
      const st = await fs.promises.lstat(full);
      if (st.isSymbolicLink()) entries.push({ kind: 'l', rel: childRel, target: await fs.promises.readlink(full) });
      else if (st.isDirectory()) {
        entries.push({ kind: 'd', rel: childRel });
        pending.push(childRel);
      } else if (st.isFile()) {
        entries.push({ kind: 'f', rel: childRel, size: st.size, exec: (st.mode & 0o111) !== 0 });
      } else {
        entries.push({ kind: 'o', rel: childRel });
      }
    }
  }
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** sha256 of one file, streamed. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Fills `sha256` of every file entry with bounded concurrency. */
async function hashEntries(root, entries) {
  const files = entries.filter((e) => e.kind === 'f');
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const entry = files[next];
      next += 1;
      entry.sha256 = await hashFile(path.join(root, entry.rel));
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker));
}

/** The canonical manifest line of one entry. */
function lineOf(entry) {
  if (entry.kind === 'f') return `f\t${entry.rel}\t${entry.exec ? 'x' : '-'}\t${entry.size}\t${entry.sha256}`;
  if (entry.kind === 'l') return `l\t${entry.rel}\t${entry.target}`;
  return `${entry.kind}\t${entry.rel}`;
}

/** The package bucket of `rel`: its longest ancestor (or itself) in `keys`, else ''. */
function bucketOf(rel, keys) {
  let probe = rel;
  while (probe !== '.' && probe !== '') {
    if (keys.has(probe)) return probe;
    probe = path.posix.dirname(probe);
  }
  return '';
}

/**
 * Computes the manifest facts of the tree at `root`. `packageKeys` are the
 * lock's package paths (`node_modules/...`); a path outside them is bucketed
 * under its nearest listed ancestor, so the key set itself is pinned.
 * @param {string} root
 * @param {readonly string[]} packageKeys
 */
export async function computeTreeManifest(root, packageKeys) {
  const keys = new Set(packageKeys);
  const entries = await walkTree(root);
  await hashEntries(root, entries);
  const tree = createHash('sha256');
  const buckets = new Map([['', createHash('sha256')]]);
  for (const key of keys) buckets.set(key, createHash('sha256'));
  let fileCount = 0;
  let symlinkCount = 0;
  let dirCount = 0;
  let otherCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const line = `${lineOf(entry)}\n`;
    tree.update(line);
    buckets.get(bucketOf(entry.rel, keys)).update(line);
    if (entry.kind === 'f') {
      fileCount += 1;
      totalBytes += entry.size;
    } else if (entry.kind === 'l') symlinkCount += 1;
    else if (entry.kind === 'd') dirCount += 1;
    else otherCount += 1;
  }
  const packages = {};
  for (const [key, hash] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    packages[key] = hash.digest('hex');
  }
  return { fileCount, symlinkCount, dirCount, otherCount, totalBytes, treeSha256: tree.digest('hex'), packages };
}

/**
 * Verifies the tree at `root` against a committed manifest. Never throws for a
 * mismatch: `{ ok, changedPackages }` (at most 20 names) — a read failure of
 * the tree is reported as `{ ok: false, error }`.
 * @param {string} root
 * @param {{ treeSha256: string, fileCount: number, packages: Record<string, string> }} manifest
 */
export async function verifyTreeManifest(root, manifest) {
  let actual;
  try {
    actual = await computeTreeManifest(root, Object.keys(manifest.packages).filter((key) => key !== ''));
  } catch (error) {
    return { ok: false, changedPackages: [], error: error?.code ?? 'tree_unreadable' };
  }
  if (actual.treeSha256 === manifest.treeSha256 && actual.otherCount === 0) {
    return { ok: true, changedPackages: [], fileCount: actual.fileCount };
  }
  const changedPackages = Object.keys(manifest.packages)
    .filter((key) => actual.packages[key] !== manifest.packages[key]).slice(0, 20);
  return { ok: false, changedPackages, fileCount: actual.fileCount };
}

/**
 * A cheap signature of the tree at `root`: every entry's path, kind, inode, size,
 * mtime and mode (lstat only, never following symlinks, no content read). Taken
 * when a full check verifies the tree and compared on every launch, so a file
 * edited, replaced, planted or removed after the check is seen without hashing.
 * Throws when the tree cannot be read.
 * @param {string} root
 * @returns {string} sha256 hex
 */
export function treeStatSignatureSync(root) {
  const lines = [];
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop();
    for (const dirent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const st = fs.lstatSync(path.join(root, childRel));
      lines.push(`${childRel}\t${st.mode}\t${st.ino}\t${st.size}\t${st.mtimeMs}`);
      if (st.isDirectory()) pending.push(childRel);
    }
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

/** sha256 of a small file (entry checks), or null when it is not a regular file. */
export function hashSmallFileSync(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The full committed manifest document of one reviewed pin: identity, the
 * lockfile digest, the launch entry digest and the tree facts of a fresh
 * `npm ci` of that lock at `installedDir`.
 * @param {{ harness: string, pkg: string, binRel: string, installedDir: string, lockBytes: Buffer }} input
 */
export async function buildPinManifest({ harness, pkg, binRel, installedDir, lockBytes }) {
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const keys = Object.keys(lock.packages ?? {})
    .filter((key) => key !== '' && fs.existsSync(path.join(installedDir, key)));
  const facts = await computeTreeManifest(installedDir, keys);
  return {
    schema: TREE_MANIFEST_SCHEMA,
    harness,
    package: pkg,
    version: lock.packages?.[`node_modules/${pkg}`]?.version ?? null,
    platform: `${process.platform}-${process.arch}`,
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    entry: { path: binRel, sha256: hashSmallFileSync(path.join(installedDir, binRel)) },
    ...facts,
  };
}
