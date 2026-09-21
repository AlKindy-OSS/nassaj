/**
 * B-94 / C1–C5 regression tests — task notification parsing + reconcile pass in
 * normalizedToChatMessages.
 *
 * A production-shaped stopped notification can render as raw XML when its
 * completed counterpart does not match the parser. A weak fixture used a
 * single inner block and a clean closing anchor, so it missed this shape:
 * `<task-id>wf_…</task-id>` with a single inner block and a clean closing anchor.
 * SDK notifications may contain multiple inner and trailing blocks.
 *
 * These fixtures are now production-shaped synthetic transcript rows:
 *   - STOPPED_FIXTURE: a representative stopped notification. Its <task-id> is
 *     the per-task SDK id `synthetic-task` — NOT a workflow id; the synthetic
 *     workflow id `wf_7f3a9c12-demo` only appears inside the
 *     <summary> as `resumeFromRunId: "wf_…"` (this is what C2 extracts).
 *   - COMPLETED_FIXTURE: a production-shaped synthetic completed notification. It carries
 *     BOTH <tool-use-id> and <output-file>, and after </summary> it carries a
 *     <result>…</result> block (markdown body, code spans) and a <usage>…</usage>
 *     block. The OLD regex required exactly one optional inner block AND a
 *     trailing </task-notification> anchor, so the second inner block plus the
 *     trailing result/usage blocks made it fail every completed notification.
 *
 * What the C1 regex changed:
 *   - allow any number of inner <tag>…</tag> blocks between <task-id> and
 *     <status> (lazily, so a bare notification still matches);
 *   - drop the trailing </task-notification> anchor so <result>/<usage> never
 *     have to parse.
 * Capture groups: [1]=task-id, [2]=status, [3]=summary.
 *
 * Run inside vitest (npm run test:client) — picked up by vite.config.js
 * test.include (src/**\/*.test.{ts,tsx}). Not node:test, because
 * normalizedToChatMessages has transitive React imports needing jsdom+vitest.
 */

import { describe, it, expect } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

import { normalizedToChatMessages } from './useChatMessages.js';

// ── The exact regex from useChatMessages.ts (must stay in sync) ────────────
// Copied here so a regex regression is immediate and readable. If you change the
// regex in useChatMessages.ts (C1), update this copy or these tests will tell you.
const TASK_NOTIF_REGEX =
  /<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*(?:<[a-z-]+>[^<]*<\/[a-z-]+>\s*)*?<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>/;

function matchOnce(content: string) {
  return new RegExp(TASK_NOTIF_REGEX.source, TASK_NOTIF_REGEX.flags).exec(content);
}

// ── Production-shaped synthetic fixtures ────────────────────────────────────

/**
 * Production-shaped synthetic "stopped" notification.
 * task-id = `synthetic-task` (per-task id, not a workflow id); the workflow id is
 * inside the summary as resumeFromRunId: "wf_7f3a9c12-demo".
 */
const STOPPED_FIXTURE = `<task-notification>
<task-id>synthetic-task</task-id>
<tool-use-id>toolu_synthetic_stopped</tool-use-id>
<status>stopped</status>
<summary>No completion record was found for background workflow "synthetic-review" from the previous session. It may have been stopped (via the UI or TaskStop — these leave no transcript marker), or it may have been running when the previous process exited. To pick up where it left off, relaunch with Workflow({scriptPath, resumeFromRunId: "wf_7f3a9c12-demo"}) — completed agent() calls return cached.</summary>
</task-notification>`;

/**
 * Production-shaped synthetic "completed" notification.
 * Carries BOTH <tool-use-id> and <output-file>, then a <result> markdown block
 * (with code spans) and a <usage> block after </summary>. This is the exact
 * shape that the pre-C1 anchored regex failed on. task-id `synthetic-completed-task`
 * is an agent() task id with no wf_ token anywhere → wfId must be undefined.
 */
const COMPLETED_FIXTURE = `<task-notification>
<task-id>synthetic-completed-task</task-id>
<tool-use-id>toolu_synthetic_completed</tool-use-id>
<output-file>/workspace/fixtures/tasks/synthetic-completed-task.output</output-file>
<status>completed</status>
<summary>Agent "synthetic review" completed</summary>
<result>Shape-only result with a \`code span\` and a second line.</result>
<usage><total_tokens>120</total_tokens><tool_uses>2</tool_uses><duration_ms>450</duration_ms></usage>
</task-notification>`;

/** Forward-compat: a bare notification with no inner block at all. */
const BARE_NO_INNER_BLOCK = `<task-notification>
<task-id>wf_bare999</task-id>
<status>completed</status>
<summary>Done</summary>
</task-notification>`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTextMsg(content: string, id = 'msg-test-01', tsMs = 1_782_000_000_000): NormalizedMessage {
  return {
    id,
    sessionId: 'sess-test',
    timestamp: new Date(tsMs).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  } as NormalizedMessage;
}

function makeReconcileMsg(
  wfId: string,
  opts: { id?: string; tsMs?: number; agentsDone?: number; agentsTotal?: number; taskStatus?: string; summary?: string } = {},
): NormalizedMessage {
  return {
    id: opts.id ?? `msg-rec-${wfId}`,
    sessionId: 'sess-test',
    timestamp: new Date(opts.tsMs ?? 1_782_000_010_000).toISOString(),
    provider: 'claude',
    kind: 'task_reconcile',
    wfId,
    agentsDone: opts.agentsDone,
    agentsTotal: opts.agentsTotal,
    taskStatus: opts.taskStatus,
    summary: opts.summary ?? 'اكتمل في الخلفية',
  } as unknown as NormalizedMessage;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. REGEX UNIT TESTS — pure pattern matching against representative notifications
// ══════════════════════════════════════════════════════════════════════════════

describe('taskNotifRegex — C1 on a production-shaped stopped notification', () => {
  it('matches the synthetic stopped notification (two inner-ish blocks not required, no anchor)', () => {
    const m = matchOnce(STOPPED_FIXTURE);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('synthetic-task');   // task-id = per-task id, NOT a wf id
    expect(m![2].trim()).toBe('stopped');      // status
    expect(m![3].trim()).toMatch(/^No completion record was found/); // summary
  });
});
describe('taskNotifRegex — C1 on a production-shaped completed notification', () => {
  it('matches the synthetic completed notification (tool-use-id + output-file + trailing <result>/<usage>)', () => {
    // This is the case the pre-C1 anchored regex FAILED: two inner blocks plus a
    // <result>/<usage> tail after </summary>.
    const m = matchOnce(COMPLETED_FIXTURE);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('synthetic-completed-task');
    expect(m![2].trim()).toBe('completed');
    expect(m![3].trim()).toBe('Agent "synthetic review" completed');
  });

  it('regression guard: the OLD anchored regex would NOT have matched the synthetic completed notification', () => {
    // Documents exactly why C1 was needed. If someone reverts C1 to the anchored
    // form, this asserts the representative failure mode.
    const OLD_ANCHORED =
      /<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*(?:<output-file>[^<]*<\/output-file>|<tool-use-id>[^<]*<\/tool-use-id>)?\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/;
    expect(OLD_ANCHORED.exec(COMPLETED_FIXTURE)).toBeNull();
  });
});

describe('taskNotifRegex — bare (no inner block, forward-compat)', () => {
  it('matches a notification with no <output-file> nor <tool-use-id> block', () => {
    const m = matchOnce(BARE_NO_INNER_BLOCK);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('wf_bare999');
    expect(m![2].trim()).toBe('completed');
    expect(m![3].trim()).toBe('Done');
  });
});

describe('taskNotifRegex — negative cases (must NOT match)', () => {
  it('does not match a plain assistant text message', () => {
    expect(matchOnce('Hello from the assistant')).toBeNull();
  });

  it('does not match a notification missing <task-id>', () => {
    const bad = `<task-notification>
<status>stopped</status>
<summary>No task-id here</summary>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match a notification missing <status>', () => {
    const bad = `<task-notification>
<task-id>wf_nostatus</task-id>
<summary>Missing status</summary>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match a notification missing <summary>', () => {
    const bad = `<task-notification>
<task-id>wf_nosummary</task-id>
<status>stopped</status>
</task-notification>`;
    expect(matchOnce(bad)).toBeNull();
  });

  it('does not match raw XML injection in task-id (tag within task-id)', () => {
    // The [^<]* quantifier in the task-id capture group prevents tag injection.
    const injection =
      '<task-notification><task-id><evil></task-id><status>stopped</status><summary>x</summary></task-notification>';
    expect(matchOnce(injection)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. INTEGRATION — normalizedToChatMessages end-to-end on representative notifications
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizedToChatMessages — synthetic stopped notification (C1/C2)', () => {
  it('converts the synthetic stopped notification to an isTaskNotification card', () => {
    const converted = normalizedToChatMessages([makeTextMsg(STOPPED_FIXTURE)]);
    expect(converted).toHaveLength(1);
    const card = converted[0];
    expect((card as any).isTaskNotification).toBe(true);
    expect((card as any).taskStatus).toBe('stopped');
  });

  // (b) wfId comes from the SUMMARY (resumeFromRunId), NOT from the task-id.
  it('extracts wfId from the summary (resumeFromRunId), not from the task-id', () => {
    const converted = normalizedToChatMessages([makeTextMsg(STOPPED_FIXTURE)]);
    // task-id is synthetic-task; the synthetic workflow id is in the summary.
    expect((converted[0] as any).wfId).toBe('wf_7f3a9c12-demo');
    expect((converted[0] as any).wfId).not.toBe('synthetic-task');
  });

  it('uses the <summary> text as the card content', () => {
    const converted = normalizedToChatMessages([makeTextMsg(STOPPED_FIXTURE)]);
    expect(converted[0].content).toMatch(/^No completion record was found/);
  });
});

describe('normalizedToChatMessages — synthetic completed notification (C1)', () => {
  it('parses the synthetic completed notification (with <result>/<usage>) as a task notification', () => {
    const converted = normalizedToChatMessages([makeTextMsg(COMPLETED_FIXTURE)]);
    expect(converted).toHaveLength(1);
    expect((converted[0] as any).isTaskNotification).toBe(true);
    expect((converted[0] as any).taskStatus).toBe('completed');
  });

  it('does not set wfId when neither the task-id nor the summary carries a wf_ token', () => {
    const converted = normalizedToChatMessages([makeTextMsg(COMPLETED_FIXTURE)]);
    expect((converted[0] as any).wfId).toBeUndefined();
  });

  it('uses the summary (not the trailing result body) as the card content', () => {
    const converted = normalizedToChatMessages([makeTextMsg(COMPLETED_FIXTURE)]);
    expect(converted[0].content).toBe('Agent "synthetic review" completed');
  });
});

describe('normalizedToChatMessages — non-notification passthrough', () => {
  it('renders a non-notification user message as type:user (not a card)', () => {
    const converted = normalizedToChatMessages([makeTextMsg('Hello, run this task for me')]);
    expect(converted).toHaveLength(1);
    expect(converted[0].type).toBe('user');
    expect((converted[0] as any).isTaskNotification).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. RECONCILE PASS (C3) — end-to-end on production-shaped synthetic fixtures + interleaved workflows
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizedToChatMessages — reconcile pass (C3)', () => {
  // (c) END-TO-END: representative stopped row (wfId derived from its summary) + a
  // task_reconcile row for the SAME wfId → the pass replaces the stopped card
  // with a single reconcile card.
  it('replaces the representative stopped card with the reconcile card when wfId (from summary) matches', () => {
    const stopped = makeTextMsg(STOPPED_FIXTURE);
    const reconcile = makeReconcileMsg('wf_7f3a9c12-demo', { agentsDone: 5, agentsTotal: 7, tsMs: 1_782_000_010_000 });

    const converted = normalizedToChatMessages([stopped, reconcile]);

    expect(converted).toHaveLength(1);
    const card = converted[0];
    expect((card as any).isReconcile).toBe(true);
    expect((card as any).isTaskNotification).toBe(true);
    expect((card as any).wfId).toBe('wf_7f3a9c12-demo');
    // C5: counts present → completed copy with (done/total).
    expect((card as any).taskStatus).toBe('completed');
    expect(card.content).toBe('اكتمل في الخلفية (5/7)');
  });

  it('keeps the reconcile card appended when there is no matching stopped card', () => {
    const userMsg = makeTextMsg('Run the workflow', 'msg-user-01');
    const reconcile = makeReconcileMsg('wf_nomatch', { agentsDone: 3, agentsTotal: 3 });

    const converted = normalizedToChatMessages([userMsg, reconcile]);
    expect(converted).toHaveLength(2);
    expect(converted[0].type).toBe('user');
    expect((converted[1] as any).isReconcile).toBe(true);
  });

  // (d) Two DIFFERENT workflows interleaved → correct order, nothing lost.
  // This is the architect-verified case the old stale-index splice corrupted:
  // [stoppedA, stoppedB, reconcileB, reconcileA] must yield [recA-at-A, recB-at-B].
  it('handles two interleaved workflows without losing or reordering cards', () => {
    // Two production-shaped synthetic stopped notifications, built by swapping the workflow
    // id inside the summary so wfId extraction (C2) drives the matching.
    const stoppedA = makeTextMsg(
      STOPPED_FIXTURE.replace('wf_7f3a9c12-demo', 'wf_aaaa1111-aaa'),
      'msg-stopA',
      1_782_000_000_000,
    );
    const stoppedB = makeTextMsg(
      STOPPED_FIXTURE.replace('wf_7f3a9c12-demo', 'wf_bbbb2222-bbb'),
      'msg-stopB',
      1_782_000_001_000,
    );
    const reconcileB = makeReconcileMsg('wf_bbbb2222-bbb', { id: 'rec-B', agentsDone: 2, agentsTotal: 2, tsMs: 1_782_000_002_000 });
    const reconcileA = makeReconcileMsg('wf_aaaa1111-aaa', { id: 'rec-A', agentsDone: 4, agentsTotal: 4, tsMs: 1_782_000_003_000 });

    // Order as the merged store would deliver them (chronological): A, B, recB, recA.
    const converted = normalizedToChatMessages([stoppedA, stoppedB, reconcileB, reconcileA]);

    // Exactly two cards: each stopped replaced by its reconcile, in stopped order.
    expect(converted).toHaveLength(2);
    expect((converted[0] as any).isReconcile).toBe(true);
    expect((converted[0] as any).wfId).toBe('wf_aaaa1111-aaa'); // A first (its stopped came first)
    expect(converted[0].content).toBe('اكتمل في الخلفية (4/4)');
    expect((converted[1] as any).isReconcile).toBe(true);
    expect((converted[1] as any).wfId).toBe('wf_bbbb2222-bbb'); // B second
    expect(converted[1].content).toBe('اكتمل في الخلفية (2/2)');
  });

  it('collapses two reconcile cards for the same wfId into one (last wins)', () => {
    const stopped = makeTextMsg(STOPPED_FIXTURE);
    const recOld = makeReconcileMsg('wf_7f3a9c12-demo', { id: 'rec-old', agentsDone: 1, agentsTotal: 7, tsMs: 1_782_000_005_000 });
    const recNew = makeReconcileMsg('wf_7f3a9c12-demo', { id: 'rec-new', agentsDone: 7, agentsTotal: 7, tsMs: 1_782_000_010_000 });

    const converted = normalizedToChatMessages([stopped, recOld, recNew]);
    expect(converted).toHaveLength(1);
    // The LAST reconcile (recNew, 7/7) survives at the stopped slot.
    expect(converted[0].content).toBe('اكتمل في الخلفية (7/7)');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. SETTLED COPY (C5) — distinct headline for a partially-settled workflow
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizedToChatMessages — settled vs completed copy (C5)', () => {
  it("renders the 'settled' copy (some agents did not finish) when taskStatus==='settled'", () => {
    const stopped = makeTextMsg(STOPPED_FIXTURE);
    const reconcile = makeReconcileMsg('wf_7f3a9c12-demo', { agentsDone: 4, agentsTotal: 7, taskStatus: 'settled' });

    const converted = normalizedToChatMessages([stopped, reconcile]);
    expect(converted).toHaveLength(1);
    expect((converted[0] as any).taskStatus).toBe('settled');
    expect(converted[0].content).toBe('هدأ في الخلفية (4/7 — بعض الوكلاء لم يُكملوا)');
  });

  it("renders the 'completed' copy when taskStatus is absent (legacy reconcile row)", () => {
    const stopped = makeTextMsg(STOPPED_FIXTURE);
    const reconcile = makeReconcileMsg('wf_7f3a9c12-demo', { agentsDone: 7, agentsTotal: 7 });

    const converted = normalizedToChatMessages([stopped, reconcile]);
    expect((converted[0] as any).taskStatus).toBe('completed');
    expect(converted[0].content).toBe('اكتمل في الخلفية (7/7)');
  });
});
