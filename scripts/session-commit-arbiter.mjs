#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { previewDomainsForPaths } from './preview-oid-dispatch.mjs';
import { previewEventMutationLock, previewEventRefs } from './local-preview-ledger.mjs';
import { materializePreviewSnapshot, resolvePreviewOid } from './preview-oid-pipeline.mjs';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_TTL_MS = 5 * 60_000;

function runGit(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: options.encoding === null ? null : 'utf8',
    env: { ...process.env, ...options.env },
    input: options.input,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : result.stderr;
    throw new Error(`git ${args.join(' ')} failed: ${detail?.trim() || `exit ${result.status}`}`);
  }
  return result;
}

function gitText(repo, args, options) {
  return runGit(repo, args, options).stdout.trim();
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function durableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function commonStateDir(repo) {
  const common = gitText(repo, ['rev-parse', '--git-common-dir']);
  return path.join(path.resolve(repo, common), 'nassaj', 'commit-arbiter');
}

function withLock(stateDir, operation, timeoutMs = 15_000, repo = null) {
  const lock = path.join(stateDir, 'lock');
  fs.mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('commit arbiter lock timeout');
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        let ownerAlive = true;
        try { process.kill(owner.pid, 0); } catch (signalError) { ownerAlive = signalError.code !== 'ESRCH'; }
        if (!ownerAlive || Date.now() - owner.at > timeoutMs * 2) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      Atomics.wait(sleepBuffer, 0, 0, 20);
    }
  }
  try {
    if (repo) {
      recoverPendingCutovers(repo, stateDir);
      recoverPendingPreviewReplays(repo, stateDir);
    }
    return operation();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function normalizePath(repo, candidate) {
  if (!candidate || path.isAbsolute(candidate) || candidate.includes('\0')) throw new Error(`invalid owned path: ${candidate}`);
  const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '.git' || normalized.startsWith('.git/') || normalized.split('/').includes('..')) {
    throw new Error(`path escapes repository: ${candidate}`);
  }
  const root = fs.realpathSync(repo);
  let cursor = root;
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = path.join(cursor, segments[index]);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink traversal is forbidden: ${candidate}`);
  }
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes repository: ${candidate}`);
  return normalized;
}

/** Resolve repository-relative ownership paths without following directory symlinks. */
export function canonicalizeOwnedPaths(repo, paths) {
  const exact = [...new Set(paths.map((item) => normalizePath(repo, item)))].sort();
  const folded = new Map();
  for (const item of exact) {
    const key = item.normalize('NFC').toLocaleLowerCase('en-US');
    if (folded.has(key) && folded.get(key) !== item) throw new Error(`case-colliding paths: ${folded.get(key)} and ${item}`);
    folded.set(key, item);
  }
  return exact;
}

function leasesFile(repo) {
  return path.join(commonStateDir(repo), 'leases.json');
}

function readLeases(repo) {
  try { return JSON.parse(fs.readFileSync(leasesFile(repo), 'utf8')); } catch { return { sessions: {} }; }
}

function assertFence(repo, session, generation, requiredPaths = []) {
  const lease = readLeases(repo).sessions[session];
  if (!lease || lease.generation !== generation || lease.expiresAt <= Date.now()) throw new Error(`stale fencing token for ${session}`);
  for (const ownedPath of requiredPaths) {
    if (!lease.paths.includes(ownedPath)) throw new Error(`session ${session} does not own ${ownedPath}`);
  }
  return lease;
}

/** Acquire a generation-fenced overlay or exclusive mutable-worktree lease. */
export function acquireLease({ repo, session, paths, ttlMs = DEFAULT_TTL_MS, isolation = 'overlay' }) {
  if (!['overlay', 'worktree'].includes(isolation)) throw new Error(`unsupported lease isolation: ${isolation}`);
  const stateDir = commonStateDir(repo);
  const canonical = canonicalizeOwnedPaths(repo, paths);
  return withLock(stateDir, () => {
    const state = readLeases(repo);
    const now = Date.now();
    for (const [otherSession, lease] of Object.entries(state.sessions)) {
      if (otherSession !== session && lease.expiresAt > now && lease.paths.some((item) => canonical.includes(item)) && (isolation !== 'overlay' || lease.isolation !== 'overlay')) {
        throw new Error(`path already leased by ${otherSession}`);
      }
    }
    const generation = (state.sessions[session]?.generation ?? 0) + 1;
    state.sessions[session] = { generation, isolation, paths: canonical, expiresAt: now + ttlMs };
    atomicJson(leasesFile(repo), state);
    return { generation, isolation, paths: canonical, expiresAt: now + ttlMs };
  }, 15_000, repo);
}

/** Extend a lease only when its fencing generation is still current. */
export function heartbeatLease({ repo, session, generation, ttlMs = DEFAULT_TTL_MS }) {
  return withLock(commonStateDir(repo), () => {
    const state = readLeases(repo);
    assertFence(repo, session, generation);
    state.sessions[session].expiresAt = Date.now() + ttlMs;
    atomicJson(leasesFile(repo), state);
    return state.sessions[session];
  }, 15_000, repo);
}

/** Release only the exact lease generation, leaving a concurrently renewed lease intact. */
export function releaseLease({ repo, session, generation }) {
  return withLock(commonStateDir(repo), () => {
    const state = readLeases(repo);
    const lease = state.sessions[session];
    if (!lease || lease.generation !== generation) return { released: false };
    delete state.sessions[session];
    atomicJson(leasesFile(repo), state);
    return { released: true };
  }, 15_000, repo);
}

function updateIndexEntry(repo, indexFile, ownedPath) {
  const diskPath = path.join(repo, ownedPath);
  const env = { GIT_INDEX_FILE: indexFile };
  if (!fs.existsSync(diskPath)) {
    runGit(repo, ['update-index', '--force-remove', '--', ownedPath], { env, allowFailure: true });
    return { path: ownedPath, deleted: true };
  }
  const stat = fs.lstatSync(diskPath);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`only files and symlinks can be captured: ${ownedPath}`);
  const body = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(diskPath)) : fs.readFileSync(diskPath);
  const oid = gitText(repo, ['hash-object', '-w', '--stdin'], { input: body });
  const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111 ? '100755' : '100644');
  runGit(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${ownedPath}`], { env });
  return { path: ownedPath, oid, mode };
}

function applySubmittedPatch(repo, indexFile, baseline, submission, allowedChangedPaths) {
  const ownedPath = normalizePath(repo, submission.path);
  if (typeof submission.patch !== 'string' || !submission.patch.trim()) throw new Error(`empty submitted patch for ${ownedPath}`);
  const env = { GIT_INDEX_FILE: indexFile };
  const result = runGit(repo, ['apply', '--cached', '--whitespace=nowarn', '--recount', '-'], {
    env,
    input: submission.patch,
    allowFailure: true,
  });
  if (result.status !== 0) throw new Error(`submitted patch does not apply to base ${baseline}: ${result.stderr.trim()}`);
  const changed = gitText(repo, ['diff', '--cached', '--name-only', '-z', baseline], { env })
    .split('\0')
    .filter(Boolean);
  const escaped = changed.filter((item) => !allowedChangedPaths.has(item));
  if (escaped.length) throw new Error(`submitted patch escapes declared path ${ownedPath}: ${escaped.join(', ')}`);
  if (!changed.includes(ownedPath)) throw new Error(`submitted patch did not change declared path ${ownedPath}`);
  const stage = gitText(repo, ['ls-files', '--stage', '--', ownedPath], { env });
  if (!stage) return { path: ownedPath, deleted: true, baseBlob: gitText(repo, ['rev-parse', `${baseline}:${ownedPath}`], { allowFailure: true }) || null, patchDigest: crypto.createHash('sha256').update(submission.patch).digest('hex') };
  const match = stage.match(/^(\d+) ([0-9a-f]+) 0\t/);
  if (!match) throw new Error(`cannot resolve submitted blob for ${ownedPath}`);
  const base = runGit(repo, ['rev-parse', `${baseline}:${ownedPath}`], { allowFailure: true });
  return {
    path: ownedPath,
    mode: match[1],
    oid: match[2],
    baseBlob: base.status === 0 ? base.stdout.trim() : null,
    patchDigest: crypto.createHash('sha256').update(submission.patch).digest('hex'),
  };
}

function applySubmittedBlob(repo, indexFile, baseline, submission) {
  const ownedPath = normalizePath(repo, submission.path);
  const env = { GIT_INDEX_FILE: indexFile };
  const base = runGit(repo, ['rev-parse', `${baseline}:${ownedPath}`], { allowFailure: true });
  const baseBlob = base.status === 0 ? base.stdout.trim() : null;
  if (submission.deleted === true) {
    if (!baseBlob) throw new Error(`cannot delete untracked overlay path: ${ownedPath}`);
    runGit(repo, ['update-index', '--force-remove', '--', ownedPath], { env });
    return { path: ownedPath, deleted: true, baseBlob };
  }
  if (!Buffer.isBuffer(submission.body)) throw new Error(`submitted blob body is required: ${ownedPath}`);
  const mode = submission.mode === '100755' ? '100755' : '100644';
  const oid = gitText(repo, ['hash-object', '-w', '--stdin'], { input: submission.body });
  runGit(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${ownedPath}`], { env });
  return { path: ownedPath, oid, mode, baseBlob };
}

function requestRef(session, generation, requestId) {
  const safeSession = session.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `refs/nassaj/requests/${safeSession}/${generation}/${requestId}`;
}

/** Capture immutable blobs in a durable Git ref; submitted patches are applied to base blobs, never the worktree. */
export function captureRequest({ repo, session, generation, paths = [], renames = [], submittedPatches = [], submittedBlobs = [], targetRef = 'HEAD', baselineRef = targetRef }) {
  const renamePaths = renames.flatMap(({ from, to }) => [from, to]);
  const submittedPaths = submittedPatches.map(({ path: submittedPath }) => submittedPath);
  const submittedBlobPaths = submittedBlobs.map(({ path: submittedPath }) => submittedPath);
  const ownedPaths = canonicalizeOwnedPaths(repo, [...paths, ...renamePaths, ...submittedPaths, ...submittedBlobPaths]);
  const lease = assertFence(repo, session, generation, ownedPaths);
  if (paths.length && lease.isolation !== 'worktree') {
    throw new Error('reading mutable worktree content requires a worktree-isolated lease; use submittedPatches for overlays');
  }
  const canonicalSubmittedPaths = new Set(
    [...submittedPaths, ...submittedBlobPaths].map((item) => normalizePath(repo, item)),
  );
  if (canonicalSubmittedPaths.size !== submittedPatches.length + submittedBlobs.length) {
    throw new Error('only one submitted patch or blob per path is allowed');
  }
  if (lease.isolation === 'overlay' && renames.some(({ from, to }) =>
    !canonicalSubmittedPaths.has(normalizePath(repo, from))
    || !canonicalSubmittedPaths.has(normalizePath(repo, to)))) {
    throw new Error('overlay rename requires submitted patches for both sides');
  }
  for (const rename of renames) {
    const from = normalizePath(repo, rename.from);
    const to = normalizePath(repo, rename.to);
    if (!ownedPaths.includes(from) || !ownedPaths.includes(to)) throw new Error('a rename must own both source and destination');
  }
  const stateDir = commonStateDir(repo);
  return withLock(stateDir, () => {
    assertFence(repo, session, generation, ownedPaths);
    const baseline = gitText(repo, ['rev-parse', `${baselineRef}^{commit}`]);
    const scratch = fs.mkdtempSync(path.join(stateDir, '.capture-'));
    try {
      const indexFile = path.join(scratch, 'index');
      const env = { GIT_INDEX_FILE: indexFile };
      runGit(repo, ['read-tree', baseline], { env });
      const submittedSet = canonicalSubmittedPaths;
      const entries = ownedPaths.filter((ownedPath) => !submittedSet.has(ownedPath)).map((ownedPath) => updateIndexEntry(repo, indexFile, ownedPath));
      const allowedChangedPaths = new Set(ownedPaths);
      for (const submission of submittedPatches) {
        entries.push(applySubmittedPatch(repo, indexFile, baseline, submission, allowedChangedPaths));
      }
      for (const submission of submittedBlobs) {
        entries.push(applySubmittedBlob(repo, indexFile, baseline, submission));
      }
      const tree = gitText(repo, ['write-tree'], { env });
      const requestId = crypto.randomUUID();
      const manifest = { schema: 1, requestId, session, generation, baseline, targetRef, ownedPaths, renames, entries, tree, createdAt: Date.now() };
      const commit = gitText(repo, ['commit-tree', tree, '-p', baseline, '-m', `nassaj request\n\n${JSON.stringify(manifest)}`]);
      const ref = requestRef(session, generation, requestId);
      runGit(repo, ['update-ref', '-m', `nassaj request ${requestId}`, ref, commit]);
      manifest.requestCommit = commit;
      manifest.requestRef = ref;
      atomicJson(path.join(stateDir, 'requests', `${requestId}.json`), manifest);
      return manifest;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 15_000, repo);
}

function readManifest(repo, requestId) {
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('invalid arbiter request id');
  const file = path.join(commonStateDir(repo), 'requests', `${requestId}.json`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const refCommit = gitText(repo, ['rev-parse', manifest.requestRef]);
  if (refCommit !== manifest.requestCommit) throw new Error('request ref no longer matches immutable manifest');
  return manifest;
}

/** Read a durable request contract without exposing mutable state paths. */
export function inspectRequest({ repo, requestId }) {
  const manifest = readManifest(repo, requestId);
  return Object.freeze({
    requestId: manifest.requestId,
    session: manifest.session,
    generation: manifest.generation,
    ownedPaths: [...manifest.ownedPaths],
    renames: manifest.renames.map((rename) => ({ ...rename })),
    targetRef: manifest.targetRef,
  });
}

function isResumableConflict(error) {
  return /owned-path conflict|default index staged-intent conflict|default index changed during cutover/.test(error?.message || '');
}

/** Re-capture resolved worktree bytes under a fresh fence while retaining the original request ref. */
export function resumeRequest({ repo, requestId, message, authorEnv }) {
  const original = readManifest(repo, requestId);
  const lease = acquireLease({
    repo,
    session: original.session,
    paths: original.ownedPaths,
    isolation: 'worktree',
  });
  let resumed;
  let preserveLease = false;
  try {
    resumed = captureRequest({
      repo,
      session: original.session,
      generation: lease.generation,
      paths: original.ownedPaths,
      targetRef: original.targetRef,
    });
    const result = commitRequest({ repo, requestId: resumed.requestId, message, authorEnv });
    return { ...result, requestId: resumed.requestId, resumedFrom: requestId };
  } catch (error) {
    if (resumed && isResumableConflict(error)) {
      preserveLease = true;
      error.commitConflict = {
        requestId: resumed.requestId,
        resumedFrom: requestId,
        session: original.session,
        generation: lease.generation,
      };
    }
    throw error;
  } finally {
    if (!preserveLease) releaseLease({ repo, session: original.session, generation: lease.generation });
  }
}

function validateMessage(repo, stateDir, message) {
  if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\r\n]+\))?!?: .+/.test(message)) {
    throw new Error('commit message must follow Conventional Commits');
  }
  const hook = gitText(repo, ['rev-parse', '--git-path', 'hooks/commit-msg']);
  if (!fs.existsSync(path.resolve(repo, hook))) return;
  const scratch = fs.mkdtempSync(path.join(stateDir, '.message-'));
  try {
    const file = path.join(scratch, 'COMMIT_EDITMSG');
    fs.writeFileSync(file, `${message}\n`);
    runGit(repo, ['hook', 'run', 'commit-msg', '--', file]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizeAuthorEnv(authorEnv) {
  if (authorEnv == null) return {};
  if (typeof authorEnv !== 'object' || Array.isArray(authorEnv)) throw new Error('authorEnv must be an object');
  const allowed = new Set([
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
  ]);
  const normalized = {};
  for (const [key, value] of Object.entries(authorEnv)) {
    if (!allowed.has(key)) throw new Error(`unsupported authorEnv key: ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`invalid authorEnv value for ${key}`);
    normalized[key] = value;
  }
  return normalized;
}

function mergeTree(repo, baseline, latest, requestCommit) {
  const result = runGit(repo, ['merge-tree', '--write-tree', '--merge-base', baseline, latest, requestCommit], { allowFailure: true });
  if (result.status !== 0) throw new Error(`owned-path conflict:\n${result.stdout}${result.stderr}`);
  return result.stdout.split('\n', 1)[0].trim();
}

function verifyScope(repo, latest, tree, ownedPaths) {
  const changed = gitText(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', latest, tree]);
  const paths = changed ? changed.split('\n') : [];
  const unexpected = paths.filter((item) => !ownedPaths.includes(item));
  if (unexpected.length) throw new Error(`merge escaped owned paths: ${unexpected.join(', ')}`);
}

function defaultIndexPath(repo) {
  const gitPath = gitText(repo, ['rev-parse', '--git-path', 'index']);
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repo, gitPath);
}

function indexTreeFromBody(repo, stateDir, body) {
  const scratch = fs.mkdtempSync(path.join(stateDir, '.inspect-index-'));
  const indexFile = path.join(scratch, 'index');
  try {
    fs.writeFileSync(indexFile, body);
    return gitText(repo, ['write-tree'], { env: { GIT_INDEX_FILE: indexFile } });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function snapshotDefaultIndex(repo, stateDir) {
  const indexFile = defaultIndexPath(repo);
  if (!fs.existsSync(indexFile)) return { indexFile, exists: false, digest: null, inode: null, tree: null };
  const body = fs.readFileSync(indexFile);
  const stat = fs.statSync(indexFile, { bigint: true });
  return {
    indexFile,
    exists: true,
    digest: crypto.createHash('sha256').update(body).digest('hex'),
    inode: stat.ino.toString(),
    tree: indexTreeFromBody(repo, stateDir, body),
  };
}

function sameIndexSnapshot(left, right) {
  return left.exists === right.exists
    && left.digest === right.digest
    && left.inode === right.inode
    && left.tree === right.tree;
}

function prepareDefaultIndex(repo, stateDir, commit) {
  const scratch = fs.mkdtempSync(path.join(stateDir, '.default-index-'));
  const indexFile = path.join(scratch, 'index');
  try {
    runGit(repo, ['read-tree', commit], { env: { GIT_INDEX_FILE: indexFile } });
    return fs.readFileSync(indexFile);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function acquireDefaultIndexLock(indexFile, timeoutMs = 5_000) {
  const lockFile = `${indexFile}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return { descriptor: fs.openSync(lockFile, 'wx'), lockFile };
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('default Git index lock timeout');
      Atomics.wait(sleepBuffer, 0, 0, 20);
    }
  }
}

/**
 * Prepare and lock the default index before HEAD moves. Existing staged intent
 * is merged as an immutable tree on top of the candidate commit. A conflicting
 * staged change fails here, before compare-and-swap can advance HEAD.
 */
function beginDefaultIndexCutover(repo, stateDir, requestId, latest, commit, before) {
  const latestTree = gitText(repo, ['rev-parse', `${latest}^{tree}`]);
  let targetTree = gitText(repo, ['rev-parse', `${commit}^{tree}`]);
  let rebasedStagedIntent = false;
  if (before.tree !== latestTree) {
    if (!before.tree) throw new Error('default index staged-intent conflict: index tree is unavailable');
    const stagedCommit = gitText(repo, [
      'commit-tree', before.tree, '-p', latest,
      '-m', `chore: immutable staged intent for ${requestId}`,
    ]);
    try {
      targetTree = mergeTree(repo, latest, commit, stagedCommit);
      rebasedStagedIntent = true;
    } catch (error) {
      throw new Error(`default index staged-intent conflict: ${error.message}`);
    }
  }
  const prepared = prepareDefaultIndex(repo, stateDir, targetTree);
  const preparedDigest = crypto.createHash('sha256').update(prepared).digest('hex');
  const heldLock = acquireDefaultIndexLock(before.indexFile);
  try {
    const current = snapshotDefaultIndex(repo, stateDir);
    if (!sameIndexSnapshot(before, current)) {
      throw new Error('default index changed during cutover');
    }
    fs.writeFileSync(heldLock.descriptor, prepared);
    fs.fsyncSync(heldLock.descriptor);
    fs.closeSync(heldLock.descriptor);
    heldLock.descriptor = null;
    return {
      ...heldLock,
      indexFile: before.indexFile,
      preparedDigest,
      stagedTree: before.tree,
      indexBeforeDigest: before.digest,
      rebasedStagedIntent,
    };
  } catch (error) {
    if (heldLock?.descriptor != null) fs.closeSync(heldLock.descriptor);
    if (heldLock?.lockFile && fs.existsSync(heldLock.lockFile)) fs.rmSync(heldLock.lockFile, { force: true });
    throw error;
  }
}

function cutoverJournalFile(stateDir, requestId) {
  return path.join(stateDir, 'cutovers', `${requestId}.json`);
}

function previewEventHighwater(repo) {
  const output = gitText(repo, [
    'for-each-ref', '--format=%(refname)', 'refs/nassaj/previews/v1/events/',
  ]);
  let highwater = 0;
  for (const ref of output ? output.split('\n') : []) {
    const match = ref.match(/^refs\/nassaj\/previews\/v1\/events\/(\d{16})\/(?:event|client|server)$/);
    if (!match) throw new Error(`malformed preview event ref: ${ref}`);
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`invalid preview event sequence: ${ref}`);
    highwater = Math.max(highwater, sequence);
  }
  return highwater;
}

function reserveCommitSequence(repo, stateDir) {
  const file = path.join(stateDir, 'sequence.json');
  let last = 0;
  if (fs.existsSync(file)) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.schema !== 1 || !Number.isSafeInteger(state.last) || state.last < 0) {
      throw new Error('invalid commit sequence state');
    }
    last = state.last;
  }
  const sequence = Math.max(last, previewEventHighwater(repo)) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('commit sequence exhausted');
  durableJson(file, { schema: 1, last: sequence });
  return sequence;
}

function replayJournalDirectory(stateDir) {
  return path.join(stateDir, 'preview-replays');
}

function replayJournalFile(stateDir, replayId) {
  const digest = crypto.createHash('sha256').update(replayId).digest('hex');
  return path.join(replayJournalDirectory(stateDir), `${digest}.json`);
}

function normalizeReplayDomains(domains) {
  const normalized = [...new Set(domains ?? [])].sort();
  if (!normalized.length || normalized.some((domain) => domain !== 'client' && domain !== 'server')) {
    throw new Error('preview replay domains must contain client and/or server');
  }
  return normalized;
}

function assertReplayJournal(journal, file) {
  if (journal?.schema !== 1 || typeof journal.replayId !== 'string'
    || !/^[0-9a-f]{40}$/.test(journal.oid ?? '')
    || !Number.isSafeInteger(journal.sequence) || journal.sequence < 1
    || !Array.isArray(journal.domains) || !Array.isArray(journal.eventRefs)
    || journal.snapshot !== path.join('.nassaj-local-preview', 'oid-snapshots', journal.oid)
    || !['pending', 'complete'].includes(journal.status)) {
    throw new Error(`invalid preview replay journal: ${file}`);
  }
  const expected = previewEventRefs(journal.sequence, journal.domains).refs;
  if (expected.length !== journal.eventRefs.length
    || expected.some((ref, index) => ref !== journal.eventRefs[index])) {
    throw new Error(`preview replay journal refs do not match its facts: ${file}`);
  }
}

function inspectReplayRefs(repo, journal) {
  return journal.eventRefs.map((ref) => {
    const result = runGit(repo, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
    if (result.status === 1) return null;
    if (result.status !== 0) throw new Error(`cannot inspect preview replay ref ${ref}`);
    return result.stdout.trim();
  });
}

function createReplayRefs(repo, journal) {
  const commands = [
    'start',
    ...journal.eventRefs.map((ref) => `create ${ref} ${journal.oid}`),
    'prepare',
    'commit',
    '',
  ].join('\n');
  const result = spawnSync('flock', [
    '-x', previewEventMutationLock(repo),
    'git', '-C', repo, 'update-ref', '--stdin',
  ], { encoding: 'utf8', input: commands });
  if (result.status !== 0) {
    throw new Error(`atomic preview replay ref creation failed: ${String(result.stderr || '').trim()}`);
  }
}

function recoverPreviewReplay(repo, file, journal) {
  assertReplayJournal(journal, file);
  const snapshot = path.join(repo, '.nassaj-local-preview', 'oid-snapshots', journal.oid);
  if (!fs.existsSync(snapshot)) {
    throw new Error(`preview replay snapshot is missing for ${journal.replayId}`);
  }
  const oids = inspectReplayRefs(repo, journal);
  const allMissing = oids.every((oid) => oid === null);
  const allExact = oids.every((oid) => oid === journal.oid);
  if (!allMissing && !allExact) {
    throw new Error(`preview replay ${journal.replayId} has partial or mismatched refs`);
  }
  if (allMissing) createReplayRefs(repo, journal);
  if (journal.status !== 'complete') durableJson(file, { ...journal, status: 'complete', completedAt: Date.now() });
}

/** Recover every durable replay before the arbiter can reserve another sequence. */
function recoverPendingPreviewReplays(repo, stateDir) {
  const directory = replayJournalDirectory(stateDir);
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(directory, name);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertReplayJournal(journal, file);
    if (journal.status === 'pending') recoverPreviewReplay(repo, file, journal);
  }
}

/**
 * Replay one exact existing commit through the preview queue without inventing
 * an out-of-band sequence. The immutable snapshot is complete before refs make
 * the event visible; the arbiter journal makes retries and crash recovery exact.
 */
export async function reservePreviewReplay({ repo, replayId, oid: revision, domains }, hooks = {}) {
  if (typeof replayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(replayId)) {
    throw new Error('preview replay id is invalid');
  }
  const oid = resolvePreviewOid(repo, revision);
  if (oid !== revision) throw new Error('preview replay requires a full exact commit OID');
  const normalizedDomains = normalizeReplayDomains(domains);
  const sourceRoot = await materializePreviewSnapshot(repo, oid);
  const stateDir = commonStateDir(repo);
  return withLock(stateDir, () => {
    const file = replayJournalFile(stateDir, replayId);
    if (fs.existsSync(file)) {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      assertReplayJournal(journal, file);
      if (journal.replayId !== replayId || journal.oid !== oid
        || journal.domains.length !== normalizedDomains.length
        || journal.domains.some((domain, index) => domain !== normalizedDomains[index])) {
        throw new Error(`preview replay ${replayId} is already bound to different facts`);
      }
      recoverPreviewReplay(repo, file, journal);
      return { replayId, oid, sequence: journal.sequence, domains: normalizedDomains, sourceRoot };
    }
    const sequence = reserveCommitSequence(repo, stateDir);
    const eventRefs = previewEventRefs(sequence, normalizedDomains).refs;
    const journal = {
      schema: 1,
      replayId,
      oid,
      sequence,
      domains: normalizedDomains,
      eventRefs,
      snapshot: path.relative(repo, sourceRoot),
      status: 'pending',
      createdAt: Date.now(),
    };
    durableJson(file, journal);
    hooks.afterJournalBeforeRefs?.({ ...journal, sourceRoot });
    createReplayRefs(repo, journal);
    hooks.afterRefsBeforeComplete?.({ ...journal, sourceRoot });
    durableJson(file, { ...journal, status: 'complete', completedAt: Date.now() });
    return { replayId, oid, sequence, domains: normalizedDomains, sourceRoot };
  }, 15_000, repo);
}

function digestFile(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function persistCutoverJournal(stateDir, requestId, manifest, latest, commit, cutover, attempt, sequence, domains, eventRefs) {
  const journal = {
    schema: 1,
    requestId,
    targetRef: manifest.targetRef,
    oldHead: latest,
    newCommit: commit,
    indexFile: cutover.indexFile,
    tempIndex: cutover.lockFile,
    indexBeforeDigest: cutover.indexBeforeDigest,
    stagedTree: cutover.stagedTree,
    tempIndexDigest: cutover.preparedDigest,
    rebasedStagedIntent: cutover.rebasedStagedIntent,
    requestRef: manifest.requestRef,
    requestCommit: manifest.requestCommit,
    changedPaths: manifest.ownedPaths,
    attempt,
    sequence,
    domains,
    eventRefs,
    createdAt: Date.now(),
  };
  durableJson(cutoverJournalFile(stateDir, requestId), journal);
  return journal;
}

function advanceHeadWithPreviewEvent(repo, targetRef, oldHead, newCommit, eventRefs) {
  const commands = [
    'start',
    `update ${targetRef} ${newCommit} ${oldHead}`,
    ...eventRefs.map((ref) => `create ${ref} ${newCommit}`),
    'prepare',
    'commit',
    '',
  ].join('\n');
  if (!eventRefs.length) return runGit(repo, ['update-ref', '--stdin'], { input: commands, allowFailure: true });
  const result = spawnSync('flock', [
    '-x', previewEventMutationLock(repo),
    'git', '-C', repo, 'update-ref', '--stdin',
  ], { encoding: 'utf8', input: commands });
  return result;
}

function removeCutoverJournal(stateDir, requestId) {
  const file = cutoverJournalFile(stateDir, requestId);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

function recordRecoveredCompletion(repo, stateDir, journal) {
  const reconciliation = {
    needsReconciliation: false,
    reconciliationRef: null,
    reconciliationReason: null,
    rebasedStagedIntent: journal.rebasedStagedIntent,
  };
  atomicJson(path.join(stateDir, 'completed', `${journal.requestId}.json`), {
    requestId: journal.requestId,
    commit: journal.newCommit,
    changedPaths: journal.changedPaths,
    sequence: journal.sequence,
    attempts: journal.attempt,
    committedAt: Date.now(),
    recovered: true,
    reconciliation,
  });
  runGit(repo, ['update-ref', '-d', journal.requestRef, journal.requestCommit], { allowFailure: true });
  removeCutoverJournal(stateDir, journal.requestId);
}

/** Recover a crash-safe HEAD/index cutover before accepting another operation. */
function recoverPendingCutovers(repo, stateDir) {
  const directory = path.join(stateDir, 'cutovers');
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    const journal = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const head = gitText(repo, ['rev-parse', journal.targetRef]);
    const indexDigest = digestFile(journal.indexFile);
    const tempDigest = digestFile(journal.tempIndex);
    const eventOids = (journal.eventRefs ?? []).map((ref) => {
      const result = runGit(repo, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
      return result.status === 0 ? result.stdout.trim() : null;
    });
    const allEventsAtNewCommit = eventOids.every((oid) => oid === journal.newCommit);
    const noEventsVisible = eventOids.every((oid) => oid === null);
    if (head === journal.newCommit) {
      if (!allEventsAtNewCommit) {
        throw new Error(`cutover recovery blocked for ${journal.requestId}: preview event is partial or missing`);
      }
      if (indexDigest === journal.tempIndexDigest) {
        if (tempDigest === journal.tempIndexDigest) fs.rmSync(journal.tempIndex, { force: true });
        recordRecoveredCompletion(repo, stateDir, journal);
        continue;
      }
      if (indexDigest === journal.indexBeforeDigest && tempDigest === journal.tempIndexDigest) {
        fs.renameSync(journal.tempIndex, journal.indexFile);
        recordRecoveredCompletion(repo, stateDir, journal);
        continue;
      }
      throw new Error(`cutover recovery blocked for ${journal.requestId}: HEAD advanced but index provenance changed`);
    }
    if (head === journal.oldHead) {
      if (!noEventsVisible) {
        throw new Error(`cutover recovery blocked for ${journal.requestId}: preview event exists without HEAD`);
      }
      if (tempDigest && tempDigest !== journal.tempIndexDigest) {
        throw new Error(`cutover recovery blocked for ${journal.requestId}: stale index lock provenance changed`);
      }
      if (tempDigest === journal.tempIndexDigest) fs.rmSync(journal.tempIndex, { force: true });
      removeCutoverJournal(stateDir, journal.requestId);
      continue;
    }
    throw new Error(`cutover recovery blocked for ${journal.requestId}: target ref diverged`);
  }
}

function abortDefaultIndexCutover(cutover) {
  if (cutover?.descriptor != null) fs.closeSync(cutover.descriptor);
  if (cutover?.lockFile && fs.existsSync(cutover.lockFile)) fs.rmSync(cutover.lockFile, { force: true });
}

function finishDefaultIndexCutover(cutover) {
  fs.renameSync(cutover.lockFile, cutover.indexFile);
  return {
    needsReconciliation: false,
    reconciliationRef: null,
    reconciliationReason: null,
    rebasedStagedIntent: cutover.rebasedStagedIntent,
  };
}

function readCompletedResult(stateDir, requestId) {
  const file = path.join(stateDir, 'completed', `${requestId}.json`);
  if (!fs.existsSync(file)) return null;
  const completed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reconciliation = completed.reconciliation ?? {};
  return {
    commit: completed.commit,
    attempts: completed.attempts ?? 1,
    sequence: completed.sequence,
    changedPaths: completed.changedPaths ?? completed.ownedPaths ?? [],
    ...reconciliation,
    recovered: completed.recovered === true,
  };
}

/** Merge a captured request onto the latest tip and advance the target with compare-and-swap retries. */
export function commitRequest({ repo, requestId, message, maxRetries = 5, beforeCas, afterCasBeforeIndexPromotion, authorEnv }) {
  const stateDir = commonStateDir(repo);
  return withLock(stateDir, () => {
    const completed = readCompletedResult(stateDir, requestId);
    if (completed) return completed;
    const manifest = readManifest(repo, requestId);
    assertFence(repo, manifest.session, manifest.generation, manifest.ownedPaths);
    validateMessage(repo, stateDir, message);
    const commitIdentityEnv = normalizeAuthorEnv(authorEnv);
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      assertFence(repo, manifest.session, manifest.generation, manifest.ownedPaths);
      const latest = gitText(repo, ['rev-parse', manifest.targetRef]);
      const tree = latest === manifest.baseline
        ? manifest.tree
        : mergeTree(repo, manifest.baseline, latest, manifest.requestCommit);
      verifyScope(repo, latest, tree, manifest.ownedPaths);
      const defaultIndexBefore = snapshotDefaultIndex(repo, stateDir);
      const commit = gitText(repo, ['commit-tree', tree, '-p', latest, '-m', message], { env: commitIdentityEnv });
      const cutover = beginDefaultIndexCutover(repo, stateDir, requestId, latest, commit, defaultIndexBefore);
      const sequence = reserveCommitSequence(repo, stateDir);
      const domains = previewDomainsForPaths(manifest.ownedPaths);
      const eventRefs = domains.length ? previewEventRefs(sequence, domains).refs : [];
      persistCutoverJournal(stateDir, requestId, manifest, latest, commit, cutover, attempt, sequence, domains, eventRefs);
      let cas;
      try {
        beforeCas?.({ attempt, latest, commit, manifest });
        cas = advanceHeadWithPreviewEvent(repo, manifest.targetRef, latest, commit, eventRefs);
      } catch (error) {
        removeCutoverJournal(stateDir, requestId);
        abortDefaultIndexCutover(cutover);
        throw error;
      }
      if (cas.status === 0) {
        afterCasBeforeIndexPromotion?.({ attempt, latest, commit, manifest });
        const reconciliation = finishDefaultIndexCutover(cutover);
        atomicJson(path.join(stateDir, 'completed', `${requestId}.json`), {
          ...manifest,
          committedAt: Date.now(),
          commit,
          attempts: attempt,
          sequence,
          reconciliation,
        });
        runGit(repo, ['update-ref', '-d', manifest.requestRef, manifest.requestCommit], { allowFailure: true });
        removeCutoverJournal(stateDir, requestId);
        return { commit, attempts: attempt, sequence, changedPaths: manifest.ownedPaths, ...reconciliation };
      }
      removeCutoverJournal(stateDir, requestId);
      abortDefaultIndexCutover(cutover);
    }
    throw new Error(`CAS retry limit reached for ${requestId}`);
  }, 15_000, repo);
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const values = { command, path: [], rename: [], submittedPatch: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index].replace(/^--/, '');
    const value = tokens[index + 1];
    if (key === 'path' || key === 'rename') values[key].push(value);
    else if (key === 'submitted-patch') values.submittedPatch.push(value);
    else values[key] = value;
    index += 1;
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? '.');
  let result;
  if (args.command === 'lease') result = acquireLease({ repo, session: args.session, paths: [...args.path, ...args.rename.flatMap((item) => item.split(':'))], isolation: args.mode ?? 'overlay' });
  else if (args.command === 'heartbeat') result = heartbeatLease({ repo, session: args.session, generation: Number(args.generation) });
  else if (args.command === 'release') result = releaseLease({ repo, session: args.session, generation: Number(args.generation) });
  else if (args.command === 'capture') result = captureRequest({
    repo,
    session: args.session,
    generation: Number(args.generation),
    paths: args.path,
    renames: args.rename.map((item) => { const [from, to] = item.split(':'); return { from, to }; }),
    submittedPatches: args.submittedPatch.map((item) => {
      const separator = item.indexOf('=');
      if (separator < 1) throw new Error('--submitted-patch requires path=patch-file');
      return { path: item.slice(0, separator), patch: fs.readFileSync(item.slice(separator + 1), 'utf8') };
    }),
    targetRef: args.target ?? 'HEAD',
  });
  else if (args.command === 'commit') result = commitRequest({ repo, requestId: args.request, message: args.message });
  else throw new Error('usage: session-commit-arbiter.mjs lease|heartbeat|release|capture|commit [--path file] [--submitted-patch path=patch-file]');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
