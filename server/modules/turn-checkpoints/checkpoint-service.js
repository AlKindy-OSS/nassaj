/**
 * T-2095 turn wrapper: a checkpoint before and after every admitted agent turn
 * on an isolated overlay, for every provider. Capture never blocks or fails a
 * turn: every problem becomes a `turn_checkpoint` event with a status and a
 * reason, and the provider's own result or error passes through unchanged.
 */
import fs from 'node:fs';

// Namespace import: tests replace the barrel with partial mocks; a missing export must fail at call time, never at load.
import * as sessionWorkspaces from '../session-workspaces/index.js';

import { captureCheckpoint } from './checkpoint-capture.js';
import { CheckpointTimeoutError } from './checkpoint-git.js';
import { enforceRetention, freeDiskBytes, RETENTION_DEFAULTS } from './checkpoint-retention.js';
import { diffCounts } from './checkpoint-query.js';
import {
  checkpointsRoot, ensureCheckpointStore, listCheckpointRefs, readStoreState, sha256, withStoreLock, writeStoreState,
} from './checkpoint-store.js';

const DEFAULT_BUDGET_MS = 5000;
const MARK_LOCK_WAIT_MS = 5000;

/** Resolves who and where to checkpoint, or the reason to skip. */
function resolveTarget(ctx) {
  const workspace = ctx.sessionWorkspace;
  if (!workspace || workspace.isolation !== 'overlay' || typeof workspace.overlayId !== 'string') {
    return { skip: 'not_overlay' };
  }
  if (ctx.principalId == null || String(ctx.principalId) === '') return { skip: 'no_principal' };
  const instance = sessionWorkspaces.readOverlayInstance(workspace);
  if (!instance) return { skip: 'not_overlay' };
  if (instance.ownerPrincipalId == null || instance.ownerPrincipalId !== String(ctx.principalId)) {
    return { skip: 'not_owner' };
  }
  return { instance, principalId: String(ctx.principalId) };
}

function manifestFields(ctx, target, createdAt) {
  return {
    schema: 1,
    overlayId: target.instance.overlayId,
    sessionId: target.instance.sessionId,
    principalDigest: sha256(target.principalId),
    provider: String(ctx.provider ?? 'unknown'),
    clientMsgIdDigest: ctx.clientMsgId ? sha256(ctx.clientMsgId) : null,
    createdAt,
  };
}

async function capturePre(ctx, target, options, deadline) {
  const store = await ensureCheckpointStore({
    commonGitDir: target.instance.commonGitDir, principalId: target.principalId,
    overlayId: target.instance.overlayId, deadline,
  });
  return withStoreLock(store, deadline, async () => {
    const state = readStoreState(store);
    const turnSeq = state.nextTurnSeq;
    const lastPost = (await listCheckpointRefs(store, deadline)).filter((ref) => ref.phase === 'post').at(-1);
    state.nextTurnSeq = turnSeq + 1;
    state.open[turnSeq] = { startedAt: new Date(options.now?.() ?? Date.now()).toISOString(), pid: process.pid };
    writeStoreState(store, state);
    try {
      const pre = await captureCheckpoint({
        store, workTree: target.instance.cwd, baseOid: target.instance.baseOid,
        parent: lastPost?.oid ?? target.instance.baseOid, turnSeq, phase: 'pre',
        fields: manifestFields(ctx, target, state.open[turnSeq].startedAt), deadline,
        limits: options.limits, hooks: options.hooks,
      });
      const current = readStoreState(store);
      current.indexTurn = turnSeq; // retention keeps the turn the private index reflects
      writeStoreState(store, current);
      return { store, turnSeq, pre: pre.commit };
    } catch (error) {
      const current = readStoreState(store);
      delete current.open[turnSeq];
      writeStoreState(store, current);
      throw error;
    }
  });
}

async function currentPreOid(store, turnSeq, deadline) {
  const pre = (await listCheckpointRefs(store, deadline)).find((ref) => ref.turnSeq === turnSeq && ref.phase === 'pre');
  if (!pre) throw new Error('the pre checkpoint of this turn is gone');
  return pre.oid;
}

/** Records a turn whose post checkpoint failed as interrupted (never left "running"). */
async function markInterrupted(turn) {
  const update = () => {
    const state = readStoreState(turn.store);
    delete state.open[turn.turnSeq];
    if (!state.interrupted.includes(turn.turnSeq)) state.interrupted.push(turn.turnSeq);
    state.interrupted = state.interrupted.slice(-200);
    writeStoreState(turn.store, state);
  };
  try {
    await withStoreLock(turn.store, Date.now() + MARK_LOCK_WAIT_MS, async () => update());
  } catch (error) {
    logFailure('mark_interrupted', error);
  }
}

async function capturePost(ctx, turn, options, deadline) {
  const instance = sessionWorkspaces.readOverlayInstance(ctx.sessionWorkspace);
  if (!instance || instance.ownerPrincipalId !== turn.target.principalId) throw new Error('overlay changed during the turn');
  const target = { ...turn.target, instance };
  return withStoreLock(turn.store, deadline, async () => {
    // M1: a prune may have re-rooted this turn's pre while it ran; use the ref, never a stale oid.
    const pre = await currentPreOid(turn.store, turn.turnSeq, deadline);
    const post = await captureCheckpoint({
      store: turn.store, workTree: instance.cwd, baseOid: instance.baseOid, parent: pre,
      turnSeq: turn.turnSeq, phase: 'post', deadline, limits: options.limits, hooks: options.hooks,
      fields: manifestFields(ctx, target, new Date(options.now?.() ?? Date.now()).toISOString()),
    });
    const state = readStoreState(turn.store);
    delete state.open[turn.turnSeq];
    state.indexTurn = turn.turnSeq;
    writeStoreState(turn.store, state);
    const counts = await diffCounts(turn.store, pre, post.commit, deadline);
    await enforceRetention({
      store: turn.store, commonGitDir: instance.commonGitDir, baseOid: instance.baseOid, deadline,
      ...RETENTION_DEFAULTS, ...options.retention,
    }).catch((error) => logFailure('retention', error));
    return { counts, withheldCount: post.withheld.length, sessionId: instance.sessionId };
  });
}

function outcomeOf(error) {
  if (error instanceof CheckpointTimeoutError) return { status: 'skipped', reason: 'timeout' };
  logFailure('capture', error);
  return { status: 'failed', reason: 'capture_failed' };
}

function logFailure(stage, error) {
  console.warn('[turn-checkpoint] stage failed', {
    stage, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300),
  });
}

async function hasLowDisk(commonGitDir, options) {
  const floor = options.minFreeBytes ?? RETENTION_DEFAULTS.minFreeBytes;
  const free = await (options.freeDiskBytes ?? freeDiskBytes)(fs.existsSync(checkpointsRoot(commonGitDir))
    ? checkpointsRoot(commonGitDir) : commonGitDir);
  return free < floor;
}

/** Captures the pre checkpoint; resolves to a turn record or a skip outcome. Never throws. */
async function beginTurn(ctx, options) {
  try {
    const target = resolveTarget(ctx);
    if (target.skip) return { outcome: { status: 'skipped', reason: target.skip } };
    if (await hasLowDisk(target.instance.commonGitDir, options)) return { outcome: { status: 'skipped', reason: 'low_disk' } };
    const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
    const pre = await capturePre(ctx, target, options, deadline);
    return { ...pre, target };
  } catch (error) {
    return { outcome: outcomeOf(error) };
  }
}

/** Captures the post checkpoint and emits the event. Never throws. */
async function finishTurn(ctx, turn, options) {
  let event = turn.outcome ?? null;
  if (!event) {
    try {
      const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
      const result = await capturePost(ctx, turn, options, deadline);
      event = { status: 'captured', turnSeq: turn.turnSeq, ...result };
    } catch (error) {
      event = { ...outcomeOf(error), turnSeq: turn.turnSeq };
      await markInterrupted(turn);
    }
  }
  // Deferred one macrotask: callers that send the turn's own text/complete
  // frames right after the adapter returns go first, so the checkpoint frame
  // always follows the turn's terminal frame on every provider path.
  setImmediate(() => emitCheckpointEvent(ctx, event));
}

const emittedFrames = new WeakSet();

/**
 * True for a frame object emitted by this module. Identity only: the payload
 * is never read, so accessor or proxy payloads are not touched.
 * @param {unknown} payload
 */
export function isTurnCheckpointFrame(payload) {
  return typeof payload === 'object' && payload !== null && emittedFrames.has(payload);
}

function emitCheckpointEvent(ctx, event) {
  try {
    ctx.writer?.send?.(checkpointFrame(ctx, event));
  } catch {
    // A closed socket must never fail the turn; the checkpoint itself is durable.
  }
}

function checkpointFrame(ctx, event) {
  const frame = {
    kind: 'turn_checkpoint',
    id: `turn_checkpoint_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    provider: ctx.provider,
    sessionId: event.sessionId ?? ctx.sessionWorkspace?.sessionId ?? '',
    turnSeq: event.turnSeq ?? null,
    status: event.status,
    ...(event.reason ? { reason: event.reason } : {}),
    counts: event.counts ?? { added: 0, modified: 0, deleted: 0 },
    withheldCount: event.withheldCount ?? 0,
    ...(ctx.clientMsgId ? { clientMsgId: ctx.clientMsgId } : {}),
  };
  emittedFrames.add(frame);
  return frame;
}

/**
 * Runs one agent turn between a pre and a post checkpoint.
 * @template T
 * @param {{sessionWorkspace: object|null, principalId: string|number|null, provider: string,
 *   clientMsgId?: string|null, writer?: {send(frame: object): void}}} ctx
 * @param {() => Promise<T>} run the provider adapter call
 * @param {{budgetMs?: number, limits?: object, retention?: object, minFreeBytes?: number,
 *   freeDiskBytes?: (dir: string) => Promise<number>, hooks?: object, now?: () => number}} [options]
 * @returns {Promise<T>} the adapter's own result (or its own rejection)
 */
export async function withTurnCheckpoint(ctx, run, options = {}) {
  const turn = await beginTurn(ctx, options);
  try {
    return await run();
  } finally {
    await finishTurn(ctx, turn, options);
  }
}
