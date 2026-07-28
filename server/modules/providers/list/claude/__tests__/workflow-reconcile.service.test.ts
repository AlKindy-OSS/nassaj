/**
 * ADR-048 / C5 — Workflow Completion Reconcile (incident 2026-06-27, wf_ef5ba242-b4b).
 *
 * This is the FORMAT-PINNING test (ADR-048 risk mitigation #1): the reconcile
 * couples to the on-disk `journal.jsonl` shape the Claude Code SDK writes
 * (`{type:'started'|'result', key, agentId, result?}`), which an upstream upgrade
 * may change. If an upgrade renames `type`/`key` or changes the settlement
 * semantics, these assertions fail FIRST in CI — before the flag is ever turned
 * on — instead of silently mis-reporting completion.
 *
 * THE FIXTURES ARE REAL (root-cause of the prior leak). The two arrays below are
 * the verbatim `started`/`result` rows (real `key`/`agentId` content hashes) from
 * the two journals on disk:
 *   - INCIDENT_JOURNAL_LINES   ← wf_ef5ba242-b4b: 17 started lines / 16 unique
 *     started keys, 15 result lines / 15 unique result keys → ONE orphan key
 *     (the last `started` row, never matched) → status 'settled', 15/16.
 *   - COMPLETED_JOURNAL_LINES  ← wf_1ea9f41d-bdf: 11 started lines / 7 unique
 *     started keys (4 retries/escalations), 10 result lines / 7 unique result
 *     keys, all matched → status 'completed', 7/7. (Naturally exercises the
 *     de-dup/retry semantics.)
 * Real `result.result` payloads carry {sectionId,title,content} for the first
 * five and `{}` for the rest — both kept faithfully (content trimmed to a marker
 * for size; only `type`/`key`/`result`-presence are load-bearing). No `path`
 * field anywhere, exactly as on disk.
 *
 * It also locks the design's other guarantees:
 *  - C5 settlement: 'completed' (started⊆result) vs 'settled' (output landed,
 *    some started key unmatched) vs null (no result row).
 *  - fail-safe: missing folder / malformed lines / results-only => NO throw.
 *  - freshness gates: a journal not newer than the stopped row, or one still
 *    being written (quiet window), yields no correction.
 *  - flag OFF (default) is a byte-for-byte no-op.
 *  - authority boundary (T-825): a DurableTask-shaped completion (result.json +
 *    DONE, no journal.jsonl) is NEVER claimed here — that is the permanent
 *    monitor's authority (workflow-supervisor/monitor.ts), not reconcile's.
 *  - the derived row's contract: kind:'task_reconcile', isTaskNotification:true,
 *    taskStatus:status, content per status, wfId, agentsDone/agentsTotal,
 *    originKind:'task-notification', timestamp = journal mtime, NO `path` field.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReconcileMessage,
  findLatestStoppedNotificationMs,
  findReconciledWorkflows,
  reconcileWorkflowMessages,
  workflowReconcileEnabled,
} from '@/modules/providers/list/claude/workflow-reconcile.service.js';

const INCIDENT_WF_ID = 'wf_ef5ba242-b4b';
const COMPLETED_WF_ID = 'wf_1ea9f41d-bdf';

/**
 * VERBATIM rows from the incident journal on disk
 * (.../230ab538-.../subagents/workflows/wf_ef5ba242-b4b/journal.jsonl).
 * 17 started lines (16 unique keys), 15 result lines (15 unique keys). The very
 * LAST line is the orphan: a `started` key with NO matching `result` — the
 * subagent that stayed hanging at restart. => 'settled', agentsDone 15 < total 16.
 */
const INCIDENT_JOURNAL_LINES: Array<Record<string, unknown>> = [
  { type: 'started', key: 'v2:ab094763ae9d7c4b3b18de57a59a69189d46f50fe7b2fb74b2460e260eeb76f3', agentId: 'a76093b3fc609de4b' },
  { type: 'started', key: 'v2:042a6955ffea14741930b22a7034dfc4d578babc902742d1ac2481b643f86212', agentId: 'ae3f5b6b6e9b6c0c4' },
  { type: 'started', key: 'v2:2b83f4f885f4c7e336932332683c022cd37a8acd54bb693ff8aea68a9d83e279', agentId: 'ac197138d808a8e81' },
  { type: 'started', key: 'v2:1b72a364893ab19cd761c7e6e553364ca5328bc8bc1ebdb314013528b882cf6e', agentId: 'a7306e087e94d697b' },
  { type: 'started', key: 'v2:1c98a46b048503799883571797aeb838b9f189b6bca8d67ed11f3c5de85d7328', agentId: 'a5df3e69c2e51ce28' },
  {
    type: 'result',
    key: 'v2:042a6955ffea14741930b22a7034dfc4d578babc902742d1ac2481b643f86212',
    agentId: 'ae3f5b6b6e9b6c0c4',
    result: { sectionId: 'S3', title: 'S3 — ربط وتفعيل مكوّنات كل مزوّد', content: '## S3 …' },
  },
  {
    type: 'result',
    key: 'v2:1b72a364893ab19cd761c7e6e553364ca5328bc8bc1ebdb314013528b882cf6e',
    agentId: 'a7306e087e94d697b',
    result: { sectionId: 'S4', title: 'S4 — سيناريوهات التشغيل والحالات الحدّية', content: '## S4 …' },
  },
  {
    type: 'result',
    key: 'v2:ab094763ae9d7c4b3b18de57a59a69189d46f50fe7b2fb74b2460e260eeb76f3',
    agentId: 'a76093b3fc609de4b',
    result: { sectionId: 'S1', title: 'جرد المكوّنات وتصميم الواصِف', content: '## S1 …' },
  },
  {
    type: 'result',
    key: 'v2:2b83f4f885f4c7e336932332683c022cd37a8acd54bb693ff8aea68a9d83e279',
    agentId: 'ac197138d808a8e81',
    result: { sectionId: 'S2', title: 'S2 — آلية التبديل ودورة الحياة', content: '## S2 …' },
  },
  {
    type: 'result',
    key: 'v2:1c98a46b048503799883571797aeb838b9f189b6bca8d67ed11f3c5de85d7328',
    agentId: 'a5df3e69c2e51ce28',
    result: { sectionId: 'S5', title: 'المعمارية الكلية والترحيل والاختبار والمخاطر', content: '## S5 …' },
  },
  { type: 'started', key: 'v2:876532f4dca6561c46045617c9214072d894175a0be3421f0958853270480a12', agentId: 'a510fb3fae50115be' },
  { type: 'started', key: 'v2:1f0c926644374bbb36cae28ed267800c5134fb7c1e76263abbcf1774ba17f31b', agentId: 'afa5e98333c8da3aa' },
  { type: 'started', key: 'v2:925fbdd29a30909cd6bdab3a7a025d1f939ac67b9730772f092a69188747f1aa', agentId: 'a215f19c870d26864' },
  { type: 'result', key: 'v2:925fbdd29a30909cd6bdab3a7a025d1f939ac67b9730772f092a69188747f1aa', agentId: 'a215f19c870d26864', result: {} },
  { type: 'result', key: 'v2:876532f4dca6561c46045617c9214072d894175a0be3421f0958853270480a12', agentId: 'a510fb3fae50115be', result: {} },
  { type: 'result', key: 'v2:1f0c926644374bbb36cae28ed267800c5134fb7c1e76263abbcf1774ba17f31b', agentId: 'afa5e98333c8da3aa', result: {} },
  { type: 'started', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a0d64a57b00abd9dc' },
  { type: 'started', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a7c59c75f7fb21d40' },
  { type: 'result', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a7c59c75f7fb21d40', result: {} },
  { type: 'started', key: 'v2:a78105d2406d19203cfc6650f4dbff20b2a257b70ecfba00bbfcede90c56117c', agentId: 'a9fec5e54e3fa17a7' },
  { type: 'started', key: 'v2:1e8c259f5a2a24d0bbb14a203fdddb4d980319cb9a4de58003357095dbc8506d', agentId: 'a3059bdd260c7bf6a' },
  { type: 'started', key: 'v2:e178f425ad277b02bea5e509c12e41525017102e559b67d38bf610d76b1fe1d7', agentId: 'aa74d739b57da23fa' },
  { type: 'started', key: 'v2:85c632271107e0bd62dcfc6df9cd46c29510679011b9d0029313a2bf07ad0632', agentId: 'a5bfb770ff8e524ba' },
  { type: 'started', key: 'v2:06dbc3ac55dec8c8c2a56a5dd9719b2d2195a49e87ad70d79728313dd85a36ae', agentId: 'a1060f8e4758cc059' },
  { type: 'started', key: 'v2:de2a1a46e46877c4bdb07dbe9a71d0b7abf400ba82e2071ad378f5a0fcdfa75b', agentId: 'a836859f588c8f018' },
  { type: 'result', key: 'v2:06dbc3ac55dec8c8c2a56a5dd9719b2d2195a49e87ad70d79728313dd85a36ae', agentId: 'a1060f8e4758cc059', result: {} },
  { type: 'result', key: 'v2:1e8c259f5a2a24d0bbb14a203fdddb4d980319cb9a4de58003357095dbc8506d', agentId: 'a3059bdd260c7bf6a', result: {} },
  { type: 'result', key: 'v2:de2a1a46e46877c4bdb07dbe9a71d0b7abf400ba82e2071ad378f5a0fcdfa75b', agentId: 'a836859f588c8f018', result: {} },
  { type: 'result', key: 'v2:e178f425ad277b02bea5e509c12e41525017102e559b67d38bf610d76b1fe1d7', agentId: 'aa74d739b57da23fa', result: {} },
  { type: 'result', key: 'v2:a78105d2406d19203cfc6650f4dbff20b2a257b70ecfba00bbfcede90c56117c', agentId: 'a9fec5e54e3fa17a7', result: {} },
  { type: 'result', key: 'v2:85c632271107e0bd62dcfc6df9cd46c29510679011b9d0029313a2bf07ad0632', agentId: 'a5bfb770ff8e524ba', result: {} },
  // THE ORPHAN: started, never produced a result (subagent left hanging at restart).
  { type: 'started', key: 'v2:2c15018a37b4a02999c95273e0db3d39e83efd4f33f35d3a9e22f02c247491c7', agentId: 'afddffbb69a48213d' },
];

/**
 * VERBATIM rows from the completed journal on disk
 * (.../41d650d6-.../subagents/workflows/wf_1ea9f41d-bdf/journal.jsonl).
 * 11 started lines collapse to 7 unique keys (4 keys re-started — retry /
 * escalation), 10 result lines collapse to 7 unique keys, and every started key
 * has a result. => 'completed', agentsDone 7 == total 7. Doubles as the
 * de-dup/retry fixture.
 */
const COMPLETED_JOURNAL_LINES: Array<Record<string, unknown>> = [
  { type: 'started', key: 'v2:b8e26b51cc782533ee6273cb9f9d876299a34a6efa537cf1927a85a73f182f19', agentId: 'a0ae48768834f44d9' },
  { type: 'result', key: 'v2:b8e26b51cc782533ee6273cb9f9d876299a34a6efa537cf1927a85a73f182f19', agentId: 'a0ae48768834f44d9', result: {} },
  { type: 'started', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a6dd1b79a68ba21b1' },
  { type: 'started', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'abe7ccc5aab802788' },
  { type: 'started', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a3c1f8e93580d1cdc' },
  { type: 'started', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'a72487559602a95a1' },
  { type: 'result', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'abe7ccc5aab802788', result: {} },
  { type: 'result', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a3c1f8e93580d1cdc', result: {} },
  { type: 'result', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'a72487559602a95a1', result: {} },
  { type: 'started', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a8aec7d281e6ec72b' },
  { type: 'started', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'aeebb22d41d718435' },
  { type: 'started', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a59d0205755883954' },
  { type: 'started', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'a358e0f4b054189ae' },
  { type: 'result', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'a358e0f4b054189ae', result: {} },
  { type: 'result', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a59d0205755883954', result: {} },
  { type: 'result', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'aeebb22d41d718435', result: {} },
  { type: 'result', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a8aec7d281e6ec72b', result: {} },
  { type: 'started', key: 'v2:56432bd40bb95d0232b4ab713a6f7c8675b0ebf77a113132b2a25ee00f3f6836', agentId: 'a5af5c06c82c65f06' },
  { type: 'started', key: 'v2:6d1f406fc027c73ce3b1525aeb57fe1438619ca449453fb162a2927975fbf264', agentId: 'a5c9110eaedc02d2d' },
  { type: 'result', key: 'v2:6d1f406fc027c73ce3b1525aeb57fe1438619ca449453fb162a2927975fbf264', agentId: 'a5c9110eaedc02d2d', result: {} },
  { type: 'result', key: 'v2:56432bd40bb95d0232b4ab713a6f7c8675b0ebf77a113132b2a25ee00f3f6836', agentId: 'a5af5c06c82c65f06', result: {} },
];

function toJsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/**
 * Runs `body` against a fresh session directory containing one `wf_*` folder
 * (named `wfId`) whose `journal.jsonl` is written from `lines` and whose mtime is
 * forced to `journalMtimeMs`, so freshness gates are deterministic regardless of
 * wall clock. Cleans the temp tree afterwards. Pass `lines === null` to create
 * the folder with NO journal file.
 */
async function withWorkflowJournal(
  wfId: string,
  lines: Array<Record<string, unknown>> | null,
  journalMtimeMs: number,
  body: (sessionDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-'));
  const sessionDir = path.join(tempDir, 'sess-1');
  const wfDir = path.join(sessionDir, 'subagents', 'workflows', wfId);
  await mkdir(wfDir, { recursive: true });

  if (lines !== null) {
    const journalPath = path.join(wfDir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(lines), 'utf8');
    const mtimeSeconds = journalMtimeMs / 1000;
    await utimes(journalPath, mtimeSeconds, mtimeSeconds);
  }

  try {
    await body(sessionDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Anchor times: stopped row at T0, journal completed 6 min later (incident gap),
// and "now" well past the quiet window so freshness is satisfied by default.
const STOPPED_AT_MS = Date.parse('2026-06-27T14:51:00.000Z');
const JOURNAL_DONE_MS = Date.parse('2026-06-27T14:57:00.000Z');
const NOW_MS = JOURNAL_DONE_MS + 60_000;

// ============================================================================
// C5 — settlement classification on REAL journals
// ============================================================================

// (أ) the incident journal: 16 started / 15 result => 'settled', agentsDone<total.
test('(أ) incident journal (16 started / 15 result) reconciles as SETTLED with agentsDone < agentsTotal', async () => {
  await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });

    assert.equal(reconciled.length, 1, 'the incident workflow must be reconciled (not skipped)');
    assert.equal(reconciled[0].wfId, INCIDENT_WF_ID);
    assert.equal(reconciled[0].status, 'settled', 'started ⊄ result with output present => settled');
    assert.equal(reconciled[0].agentsTotal, 16, '16 unique started keys');
    assert.equal(reconciled[0].agentsDone, 15, '15 unique result keys (one orphan unmatched)');
    assert.ok(reconciled[0].agentsDone < reconciled[0].agentsTotal, 'partial: done < total');
    assert.equal(reconciled[0].completedAt, new Date(JOURNAL_DONE_MS).toISOString());
  });
});

// (ب) the completed journal: 7 started / 7 result (with retries) => 'completed', 7/7.
test('(ب) completed journal (7/7, started ⊆ result, retries de-duped) reconciles as COMPLETED', async () => {
  await withWorkflowJournal(COMPLETED_WF_ID, COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].wfId, COMPLETED_WF_ID);
    assert.equal(reconciled[0].status, 'completed', 'started ⊆ result => completed');
    assert.equal(reconciled[0].agentsTotal, 7, '7 unique started keys (11 lines de-duped by key)');
    assert.equal(reconciled[0].agentsDone, 7, '7 unique result keys');
    assert.equal(reconciled[0].agentsDone, reconciled[0].agentsTotal, 'completed => done == total');
  });
});

// (ج) zero result rows => null (no correction).
test('(ج) a journal with ZERO result rows yields no correction (started-only orphan, not settled)', async () => {
  const startedOnly = INCIDENT_JOURNAL_LINES.filter((line) => line.type === 'started');
  await withWorkflowJournal(INCIDENT_WF_ID, startedOnly, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0, 'resultKeys.size == 0 => null => skipped');
  });
});

// ============================================================================
// (د) fail-safe: never throws, no correction
// ============================================================================

test('(د.1) malformed JSON lines are skipped, not fatal; the rest of the incident journal still settles', async () => {
  await withWorkflowJournal(INCIDENT_WF_ID, null, JOURNAL_DONE_MS, async (sessionDir) => {
    const journalPath = path.join(sessionDir, 'subagents', 'workflows', INCIDENT_WF_ID, 'journal.jsonl');
    const body = INCIDENT_JOURNAL_LINES.map((line) => JSON.stringify(line));
    // Inject a corrupt line in the middle; the good lines must still reconcile.
    body.splice(3, 0, '{ this is not valid json');
    await writeFile(journalPath, body.join('\n') + '\n', 'utf8');
    const mtimeSeconds = JOURNAL_DONE_MS / 1000;
    await utimes(journalPath, mtimeSeconds, mtimeSeconds);

    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 1, 'corrupt line skipped, remaining keys still settle');
    assert.equal(reconciled[0].status, 'settled');
    assert.equal(reconciled[0].agentsTotal, 16);
    assert.equal(reconciled[0].agentsDone, 15);
  });
});

test('(د.2) a missing subagents/workflows directory yields no correction and never throws', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-empty-'));
  try {
    const sessionDir = path.join(tempDir, 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.deepEqual(reconciled, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('(د.3) a wf_ folder with NO journal file yields no correction and never throws', async () => {
  await withWorkflowJournal(INCIDENT_WF_ID, null, JOURNAL_DONE_MS, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.deepEqual(reconciled, [], 'missing journal.jsonl => no signal for that workflow');
  });
});

// ============================================================================
// (هـ) flag gating
// ============================================================================

test('workflowReconcileEnabled is OFF unless explicitly truthy', () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    delete process.env.WORKFLOW_RECONCILE;
    assert.equal(workflowReconcileEnabled(), false, 'unset => OFF');
    process.env.WORKFLOW_RECONCILE = 'false';
    assert.equal(workflowReconcileEnabled(), false);
    process.env.WORKFLOW_RECONCILE = '0';
    assert.equal(workflowReconcileEnabled(), false);
    process.env.WORKFLOW_RECONCILE = 'on';
    assert.equal(workflowReconcileEnabled(), true);
    process.env.WORKFLOW_RECONCILE = '1';
    assert.equal(workflowReconcileEnabled(), true);
    process.env.WORKFLOW_RECONCILE = 'true';
    assert.equal(workflowReconcileEnabled(), true);
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('(هـ) reconcileWorkflowMessages is a no-op when the flag is OFF (byte-for-byte prior behaviour)', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    delete process.env.WORKFLOW_RECONCILE;
    await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
      assert.deepEqual(messages, [], 'OFF => no derived rows even for a settled workflow');
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages is a no-op when there is no stopped notification', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, null, { now: NOW_MS });
      assert.deepEqual(messages, [], 'no stopped row => nothing to correct');
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages emits a SETTLED correction when ON for the incident journal', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'task_reconcile');
      assert.equal(messages[0].taskStatus, 'settled');
      assert.equal(messages[0].content, 'هدأت المهمة الخلفية (بعض الوكلاء لم يُكملوا)');
      assert.equal(messages[0].wfId, INCIDENT_WF_ID);
      assert.equal(messages[0].agentsDone, 15);
      assert.equal(messages[0].agentsTotal, 16);
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

test('reconcileWorkflowMessages emits a COMPLETED correction when ON for the completed journal', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    await withWorkflowJournal(COMPLETED_WF_ID, COMPLETED_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
      const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'task_reconcile');
      assert.equal(messages[0].taskStatus, 'completed');
      assert.equal(messages[0].content, 'اكتملت المهمة الخلفية');
      assert.equal(messages[0].wfId, COMPLETED_WF_ID);
      assert.equal(messages[0].agentsDone, 7);
      assert.equal(messages[0].agentsTotal, 7);
    });
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
  }
});

// ============================================================================
// (و) freshness gates (apply to BOTH completed and settled)
// ============================================================================

test('(و.1) a journal not newer than the stopped notification is ignored (freshness a) — settled case', async () => {
  // Journal mtime BEFORE the stopped row => predates the stop, not a fresh settlement.
  const olderThanStop = STOPPED_AT_MS - 60_000;
  await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, olderThanStop, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0, 'stale-vs-stopped journal must not be reconciled');
  });
});

test('(و.2) a journal still within the quiet window is ignored (freshness b: write may be in flight)', async () => {
  await withWorkflowJournal(INCIDENT_WF_ID, INCIDENT_JOURNAL_LINES, JOURNAL_DONE_MS, async (sessionDir) => {
    // now is only 1s after the last write, below the default 5000ms quiet window.
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, {
      now: JOURNAL_DONE_MS + 1000,
      quietMs: 5000,
    });
    assert.equal(reconciled.length, 0, 'a journal written <QUIET_MS ago is treated as in-flight');
  });
});

test('(و.3) freshness gates also apply to a COMPLETED journal (not just settled)', async () => {
  const olderThanStop = STOPPED_AT_MS - 60_000;
  await withWorkflowJournal(COMPLETED_WF_ID, COMPLETED_JOURNAL_LINES, olderThanStop, async (sessionDir) => {
    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 0, 'a completed-but-stale journal is also skipped');
  });
});

// ============================================================================
// (ز) AUTHORITY BOUNDARY (T-825): reconcile is the inline-restart detector ONLY.
// A B-103 DurableTask completes via `result.json` + `DONE` under the supervisor's
// `tasks/<taskId>/` tree, read by workflow-supervisor/monitor.ts — NEVER here.
// These tests lock that reconcile keys off `journal.jsonl` (its authority) and
// ignores the DurableTask completion markers even under a name/location collision.
// ============================================================================

/**
 * Writes a DurableTask-shaped completion artifact (`result.json` + `DONE`, and
 * deliberately NO `journal.jsonl`) into a `wf_*` folder under a session's
 * `subagents/workflows/`. This is the adversarial collision case: the folder is
 * (a) named with the SDK `wf_` prefix AND (b) carries a fully-successful result
 * with a fresh mtime — so ONLY the shape boundary (missing journal.jsonl) can be
 * the reason reconcile skips it, proving it keys off its own authority, not the
 * monitor's `result.json`/`DONE`.
 */
async function writeDurableTaskShapedDir(
  sessionDir: string,
  taskDirName: string,
  finalizedAtMs: number,
): Promise<void> {
  const dir = path.join(sessionDir, 'subagents', 'workflows', taskDirName);
  await mkdir(dir, { recursive: true });
  const resultPath = path.join(dir, 'result.json');
  const donePath = path.join(dir, 'DONE');
  await writeFile(
    resultPath,
    JSON.stringify({ type: 'result', subtype: 'success', result: 'DurableTask output' }) + '\n',
    'utf8',
  );
  await writeFile(
    donePath,
    JSON.stringify({ exit_code: 0, signal: null, finalizedAt: new Date(finalizedAtMs).toISOString() }) +
      '\n',
    'utf8',
  );
  const secs = finalizedAtMs / 1000;
  await utimes(resultPath, secs, secs);
  await utimes(donePath, secs, secs);
}

test('(ز.1) a DurableTask-shaped completion (result.json + DONE, no journal) is NOT reconciled', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-boundary-'));
  try {
    const sessionDir = path.join(tempDir, 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    // Adversarial: wf_-prefixed name + a successful result, mtime AFTER the stopped
    // row (freshness WOULD pass). The only reason it is skipped is the SHAPE
    // boundary — no journal.jsonl — so this is not reconcile's authority.
    await writeDurableTaskShapedDir(sessionDir, 'wf_durable_task_abc', JOURNAL_DONE_MS);

    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.deepEqual(reconciled, [], 'result.json/DONE is the monitor authority — reconcile ignores it');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('(ز.2) an inline journal and a DurableTask-shaped dir coexist ⇒ ONLY the inline one reconciles', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-boundary-'));
  try {
    const sessionDir = path.join(tempDir, 'sess-1');
    // A real inline SDK workflow (the incident journal) — this MUST still reconcile.
    const inlineDir = path.join(sessionDir, 'subagents', 'workflows', INCIDENT_WF_ID);
    await mkdir(inlineDir, { recursive: true });
    const journalPath = path.join(inlineDir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(INCIDENT_JOURNAL_LINES), 'utf8');
    const secs = JOURNAL_DONE_MS / 1000;
    await utimes(journalPath, secs, secs);
    // A sibling DurableTask artifact under the SAME subagents/workflows/ tree.
    await writeDurableTaskShapedDir(sessionDir, 'wf_durable_task_xyz', JOURNAL_DONE_MS);

    const reconciled = await findReconciledWorkflows(sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.equal(reconciled.length, 1, 'exactly one correction — never the DurableTask dir');
    assert.equal(reconciled[0].wfId, INCIDENT_WF_ID, 'the claimed workflow is the inline journal one');
    assert.equal(reconciled[0].status, 'settled', 'the live inline-restart path is intact');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('(ز.3) reconcileWorkflowMessages (flag ON) emits NO card for a DurableTask-shaped dir', async () => {
  const prev = process.env.WORKFLOW_RECONCILE;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wf-reconcile-boundary-'));
  try {
    process.env.WORKFLOW_RECONCILE = '1';
    const sessionDir = path.join(tempDir, 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    await writeDurableTaskShapedDir(sessionDir, 'wf_durable_task_only', JOURNAL_DONE_MS);

    const messages = await reconcileWorkflowMessages('sess-1', sessionDir, STOPPED_AT_MS, { now: NOW_MS });
    assert.deepEqual(messages, [], 'a DurableTask completion is delivered by the monitor, never by reconcile');
  } finally {
    if (prev === undefined) {
      delete process.env.WORKFLOW_RECONCILE;
    } else {
      process.env.WORKFLOW_RECONCILE = prev;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// derived-message contract shape (server → client) for BOTH statuses
// ============================================================================

test('buildReconcileMessage (completed) matches the server→client contract exactly (no path field)', () => {
  const msg = buildReconcileMessage('sess-1', {
    wfId: COMPLETED_WF_ID,
    status: 'completed',
    agentsDone: 7,
    agentsTotal: 7,
    completedAt: '2026-06-27T14:57:00.000Z',
  });

  assert.equal(msg.kind, 'task_reconcile');
  assert.equal(msg.provider, 'claude');
  assert.equal(msg.sessionId, 'sess-1');
  assert.equal(msg.isTaskNotification, true);
  assert.equal(msg.taskStatus, 'completed');
  assert.equal(msg.content, 'اكتملت المهمة الخلفية');
  assert.equal(msg.wfId, COMPLETED_WF_ID);
  assert.equal(msg.agentsDone, 7);
  assert.equal(msg.agentsTotal, 7);
  assert.equal(msg.originKind, 'task-notification', 'must not be attributed to the user');
  assert.equal(msg.timestamp, '2026-06-27T14:57:00.000Z', 'timestamp = journal mtime, sorts after stopped');
  assert.ok(Object.hasOwn(msg, 'id') && typeof msg.id === 'string', 'envelope id filled');
  assert.equal(Object.hasOwn(msg, 'path'), false, 'the journal has no output-file path');
});

test('buildReconcileMessage (settled) carries taskStatus:settled, the partial copy, and done < total', () => {
  const msg = buildReconcileMessage('sess-1', {
    wfId: INCIDENT_WF_ID,
    status: 'settled',
    agentsDone: 15,
    agentsTotal: 16,
    completedAt: '2026-06-27T14:57:00.000Z',
  });

  assert.equal(msg.kind, 'task_reconcile');
  assert.equal(msg.isTaskNotification, true);
  assert.equal(msg.taskStatus, 'settled');
  assert.equal(msg.content, 'هدأت المهمة الخلفية (بعض الوكلاء لم يُكملوا)');
  assert.equal(msg.wfId, INCIDENT_WF_ID);
  assert.equal(msg.agentsDone, 15);
  assert.equal(msg.agentsTotal, 16);
  assert.ok((msg.agentsDone as number) < (msg.agentsTotal as number), 'settled => done < total');
  assert.equal(msg.originKind, 'task-notification');
  assert.equal(Object.hasOwn(msg, 'path'), false);
});

// ============================================================================
// stopped-notification detection (unchanged contract)
// ============================================================================

test('findLatestStoppedNotificationMs picks the latest task-notification stopped row', () => {
  const rows: Array<Record<string, unknown>> = [
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T14:40:00.000Z',
      message: { role: 'user', content: '<task-notification><status>stopped</status></task-notification>' },
    },
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T14:51:00.000Z',
      message: { role: 'user', content: '<task-notification><status>stopped</status></task-notification>' },
    },
    // a non-stopped task-notification and a human row must be ignored
    {
      origin: { kind: 'task-notification' },
      timestamp: '2026-06-27T15:00:00.000Z',
      message: { role: 'user', content: '<task-notification><status>started</status></task-notification>' },
    },
    {
      timestamp: '2026-06-27T15:05:00.000Z',
      message: { role: 'user', content: '<status>stopped</status> typed by a human (no task-notification origin)' },
    },
  ];

  const latest = findLatestStoppedNotificationMs(rows);
  assert.equal(latest, Date.parse('2026-06-27T14:51:00.000Z'));
});

test('findLatestStoppedNotificationMs returns null when there is no background stop', () => {
  const rows: Array<Record<string, unknown>> = [
    {
      timestamp: '2026-06-27T14:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    },
  ];
  assert.equal(findLatestStoppedNotificationMs(rows), null);
});
