/**
 * T-2095 checkpoint store layout, initialisation, state and locking.
 *
 * One bare repository per member and overlay:
 *   <commonGitDir>/nassaj-checkpoints/v1/<sha256(principal)[0:32]>/<overlayId>.git
 * Its objects borrow the project's objects one way (objects/info/alternates);
 * the project never learns about the store. Its config is written by the
 * server only: no fsmonitor, no hooks, no filters, no auto gc.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runStoreGit, storeGitEnv, storeGitText } from './checkpoint-git.js';

const OVERLAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_SCHEMA = 1;
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_OWNERLESS_GRACE_MS = 10_000;
const LOCK_WAIT_MS = 20;
const inProcessQueues = new Map();

/** sha256 hex of a value. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Root holding every store of one repository. */
export function checkpointsRoot(commonGitDir) {
  return path.join(commonGitDir, 'nassaj-checkpoints', 'v1');
}

/**
 * The store path, derived only from server-trusted manifest values.
 * @param {{commonGitDir: string, principalId: string, overlayId: string}} input
 */
export function checkpointStorePath({ commonGitDir, principalId, overlayId }) {
  if (typeof overlayId !== 'string' || !OVERLAY_ID.test(overlayId)) throw new Error('invalid overlay id');
  if (principalId == null || String(principalId) === '') throw new Error('a principal is required');
  return path.join(checkpointsRoot(commonGitDir), sha256(principalId).slice(0, 32), `${overlayId}.git`);
}

/** Ref name of one checkpoint phase; turnSeq must be a positive safe integer. */
export function checkpointRef(turnSeq, phase) {
  if (!Number.isSafeInteger(turnSeq) || turnSeq < 1 || turnSeq > 99_999_999) throw new Error('invalid turn sequence');
  if (phase !== 'pre' && phase !== 'post') throw new Error('invalid checkpoint phase');
  return `refs/checkpoints/${String(turnSeq).padStart(8, '0')}/${phase}`;
}

const STORE_CONFIG = [
  '[core]', '\trepositoryformatversion = 1', '\tbare = true', '\tfsmonitor = false',
  '\thooksPath = /dev/null', '\tuntrackedCache = false', '\tsplitIndex = false', '\tautocrlf = false',
  '\tsafecrlf = false', '\tsymlinks = true', '\tfilemode = true', '\tlogAllRefUpdates = false',
  '[gc]', '\tauto = 0', '[index]', '\tthreads = 1',
];

async function objectFormat(commonGitDir, deadline) {
  return (await storeGitText(['rev-parse', '--show-object-format'], {
    env: storeGitEnv({ store: commonGitDir }), deadline,
  })) || 'sha1';
}

/**
 * Creates the store when absent (mode 0700) and returns its path.
 * @param {{commonGitDir: string, principalId: string, overlayId: string, deadline?: number}} input
 */
export async function ensureCheckpointStore({ commonGitDir, principalId, overlayId, deadline }) {
  const store = checkpointStorePath({ commonGitDir, principalId, overlayId });
  if (fs.existsSync(path.join(store, 'nassaj-state.json'))) return store;
  const format = await objectFormat(commonGitDir, deadline);
  fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
  const staging = `${store}.init-${crypto.randomUUID()}`;
  try {
    for (const dir of ['', 'objects/info', 'objects/pack', 'refs/checkpoints', 'tmp']) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(path.join(staging, 'HEAD'), 'ref: refs/heads/none\n', { mode: 0o600 });
    const config = [...STORE_CONFIG, '[extensions]', `\tobjectformat = ${format}`, ''].join('\n');
    fs.writeFileSync(path.join(staging, 'config'), config, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'objects/info/alternates'), `${path.join(commonGitDir, 'objects')}\n`, { mode: 0o600 });
    writeJsonAtomic(path.join(staging, 'nassaj-state.json'), initialState(overlayId));
    fs.renameSync(staging, store);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(path.join(store, 'nassaj-state.json'))) throw error;
  }
  fs.chmodSync(store, 0o700);
  return store;
}

function initialState(overlayId) {
  return { schema: STATE_SCHEMA, overlayId, nextTurnSeq: 1, interrupted: [], open: {} };
}

/** Writes JSON atomically (tmp file + rename) with mode 0600. */
export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Reads the store's private state file. */
export function readStoreState(store) {
  const state = JSON.parse(fs.readFileSync(path.join(store, 'nassaj-state.json'), 'utf8'));
  if (state?.schema !== STATE_SCHEMA || !Number.isSafeInteger(state.nextTurnSeq)) throw new Error('checkpoint state is malformed');
  state.interrupted ??= [];
  state.open ??= {};
  return state;
}

/** Persists the store's private state file. */
export function writeStoreState(store, state) {
  writeJsonAtomic(path.join(store, 'nassaj-state.json'), state);
}

function lockDir(store) {
  return path.join(store, 'nassaj.lock');
}

/** True when a lock directory's owner process is gone or the lock is too old. */
export function lockIsStale(store, now = Date.now()) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir(store), 'owner.json'), 'utf8'));
  } catch {
    // An owner-less lock is either being created right now or was abandoned: grace period by age.
    try { return now - fs.statSync(lockDir(store)).mtimeMs > LOCK_OWNERLESS_GRACE_MS; } catch { return true; }
  }
  if (now - owner.at > LOCK_STALE_MS) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code !== 'EPERM';
  }
}

/** Creates the lock directory with its owner file already inside (atomic rename). */
function createLockDir(store) {
  const staging = `${lockDir(store)}.${process.pid}.${crypto.randomUUID()}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(staging, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.renameSync(staging, lockDir(store));
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error.code === 'ENOTEMPTY' ? Object.assign(new Error('lock exists'), { code: 'EEXIST' }) : error;
  }
}

async function acquireDiskLock(store, deadline) {
  while (true) {
    try {
      createLockDir(store);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(store)) { fs.rmSync(lockDir(store), { recursive: true, force: true }); continue; }
      if (Date.now() + LOCK_WAIT_MS >= deadline) throw new Error('checkpoint store is locked');
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

/**
 * Runs `operation` while holding the per-store lock (in-process queue plus an
 * on-disk lock directory for other server processes).
 * @template T
 * @param {string} store
 * @param {number} deadline epoch ms
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export function withStoreLock(store, deadline, operation) {
  const previous = inProcessQueues.get(store) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    await acquireDiskLock(store, deadline);
    try { return await operation(); } finally { fs.rmSync(lockDir(store), { recursive: true, force: true }); }
  });
  const tail = run.catch(() => {});
  inProcessQueues.set(store, tail);
  tail.then(() => { if (inProcessQueues.get(store) === tail) inProcessQueues.delete(store); });
  return run;
}

/** Lists checkpoint refs as [{turnSeq, phase, oid}] sorted by turnSeq. */
export async function listCheckpointRefs(store, deadline) {
  const out = await storeGitText(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/checkpoints/'], {
    env: storeGitEnv({ store }), deadline,
  });
  const refs = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]+) refs\/checkpoints\/(\d{8})\/(pre|post)$/.exec(line);
    if (match) refs.push({ oid: match[1], turnSeq: Number(match[2]), phase: match[3] });
  }
  return refs.sort((left, right) => left.turnSeq - right.turnSeq || (left.phase === 'pre' ? -1 : 1));
}

/** Atomically creates a ref that must not exist yet. */
export async function createRef(store, ref, oid, deadline) {
  const zero = '0'.repeat(oid.length);
  await runStoreGit(['update-ref', '--no-deref', ref, oid, zero], { env: storeGitEnv({ store }), deadline });
}
