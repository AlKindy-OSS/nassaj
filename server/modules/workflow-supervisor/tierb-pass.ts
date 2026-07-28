/**
 * tierb-pass — the monitor's Tier-B (injected-turn) pass, run ALONGSIDE the
 * proven Tier-A card pass (reconcileAndDeliverOnce) but ONLY when the chat-lock
 * sub-flag is on. It is the COALESCING layer: it gathers every terminal task that
 * wants a turn, groups them by conversation, and hands each conversation's batch
 * to `injectForConversation` (one turn for the whole batch, §د).
 *
 * ROUTING (each task delivered by exactly one tier, via the shared ledger):
 *   - policy card-only            ⇒ NOT here (the card pass owns it).
 *   - policy auto-turn            ⇒ eligible every terminal tick.
 *   - policy on-demand            ⇒ eligible only when a `handoff-requested`
 *                                   trigger file exists in the task dir (the
 *                                   "hand off" button; the informational card that
 *                                   surfaces the button is deferred client work).
 *   - outcome SUCCEEDED           ⇒ joins the conversation's INJECT batch.
 *   - outcome PARTIAL/CRASHED/…   ⇒ Tier-A card only (finalizeDelivery) — NEVER a
 *                                   turn, so quota is never burned on a failure
 *                                   (§ج-2, §أ-3 "no auto LLM turn on untrusted/partial").
 *
 * CRASH-SAFETY comes entirely from injectForConversation (ledger + ref scan); this
 * pass only GROUPS. Never throws — a bad task is audited and skipped.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { reconcileGraceMs, scopeUnitName } from './config.js';
import { classifyTerminal, type UnitStateProbe } from './result-capture.js';
import {
  listTaskDirs,
  readTaskRecord,
  readResultObj,
  looksTerminal,
  type DeliveryTarget,
} from './monitor.js';
import {
  finalizeDelivery,
  readLedger,
  ledgerHasTask,
  type DeliverOutcome,
} from './handoff.js';
import {
  injectForConversation,
  type InjectTaskInput,
  type ResumeTurnParams,
  type ResumeTurnResult,
} from './handoff-injector.js';
import { defaultRunResumeTurn } from './resume-turn-runner.js';
import type { DurableTask } from './intent.js';

export type TierBDeps = {
  env?: NodeJS.ProcessEnv;
  probeUnitState: UnitStateProbe;
  /** C2 ownership gate → AUTHORITATIVE jsonl/project path from the DB. */
  verifyDeliveryTarget: (conversationId: string, userId: number) => DeliveryTarget;
  /** The `claude -p --resume` runner (defaults to the real spawn). */
  runResumeTurn?: (params: ResumeTurnParams) => Promise<ResumeTurnResult>;
  graceMs?: number;
  now?: () => number;
  onAudit?: (rec: Record<string, unknown>) => void;
  /** on-demand trigger predicate (default: a `handoff-requested` file exists). */
  isHandoffRequested?: (taskDir: string, task: DurableTask) => boolean;
};

export type TierBPassResult = {
  injected: number;
  cards: number;
  deferred: number;
  fallback: number;
  denied: number;
  conversations: number;
};

type Eligible = { taskDir: string; task: DurableTask; outcome: DeliverOutcome; resultObj: unknown };

function defaultIsHandoffRequested(taskDir: string): boolean {
  return existsSync(path.join(taskDir, 'handoff-requested'));
}

/**
 * One Tier-B pass. Gathers eligible terminal tasks, groups by conversation, and
 * delivers each conversation (coalesced turn for the SUCCEEDED batch + cards for
 * the rest). Used both for reconcile-on-boot and each tick.
 */
export async function deliverTierBOnce(deps: TierBDeps): Promise<TierBPassResult> {
  const env = deps.env ?? process.env;
  const graceMs = deps.graceMs ?? reconcileGraceMs(env);
  const isRequested = deps.isHandoffRequested ?? defaultIsHandoffRequested;
  const runResumeTurn = deps.runResumeTurn ?? defaultRunResumeTurn;
  const result: TierBPassResult = {
    injected: 0,
    cards: 0,
    deferred: 0,
    fallback: 0,
    denied: 0,
    conversations: 0,
  };

  // (1) Gather eligible terminal Tier-B tasks, grouped by conversationId.
  const byConv = new Map<string, Eligible[]>();
  for (const taskDir of listTaskDirs(env)) {
    const task = readTaskRecord(taskDir);
    if (!task || task.schema_version !== '2') {
      continue;
    }
    const policy = task.spec.handoffPolicy;
    if (policy !== 'auto-turn' && policy !== 'on-demand') {
      continue; // card-only is the Tier-A pass's job
    }
    if (policy === 'on-demand' && !isRequested(taskDir, task)) {
      continue; // await the explicit "hand off" trigger
    }

    const unit = scopeUnitName(task.taskId);
    let terminal = false;
    try {
      terminal = await looksTerminal(taskDir, unit, deps.probeUnitState);
    } catch {
      terminal = false;
    }
    if (!terminal) {
      continue;
    }

    // Cheap ledger short-circuit before the (possibly graced) classify.
    if (ledgerHasTask(readLedger(env, task.conversationId), task.taskId)) {
      continue;
    }

    let outcome: DeliverOutcome | 'RUNNING';
    try {
      const verdict = await classifyTerminal(taskDir, unit, deps.probeUnitState, {
        graceMs,
        pollTimeoutMs: 20_000,
        now: deps.now,
      });
      outcome = verdict.classification;
    } catch {
      continue; // classify blip — retry next tick
    }
    if (outcome === 'RUNNING') {
      continue;
    }

    const resultObj = readResultObj(taskDir, outcome);
    const list = byConv.get(task.conversationId) ?? [];
    list.push({ taskDir, task, outcome, resultObj });
    byConv.set(task.conversationId, list);
  }

  // (2) Per conversation: C2 gate, then route (inject the SUCCEEDED batch, card
  //     the rest) — coalescing happens inside injectForConversation.
  for (const [conversationId, items] of byConv) {
    result.conversations++;
    const userId = items[0]!.task.userId;
    const target = deps.verifyDeliveryTarget(conversationId, userId);
    if (!target.ok) {
      result.denied++;
      deps.onAudit?.({ event: 'tierb-delivery-denied', conversationId, userId, reason: target.reason });
      continue;
    }

    const injectTasks: InjectTaskInput[] = [];
    for (const it of items) {
      if (it.outcome === 'SUCCEEDED') {
        injectTasks.push({
          taskId: it.task.taskId,
          userId: it.task.userId,
          outcome: it.outcome,
          resultObj: it.resultObj,
          taskDir: it.taskDir,
        });
      } else {
        // Non-success ⇒ Tier-A card (no turn, no quota). Exactly-once via ledger.
        finalizeDelivery({
          env,
          task: { taskId: it.task.taskId, conversationId },
          jsonlPath: target.jsonlPath,
          resultObj: it.resultObj,
          outcome: it.outcome,
        });
        result.cards++;
        deps.onAudit?.({ event: 'tierb-nonsuccess-card', conversationId, taskId: it.task.taskId, outcome: it.outcome });
      }
    }

    if (injectTasks.length === 0) {
      continue;
    }

    const r = await injectForConversation(
      { env, runResumeTurn, now: deps.now, onAudit: deps.onAudit },
      { conversationId, projectPath: target.projectPath, jsonlPath: target.jsonlPath, tasks: injectTasks },
    );
    if (r.event === 'delivered') {
      result.injected += r.injected.length;
      result.cards += r.overflowCarded.length; // oversize overflow surfaced as cards (B-156)
    } else if (r.event === 'card-fallback') {
      result.fallback += r.injected.length;
    } else if (r.event === 'deferred') {
      result.deferred++;
    }
  }

  return result;
}
