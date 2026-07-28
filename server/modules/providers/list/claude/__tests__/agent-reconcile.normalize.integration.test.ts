/**
 * T-873(2) — THE DELIVERY TEST: does the derived card actually reach a client?
 *
 * WHY THIS FILE EXISTS (the qa-critic veto)
 * -----------------------------------------
 * `agent-reconcile.service.test.ts` proves the card is BUILT correctly and stops
 * at `buildUndeliveredAgentMessage`. That is one hop short of the truth. The card
 * is appended to the raw history stream inside `getSessionMessages`, and every
 * row of that stream is then re-run through `normalizeMessage`, which returns
 * `[]` for anything it does not recognise. A derived card carries no `type` and
 * no `message`, so it falls through EVERY branch and is silently dropped unless
 * `normalizeMessage`'s pass-through guard names its `kind` explicitly. It did not
 * (only `task_reconcile`/`workflow_reconciled` were listed), so the whole feature
 * was dead code behind a green suite that never crossed that boundary.
 *
 * So this file deliberately enters at the REAL entry point — the provider's
 * `fetchHistory`, the same call the REST history route makes — writes a real
 * transcript to disk, and asserts on the FINAL normalized payload. It fails on
 * e82e3847 and passes after the guard fix; nothing in between is stubbed.
 *
 * THE FIXTURES ARE REAL. Both transcript rows below are verbatim lines from
 * `~/.nassaj-users/1/.claude/projects/-home-dev-workspace-nassaj/
 * 42034af0-5a53-4b10-8ebf-82b028fc8933.jsonl` — the incident session itself. The
 * enqueue row is the `killed` notification whose `<result>` the user never saw.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { buildUndeliveredAgentMessage } from '@/modules/providers/list/claude/agent-reconcile.service.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = '42034af0-5a53-4b10-8ebf-82b028fc8933';

/** VERBATIM — the enqueued `killed` notification that never reached the chat. */
const KILLED_ENQUEUE_LINE =
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-26T09:21:15.954Z","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","content":"<task-notification>\\n<task-id>ab0bf67f9ea3d0c25</task-id>\\n<tool-use-id>toolu_01KG8iUEDabYSQdTQmJENNeJ</tool-use-id>\\n<status>killed</status>\\n<summary>Agent \\"إصلاح تشوّه bidi في عرض رسائل RTL\\" was stopped by user</summary>\\n<result>Two files from another session appeared — staging mine by name only.</result>\\n</task-notification>"}';

/** VERBATIM — a normal assistant row from the same transcript (the live control). */
const ASSISTANT_LINE =
  '{"parentUuid":"f1f1c0c0-4dd8-406c-b471-6a080db78fc8","isSidechain":false,"message":{"model":"claude-opus-5","id":"msg_011CdQ1fSSmtVxAfd9YanUFv","type":"message","role":"assistant","content":[{"type":"text","text":"I\'ll look at the image first."}],"stop_reason":"tool_use","stop_sequence":null},"type":"assistant","uuid":"94a05a56-38a2-4035-ac8b-2f7af7d28cfb","timestamp":"2026-07-26T04:08:53.932Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

type Card = Record<string, unknown>;

/**
 * An isolated migrated DB whose session row points at a real transcript file, so
 * `getSessionMessages` resolves and streams it exactly as it does in production.
 */
async function withSessionOnDisk(
  lines: string[],
  run: (provider: ClaudeSessionsProvider) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousFlag = process.env.AGENT_RECONCILE;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-normalize-'));
  const projectDir = path.join(tempRoot, 'project-encoded');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'db.sqlite');
  await initializeDatabase();

  try {
    const jsonlPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    await writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');
    sessionsDb.createSession(
      SESSION_ID,
      'claude',
      projectDir,
      undefined,
      undefined,
      undefined,
      jsonlPath,
    );

    await run(new ClaudeSessionsProvider());
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousFlag === undefined) {
      delete process.env.AGENT_RECONCILE;
    } else {
      process.env.AGENT_RECONCILE = previousFlag;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const cards = (messages: unknown[]): Card[] =>
  (messages as Card[]).filter((message) => message.kind === 'task_notification');

// ---------------------------------------------------------------------------
// The veto, reproduced end to end
// ---------------------------------------------------------------------------

test('THE VETO: the derived card survives fetchHistory and reaches the client payload', async () => {
  await withSessionOnDisk([ASSISTANT_LINE, KILLED_ENQUEUE_LINE], async (provider) => {
    process.env.AGENT_RECONCILE = '1';

    const result = await provider.fetchHistory(SESSION_ID);
    const produced = cards(result.messages);

    // On e82e3847 this is 0: normalizeMessage's pass-through guard listed only
    // task_reconcile/workflow_reconciled, so the card was dropped here.
    assert.equal(produced.length, 1, 'the undelivered-agent card must reach the normalized payload');

    const card = produced[0];
    assert.equal(card.status, 'undelivered', 'never "completed" — no false success');
    assert.equal(card.agentReportedStatus, 'killed');
    assert.equal(card.agentId, 'ab0bf67f9ea3d0c25');
    assert.equal(card.agentToolUseId, 'toolu_01KG8iUEDabYSQdTQmJENNeJ');
    assert.equal(card.sessionId, SESSION_ID);
    assert.equal(card.originKind, 'task-notification', 'never attributed to the human');
    assert.equal(card.wfId, undefined, 'the Agent path never emits a wfId');
    // The report the user never saw, recovered verbatim through the full path.
    assert.equal(
      card.agentResult,
      'Two files from another session appeared — staging mine by name only.',
    );
    // Placed at the moment the harness knew, not at read time.
    assert.equal(card.timestamp, '2026-07-26T09:21:15.954Z');
  });
});

test('the pipeline is live: the real assistant row normalizes in the same payload', async () => {
  await withSessionOnDisk([ASSISTANT_LINE, KILLED_ENQUEUE_LINE], async (provider) => {
    process.env.AGENT_RECONCILE = '1';

    const result = await provider.fetchHistory(SESSION_ID);
    const texts = (result.messages as Card[]).filter((message) => message.kind === 'text');

    // Without this, a green card assertion could come from an inert harness.
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, "I'll look at the image first.");
    assert.equal(texts[0].role, 'assistant');
    assert.ok(result.total >= 2);
  });
});

test('NEGATIVE CONTROL: with the flag OFF the payload is byte-for-byte the old one', async () => {
  await withSessionOnDisk([ASSISTANT_LINE, KILLED_ENQUEUE_LINE], async (provider) => {
    delete process.env.AGENT_RECONCILE;

    const result = await provider.fetchHistory(SESSION_ID);
    assert.deepEqual(cards(result.messages), [], 'flag OFF ⇒ no derived card at all');
    // The queue-operation row itself is still invisible, as it always was.
    assert.equal(result.messages.length, 1, 'only the assistant row survives normalization');
  });
});

// ---------------------------------------------------------------------------
// The guard itself, at unit granularity
// ---------------------------------------------------------------------------

test('normalizeMessage passes an already-normalized task_notification card through untouched', () => {
  const card = buildUndeliveredAgentMessage(SESSION_ID, {
    taskId: 'ab0bf67f9ea3d0c25',
    status: 'killed',
    summary: 'Agent was stopped by user',
    toolUseId: 'toolu_01KG8iUEDabYSQdTQmJENNeJ',
    result: 'the report',
    resultTruncated: false,
    enqueuedAt: '2026-07-26T09:21:15.954Z',
  });

  const out = new ClaudeSessionsProvider().normalizeMessage(card, SESSION_ID);

  // The exact assertion the 24/24 suite never made: the card has no `type` and
  // no `message`, so without the guard entry it falls through every branch.
  assert.equal(out.length, 1, 'a derived card must not be dropped as an unrecognized row');
  assert.equal(out[0], card, 'passed through by identity, not re-derived');
});
