/**
 * T-2095 retention and space guards for checkpoint stores.
 *
 * Per overlay the newest 50 turns within 14 days are kept; per member 200 MB
 * and per repository root 2 GB are hard caps; capture is skipped below a free
 * disk floor. Pruning deletes the oldest refs, re-roots the surviving parent
 * chain on the overlay base (so dropped history becomes unreachable), then
 * rewrites the store's single pack and prunes loose objects: the equivalent of
 * `gc --prune=now` that never copies the project's own objects in.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runStoreGit, storeGitEnv, storeGitText } from './checkpoint-git.js';
import { readStoreState } from './checkpoint-store.js';

export const RETENTION_DEFAULTS = Object.freeze({
  keepTurns: 50,
  pruneSlack: 10,
  maxAgeMs: 14 * 24 * 60 * 60_000,
  memberCapBytes: 200 * 1024 * 1024,
  globalCapBytes: 2 * 1024 * 1024 * 1024,
  minFreeBytes: 5 * 1024 * 1024 * 1024,
});
const MAX_CAP_ROUNDS = 8;

/** Free bytes available to the server user on the filesystem holding `dir`. */
export async function freeDiskBytes(dir) {
  const stats = await fs.promises.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Total size in bytes of every file under `dir` (symlinks not followed). */
export async function directoryBytes(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else total += (await fs.promises.lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Turn time from the manifest's createdAt (authoritative); the commit date is only a fallback. */
function manifestTime(subject, fallbackMs) {
  try {
    const created = Date.parse(JSON.parse(subject).createdAt);
    return Number.isFinite(created) ? created : fallbackMs;
  } catch {
    return fallbackMs;
  }
}

async function turnsWithDates(store, deadline) {
  const format = '%(objectname) %(refname) %(committerdate:unix) %(contents:subject)';
  const out = await storeGitText(['for-each-ref', `--format=${format}`, 'refs/checkpoints/'], {
    env: storeGitEnv({ store }), deadline,
  });
  const turns = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]+) refs\/checkpoints\/(\d{8})\/(pre|post) (\d+) (.*)$/.exec(line);
    if (!match) continue;
    const at = manifestTime(match[5], Number(match[4]) * 1000);
    const entry = turns.get(Number(match[2])) ?? { turnSeq: Number(match[2]), at };
    entry[match[3]] = match[1];
    entry.at = Math.min(entry.at, at);
    turns.set(entry.turnSeq, entry);
  }
  return [...turns.values()].sort((left, right) => left.turnSeq - right.turnSeq);
}

async function readCommit(store, oid, deadline) {
  const body = await storeGitText(['cat-file', 'commit', oid], { env: storeGitEnv({ store }), deadline });
  const header = body.slice(0, body.indexOf('\n\n'));
  const dateOf = (role) => /^(?:author|committer) .* (\d+ [+-]\d{4})$/m.exec(header.split('\n').find((line) => line.startsWith(`${role} `)) ?? '')?.[1];
  return {
    tree: /^tree ([0-9a-f]+)$/m.exec(header)[1],
    authorDate: dateOf('author'),
    committerDate: dateOf('committer'),
    message: body.slice(body.indexOf('\n\n') + 2),
  };
}

/** Re-parents one commit, keeping its tree, message and original author/committer dates (H2). */
async function recommit(store, oid, parent, deadline) {
  const { tree, message, authorDate, committerDate } = await readCommit(store, oid, deadline);
  const env = { ...storeGitEnv({ store }) };
  if (authorDate) env.GIT_AUTHOR_DATE = `@${authorDate}`;
  if (committerDate) env.GIT_COMMITTER_DATE = `@${committerDate}`;
  return storeGitText(['commit-tree', tree, '-p', parent, '-F', '-'], { env, deadline, input: message });
}

/** Re-roots the kept chain on the base and returns update-ref --stdin commands. */
async function rerootCommands(store, kept, dropped, baseOid, deadline) {
  const commands = [];
  for (const turn of dropped) {
    for (const phase of ['pre', 'post']) {
      if (turn[phase]) commands.push(`delete refs/checkpoints/${String(turn.turnSeq).padStart(8, '0')}/${phase} ${turn[phase]}`);
    }
  }
  let previousPost = baseOid;
  for (const turn of kept) {
    const ref = (phase) => `refs/checkpoints/${String(turn.turnSeq).padStart(8, '0')}/${phase}`;
    const pre = turn.pre ? await recommit(store, turn.pre, previousPost, deadline) : null;
    if (pre) commands.push(`update ${ref('pre')} ${pre} ${turn.pre}`);
    if (turn.post && pre) {
      const post = await recommit(store, turn.post, pre, deadline);
      commands.push(`update ${ref('post')} ${post} ${turn.post}`);
      previousPost = post;
    }
  }
  return commands;
}

/** Writes one fresh pack of everything the refs need beyond the base, drops the rest. */
async function repackStore(store, baseOid, deadline) {
  const env = storeGitEnv({ store });
  const packDir = path.join(store, 'objects', 'pack');
  const objects = await runStoreGit(['rev-list', '--objects', '--all', '--not', baseOid], { env, deadline });
  const keep = objects.stdout.length > 0
    ? await storeGitText(['pack-objects', '-q', path.join(packDir, 'pack')], { env, deadline, input: objects.stdout })
    : null;
  for (const name of fs.readdirSync(packDir)) {
    const stalePack = name.startsWith('pack-') && (!keep || !name.startsWith(`pack-${keep}.`));
    if (stalePack || name.startsWith('tmp_')) fs.rmSync(path.join(packDir, name), { force: true });
  }
  await runStoreGit(['prune', '--expire=now'], { env, deadline });
}

/**
 * Drops the given turns and rewrites the store so their objects are freed.
 * @param {{store: string, baseOid: string, dropSeqs: Set<number>, deadline: number}} input
 * @returns {Promise<number>} turns dropped
 */
export async function pruneTurns({ store, baseOid, dropSeqs, deadline }) {
  const turns = await turnsWithDates(store, deadline);
  const dropped = turns.filter((turn) => dropSeqs.has(turn.turnSeq));
  if (dropped.length === 0) return 0;
  const kept = turns.filter((turn) => !dropSeqs.has(turn.turnSeq));
  const commands = await rerootCommands(store, kept, dropped, baseOid, deadline);
  await runStoreGit(['update-ref', '--stdin'], { env: storeGitEnv({ store }), deadline, input: `${commands.join('\n')}\n` });
  await repackStore(store, baseOid, deadline);
  return dropped.length;
}

/**
 * Turns retention may drop: never the newest turn, never a turn that is still
 * open, and never the turn recorded as the one the private index reflects
 * (concurrent turns can close out of order), so the index never names a
 * pruned object.
 */
function droppableTurns(store, turns) {
  const state = readStoreState(store);
  const kept = new Set(Object.keys(state.open).map(Number));
  // qa round 2: the turn whose capture the private index mirrors keeps its objects.
  if (Number.isSafeInteger(state.indexTurn)) kept.add(state.indexTurn);
  return turns.slice(0, -1).filter((turn) => !kept.has(turn.turnSeq));
}

function countAndAgeDrops(turns, candidates, { keepTurns, pruneSlack, maxAgeMs, now }) {
  const drop = new Set();
  if (turns.length > keepTurns + pruneSlack) {
    const excess = turns.slice(0, Math.max(0, turns.length - keepTurns)).map((turn) => turn.turnSeq);
    for (const turn of candidates) if (excess.includes(turn.turnSeq)) drop.add(turn.turnSeq);
  }
  for (const turn of candidates) if (now - turn.at > maxAgeMs) drop.add(turn.turnSeq);
  return drop;
}

async function overCap(store, commonGitDir, { memberCapBytes, globalCapBytes }) {
  if (await directoryBytes(path.dirname(store)) > memberCapBytes) return true;
  return await directoryBytes(path.join(commonGitDir, 'nassaj-checkpoints')) > globalCapBytes;
}

/**
 * Applies count, age and size retention to one store (caller holds its lock).
 * The newest turn and open turns are never dropped.
 * @param {{store: string, commonGitDir: string, baseOid: string, deadline: number, keepTurns?: number,
 *   pruneSlack?: number, maxAgeMs?: number, memberCapBytes?: number, globalCapBytes?: number, now?: number}} input
 * @returns {Promise<{dropped: number}>}
 */
export async function enforceRetention(input) {
  const settings = { ...RETENTION_DEFAULTS, now: Date.now(), ...input };
  const { store, baseOid, deadline } = settings;
  const turns = await turnsWithDates(store, deadline);
  let dropped = await pruneTurns({
    store, baseOid, deadline, dropSeqs: countAndAgeDrops(turns, droppableTurns(store, turns), settings),
  });
  for (let round = 0; round < MAX_CAP_ROUNDS && await overCap(store, settings.commonGitDir, settings); round += 1) {
    const candidates = droppableTurns(store, await turnsWithDates(store, deadline));
    if (candidates.length === 0) break;
    const count = Math.max(1, Math.floor(candidates.length / 4));
    dropped += await pruneTurns({ store, baseOid, deadline, dropSeqs: new Set(candidates.slice(0, count).map((turn) => turn.turnSeq)) });
  }
  return { dropped };
}
