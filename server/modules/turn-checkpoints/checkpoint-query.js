/**
 * T-2095 read side: what each turn changed. The store is located only from the
 * overlay manifest (owner principal, overlay id), never from client input, and
 * every miss (no overlay, another owner, no store) answers null so the route
 * can return one uniform 404.
 */
import fs from 'node:fs';

// Namespace import: tests replace the barrel with partial mocks; a missing export must fail at call time, never at load.
import * as sessionWorkspaces from '../session-workspaces/index.js';

import { runStoreGit, storeGitEnv, storeGitText } from './checkpoint-git.js';
import { checkpointRef, checkpointStorePath, listCheckpointRefs, readStoreState } from './checkpoint-store.js';

const READ_BUDGET_MS = 10_000;
const DIFF_BYTES_CAP = 256 * 1024;
const FILES_PER_TURN_CAP = 500;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
const STATUS_NAMES = Object.freeze({ A: 'A', M: 'M', D: 'D', T: 'M' });

function readEnv(store) {
  return { ...storeGitEnv({ store }), GIT_LITERAL_PATHSPECS: '1' };
}

/** Name-status between two checkpoint commits: [{path, status: 'A'|'M'|'D'}]. */
export async function nameStatus(store, from, to, deadline) {
  const out = await runStoreGit(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, to], {
    env: readEnv(store), deadline,
  });
  const fields = out.stdout.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    files.push({ path: fields[index + 1], status: STATUS_NAMES[fields[index][0]] ?? 'M' });
  }
  return files;
}

/** Added/modified/deleted counts between two checkpoint commits. */
export async function diffCounts(store, from, to, deadline) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of await nameStatus(store, from, to, deadline)) {
    if (file.status === 'A') counts.added += 1;
    else if (file.status === 'D') counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

/** Parses the JSON manifest carried as a checkpoint commit message. */
async function readManifest(store, oid, deadline) {
  const body = await storeGitText(['cat-file', 'commit', oid], { env: readEnv(store), deadline });
  const separator = body.indexOf('\n\n');
  try { return JSON.parse(body.slice(separator + 2)); } catch { return null; }
}

/** Resolves the caller's own store for a server-bound overlay binding, or null. */
function ownStore(binding, principalId) {
  if (!binding || binding.isolation !== 'overlay' || principalId == null) return null;
  let instance;
  try {
    instance = sessionWorkspaces.readOverlayInstance(binding);
  } catch {
    return null; // a malformed or foreign overlay is the same uniform miss as an absent one
  }
  if (!instance || instance.ownerPrincipalId == null || instance.ownerPrincipalId !== String(principalId)) return null;
  const store = checkpointStorePath({
    commonGitDir: instance.commonGitDir, principalId: instance.ownerPrincipalId, overlayId: instance.overlayId,
  });
  return { store, exists: fs.existsSync(store) };
}

function turnStatus(state, turnSeq, post) {
  if (post) return 'complete';
  if (state.interrupted.includes(turnSeq)) return 'interrupted';
  return state.open[turnSeq] ? 'running' : 'interrupted';
}

/** Changed files of one turn: captured name-status plus every withheld path. */
async function turnFiles(store, pre, post, deadline) {
  if (!pre || !post) return { files: [], manifest: null };
  const manifest = await readManifest(store, post.oid, deadline);
  const preManifest = await readManifest(store, pre.oid, deadline);
  const withheld = withheldEntries(preManifest, manifest);
  const withheldPaths = new Set(withheld.map((entry) => entry.path));
  const captured = (await nameStatus(store, pre.oid, post.oid, deadline)).filter((file) => !withheldPaths.has(file.path));
  return { files: [...captured, ...withheld], manifest };
}

/**
 * Withheld paths of one turn: every path withheld at post, plus paths withheld
 * at pre only (phase 'pre'), whose pre bytes were never captured, so a post
 * capture of them must not read as "added" or "modified".
 */
function withheldEntries(preManifest, postManifest) {
  const listOf = (manifest) => (Array.isArray(manifest?.withheld) ? manifest.withheld : []);
  const entry = (item, phase) => ({
    path: item.path, status: 'withheld', reason: item.reason, ...(item.size != null ? { size: item.size } : {}),
    ...(phase ? { phase } : {}),
  });
  const post = listOf(postManifest).map((item) => entry(item));
  const postPaths = new Set(post.map((item) => item.path));
  const preOnly = listOf(preManifest).filter((item) => !postPaths.has(item.path)).map((item) => entry(item, 'pre'));
  return [...post, ...preOnly];
}

async function describeTurn(store, state, turnSeq, phases, deadline) {
  const { files, manifest } = await turnFiles(store, phases.pre, phases.post, deadline);
  const preManifest = phases.pre ? await readManifest(store, phases.pre.oid, deadline) : null;
  const counts = { added: 0, modified: 0, deleted: 0, withheld: 0 };
  for (const file of files) {
    const key = { A: 'added', M: 'modified', D: 'deleted', withheld: 'withheld' }[file.status];
    counts[key] += 1;
  }
  return {
    turnSeq,
    status: turnStatus(state, turnSeq, phases.post),
    provider: preManifest?.provider ?? null,
    startedAt: preManifest?.createdAt ?? null,
    completedAt: manifest?.createdAt ?? null,
    counts,
    files: files.slice(0, FILES_PER_TURN_CAP),
    filesTruncated: files.length > FILES_PER_TURN_CAP,
  };
}

function groupTurns(refs) {
  const turns = new Map();
  for (const ref of refs) {
    const entry = turns.get(ref.turnSeq) ?? {};
    entry[ref.phase] = ref;
    turns.set(ref.turnSeq, entry);
  }
  return turns;
}

function pageSize(limit) {
  const value = Number(limit ?? DEFAULT_PAGE);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PAGE) : DEFAULT_PAGE;
}

/**
 * Lists the caller's turn checkpoints, newest first, paginated by `before`.
 * @param {{binding: object, principalId: string|number|null, limit?: number, before?: number|null}} input
 * @returns {Promise<{turns: object[], nextBefore: number|null}|null>} null = not found
 */
export async function listTurnCheckpoints({ binding, principalId, limit, before = null }) {
  const own = ownStore(binding, principalId);
  if (!own) return null;
  if (!own.exists) return { turns: [], nextBefore: null };
  const deadline = Date.now() + READ_BUDGET_MS;
  const state = readStoreState(own.store);
  const grouped = groupTurns(await listCheckpointRefs(own.store, deadline));
  const sequences = [...grouped.keys()].filter((seq) => before == null || seq < before).sort((a, b) => b - a);
  const size = pageSize(limit);
  const page = sequences.slice(0, size);
  const turns = [];
  for (const turnSeq of page) turns.push(await describeTurn(own.store, state, turnSeq, grouped.get(turnSeq), deadline));
  return { turns, nextBefore: sequences.length > size ? page.at(-1) : null };
}

async function refOid(store, ref, deadline) {
  const result = await runStoreGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    env: readEnv(store), deadline, allowFailure: true,
  });
  return result.status === 0 ? result.stdout.toString('utf8').trim() : null;
}

/**
 * One turn's changes: the file list, or one file's unified diff (capped 256 KiB).
 * A withheld path answers `{withheld: true}` and never a diff.
 * @param {{binding: object, principalId: string|number|null, turnSeq: number, path?: string}} input
 * @returns {Promise<object|null>} null = not found
 */
export async function readTurnCheckpointDiff({ binding, principalId, turnSeq, path: requestedPath }) {
  const ownedPath = requestedPath == null ? null : sessionWorkspaces.normalizeOverlayPath(requestedPath).ownedPath;
  const own = ownStore(binding, principalId);
  if (!own?.exists) return null;
  const deadline = Date.now() + READ_BUDGET_MS;
  const pre = await refOid(own.store, checkpointRef(turnSeq, 'pre'), deadline);
  const post = await refOid(own.store, checkpointRef(turnSeq, 'post'), deadline);
  if (!pre || !post) return null;
  const { files } = await turnFiles(own.store, { oid: pre }, { oid: post }, deadline);
  if (ownedPath == null) return { turnSeq, files };
  const withheld = files.find((file) => file.path === ownedPath && file.status === 'withheld');
  if (withheld) return { path: ownedPath, withheld: true, reason: withheld.reason };
  const out = await runStoreGit(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', pre, post, '--', ownedPath], {
    env: readEnv(own.store), deadline, maxBytes: DIFF_BYTES_CAP * 32,
  });
  const truncated = out.stdout.length > DIFF_BYTES_CAP;
  return { path: ownedPath, diff: out.stdout.subarray(0, DIFF_BYTES_CAP).toString('utf8'), truncated };
}
