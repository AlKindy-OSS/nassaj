/**
 * T-2095 boot reconciliation and periodic orphan sweep (QA conditions 5, 7).
 *
 * At boot no turn can be running in this process, so every pre without a post
 * is marked interrupted, stale locks and leftover temporary indexes are
 * removed. Every pass deletes stores whose overlay manifest is gone and applies
 * retention to the rest.
 */
import fs from 'node:fs';
import path from 'node:path';

// Namespace import: tests replace the barrel with partial mocks; a missing export must fail at call time, never at load.
import * as sessionWorkspaces from '../session-workspaces/index.js';

import { enforceRetention } from './checkpoint-retention.js';
import { checkpointsRoot, lockIsStale, readStoreState, withStoreLock, writeStoreState } from './checkpoint-store.js';

const STORE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.git$/;
const SWEEP_BUDGET_MS = 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;

function listStores(commonGitDir) {
  const root = checkpointsRoot(commonGitDir);
  const stores = [];
  for (const member of safeReaddir(root)) {
    const memberDir = path.join(root, member);
    for (const name of safeReaddir(memberDir)) {
      const full = path.join(memberDir, name);
      if (name.includes('.init-')) { fs.rmSync(full, { recursive: true, force: true }); continue; }
      const match = STORE_NAME.exec(name);
      if (match) stores.push({ store: full, overlayId: match[1] });
    }
  }
  return stores;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/** True while the process that opened a turn is still alive (this process included). */
function ownerAlive(entry) {
  if (!Number.isSafeInteger(entry?.pid)) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Boot repair, run while holding the store lock (M2): no capture can be using a
 * temporary index, and only turns whose owning process is gone are interrupted.
 */
/** Removes abandoned temporary index, pack (tmp_pack_*) and loose-object (tmp_obj_*) files. */
function removeTemporaryFiles(store) {
  for (const name of safeReaddir(path.join(store, 'tmp'))) fs.rmSync(path.join(store, 'tmp', name), { force: true });
  const objects = path.join(store, 'objects');
  for (const dir of safeReaddir(objects).filter((name) => /^(?:[0-9a-f]{2}|pack)$/.test(name))) {
    for (const name of safeReaddir(path.join(objects, dir))) {
      if (name.startsWith('tmp_')) fs.rmSync(path.join(objects, dir, name), { force: true });
    }
  }
}

function reconcileBootState(store, report) {
  removeTemporaryFiles(store);
  const state = readStoreState(store);
  const open = Object.entries(state.open).filter(([, entry]) => !ownerAlive(entry)).map(([seq]) => Number(seq))
    .filter(Number.isSafeInteger);
  if (open.length === 0) return;
  for (const seq of open) delete state.open[seq];
  state.interrupted = [...new Set([...state.interrupted, ...open])].sort((left, right) => left - right).slice(-200);
  writeStoreState(store, state);
  report.interrupted += open.length;
}

async function sweepStore({ commonGitDir, store, overlayId, boot, retention, report }) {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  if (boot && fs.existsSync(path.join(store, 'nassaj.lock')) && lockIsStale(store)) report.locksCleared += 1;
  await withStoreLock(store, deadline, async () => {
    if (!sessionWorkspaces.overlayInstancePresent(commonGitDir, overlayId)) {
      fs.rmSync(store, { recursive: true, force: true });
      report.removed.push(overlayId);
      return;
    }
    if (boot) reconcileBootState(store, report);
    const baseOid = readBaseOid(commonGitDir, overlayId);
    if (baseOid) await enforceRetention({ store, commonGitDir, baseOid, deadline, ...retention });
  });
}

function readBaseOid(commonGitDir, overlayId) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(commonGitDir, 'nassaj-session-overlays', 'instances', overlayId, 'manifest.json'), 'utf8',
    ));
    return typeof manifest.baseOid === 'string' && /^[0-9a-f]{40,64}$/.test(manifest.baseOid) ? manifest.baseOid : null;
  } catch {
    return null;
  }
}

/**
 * Reconciles every checkpoint store of the given repositories.
 * @param {{commonGitDirs: string[], boot?: boolean, retention?: object}} input
 * @returns {Promise<{removed: string[], interrupted: number, locksCleared: number, failed: number}>}
 */
export async function reconcileCheckpointStores({ commonGitDirs, boot = false, retention = {} }) {
  const report = { removed: [], interrupted: 0, locksCleared: 0, failed: 0 };
  for (const commonGitDir of new Set(commonGitDirs)) {
    for (const { store, overlayId } of listStores(commonGitDir)) {
      try {
        await sweepStore({ commonGitDir, store, overlayId, boot, retention, report });
      } catch (error) {
        report.failed += 1;
        console.warn('[turn-checkpoint] sweep failed', { overlayId, message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }
  return report;
}

/** The common git dir of a project that is a repository root with a `.git` directory, or null. */
export function commonGitDirOfProject(projectPath) {
  try {
    const dotGit = path.join(projectPath, '.git');
    const stat = fs.lstatSync(dotGit);
    return stat.isDirectory() && !stat.isSymbolicLink() ? fs.realpathSync(dotGit) : null;
  } catch {
    return null;
  }
}

/**
 * Lifecycle hook: one boot reconciliation, then a periodic sweep.
 * @param {{listProjectPaths: () => string[], intervalMs?: number, retention?: object}} input
 * @returns {{start(): Promise<void>, stop(): void}}
 */
export function createTurnCheckpointMaintenance({ listProjectPaths, intervalMs = DEFAULT_INTERVAL_MS, retention }) {
  let timer = null;
  const pass = async (boot) => {
    try {
      const commonGitDirs = listProjectPaths().map(commonGitDirOfProject).filter(Boolean);
      await reconcileCheckpointStores({ commonGitDirs, boot, retention });
    } catch (error) {
      console.warn('[turn-checkpoint] maintenance pass failed', { boot, message: String(error?.message ?? error).slice(0, 200) });
    }
  };
  return {
    async start() {
      if (timer) return;
      timer = setInterval(() => { void pass(false); }, intervalMs);
      timer.unref?.();
      await pass(true);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
