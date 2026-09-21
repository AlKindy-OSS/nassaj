/**
 * monitor — the permanent monitor's DELIVERY cycle (§ب-2, §ج-1/ج-2/ج-3), ported
 * from the proven T-819 consumer spike (`spikes/b103-t819/lib/supervisor.mjs`)
 * onto server code (audit condition C2). It models the reconcile→monitor→deliver
 * arc that runSupervisor now runs alongside the existing launch poll:
 *
 *   reconcile-on-boot : one immediate pass re-binds any task that finished while
 *                       the monitor was dead — it enumerates tasks/<id>/ on disk
 *                       (each task.json), derives the unit deterministically
 *                       (scopeUnitName), and delivers any that are terminal.
 *   monitorRunning    : a cheap terminal check per task each tick (DONE present,
 *                       or the unit no longer active) before the authoritative
 *                       classifier runs — so a still-running task costs one probe,
 *                       not a full classify.
 *   onTerminal        : classify (§أ-3) → C2 ownership verify → build the untrusted
 *                       result → finalizeDelivery (exactly-once card, §أ-4).
 *
 * CRASH SAFETY (§و/م3, reproducing T-819 criteria 6): the tasks are independent
 * systemd transient units that OUTLIVE this process; killing the monitor at any
 * offset and restarting it re-binds and finishes delivery EXACTLY ONCE — the
 * ledger + JSON.parse jsonl reconcile in handoff.ts guarantee no double, no lost.
 *
 * C2 (T-820 audit) — DELIVERY-TARGET OWNERSHIP: before ANY card is written, the
 * injected `verifyDeliveryTarget` confirms the DurableTask's conversationId maps
 * to a session under a projectPath OWNED/MEMBERED by the task's userId, and
 * returns the AUTHORITATIVE jsonl path FROM THE DB — never a path built from the
 * web-supplied conversationId. A conversation the user does not own is skipped,
 * never delivered to (defeats a shared-project member steering a delivery to a
 * peer's chat).
 */

import fs from 'node:fs';
import path from 'node:path';

import { tasksDir, reconcileGraceMs, scopeUnitName } from './config.js';
import { classifyTerminal, type UnitStateProbe, type UnitState } from './result-capture.js';
import {
  finalizeDelivery,
  readLedger,
  ledgerHasTask,
  type DeliverOutcome,
  type FinalizeAction,
  type FinalizeHooks,
} from './handoff.js';
import type { DurableTask } from './intent.js';

/** Result of the C2 delivery-target ownership verification. */
export type DeliveryTarget =
  | { ok: true; jsonlPath: string; projectPath: string }
  | { ok: false; reason: string };

export type MonitorDeps = {
  env?: NodeJS.ProcessEnv;
  /** Real: systemctl show; test: a stub. */
  probeUnitState: UnitStateProbe;
  /** C2 ownership gate; returns the AUTHORITATIVE jsonl path from the DB. */
  verifyDeliveryTarget: (conversationId: string, userId: number) => DeliveryTarget;
  /** Override the DONE-absent grace (defaults to config). */
  graceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Notified after each delivery (WS badge broadcast / audit). */
  onAction?: (action: FinalizeAction, task: DurableTask) => void;
  /** Test-only passthrough to finalizeDelivery (tear/widen/marker/matcher). */
  finalizeHooks?: FinalizeHooks;
  /**
   * T-822 Tier-A/Tier-B routing (OPTIONAL — undefined preserves T-821 behavior
   * byte-for-byte: every terminal task gets a card). When provided, a task for
   * which this returns FALSE is left for the Tier-B injector pass (auto-turn/
   * on-demand) instead of being delivered as a card here. The two passes share
   * ONE ledger keyed by taskId, so each task is delivered by exactly one tier.
   */
  shouldDeliverTierA?: (task: DurableTask) => boolean;
};

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/** List task dirs that carry a task.json (a launched DurableTask). */
export function listTaskDirs(env: NodeJS.ProcessEnv): string[] {
  const dir = tasksDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .map((n) => path.join(dir, n))
    .filter((d) => fs.existsSync(path.join(d, 'task.json')));
}

/** Read a task.json (DurableTask). Returns null on missing/corrupt. */
export function readTaskRecord(taskDir: string): DurableTask | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as DurableTask;
  } catch {
    return null;
  }
}

/** Cheap, non-blocking terminal check: DONE present, or unit no longer active. */
export async function looksTerminal(taskDir: string, unit: string, probe: UnitStateProbe): Promise<boolean> {
  if (fs.existsSync(path.join(taskDir, 'DONE'))) {
    return true;
  }
  if (!unit) {
    return true;
  }
  let state: string;
  try {
    state = await probe(unit);
  } catch {
    return true; // probe failure ⇒ treat as gone (decisive, never a hang)
  }
  return state !== 'active' && state !== 'activating';
}

/** Read the raw result.json for the untrusted payload, or a classification note. */
export function readResultObj(taskDir: string, classification: DeliverOutcome): unknown {
  const p = path.join(taskDir, 'result.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { unparseable: true, classification };
    }
  }
  const partial = path.join(taskDir, 'result.json.partial');
  if (fs.existsSync(partial)) {
    try {
      return { partial: fs.readFileSync(partial, 'utf8'), classification };
    } catch {
      return { note: 'partial unreadable', classification };
    }
  }
  return { note: 'no result.json', classification };
}

/** Append one audit line for a delivery transition (§هـ-3). Best-effort. */
function auditLine(taskDir: string, rec: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(taskDir, 'audit.log'),
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

export type DeliverResult =
  | 'already'
  | 'running'
  | 'error'
  | 'denied-ownership'
  | 'skipped-tierb'
  | FinalizeAction['event'];

/**
 * Deliver one task if it is terminal. Idempotent and exactly-once (the ledger +
 * jsonl scan in finalizeDelivery). Returns a coarse status the loop aggregates.
 */
export async function deliverIfTerminal(
  deps: MonitorDeps,
  taskDir: string,
  task: DurableTask,
): Promise<DeliverResult> {
  const env = deps.env ?? process.env;
  const unit = scopeUnitName(task.taskId);

  // T-822 routing: a Tier-B-policy task is owned by the injector pass, not the
  // card path. Checked BEFORE the (possibly graced) classify so it costs nothing.
  if (deps.shouldDeliverTierA && !deps.shouldDeliverTierA(task)) {
    return 'skipped-tierb';
  }

  if (!(await looksTerminal(taskDir, unit, deps.probeUnitState))) {
    return 'running';
  }

  // Authoritative §أ-3 verdict.
  const verdict = await classifyTerminal(taskDir, unit, deps.probeUnitState, {
    graceMs: deps.graceMs ?? reconcileGraceMs(env),
    pollTimeoutMs: 20_000,
    now: deps.now,
    sleep: deps.sleep ?? realSleep,
  });
  if (verdict.classification === 'RUNNING') {
    return 'running';
  }

  // C2 — verify the delivery target BEFORE any write; get the DB-authoritative
  // jsonl path (never a path built from the web-supplied conversationId).
  const target = deps.verifyDeliveryTarget(task.conversationId, task.userId);
  if (!target.ok) {
    auditLine(taskDir, {
      event: 'delivery-denied',
      taskId: task.taskId,
      userId: task.userId,
      conversationId: task.conversationId,
      classification: verdict.classification,
      reason: target.reason,
    });
    return 'denied-ownership';
  }

  const outcome = verdict.classification as DeliverOutcome;
  const resultObj = readResultObj(taskDir, outcome);
  const action = finalizeDelivery(
    { env, task, jsonlPath: target.jsonlPath, resultObj, outcome },
    deps.finalizeHooks ?? {},
  );

  auditLine(taskDir, {
    event: action.event,
    taskId: task.taskId,
    userId: task.userId,
    conversationId: task.conversationId,
    projectPath: target.projectPath,
    classification: verdict.classification,
    injected: action.injected,
    ledgerWritten: action.ledgerWritten,
  });
  deps.onAction?.(action, task);
  return action.event;
}

export type MonitorPassResult = {
  allDelivered: boolean;
  pending: number;
  delivered: number;
};

/**
 * One monitor pass over every task dir. Used both for reconcile-on-boot (one
 * immediate call) and each poll tick. Never throws — a single bad task is logged
 * (via audit) and skipped so the loop continues.
 */
export async function reconcileAndDeliverOnce(deps: MonitorDeps): Promise<MonitorPassResult> {
  const env = deps.env ?? process.env;
  let allDelivered = true;
  let pending = 0;
  let delivered = 0;

  for (const taskDir of listTaskDirs(env)) {
    const task = readTaskRecord(taskDir);
    if (!task || task.schema_version !== '2') {
      continue;
    }
    let r: DeliverResult;
    try {
      r = await deliverIfTerminal(deps, taskDir, task);
    } catch (error) {
      auditLine(taskDir, {
        event: 'monitor-error',
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      allDelivered = false;
      pending++;
      continue;
    }
    if (r === 'running' || r === 'error') {
      allDelivered = false;
      pending++;
    } else if (r === 'inject+ledger' || r === 'ledger-repair') {
      delivered++;
    }
  }
  return { allDelivered, pending, delivered };
}

export type OrphanReport = {
  scanned: number;
  orphans: number;
  /** taskIds surfaced as reboot orphans this pass (for the caller's log/test). */
  taskIds: string[];
};

/**
 * REBOOT SEMANTICS (§ج-4 / §و م5, condition "reboot ⇒ visible-orphan"). A
 * transient `wf-<taskId>.service` does NOT survive a reboot and is NEVER auto-
 * resumed (consistent with the rejected resumeFromRunId auto-resume). This pass —
 * run once at supervisor boot, BEFORE reconcile — makes that VISIBLE: it finds
 * every launched task that was INTERRUPTED (its unit is terminal/gone AND it has
 * no DONE AND it was not already delivered) and writes a `reboot-orphan` audit line
 * marking it surfaced-not-resumed. It LAUNCHES NOTHING: reconcileAndDeliverOnce
 * (which runs right after) delivers each as a CRASHED/PARTIAL "did not complete"
 * card. Pure visibility; the "no auto-restart" property is structural (the monitor
 * has no launch path) and this pass makes it observable + testable. Never throws.
 */
export async function reportRebootOrphansOnce(deps: MonitorDeps): Promise<OrphanReport> {
  const env = deps.env ?? process.env;
  const report: OrphanReport = { scanned: 0, orphans: 0, taskIds: [] };
  for (const taskDir of listTaskDirs(env)) {
    const task = readTaskRecord(taskDir);
    if (!task || task.schema_version !== '2') {
      continue;
    }
    report.scanned++;
    // DONE present ⇒ the task actually finished (deliver normally, not an orphan).
    if (fs.existsSync(path.join(taskDir, 'DONE'))) {
      continue;
    }
    // Already delivered on a prior boot ⇒ not pending.
    if (ledgerHasTask(readLedger(env, task.conversationId), task.taskId)) {
      continue;
    }
    const unit = scopeUnitName(task.taskId);
    let state: UnitState;
    try {
      state = await deps.probeUnitState(unit);
    } catch {
      state = 'gone'; // probe blip ⇒ treat as gone (decisive), never a hang
    }
    // active/activating ⇒ a genuinely still-running task (NOT a reboot orphan) —
    // reboot kills transient units, so post-reboot this is only ever terminal/gone.
    if (state === 'active' || state === 'activating') {
      continue;
    }
    // Interrupted with no DONE and no delivery ⇒ a reboot orphan. Surface it
    // (audit), do NOT relaunch.
    report.orphans++;
    report.taskIds.push(task.taskId);
    auditLine(taskDir, {
      event: 'reboot-orphan',
      taskId: task.taskId,
      userId: task.userId,
      conversationId: task.conversationId,
      unitState: state,
      resumed: false,
      note: 'transient unit did not survive reboot; surfaced as incomplete, NOT auto-resumed',
    });
  }
  return report;
}
