#!/usr/bin/env node
/**
 * Out-of-process readiness/rollback guard for ADR-129.
 *
 * The HTTP process persists an exact transaction, then launches this script
 * with the fixed `--guard` argv before it invokes the existing fixed
 * safe-restart action. Build identities are read only from the transaction;
 * they never enter argv, env, or a path.
 */
import { assertLegacyNodePublication } from './lib/node-update-mode.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectServerCandidate,
  readActivationTransaction,
  serverActivatingDirectory,
  serverCandidateDirectory,
  transitionActivationTransaction,
} from '../server/services/local-preview-server-control.js';
import { recordPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { gitControlPath } from './git-control-root.mjs';

const ARTIFACT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateParent = path.dirname(ARTIFACT_ROOT);
const ROOT = path.basename(candidateParent) === 'server-candidates'
  && path.basename(path.dirname(candidateParent)) === '.nassaj-local-preview'
  ? path.resolve(ARTIFACT_ROOT, '..', '..', '..')
  : path.basename(ARTIFACT_ROOT) === 'dist-server' ? path.dirname(ARTIFACT_ROOT) : ARTIFACT_ROOT;
const BUILD_LOCK = gitControlPath(ROOT, 'nassaj-local-preview-build.lock');
const HEALTH_URL = `http://127.0.0.1:${Number(process.env.PORT) || 3004}/health`;
const READINESS_TIMEOUT_MS = 60_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeLoadedBuildId(expectedBuildId, options = {}) {
  try {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(options.healthUrl || HEALTH_URL, {
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? 2_000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.status === 'ok' && health.serverLoadedBuildId === expectedBuildId;
  } catch { return false; }
}

function recordLoaded(transaction, loadedBuildId) {
  recordPreviewLedgerEvent(ROOT, {
    target: 'server',
    sourceGeneration: transaction.sourceGeneration,
    state: 'loaded',
    sourceBuildId: transaction.expectedServerBuildId,
    candidateBuildId: loadedBuildId,
    promotedBuildId: loadedBuildId,
    runtimeBuildId: loadedBuildId,
  });
}

/** Poll public readiness without treating transport or JSON errors as healthy. */
export async function waitForLoadedBuildId(expectedBuildId, options = {}) {
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeLoadedBuildId(expectedBuildId, options)) return true;
    await delay(intervalMs);
  }
  return false;
}

/** Race delayed PM2 autorestart readiness against the route's durable state. */
export async function waitForRestartOrReadiness(expectedBuildId, options = {}) {
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 250;
  const readTransaction = options.readTransaction || (() => readActivationTransaction(ROOT));
  const now = options.now || Date.now;
  const wait = options.delay || delay;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    // Readiness wins a same-tick race: a replacement process that already loaded
    // the exact candidate must never be rolled back because A died before it
    // could persist restart_spawned.
    if (await probeLoadedBuildId(expectedBuildId, options)) return { kind: 'ready' };
    const transaction = readTransaction();
    if (!transaction || transaction.expectedServerBuildId !== expectedBuildId
      || transaction.state !== 'candidate_installed') {
      return { kind: 'state', transaction };
    }
    await wait(intervalMs);
  }
  return { kind: 'timeout', transaction: readTransaction() };
}

function artifactBuildId(directory) {
  try {
    const file = path.join(directory, 'BUILD_PROVENANCE.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const buildId = JSON.parse(fs.readFileSync(file, 'utf8')).buildId;
    return /^[a-f0-9]{64}$/.test(buildId || '') ? buildId : null;
  } catch { return null; }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function assertExchangeDirectories(root, live, candidate, activating) {
  const previewRoot = path.join(root, '.nassaj-local-preview');
  const candidateParent = path.dirname(candidate);
  const activatingParent = path.dirname(activating);
  for (const directory of [root, previewRoot, candidateParent, live, candidate]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('candidate_exchange_path_not_regular');
  }
  try {
    const stat = fs.lstatSync(activatingParent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('candidate_exchange_path_not_regular');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(activatingParent);
  }
  const devices = [live, candidate, activatingParent].map((directory) => fs.lstatSync(directory).dev);
  if (!devices.every((device) => device === devices[0])) throw new Error('candidate_exchange_cross_device');
}

/** Install exactly the immutable candidate named by the durable transaction. */
export function installExactCandidate(root = ROOT, run = spawnSync) {
    assertLegacyNodePublication(root);
  const transaction = readActivationTransaction(root);
  if (!transaction) throw new Error('activation_transaction_missing');
  const live = path.join(root, 'dist-server');
  const candidate = serverCandidateDirectory(root, transaction.expectedServerBuildId);
  const activating = serverActivatingDirectory(root, transaction.expectedServerBuildId);
  const liveId = artifactBuildId(live);
  const candidateId = artifactBuildId(candidate);
  const activatingId = artifactBuildId(activating);
  if (liveId === transaction.expectedServerBuildId && !candidateId
    && activatingId === transaction.previousServerBuildId) {
    return 'already_installed';
  }
  if (liveId !== transaction.previousServerBuildId) {
    throw new Error('candidate_install_identity_mismatch');
  }
  if (candidateId === transaction.expectedServerBuildId && !activatingId) {
    const inspected = inspectServerCandidate(transaction.expectedServerBuildId, root);
    if (!inspected.allowed) throw new Error('candidate_install_identity_mismatch');
    assertExchangeDirectories(root, live, candidate, activating);
    fs.renameSync(candidate, activating);
    fsyncDirectory(path.dirname(candidate));
    fsyncDirectory(path.dirname(activating));
  } else if (candidateId || activatingId !== transaction.expectedServerBuildId) {
    throw new Error('candidate_install_identity_mismatch');
  }
  assertLegacyNodePublication(root);
  const result = run('mv', ['--exchange', '--no-copy', '-T', live, activating], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('candidate_atomic_install_failed');
  fsyncDirectory(path.dirname(live));
  fsyncDirectory(path.dirname(activating));
  if (artifactBuildId(live) !== transaction.expectedServerBuildId
    || artifactBuildId(activating) !== transaction.previousServerBuildId
    || fs.existsSync(candidate)) {
    throw new Error('candidate_install_verification_failed');
  }
  return 'installed';
}

/** Exchange only the exact expected/previous pair; every ambiguity blocks. */
export function exchangePreviousGeneration(root = ROOT, run = spawnSync) {
  const transaction = readActivationTransaction(root);
  if (!transaction) throw new Error('activation_transaction_missing');
  const live = path.join(root, 'dist-server');
  const candidate = serverCandidateDirectory(root, transaction.expectedServerBuildId);
  const previous = serverActivatingDirectory(root, transaction.expectedServerBuildId);
  const liveId = artifactBuildId(live);
  const previousId = artifactBuildId(previous);

  // Crash-resume after the exchange: do not exchange the pair a second time.
  if (liveId === transaction.previousServerBuildId && previousId === transaction.expectedServerBuildId) {
    if (fs.existsSync(candidate)) throw new Error('rollback_candidate_collision');
    fs.renameSync(previous, candidate);
    fsyncDirectory(path.dirname(previous));
    fsyncDirectory(path.dirname(candidate));
    return 'already_exchanged';
  }
  if (liveId !== transaction.expectedServerBuildId || previousId !== transaction.previousServerBuildId) {
    throw new Error('rollback_artifact_identity_mismatch');
  }
  const result = run('mv', ['--exchange', '--no-copy', '-T', live, previous], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('rollback_atomic_exchange_failed');
  fsyncDirectory(path.dirname(live));
  fsyncDirectory(path.dirname(previous));
  if (artifactBuildId(live) !== transaction.previousServerBuildId
    || artifactBuildId(previous) !== transaction.expectedServerBuildId) {
    throw new Error('rollback_exchange_verification_failed');
  }
  if (fs.existsSync(candidate)) throw new Error('rollback_candidate_collision');
  fs.renameSync(previous, candidate);
  fsyncDirectory(path.dirname(previous));
  fsyncDirectory(path.dirname(candidate));
  return 'exchanged';
}

export function runSafeRestart(run = spawnSync, recovery = false) {
  return run('bash', [path.join('dist-server', 'scripts', 'safe-restart.sh'), ...(recovery ? ['--rollback-recovery'] : []), '--exec'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
  });
}

export function runRollbackRestart(run = spawnSync) {
  const ordinary = runSafeRestart(run, false);
  return ordinary.status === 4 ? runSafeRestart(run, true) : ordinary;
}

async function waitForTransactionState(expected, states, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readActivationTransaction(ROOT);
    if (!current || current.expectedServerBuildId !== expected) return null;
    if (states.includes(current.state)) return current;
    await delay(100);
  }
  return null;
}

async function guardLocked() {
  const transaction = readActivationTransaction(ROOT);
  if (!transaction || !['prepared', 'guard_ready', 'install_authorized', 'candidate_installed',
    'restart_spawned', 'awaiting_readiness',
    'rolling_back', 'rollback_restart_pending', 'rollback_deferred'].includes(transaction.state)) return;
  const expected = transaction.expectedServerBuildId;
  const previous = transaction.previousServerBuildId;

  if (['prepared', 'guard_ready'].includes(transaction.state)) {
    transitionActivationTransaction(expected, [transaction.state], { state: 'guard_ready' }, ROOT);
    const authorized = await waitForTransactionState(expected, ['install_authorized', 'deferred']);
    if (!authorized || authorized.state === 'deferred') {
      transitionActivationTransaction(expected, ['guard_ready'], {
        state: 'deferred', error: 'candidate_install_not_authorized',
      }, ROOT);
      return;
    }
  }

  const beforeInstall = readActivationTransaction(ROOT);
  if (beforeInstall?.state === 'install_authorized') {
    try {
      installExactCandidate(ROOT);
      transitionActivationTransaction(expected, ['install_authorized'], { state: 'candidate_installed' }, ROOT);
    } catch (error) {
      transitionActivationTransaction(expected, ['install_authorized'], {
        state: 'deferred', error: `candidate_install_failed:${error.message}`,
      }, ROOT);
      return;
    }
  }

  const installed = readActivationTransaction(ROOT);
  if (installed?.state === 'candidate_installed') {
    const progress = await waitForRestartOrReadiness(expected);
    if (progress.kind === 'ready') {
      recordLoaded(transaction, expected);
      transitionActivationTransaction(expected, ['candidate_installed'], { state: 'complete', error: null }, ROOT);
      return;
    }
    const launched = progress.transaction;
    if (launched && ['complete', 'rolled_back', 'superseded'].includes(launched.state)) return;
    if (!launched || launched.state === 'deferred') {
      try { exchangePreviousGeneration(ROOT); } catch { /* durable state keeps recovery visible */ }
      transitionActivationTransaction(expected, ['candidate_installed'], {
        state: 'deferred', error: 'restart_not_spawned',
      }, ROOT);
      return;
    }
  }

  const beforeReadiness = readActivationTransaction(ROOT);
  if (beforeReadiness && ['restart_spawned', 'awaiting_readiness'].includes(beforeReadiness.state)) {
    transitionActivationTransaction(expected, [beforeReadiness.state], {
      state: 'awaiting_readiness', attempt: (transaction.attempt || 0) + 1,
    }, ROOT);
    if (await waitForLoadedBuildId(expected)) {
      try {
        recordLoaded(transaction, expected);
        transitionActivationTransaction(expected, ['awaiting_readiness'], { state: 'complete', error: null }, ROOT);
        return;
      } catch {
        // A runtime whose durable identity could not be recorded is not accepted.
      }
    }
    const rollback = transitionActivationTransaction(expected, ['awaiting_readiness'], {
      state: 'rolling_back', error: 'candidate_readiness_timeout',
    }, ROOT);
    if (!rollback) {
      const current = readActivationTransaction(ROOT);
      if (current?.expectedServerBuildId !== expected || current.state !== 'rolling_back') return;
    }
  }

  try {
    exchangePreviousGeneration(ROOT);
  } catch (error) {
    transitionActivationTransaction(expected, ['rolling_back', 'rollback_deferred'], {
      state: 'rollback_deferred', error: `rollback_exchange_failed:${error.message}`,
    }, ROOT);
    return;
  }
  transitionActivationTransaction(expected, ['rolling_back', 'rollback_deferred', 'rollback_restart_pending'], {
    state: 'rollback_restart_pending',
  }, ROOT);

  // Codes 3/6 are safe zero-live deferrals, never terminal failure. Keep retrying
  // from the durable state; no --force path exists.
  for (;;) {
    const restart = runRollbackRestart();
    if (restart.status === 3 || restart.status === 6) {
      transitionActivationTransaction(expected, ['rollback_restart_pending', 'rollback_deferred'], {
        state: 'rollback_deferred', error: `rollback_restart_deferred:${restart.status}`,
      }, ROOT);
      await delay(5_000);
      continue;
    }
    if (restart.status !== 0) {
      transitionActivationTransaction(expected, ['rollback_restart_pending', 'rollback_deferred'], {
        state: 'rollback_deferred', error: `rollback_restart_failed:${restart.status ?? restart.signal}`,
      }, ROOT);
      return;
    }
    if (await waitForLoadedBuildId(previous)) {
      try {
        recordLoaded(transaction, previous);
        transitionActivationTransaction(expected, ['rollback_restart_pending', 'rollback_deferred'], {
          state: 'rolled_back', error: 'candidate_readiness_failed_previous_restored',
        }, ROOT);
      } catch {
        transitionActivationTransaction(expected, ['rollback_restart_pending', 'rollback_deferred'], {
          state: 'rollback_deferred', error: 'previous_loaded_identity_not_recorded',
        }, ROOT);
      }
    } else {
      transitionActivationTransaction(expected, ['rollback_restart_pending', 'rollback_deferred'], {
        state: 'rollback_deferred', error: 'previous_readiness_timeout',
      }, ROOT);
    }
    return;
  }
}

function startDetachedGuard() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--guard'], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  child.unref();
}

function guardWithBuildLock() {
  return spawnSync('flock', [
    '-x', '-w', '30', '-F', BUILD_LOCK,
    process.execPath, fileURLToPath(import.meta.url), '--guard-locked',
  ], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
}

const mode = process.argv[2];
if (mode === '--start-guard') startDetachedGuard();
else if (mode === '--guard') {
  const result = guardWithBuildLock();
  if (result.status !== 0) process.exitCode = result.status || 1;
}
else if (mode === '--guard-locked') guardLocked().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
else if (mode === '--rollback-locked') {
  try { exchangePreviousGeneration(ROOT); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
else if (mode === '--validate-recovery') {
  try {
    const transaction = readActivationTransaction(ROOT);
    const liveId = transaction ? artifactBuildId(path.join(ROOT, 'dist-server')) : null;
    if (!transaction || !['rollback_restart_pending', 'rollback_deferred'].includes(transaction.state)
      || liveId !== transaction.previousServerBuildId) process.exitCode = 1;
  } catch { process.exitCode = 1; }
}
