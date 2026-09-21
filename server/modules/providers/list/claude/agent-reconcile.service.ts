/**
 * T-873(2) — undelivered `Agent` task-notifications (VISIBILITY ONLY).
 *
 * THE MEASURED BUG
 * ----------------
 * When a background `Agent` stops, the harness WRITES a truthful, fully detailed
 * notification to the parent transcript as a `queue-operation`/`enqueue` row —
 * `<task-id>`, `<status>`, `<summary>`, and for a finished agent the entire
 * `<result>` (its report). That row is durable. It then has to be handed to the
 * conversation as a `user` row carrying `origin.kind:'task-notification'`, and
 * THAT hop happens in memory. If the coordinator process exits first, the hop
 * never completes and the notification is lost with no trace in the UI.
 *
 * Correlating enqueue rows against delivered rows across every parent transcript
 * in this project (574 notifications) measures the gap exactly:
 *
 *     status=killed      62 enqueued   62 NEVER DELIVERED   (100%)
 *     status=completed  339 enqueued   82 NEVER DELIVERED   ( 24%)
 *     status=failed       8 enqueued    2 NEVER DELIVERED
 *     status=stopped     67 enqueued    0 never delivered
 *
 * Not one `killed` notification has ever reached a conversation. The incident
 * that motivated this (agent `ab0bf67f9ea3d0c25`) is the canonical shape: the
 * agent finished its work, was killed 63 s later, the harness enqueued a
 * `killed` notification whose `<result>` held the report verbatim — and the only
 * thing the user ever saw was a LATER, much poorer `stopped` notice five minutes
 * on ("No completion record was found…").
 *
 * WHAT THIS SERVICE DOES
 * ----------------------
 * Recovers those lost notifications from the rows `getSessionMessages` ALREADY
 * holds in memory and appends them as derived cards. No new disk read, no new
 * path coupling — the same seam and the same posture as
 * `findLatestStoppedNotificationMs` in workflow-reconcile.service.ts.
 *
 * `remove` IS NOT DELIVERY. 49 `completed` + 2 `failed` notifications were
 * removed from the queue and still never appeared in any conversation, so a
 * `remove` row is treated as no evidence at all. Only an actual `user` row with
 * `origin.kind === 'task-notification'` counts as delivered.
 *
 * HARD LIMITS
 * -----------
 * - READ-ONLY. Derived rows are appended to the response payload and NEVER
 *   written to the SDK-owned transcript, so turning the flag off erases them
 *   without a trace.
 * - NOTHING IS RESUMED. The card states the fact and stops. There is no spawn,
 *   no re-dispatch, no "auto-retry" — the standing veto on automatic agent
 *   resume is respected structurally: this file's only output is data.
 * - NO FALSE COMPLETION CLAIM. The card reports the status the harness itself
 *   recorded (`killed`/`completed`/`failed`), never an inferred one, and is
 *   emitted with `status:'undelivered'` so it can never be mistaken for a
 *   completion by the existing card renderer (which greens only `'completed'`).
 * - Behind the `AGENT_RECONCILE` flag, default OFF: byte-for-byte prior
 *   behaviour when disabled.
 *
 * ORTHOGONAL to workflow-reconcile: that service reads `subagents/workflows/wf_*`
 * journals and corrects a `run.stopped` card; this one reads parent-transcript
 * queue rows for the `Agent` tool. Disjoint inputs, disjoint outputs — this
 * service never emits a `wfId`, so the frontend's wfId-keyed reconcile pass
 * cannot interact with its cards.
 */

import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const PROVIDER = 'claude';

/**
 * Per-tag extraction, deliberately NOT one monolithic pattern.
 *
 * A single combined regex is exactly how the B-94 notification parser came to
 * match only 6.5% of real rows while its tests stayed green. These were each
 * validated against all 574 real notifications on disk:
 *   task-id 574/574 · summary 574/574 · status 573/574 · tool-use-id 527/574
 *   (absent on the `stopped` shape) · result 436/574 (absent when there is no
 *   report). Optional tags are optional in the type, not assumed present.
 */
const TASK_ID_RE = /<task-id>([^<]*)<\/task-id>/;
const STATUS_RE = /<status>([^<]*)<\/status>/;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const TOOL_USE_ID_RE = /<tool-use-id>([^<]*)<\/tool-use-id>/;
/**
 * GREEDY on purpose: a `<result>` body routinely contains unbalanced `<` and
 * even markup, and is followed by an optional `<usage>` block. Matching to the
 * LAST `</result>` was verified against all 436 real result blocks — the
 * remainder after the match was always empty, `</task-notification>`, or the
 * `<usage>` block, never truncated report text.
 */
const RESULT_RE = /<result>([\s\S]*)<\/result>/;

/** Upper bound on recovered report text carried in a card. */
const MAX_RESULT_CHARS = 20000;

/**
 * Reads the `AGENT_RECONCILE` flag. OFF unless explicitly truthy — same idiom as
 * `workflowReconcileEnabled()`. While OFF this service is a total no-op.
 */
export function agentReconcileEnabled(): boolean {
  const raw = process.env.AGENT_RECONCILE;
  if (typeof raw !== 'string') {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** One `<task-notification>` parsed out of a transcript row. */
export type ParsedTaskNotification = {
  taskId: string;
  /** Harness-recorded status: `killed` | `completed` | `stopped` | `failed` | … */
  status: string;
  summary: string | null;
  toolUseId: string | null;
  /** The agent's report, when the notification carried one. */
  result: string | null;
  resultTruncated: boolean;
};

/**
 * Parses a `<task-notification>` payload. Returns null when the string is not a
 * notification or carries no `<task-id>` (without an id it cannot be correlated,
 * so it is dropped rather than half-reported).
 */
export function parseTaskNotification(content: unknown): ParsedTaskNotification | null {
  if (typeof content !== 'string' || !content.includes('<task-notification>')) {
    return null;
  }

  const taskId = TASK_ID_RE.exec(content)?.[1]?.trim();
  if (!taskId) {
    return null;
  }

  const rawResult = RESULT_RE.exec(content)?.[1] ?? null;
  const resultTruncated = rawResult !== null && rawResult.length > MAX_RESULT_CHARS;

  return {
    taskId,
    status: STATUS_RE.exec(content)?.[1]?.trim() || 'unknown',
    summary: SUMMARY_RE.exec(content)?.[1]?.trim() || null,
    toolUseId: TOOL_USE_ID_RE.exec(content)?.[1]?.trim() || null,
    result: resultTruncated ? rawResult!.slice(0, MAX_RESULT_CHARS) : rawResult,
    resultTruncated,
  };
}

/** An enqueued notification with no matching delivered row. */
export type UndeliveredNotification = ParsedTaskNotification & {
  /** Timestamp of the enqueue row (ISO) — when the harness knew the truth. */
  enqueuedAt: string;
};

/**
 * Correlation key. Keyed on (taskId, status) rather than taskId alone because a
 * single agent legitimately notifies more than once ("the same task-id may
 * notify more than once" — the harness' own note): an agent can be `completed`,
 * resumed, then `killed`. Keying on the id alone would let one delivered
 * notification mask a different, undelivered one for the same agent.
 *
 * The pairing is deliberately CONSERVATIVE in the other direction: two enqueues
 * with the same (id, status) and one delivery count as delivered, so the service
 * under-reports rather than inventing a card for something the user did see.
 */
function correlationKey(taskId: string, status: string): string {
  return `${taskId}::${status}`;
}

/**
 * Finds notifications the harness enqueued but never delivered to the
 * conversation, from the parent-transcript rows already in memory.
 *
 * Pure, single pass, no I/O, never throws. Results are ordered by enqueue time;
 * duplicates on the same (taskId, status) collapse to the LAST enqueue, which is
 * the one carrying the most recent report.
 */
export function findUndeliveredAgentNotifications(
  messages: AnyRecord[],
): UndeliveredNotification[] {
  const enqueued = new Map<string, UndeliveredNotification>();
  const delivered = new Set<string>();

  for (const entry of messages) {
    if (!entry) {
      continue;
    }

    // (a) Delivered: a real conversation row stamped by the SDK as a
    //     task-notification. This is the ONLY accepted proof of delivery.
    if ((entry.origin as AnyRecord | undefined)?.kind === 'task-notification') {
      const parsed = parseTaskNotification((entry.message as AnyRecord | undefined)?.content);
      if (parsed) {
        delivered.add(correlationKey(parsed.taskId, parsed.status));
      }
      continue;
    }

    // (b) Enqueued: the harness wrote the notification to the queue. `dequeue`
    //     carries no content and `remove` is NOT delivery (measured: 51 removed
    //     notifications were never delivered), so only `enqueue` is collected.
    if (entry.type !== 'queue-operation' || entry.operation !== 'enqueue') {
      continue;
    }
    const parsed = parseTaskNotification(entry.content);
    if (!parsed) {
      continue;
    }
    const timestamp = entry.timestamp;
    if (typeof timestamp !== 'string' || !Number.isFinite(new Date(timestamp).getTime())) {
      continue; // Without a usable timestamp the card cannot be placed in order.
    }
    enqueued.set(correlationKey(parsed.taskId, parsed.status), {
      ...parsed,
      enqueuedAt: timestamp,
    });
  }

  const undelivered: UndeliveredNotification[] = [];
  for (const [key, notification] of enqueued) {
    if (!delivered.has(key)) {
      undelivered.push(notification);
    }
  }

  undelivered.sort(
    (a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime(),
  );
  return undelivered;
}

/** Arabic headline per harness-recorded status. */
function undeliveredHeadline(notification: UndeliveredNotification): string {
  const label = notification.summary?.trim();
  const suffix = label ? ` — ${label}` : '';
  switch (notification.status) {
    case 'killed':
      return `لم تُسلَّم نتيجة وكيل أُوقِف${suffix}`;
    case 'completed':
      return `لم تُسلَّم نتيجة وكيل أنهى عمله${suffix}`;
    case 'failed':
      return `لم يُسلَّم إخفاق وكيل${suffix}`;
    default:
      return `لم يُسلَّم إشعار وكيل (${notification.status})${suffix}`;
  }
}

/**
 * Builds the derived "result never delivered" card.
 *
 * CONTRACT — chosen so NO frontend change is required and no false claim is
 * possible:
 *  - `kind:'task_notification'` rides the card path the client already renders
 *    (`content: summary`, `taskStatus: status`).
 *  - `status:'undelivered'` — deliberately NOT `'completed'`, so the renderer's
 *    green dot (which triggers only on exactly `'completed'`) can never appear
 *    for a card this service produced. It is also NOT `'stopped'`, so the
 *    client's wfId-keyed reconcile-replacement pass ignores it.
 *  - no `wfId` — this is the `Agent` path, not a workflow.
 *  - `originKind:'task-notification'` so it is never attributed to the user.
 *  - `timestamp` = the ENQUEUE time, so the card lands at the moment the harness
 *    actually knew, not at read time.
 *  - `agentResult` carries the recovered report verbatim for a client that later
 *    wants to expose it; ignored harmlessly by today's renderer.
 *
 * MANUAL RESUME IS AN INSTRUCTION, NEVER AN ACTION. `resumeHint` is descriptive
 * text naming the agent id; nothing in this codebase acts on it.
 */
export function buildUndeliveredAgentMessage(
  sessionId: string,
  notification: UndeliveredNotification,
): NormalizedMessage {
  return createNormalizedMessage({
    kind: 'task_notification',
    provider: PROVIDER,
    sessionId,
    timestamp: notification.enqueuedAt,
    status: 'undelivered',
    summary: undeliveredHeadline(notification),
    originKind: 'task-notification',
    agentId: notification.taskId,
    agentToolUseId: notification.toolUseId,
    agentReportedStatus: notification.status,
    agentResult: notification.result,
    agentResultTruncated: notification.resultTruncated,
    resumeHint: `SendMessage → ${notification.taskId}`,
  });
}

/**
 * Top-level entry consumed by `getSessionMessages`.
 *
 * Returns derived cards for every task-notification the harness enqueued and
 * never delivered in this session (possibly empty). A no-op when the flag is
 * OFF. Read-only, never throws — a failure here must never break a history load.
 *
 * @param sessionId App/session id stamped on the derived rows.
 * @param messages  The parent-transcript rows getSessionMessages already parsed.
 */
export function reconcileAgentMessages(
  sessionId: string,
  messages: AnyRecord[],
): NormalizedMessage[] {
  try {
    if (!agentReconcileEnabled()) {
      return [];
    }
    return findUndeliveredAgentNotifications(messages).map((notification) =>
      buildUndeliveredAgentMessage(sessionId, notification),
    );
  } catch (error) {
    console.debug(
      '[agent-reconcile] unexpected failure, skipping cards:',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}
