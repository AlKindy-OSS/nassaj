/**
 * T-873(2) — FORMAT-PINNING test for the undelivered-notification detector.
 *
 * THE FIXTURES ARE REAL. Every row below is a verbatim line from a parent
 * transcript on disk under
 * `~/.nassaj-users/1/.claude/projects/-home-dev-workspace-nassaj/`.
 * Nothing is trimmed, invented, or reshaped — these are the exact
 * `queue-operation` and delivered-notification rows the harness wrote.
 *
 * This is not optional rigour: the previous notification parser in this codebase
 * (B-94) shipped with a green suite built on invented fixtures and matched 6.5%
 * of real rows. The tag extractors this test pins were each measured against all
 * 574 real notifications in the project before being written:
 *   task-id 574/574 · summary 574/574 · status 573/574 · tool-use-id 527/574 ·
 *   result 436/574. The optional ones are optional in the type, not assumed.
 *
 * THE INCIDENT, ROW BY ROW (agent `ab0bf67f9ea3d0c25`, 2026-07-26):
 *   09:21:15.954  enqueue  <status>killed</status> + the full <result>  → NEVER DELIVERED
 *   09:26:36.474  enqueue  <status>stopped</status>, "No completion record…"
 *   09:26:36.505  user row origin.kind=task-notification (the stopped one)  → delivered
 * The killed notification carried the agent's entire report and the user never
 * saw it; five minutes later a far poorer stopped notice was the only thing that
 * arrived. Across the whole project: 62/62 `killed` notifications were lost.
 *
 * CROSS-LAYER CHECK: `COMPLETED_UNDELIVERED_ENQUEUE` below is the notification of
 * agent `af485a27dc52b445a` — the same agent used as the COMPLETED fixture in
 * `agent-transcript.reader.test.ts`. Its `<result>` and that transcript's final
 * assistant text are the same string, independently sourced. The two layers
 * recover the identical report from two different files.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyRecord } from '@/shared/types.js';
import {
  agentReconcileEnabled,
  buildUndeliveredAgentMessage,
  findUndeliveredAgentNotifications,
  parseTaskNotification,
  reconcileAgentMessages,
} from '@/modules/providers/list/claude/agent-reconcile.service.js';

const SESSION_ID = '42034af0-5a53-4b10-8ebf-82b028fc8933';

const row = (line: string): AnyRecord => JSON.parse(line) as AnyRecord;

/** VERBATIM — the killed notification that was never delivered (the incident). */
const KILLED_ENQUEUE = row(
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-26T09:21:15.954Z","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","content":"<task-notification>\\n<task-id>ab0bf67f9ea3d0c25</task-id>\\n<tool-use-id>toolu_01KG8iUEDabYSQdTQmJENNeJ</tool-use-id>\\n<output-file>/tmp/claude-1000/-home-dev-workspace-nassaj/42034af0-5a53-4b10-8ebf-82b028fc8933/tasks/ab0bf67f9ea3d0c25.output</output-file>\\n<status>killed</status>\\n<summary>Agent \\"إصلاح تشوّه bidi في عرض رسائل RTL\\" was stopped by user</summary>\\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\\n<result>Two files from another session appeared — staging mine by name only.</result>\\n</task-notification>"}',
);

/** VERBATIM — the poorer `stopped` notification enqueued 5 minutes later. */
const STOPPED_ENQUEUE = row(
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-26T09:26:36.474Z","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","content":"<task-notification>\\n<task-id>ab0bf67f9ea3d0c25</task-id>\\n<status>stopped</status>\\n<summary>No completion record was found for background agent \\"Agent \\"ab0bf67f9ea3d0c25\\" had no active task; resumed from transcript in the background with your message.\\" after it was re-dispatched via SendMessage in the previous session. It may have been stopped (via the UI, an SDK interrupt, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited.</summary>\\n</task-notification>"}',
);

/** VERBATIM — the ONLY notification of this agent that ever reached the chat. */
const DELIVERED_STOPPED = row(
  '{"parentUuid":"17674e0f-5c16-4f43-a83b-0d887b59a07f","isSidechain":false,"promptId":"5b58a9fc-1d79-46a1-976a-1559f05cf270","type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>ab0bf67f9ea3d0c25</task-id>\\n<status>stopped</status>\\n<summary>No completion record was found for background agent \\"Agent \\"ab0bf67f9ea3d0c25\\" had no active task; resumed from transcript in the background with your message.\\" after it was re-dispatched via SendMessage in the previous session. It may have been stopped (via the UI, an SDK interrupt, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited.</summary>\\n</task-notification>"},"uuid":"f1a5b231-aecc-4699-88eb-fa6accdb6e24","timestamp":"2026-07-26T09:26:36.505Z","permissionMode":"bypassPermissions","origin":{"kind":"task-notification"},"promptSource":"sdk","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}',
);

/**
 * VERBATIM — a `completed` notification that was also never delivered (82 of 339
 * were lost this way). Carries the trailing `<usage>` block after `</result>`,
 * which is exactly the shape the greedy result extractor had to survive.
 */
const COMPLETED_UNDELIVERED_ENQUEUE = row(
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-10T17:51:53.638Z","sessionId":"b89bac0e-1057-4207-84bf-e06587b9d823","content":"<task-notification>\\n<task-id>af485a27dc52b445a</task-id>\\n<tool-use-id>toolu_01QmESQChSWFCpUFzHY1dzuJ</tool-use-id>\\n<output-file>/tmp/claude-1000/-home-dev-workspace-nassaj/b89bac0e-1057-4207-84bf-e06587b9d823/tasks/af485a27dc52b445a.output</output-file>\\n<status>completed</status>\\n<summary>Agent \\"Anthropic ToS third-party client research\\" finished</summary>\\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\\n<result>*Please answer in the same language as the question.*</result>\\n<usage><subagent_tokens>29468</subagent_tokens><tool_uses>0</tool_uses><duration_ms>2063</duration_ms></usage>\\n</task-notification>"}',
);

/** VERBATIM — a `remove` row. Measured: `remove` is NOT delivery. */
const REMOVE_ROW = row(
  '{"type":"queue-operation","operation":"remove","timestamp":"2026-07-26T02:14:17.680Z","sessionId":"744baeb3-50fe-4410-85ce-d493af66ec55","content":"<task-notification>\\n<task-id>b4qftb123</task-id>\\n<tool-use-id>toolu_012xA4RKRRXNdB5ywnX2hyuj</tool-use-id>\\n<output-file>/tmp/claude-1000/-home-dev-workspace-nassaj/744baeb3-50fe-4410-85ce-d493af66ec55/tasks/b4qftb123.output</output-file>\\n<status>completed</status>\\n<summary>Background command \\"Final lint run\\" completed (exit code 0)</summary>\\n</task-notification>"}',
);

/** VERBATIM shape — a contentless `dequeue` row (922 of these exist). */
const DEQUEUE_ROW = row(
  '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-07-26T09:26:36.500Z","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","content":""}',
);

function withFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.AGENT_RECONCILE;
  if (value === undefined) {
    delete process.env.AGENT_RECONCILE;
  } else {
    process.env.AGENT_RECONCILE = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_RECONCILE;
    } else {
      process.env.AGENT_RECONCILE = previous;
    }
  }
}

// ---------------------------------------------------------------------------
// (أ) Tag extraction against the real shapes
// ---------------------------------------------------------------------------

test('parses the real killed notification, report included', () => {
  const parsed = parseTaskNotification(KILLED_ENQUEUE.content);
  assert.ok(parsed);
  assert.equal(parsed.taskId, 'ab0bf67f9ea3d0c25');
  assert.equal(parsed.status, 'killed');
  assert.equal(parsed.toolUseId, 'toolu_01KG8iUEDabYSQdTQmJENNeJ');
  assert.equal(parsed.summary, 'Agent "إصلاح تشوّه bidi في عرض رسائل RTL" was stopped by user');
  // The report the user never saw.
  assert.equal(
    parsed.result,
    'Two files from another session appeared — staging mine by name only.',
  );
  assert.equal(parsed.resultTruncated, false);
});

test('the greedy result extractor is not confused by the trailing <usage> block', () => {
  const parsed = parseTaskNotification(COMPLETED_UNDELIVERED_ENQUEUE.content);
  assert.ok(parsed);
  // Exactly the report — no `<usage>` bleed, no truncation.
  assert.equal(parsed.result, '*Please answer in the same language as the question.*');
  assert.ok(!parsed.result!.includes('usage'));
});

test('optional tags are optional: the real stopped shape has no tool-use-id and no result', () => {
  const parsed = parseTaskNotification(STOPPED_ENQUEUE.content);
  assert.ok(parsed);
  assert.equal(parsed.status, 'stopped');
  assert.equal(parsed.toolUseId, null);
  assert.equal(parsed.result, null);
  assert.ok(parsed.summary?.startsWith('No completion record was found'));
});

test('non-notification content is rejected rather than half-parsed', () => {
  assert.equal(parseTaskNotification(''), null);
  assert.equal(parseTaskNotification(null), null);
  assert.equal(parseTaskNotification(42), null);
  assert.equal(parseTaskNotification('<task-notification>\n<status>killed</status>\n'), null);
});

// ---------------------------------------------------------------------------
// (ب) The delivery gap — the incident, reproduced from its own rows
// ---------------------------------------------------------------------------

test('the incident: the killed notification is reported missing, the stopped one is not', () => {
  const undelivered = findUndeliveredAgentNotifications([
    KILLED_ENQUEUE,
    STOPPED_ENQUEUE,
    DEQUEUE_ROW,
    DELIVERED_STOPPED,
  ]);

  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].taskId, 'ab0bf67f9ea3d0c25');
  assert.equal(undelivered[0].status, 'killed');
  assert.equal(undelivered[0].enqueuedAt, '2026-07-26T09:21:15.954Z');
  assert.equal(
    undelivered[0].result,
    'Two files from another session appeared — staging mine by name only.',
  );
});

test('NEGATIVE CONTROL: a delivered notification produces nothing', () => {
  // The stopped notification alone — enqueued AND delivered. If this ever
  // returned a card, every healthy conversation would grow a bogus one.
  assert.deepEqual(findUndeliveredAgentNotifications([STOPPED_ENQUEUE, DELIVERED_STOPPED]), []);
  assert.deepEqual(findUndeliveredAgentNotifications([]), []);
  assert.deepEqual(findUndeliveredAgentNotifications([DEQUEUE_ROW]), []);
});

test('a `remove` row is not treated as delivery (measured: 51 removed, never delivered)', () => {
  const undelivered = findUndeliveredAgentNotifications([
    { ...REMOVE_ROW, operation: 'enqueue' },
    REMOVE_ROW,
  ]);
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].taskId, 'b4qftb123');
});

test('correlation is (task-id, status): one delivered status never masks another', () => {
  // The real pattern: the SAME agent completes, is resumed, then is killed. The
  // completed notification arrived; the killed one did not.
  const completedForIncidentAgent = {
    ...KILLED_ENQUEUE,
    timestamp: '2026-07-26T04:34:22.963Z',
    content: (KILLED_ENQUEUE.content as string).replace(
      '<status>killed</status>',
      '<status>completed</status>',
    ),
  };
  const deliveredCompleted = {
    ...DELIVERED_STOPPED,
    timestamp: '2026-07-26T04:34:23.000Z',
    message: { role: 'user', content: completedForIncidentAgent.content },
  };

  const undelivered = findUndeliveredAgentNotifications([
    completedForIncidentAgent,
    deliveredCompleted,
    KILLED_ENQUEUE,
  ]);
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].status, 'killed');
});

test('results are ordered by enqueue time and deduped on the latest enqueue', () => {
  const undelivered = findUndeliveredAgentNotifications([
    COMPLETED_UNDELIVERED_ENQUEUE, // 2026-07-10
    KILLED_ENQUEUE, // 2026-07-26
    { ...KILLED_ENQUEUE, timestamp: '2026-07-26T09:22:00.000Z' }, // same (id,status)
  ]);
  assert.equal(undelivered.length, 2);
  assert.equal(undelivered[0].taskId, 'af485a27dc52b445a');
  assert.equal(undelivered[1].taskId, 'ab0bf67f9ea3d0c25');
  assert.equal(undelivered[1].enqueuedAt, '2026-07-26T09:22:00.000Z');
});

// ---------------------------------------------------------------------------
// (ج) The derived card contract — and what it must never claim
// ---------------------------------------------------------------------------

test("the card never claims completion and never carries a wfId", () => {
  const [notification] = findUndeliveredAgentNotifications([KILLED_ENQUEUE]);
  const card = buildUndeliveredAgentMessage(SESSION_ID, notification) as Record<string, unknown>;

  assert.equal(card.kind, 'task_notification');
  assert.equal(card.provider, 'claude');
  assert.equal(card.sessionId, SESSION_ID);
  // Lands at the moment the harness knew the truth, not at read time.
  assert.equal(card.timestamp, '2026-07-26T09:21:15.954Z');
  // NOT 'completed' — the renderer greens only exactly 'completed', so this card
  // can never be mistaken for a success. NOT 'stopped' either, so the client's
  // wfId-keyed reconcile-replacement pass leaves it alone.
  assert.equal(card.status, 'undelivered');
  assert.notEqual(card.status, 'completed');
  assert.equal(card.wfId, undefined);
  // Never attributed to the human.
  assert.equal(card.originKind, 'task-notification');
  // The harness-recorded status is preserved separately, never inferred.
  assert.equal(card.agentReportedStatus, 'killed');
  assert.equal(card.agentId, 'ab0bf67f9ea3d0c25');
  assert.equal(card.agentToolUseId, 'toolu_01KG8iUEDabYSQdTQmJENNeJ');
  assert.equal(
    card.agentResult,
    'Two files from another session appeared — staging mine by name only.',
  );
  // Manual only: a hint string, not an action.
  assert.equal(card.resumeHint, 'SendMessage → ab0bf67f9ea3d0c25');
  assert.match(String(card.summary), /^لم تُسلَّم نتيجة وكيل أُوقِف/);
});

test('the completed-but-undelivered card is worded as undelivered, not as success', () => {
  const [notification] = findUndeliveredAgentNotifications([COMPLETED_UNDELIVERED_ENQUEUE]);
  const card = buildUndeliveredAgentMessage(SESSION_ID, notification) as Record<string, unknown>;
  assert.equal(card.status, 'undelivered');
  assert.equal(card.agentReportedStatus, 'completed');
  assert.match(String(card.summary), /^لم تُسلَّم نتيجة وكيل أنهى عمله/);
});

// ---------------------------------------------------------------------------
// (د) Flag gate + fail-safe
// ---------------------------------------------------------------------------

test('the flag is OFF by default and the service is then a total no-op', () => {
  withFlag(undefined, () => {
    assert.equal(agentReconcileEnabled(), false);
    assert.deepEqual(reconcileAgentMessages(SESSION_ID, [KILLED_ENQUEUE]), []);
  });
  for (const off of ['', '0', 'false', 'off', 'no', 'maybe']) {
    withFlag(off, () => assert.equal(agentReconcileEnabled(), false));
  }
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
    withFlag(on, () => assert.equal(agentReconcileEnabled(), true));
  }
});

test('with the flag ON the incident yields exactly one card', () => {
  withFlag('1', () => {
    const cards = reconcileAgentMessages(SESSION_ID, [
      KILLED_ENQUEUE,
      STOPPED_ENQUEUE,
      DELIVERED_STOPPED,
    ]);
    assert.equal(cards.length, 1);
    assert.equal((cards[0] as unknown as Record<string, unknown>).agentId, 'ab0bf67f9ea3d0c25');
  });
});

test('malformed rows are skipped, never fatal', () => {
  withFlag('1', () => {
    const cards = reconcileAgentMessages(SESSION_ID, [
      null as unknown as AnyRecord,
      {} as AnyRecord,
      { type: 'queue-operation', operation: 'enqueue' } as AnyRecord,
      // Enqueue with no usable timestamp: dropped, because the card could not be
      // placed in order.
      { ...KILLED_ENQUEUE, timestamp: 'not-a-date' },
      { type: 'assistant', message: { role: 'assistant', content: [] } } as AnyRecord,
      KILLED_ENQUEUE,
    ]);
    assert.equal(cards.length, 1);
  });
});
