/**
 * Standalone supervisor entrypoint (ADR-053 §ج, architecture decision (ب)).
 *
 * A SEPARATE PROCESS, on the nassaj-ops pattern — NOT a module inside the
 * critical path. It is meant to run as its own systemd user unit
 * (workflow-supervisor.service, see workflow-supervisor.service.template) so a
 * launched workflow survives the exit of ANY coordinator (terminal/ssh/the
 * nassaj-dev app itself). nassaj-dev only ever WRITES intents; THIS process owns
 * identity validation and the privileged systemd-run.
 *
 * MASTER NO-OP: refuses to start when WORKFLOW_SUPERVISOR is off, so deploying
 * this file changes nothing until the flag is set.
 *
 * REBOOT SEMANTICS (§ج-4, decided): transient scopes do NOT survive reboot and
 * are NOT auto-resumed. After a reboot the supervisor simply resumes polling for
 * NEW intents; any pre-reboot scope is gone and its workflow is surfaced as a
 * visible ORPHAN by the liveness source (is-active → inactive) — visibility, not
 * silent revival, consistent with the rejected resumeFromRunId auto-resume.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { resolveProviderEnvStrict } from '@/services/isolation/resolve-provider-env-strict.js';

import {
  isSupervisorEnabled,
  isChatTurnLockEnabled,
  validateChatLockConfig,
  intentsDir,
  scopeStateDir,
  taskArtifactDir,
  supervisorLockPath,
  intentSweepMaxAgeMs,
  intentSweepIntervalMs,
  queuedRetryBackoffMs,
} from './config.js';
import type { DurableTask } from './intent.js';
import { processIntent, type SupervisorRecord } from './supervisor-core.js';
import {
  computeIsolationSetenv,
  launchScope,
  listActiveUserScopes,
  listAllActiveScopes,
  systemctlShowState,
} from './systemd.js';
import { acquireSingleOwnerLock } from './supervisor-lock.js';
import {
  reconcileAndDeliverOnce,
  reportRebootOrphansOnce,
  type DeliveryTarget,
  type MonitorDeps,
} from './monitor.js';
import { deliverTierBOnce, type TierBDeps } from './tierb-pass.js';
import { sweepStaleIntents, QueuedRetryTracker } from './queue-guard.js';

const CLAUDE_BIN = process.env.WORKFLOW_SUPERVISOR_CLAUDE_BIN || 'claude';
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.WORKFLOW_SUPERVISOR_POLL_MS ?? '',
  10,
) || 2000;

/**
 * C2 (T-820 audit) — the real delivery-target ownership gate. Resolves the
 * conversation from the DB by its id, verifies the owning project is
 * OWNED/MEMBERED by the task's userId, and returns the AUTHORITATIVE jsonl path
 * FROM THE DB (never a path built from the web-supplied conversationId). A
 * conversation the user does not own, or one with no transcript path, is refused.
 * Never throws — a DB blip fails CLOSED (refuse delivery).
 */
function verifyDeliveryTarget(conversationId: string, userId: number): DeliveryTarget {
  try {
    const row = sessionsDb.getSessionById(conversationId);
    if (!row) {
      return { ok: false, reason: 'no such conversation' };
    }
    if (row.provider && row.provider !== 'claude') {
      return { ok: false, reason: `unsupported provider ${row.provider}` };
    }
    if (!row.jsonl_path || !row.project_path) {
      return { ok: false, reason: 'conversation missing transcript/project path' };
    }
    if (!projectsDb.isProjectPathOwnedOrMemberedBy(row.project_path, userId)) {
      return { ok: false, reason: 'conversation not owned/membered by requester' };
    }
    return { ok: true, jsonlPath: row.jsonl_path, projectPath: row.project_path };
  } catch (error) {
    return {
      ok: false,
      reason: `ownership check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * DOCUMENTED TEST-ONLY hook (mirrors the T-819 spike's HANDOFF_WIDEN_MS): widen
 * the append→ledger gap so a harness can kill -9 the monitor PRECISELY inside the
 * crash window and prove exactly-once re-delivery on restart. Unset/0 in
 * production ⇒ no delay, no behavior change. Read once at process start.
 */
const HANDOFF_WIDEN_MS =
  Number.parseInt(process.env.WORKFLOW_SUPERVISOR_HANDOFF_WIDEN_MS ?? '', 10) || 0;

/**
 * T-822 sub-flag, read once at start (like the other flags). When OFF, the
 * supervisor behaves EXACTLY as T-821: every terminal task gets a Tier-A card,
 * NO Tier-B pass, NO chat-lock coupling. When ON, card-only tasks still get
 * cards while auto-turn/on-demand tasks are routed to the Tier-B injector pass.
 */
const CHAT_LOCK_ON = isChatTurnLockEnabled();

/** Shared monitor deps (real adapters). Reused by boot reconcile + each tick.
 * `shouldDeliverTierA` is added ONLY when the T-822 flag is on, so the Tier-A
 * pass keeps delivering card-only tasks and leaves Tier-B tasks to the injector. */
const monitorDeps: MonitorDeps = {
  probeUnitState: systemctlShowState,
  verifyDeliveryTarget,
  ...(HANDOFF_WIDEN_MS > 0 ? { finalizeHooks: { widenMs: HANDOFF_WIDEN_MS } } : {}),
  ...(CHAT_LOCK_ON
    ? { shouldDeliverTierA: (task: DurableTask) => task.spec.handoffPolicy === 'card-only' }
    : {}),
};

/** Tier-B pass deps (real adapters). Only used when CHAT_LOCK_ON. */
const tierBDeps: TierBDeps = {
  probeUnitState: systemctlShowState,
  verifyDeliveryTarget,
  onAudit: (rec) => console.info(JSON.stringify({ level: 'info', msg: 'tierb', ...rec })),
};

/** Run the Tier-B injector pass when the T-822 flag is on (no-op otherwise). */
async function maybeTierBPass(where: string): Promise<void> {
  if (!CHAT_LOCK_ON) {
    return;
  }
  try {
    const r = await deliverTierBOnce(tierBDeps);
    if (r.injected > 0 || r.cards > 0 || r.deferred > 0 || r.fallback > 0 || r.denied > 0) {
      console.info(JSON.stringify({ level: 'info', msg: `tierb pass (${where})`, ...r }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'tierb pass failed',
        where,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Atomic JSON write (tmp + rename) — same contract as the bridge. */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, filePath);
}

/** Persist supervisor.json under the per-scope state dir (UI reads via watcher). */
async function writeSupervisorRecord(wfLaunchId: string, record: SupervisorRecord): Promise<void> {
  await atomicWriteJson(path.join(scopeStateDir(wfLaunchId), 'supervisor.json'), record);
}

/**
 * Persist the full DurableTask (delivery context) under the task artifact dir at
 * the moment of launch, so a later monitor can deliver to the requesting
 * conversation. The dir is 0700 (web-originated context — §هـ-4).
 */
async function writeTaskRecord(taskId: string, task: DurableTask): Promise<void> {
  const dir = taskArtifactDir(taskId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
  await atomicWriteJson(path.join(dir, 'task.json'), task);
}

/**
 * Handle one intent file: read → processIntent (GATE2 → concurrency → launch).
 * On a terminal outcome (launched/denied/error) the intent file is consumed
 * (deleted). On `queued` it is LEFT on disk for a later tick. Returns the outcome
 * status so the poll loop can apply the C1 back-off to a queued intent.
 */
async function handleIntentFile(
  filePath: string,
): Promise<'launched' | 'denied' | 'queued' | 'error' | 'skip'> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable/half-written (rename should prevent the latter) — skip; a
    // corrupt file that never becomes valid is cleaned by the sweep timer.
    return 'skip';
  }

  const outcome = await processIntent(raw, {
    authorize: {
      // STRICT ownership predicate — NOT visibility (§ج-3 حرج-2).
      isOwnedOrMembered: (projectPath, userId) =>
        projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, userId),
      // FAIL-CLOSED env resolver (§هـ-1): a non-integer id THROWS here instead
      // of falling open to the owner subscription. GATE2 already guarantees an
      // integer id before this runs, so it never throws on the happy path — this
      // is the belt over the fail-open resolveProviderEnv the critic flagged.
      resolveEnv: (userId, provider, baseEnv) =>
        resolveProviderEnvStrict(userId, provider, baseEnv),
    },
    listActiveScopes: listActiveUserScopes,
    // HOST-WIDE gate source (§ج-5) — bounds total memory across all users.
    listAllActiveScopes,
    launchScope: async ({ intent, env }) => {
      // Forward the isolation keys (esp. the ToS-critical CLAUDE_CONFIG_DIR)
      // deterministically — a transient unit inherits NOTHING, so a dropped key
      // would silently fall back to the owner/default credentials.
      const setenv = computeIsolationSetenv(env, process.env);
      // Task artifact dir (result.json[.partial] + DONE land here — §أ-2/§أ-4).
      const resultDir = taskArtifactDir(intent.wfLaunchId);
      await fsp.mkdir(resultDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(resultDir, 0o700).catch(() => {});
      return launchScope({
        wfLaunchId: intent.wfLaunchId,
        userId: intent.userId,
        cwd: intent.projectPath,
        claudeBin: CLAUDE_BIN,
        scriptOrPrompt: intent.scriptOrPrompt,
        model: intent.model,
        setenv,
        resultDir,
      });
    },
    writeRecord: writeSupervisorRecord,
    writeTaskRecord,
  });

  if (outcome.status === 'queued') {
    // Leave the intent for a later tick (capacity may free up).
    console.info(JSON.stringify({ level: 'info', msg: 'workflow intent queued', file: path.basename(filePath), reason: outcome.reason }));
    return 'queued';
  }

  // launched / denied / error: consume the intent so it is not reprocessed.
  await fsp.rm(filePath, { force: true });
  console.info(
    JSON.stringify({
      level: outcome.status === 'launched' ? 'info' : 'warn',
      msg: `workflow intent ${outcome.status}`,
      file: path.basename(filePath),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('unit' in outcome ? { unit: outcome.unit } : {}),
    }),
  );
  return outcome.status;
}

/**
 * One poll pass over every user's intents dir. The C1 back-off tracker collapses
 * the audit's amplification: a QUEUED intent is re-processed at most once per
 * back-off interval instead of on EVERY tick (a queued intent otherwise re-runs
 * GATE2 + a systemctl probe each tick). A consumed intent is forgotten; keys no
 * longer on disk are pruned so the tracker cannot grow unbounded.
 */
async function pollOnce(retry: QueuedRetryTracker): Promise<void> {
  const root = intentsDir();
  let userDirs: string[];
  try {
    userDirs = await fsp.readdir(root);
  } catch {
    return; // no intents yet
  }
  const liveKeys = new Set<string>();
  for (const userDir of userDirs) {
    const dir = path.join(root, userDir);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) {
        continue;
      }
      const full = path.join(dir, file);
      liveKeys.add(full);
      // Back-off: skip a still-queued intent until its retry interval elapses.
      if (!retry.shouldAttempt(full)) {
        continue;
      }
      try {
        const status = await handleIntentFile(full);
        if (status === 'queued') {
          retry.markAttempt(full); // wait a full back-off before the next probe
        } else {
          retry.forget(full); // consumed/terminal — drop the key
        }
      } catch (error) {
        retry.markAttempt(full); // a crashing intent also backs off
        console.error(
          JSON.stringify({ level: 'error', msg: 'intent handler crashed', file, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }
  // Prune tracked keys whose intent files are gone (consumed elsewhere/swept).
  retry.retain(liveKeys);
}

/**
 * Start the full supervisor cycle. No-op (never loops) when the flag is off.
 *
 * BOOT (§ب-2):
 *   1. Acquire the single-owner flock (الشرط 5). If another instance holds it,
 *      exit QUIETLY — one monitor at a time. flock is released by the kernel on
 *      any death (incl. kill -9), so a restart re-acquires with no stale lock.
 *   2. reconcile-on-boot: one immediate monitor pass re-binds and delivers any
 *      task that finished while the monitor was dead (§و/م3 crash-safety).
 *
 * LOOP each tick:
 *   a. pollOnce   — launch new intents (GATE2 → concurrency → launchScope), with
 *                   the C1 back-off on queued intents.
 *   b. monitor    — reconcileAndDeliverOnce: classify terminals + deliver cards
 *                   exactly-once (§أ-3/§أ-4).
 *   c. sweep      — on a slower cadence, delete stale/corrupt intents (C1-د).
 */
export async function runSupervisor(): Promise<void> {
  if (!isSupervisorEnabled()) {
    console.info(JSON.stringify({ level: 'info', msg: 'WORKFLOW_SUPERVISOR off — supervisor is a no-op, exiting' }));
    return;
  }

  // (0) T-823 condition 3 — chat-lock timing invariant, asserted at boot. Only
  //     matters when the sub-flag is on (the injector is the sole lock holder, and
  //     it runs ONLY in this process). A broken invariant means a human turn could
  //     time out fail-OPEN while the injector still holds the lock ⇒ concurrent
  //     jsonl append (the exact race the seam prevents). FAIL-CLOSED: refuse to
  //     start (exit 1) so no injection ever runs against a misconfigured wait
  //     ceiling — no supervisor ⇒ no injector ⇒ no race. When the sub-flag is off
  //     this is skipped entirely (no-op).
  if (isChatTurnLockEnabled()) {
    const verdict = validateChatLockConfig();
    if (!verdict.ok) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'workflow supervisor: chat-lock timing invariant BROKEN — refusing to start (fail-closed)',
          holdMs: verdict.holdMs,
          waitMs: verdict.waitMs,
          problems: verdict.problems,
          fix: 'raise WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS or lower WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS so wait ≥ hold + grace and both are under their ceilings',
        }),
      );
      process.exit(1);
    }
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'chat-lock timing invariant OK',
        holdMs: verdict.holdMs,
        waitMs: verdict.waitMs,
      }),
    );
  }

  // (1) Single-owner flock — a second monitor exits quietly (الشرط 5).
  const lock = acquireSingleOwnerLock(supervisorLockPath());
  if (!lock) {
    console.info(JSON.stringify({ level: 'info', msg: 'workflow supervisor: another instance holds the lock — exiting quietly' }));
    return;
  }

  const retry = new QueuedRetryTracker(queuedRetryBackoffMs());
  console.info(JSON.stringify({ level: 'info', msg: 'workflow supervisor started', intentsDir: intentsDir(), pollMs: POLL_INTERVAL_MS, lockFd: lock.fd }));

  // (2a) reboot-orphan report (§و م5): surface any task whose transient unit did
  //      NOT survive a reboot (terminal/gone + no DONE + undelivered) as a VISIBLE
  //      incomplete orphan — launches NOTHING, no auto-resume. Runs BEFORE reconcile
  //      so the "orphaned, not resumed" audit precedes the CRASHED/PARTIAL card that
  //      reconcile then delivers for it.
  try {
    const orphans = await reportRebootOrphansOnce(monitorDeps);
    if (orphans.orphans > 0) {
      console.info(JSON.stringify({ level: 'info', msg: 'reboot orphans surfaced (visible, NOT auto-resumed)', ...orphans }));
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'reboot-orphan report failed', error: error instanceof Error ? error.message : String(error) }));
  }

  // (2b) reconcile-on-boot: deliver anything that finished while we were dead.
  try {
    const boot = await reconcileAndDeliverOnce(monitorDeps);
    console.info(JSON.stringify({ level: 'info', msg: 'reconcile-on-boot done', ...boot }));
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'reconcile-on-boot failed', error: error instanceof Error ? error.message : String(error) }));
  }
  // Tier-B (T-822): coalesced injected turns for auto-turn/on-demand tasks that
  // finished while we were dead (no-op unless the chat-lock sub-flag is on).
  await maybeTierBPass('boot');

  let lastSweep = 0;
  // Sequential cycle; a long-lived poller is equivalent to the runner's timer and
  // self-contained for B-103's scope.
  while (true) {
    await pollOnce(retry);
    try {
      await reconcileAndDeliverOnce(monitorDeps);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', msg: 'monitor pass failed', error: error instanceof Error ? error.message : String(error) }));
    }
    await maybeTierBPass('tick');
    const now = Date.now();
    if (now - lastSweep >= intentSweepIntervalMs()) {
      lastSweep = now;
      const swept = sweepStaleIntents(process.env, intentSweepMaxAgeMs(), now);
      if (swept.deleted > 0) {
        console.info(JSON.stringify({ level: 'info', msg: 'swept stale intents', ...swept }));
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Direct-exec entrypoint (node dist-server/.../supervisor.js). Guarded so an
// import for tests does not start the loop.
const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /workflow-supervisor[/\\]supervisor(\.[cm]?js|\.ts)?$/.test(process.argv[1] ?? '');
if (isMain) {
  runSupervisor().catch((error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'supervisor fatal', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
