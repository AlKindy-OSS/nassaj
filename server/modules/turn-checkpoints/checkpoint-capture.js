/**
 * T-2095 capture of one checkpoint (pre or post) into a private store.
 *
 * Every git call runs with GIT_DIR=<store>, GIT_WORK_TREE=<overlay> and a
 * temporary copy of the store's own stat-cache index; the shared index and the
 * project's refs are never read for writing. Bytes are read once, scanned, and
 * those same bytes are hashed into the store, so a file swapped mid-capture can
 * never smuggle unscanned content in.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CHECKPOINT_LIMITS, classifyCheckpointPath, inspectCheckpointContent } from './checkpoint-filter.js';
import { CheckpointTimeoutError, runStoreGit, storeGitEnv, storeGitText } from './checkpoint-git.js';
import { writeLooseBlob } from './checkpoint-objects.js';
import { readCandidate } from './checkpoint-read.js';
import { checkpointRef, createRef } from './checkpoint-store.js';

const HASH_CONCURRENCY = 16;
const MANIFEST_WITHHELD_CAP = 5000;

async function prepareIndex(store, workTree, baseOid, deadline) {
  const indexFile = path.join(store, 'tmp', `idx-${crypto.randomUUID()}`);
  const env = storeGitEnv({ store, workTree, indexFile });
  const privateIndex = path.join(store, 'index');
  if (fs.existsSync(privateIndex)) fs.copyFileSync(privateIndex, indexFile);
  else await runStoreGit(['read-tree', baseOid], { env, deadline });
  // QA condition 8: refresh stat info first so diff-files reports content changes only.
  await runStoreGit(['update-index', '-q', '--refresh', '--ignore-submodules'], { env, deadline, allowFailure: true });
  return { indexFile, env };
}

async function listCandidates(env, deadline) {
  const others = await runStoreGit(['ls-files', '-z', '--others', '--exclude-standard'], { env, deadline });
  const changed = await runStoreGit(['diff-files', '-z', '--name-only', '--ignore-submodules'], { env, deadline });
  const paths = new Set();
  for (const output of [others.stdout, changed.stdout]) {
    for (const entry of output.toString('utf8').split('\0')) {
      // A trailing slash is a nested repository listed as a directory: never captured.
      if (entry && !entry.endsWith('/')) paths.add(entry);
    }
  }
  return [...paths].sort();
}

async function evaluateCandidate(workTree, relativePath, limits, hooks) {
  const denied = classifyCheckpointPath(relativePath);
  if (denied) return { kind: 'withheld', reason: denied };
  const candidate = await readCandidate(workTree, relativePath, limits.fileBytes);
  if (candidate.kind !== 'file') return candidate;
  hooks?.afterRead?.(relativePath);
  const unsafe = inspectCheckpointContent(candidate.body, relativePath);
  return unsafe ? { kind: 'withheld', reason: unsafe } : candidate;
}

function withinBudget(budget, limits, candidate) {
  if (budget.paths + 1 > limits.checkpointPaths) return false;
  const bytes = candidate.kind === 'file' ? candidate.body.length : 0;
  if (budget.bytes + bytes > limits.checkpointBytes) return false;
  budget.paths += 1;
  budget.bytes += bytes;
  return true;
}

/** One --index-info line; the blob is written in-process from the scanned bytes (M3: no spawn per file). */
async function hashEntry(store, deadline, relativePath, candidate, zeroOid) {
  if (candidate.kind === 'deleted') return `0 ${zeroOid}\t${relativePath}\0`;
  if (Date.now() >= deadline) throw new CheckpointTimeoutError();
  const oid = await writeLooseBlob(store, candidate.body);
  return `${candidate.mode} ${oid}\t${relativePath}\0`;
}

/**
 * Evaluates every candidate and writes the allowed ones into the store.
 * @returns {Promise<{lines: string[], withheld: Array<{path: string, reason: string, size?: number}>}>}
 */
async function stageCandidates({ store, deadline, workTree, candidates, limits, hooks, zeroOid }) {
  const lines = [];
  const withheld = [];
  const budget = { paths: 0, bytes: 0 };
  const accepted = [];
  // Reads run in bounded parallel batches; budget decisions stay in path order.
  const evaluated = [];
  for (let index = 0; index < candidates.length; index += HASH_CONCURRENCY) {
    if (Date.now() >= deadline) throw new CheckpointTimeoutError();
    const batch = candidates.slice(index, index + HASH_CONCURRENCY);
    const results = await Promise.all(batch.map((relativePath) => evaluateCandidate(workTree, relativePath, limits, hooks)));
    results.forEach((candidate, offset) => evaluated.push([batch[offset], candidate]));
  }
  for (const [relativePath, candidate] of evaluated) {
    if (candidate.kind === 'skip') continue;
    if (candidate.kind === 'withheld') {
      withheld.push({ path: relativePath, reason: candidate.reason, ...(candidate.size != null ? { size: candidate.size } : {}) });
    } else if (!withinBudget(budget, limits, candidate)) {
      withheld.push({ path: relativePath, reason: 'budget' });
    } else accepted.push([relativePath, candidate]);
  }
  for (let index = 0; index < accepted.length; index += HASH_CONCURRENCY) {
    const batch = accepted.slice(index, index + HASH_CONCURRENCY);
    lines.push(...await Promise.all(batch.map(([relativePath, candidate]) => (
      hashEntry(store, deadline, relativePath, candidate, zeroOid)))));
  }
  return { lines, withheld };
}

/**
 * QA condition 1: copy every object of `commit` not reachable from the base or
 * an existing checkpoint into the store's own pack, so the store survives a
 * `gc --prune=now` of the project (objects borrowed through alternates included).
 */
async function packNewObjects(store, commit, baseOid, deadline) {
  const env = storeGitEnv({ store });
  const objects = await runStoreGit(['rev-list', '--objects', commit, '--not', baseOid, '--all'], { env, deadline });
  if (objects.stdout.length > 0) {
    await runStoreGit(['pack-objects', '-q', path.join(store, 'objects', 'pack', 'pack')], {
      env, deadline, input: objects.stdout,
    });
  }
  await runStoreGit(['prune-packed', '-q'], { env, deadline });
}

function manifestMessage(fields, withheld) {
  const listed = withheld.slice(0, MANIFEST_WITHHELD_CAP);
  return JSON.stringify({
    ...fields,
    withheld: listed,
    ...(withheld.length > listed.length ? { withheldOmitted: withheld.length - listed.length } : {}),
  });
}

/** Entry count from a git index header ("DIRC", version, count), or null when unreadable. */
function indexEntryCount(indexFile) {
  try {
    const header = Buffer.alloc(12);
    const descriptor = fs.openSync(indexFile, 'r');
    try { fs.readSync(descriptor, header, 0, 12, 0); } finally { fs.closeSync(descriptor); }
    return header.toString('latin1', 0, 4) === 'DIRC' ? header.readUInt32BE(8) : null;
  } catch {
    return null;
  }
}

/**
 * write-tree that refuses a tree not built from `indexFile` (M2): git treats a
 * missing GIT_INDEX_FILE as an empty index, so the index must exist with the
 * same entry count before and after the call (git may rewrite it to store its
 * cache tree, so the inode is not compared).
 */
async function writeTreeFromIndex(env, indexFile, deadline, afterWrite) {
  const before = indexEntryCount(indexFile);
  if (before === null) throw new Error('checkpoint index is missing before write-tree');
  const tree = await storeGitText(['write-tree'], { env, deadline });
  afterWrite?.();
  if (indexEntryCount(indexFile) !== before) throw new Error('checkpoint index changed during write-tree');
  return tree;
}

/**
 * Captures one checkpoint and creates its ref atomically.
 * @param {{store: string, workTree: string, baseOid: string, parent: string, turnSeq: number,
 *   phase: 'pre'|'post', fields: object, deadline: number, limits?: object, hooks?: object}} input
 * Any failure other than the time budget drops the private index, so the next
 * capture rebuilds it from the base instead of reusing an index that may name
 * objects retention removed (qa round 2).
 * @returns {Promise<{commit: string, withheld: Array<object>}>}
 */
export async function captureCheckpoint(input) {
  try {
    return await captureIntoStore(input);
  } catch (error) {
    if (!(error instanceof CheckpointTimeoutError)) fs.rmSync(path.join(input.store, 'index'), { force: true });
    throw error;
  }
}

async function captureIntoStore({ store, workTree, baseOid, parent, turnSeq, phase, fields, deadline, limits, hooks }) {
  const effectiveLimits = { ...CHECKPOINT_LIMITS, ...limits };
  const { indexFile, env } = await prepareIndex(store, workTree, baseOid, deadline);
  try {
    const candidates = await listCandidates(env, deadline);
    const zeroOid = '0'.repeat(baseOid.length);
    const { lines, withheld } = await stageCandidates({
      store, deadline, workTree, candidates, limits: effectiveLimits, hooks, zeroOid,
    });
    if (lines.length > 0) await runStoreGit(['update-index', '-z', '--index-info'], { env, deadline, input: lines.join('') });
    const tree = await writeTreeFromIndex(env, indexFile, deadline, () => hooks?.afterWriteTree?.(indexFile, phase));
    const commit = await storeGitText(['commit-tree', tree, '-p', parent, '-F', '-'], {
      env, deadline, input: manifestMessage({ ...fields, turnSeq, phase }, withheld),
    });
    await packNewObjects(store, commit, baseOid, deadline);
    // M2: the private index moves into place first; a ref is created only for a
    // tree built from that exact index, and a failed ref drops the index so the
    // next capture reseeds from the base instead of trusting an orphan state.
    fs.renameSync(indexFile, path.join(store, 'index'));
    try {
      await createRef(store, checkpointRef(turnSeq, phase), commit, deadline);
    } catch (error) {
      fs.rmSync(path.join(store, 'index'), { force: true });
      throw error;
    }
    return { commit, withheld };
  } finally {
    fs.rmSync(indexFile, { force: true });
    fs.rmSync(`${indexFile}.lock`, { force: true });
  }
}
