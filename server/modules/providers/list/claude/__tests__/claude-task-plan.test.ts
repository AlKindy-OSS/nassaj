/**
 * ADR-199 Addendum A (P1b/P1c): Claude TaskCreate/TaskUpdate fold and
 * background-agent settlement, on the history and the live path.
 *
 * Every row comes from `claude-task-plan.real.json` (scrubbed recorded transcript
 * rows; see its `_provenance`). Scenarios are composed by ordering those rows
 * and re-stamping timestamps; where a case needs a different task id or status
 * the real row is cloned and only that value changes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, participantsDb, sessionsDb } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { resetHistorySnapshotCacheForTests } from '../../../services/session-history-light.service.js';
import { sessionsService } from '../../../services/sessions.service.js';
import { claudeNotifiedTasks, claudeSettlements, createClaudeProgressFold } from '../claude-progress-fold.js';
import { createSeededLiveFold, seedClaudeProgressFold } from '../claude-progress-seed.js';
import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';
import { TASK_PLAN_MAX_ITEMS, TASK_PLAN_PENDING_MAX } from '../claude-task-plan.js';

type Row = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SID = '00000000-0000-4000-8000-000000000002';
const provider = new ClaudeSessionsProvider();

const real: Record<string, Row> = JSON.parse(
  await readFile(path.join(HERE, '__fixtures__', 'claude-task-plan.real.json'), 'utf8'),
).rows;

const copy = (row: Row): Row => JSON.parse(JSON.stringify(row));
const R = (name: string): Row => copy(real[name]);

/** Re-stamps timestamps (and makes uuids unique) in the given order. */
function sequence(rows: Row[]): Row[] {
  return rows.map((row, index) => ({
    ...row,
    uuid: `${row.uuid.slice(0, 24)}${String(index).padStart(12, '0')}`,
    timestamp: new Date(Date.UTC(2026, 9, 9, 6, 0, index)).toISOString(),
  }));
}

/** A real TaskUpdate call/result pair cloned for another task id and status. */
function updatePair(taskId: string, status: string, n: number): Row[] {
  const use = R('updateHelloInProgressUse');
  const result = R('updateHelloInProgressResult');
  const toolId = `toolu_clone_update_${n}`;
  use.message.content[0] = { ...use.message.content[0], id: toolId, input: { taskId, status } };
  result.message.content[0] = { ...result.message.content[0], tool_use_id: toolId };
  result.toolUseResult = { ...result.toolUseResult, taskId, statusChange: { from: 'pending', to: status } };
  return [use, result];
}

/** A real TaskCreate call/result pair cloned for another task id. */
function createPair(taskId: string, subject: string, n: number): Row[] {
  const use = R('createHelloUse');
  const result = R('createHelloResult');
  const toolId = `toolu_clone_create_${n}`;
  use.message.content[0] = { ...use.message.content[0], id: toolId, input: { subject, description: subject } };
  result.message.content[0] = { ...result.message.content[0], tool_use_id: toolId };
  result.toolUseResult = { task: { id: taskId, subject } };
  return [use, result];
}

const TURN1 = ['humanPrompt', 'createHelloUse', 'createHelloResult', 'createByeUse', 'createByeResult',
  'updateHelloInProgressUse', 'updateHelloInProgressResult'];
const TURN2 = ['compactBoundary', 'compactSummary', 'updateHelloCompletedUse', 'updateHelloCompletedResult',
  'deleteByeUse', 'deleteByeResult'];
const secondPrompt = (): Row => ({ ...R('humanPrompt'), message: { role: 'user', content: 'Continue.' } });

/** Pure history fold over ordered rows, as fetchHistory runs it. */
function foldHistory(rows: Row[]): NormalizedMessage[] {
  const fold = createClaudeProgressFold('history', SID);
  const out: NormalizedMessage[] = [];
  for (const raw of rows) {
    const normalized = provider.normalizeMessage(raw, SID);
    out.push(...normalized, ...fold.observe(raw, normalized));
  }
  fold.endTurn();
  return out;
}

const planOf = (rows: NormalizedMessage[]) => rows.filter((m) => m.plan).map((m) => m.plan?.items.map((i) => [i.id, i.label, i.status]));

test('history: one snapshot per turn on its last Task* row; deleted tasks vanish; compaction keeps the fold', () => {
  const rows = sequence([...TURN1.map(R), secondPrompt(), ...TURN2.map(R)]);
  const out = foldHistory(rows);
  assert.deepEqual(planOf(out), [
    [['1', 'Say hello', 'in_progress'], ['2', 'Say bye', 'pending']],
    [['1', 'Say hello', 'completed']],
  ]);
  const carriers = out.filter((m) => m.plan).map((m) => m.toolId);
  assert.deepEqual(carriers, [rows[6].message.content[0].tool_use_id, rows[13].message.content[0].tool_use_id]);
});

test('history: unknown status stays pending, excluded status drops, an empty snapshot is omitted', () => {
  const out = foldHistory(sequence([
    R('humanPrompt'), ...createPair('1', 'Say hello', 1), ...updatePair('1', 'blocked', 2),
    ...createPair('2', 'Say bye', 3), ...updatePair('2', 'cancelled', 4),
  ]));
  assert.deepEqual(planOf(out), [[['1', 'Say hello', 'pending']]]);
  const emptied = foldHistory(sequence([R('humanPrompt'), ...createPair('1', 'x', 1), ...updatePair('1', 'deleted', 2)]));
  assert.deepEqual(planOf(emptied), []);
});

test('pending buffer: an update before its create applies on create, and drops at turn end', () => {
  const sameTurn = foldHistory(sequence([R('humanPrompt'), ...updatePair('1', 'in_progress', 1), ...createPair('1', 'Say hello', 2)]));
  assert.deepEqual(planOf(sameTurn), [[['1', 'Say hello', 'in_progress']]]);
  const nextTurn = foldHistory(sequence([R('humanPrompt'), ...updatePair('1', 'completed', 1), secondPrompt(), ...createPair('1', 'Say hello', 2)]));
  assert.deepEqual(planOf(nextTurn), [[['1', 'Say hello', 'pending']]]);
  const flood = [R('humanPrompt')];
  for (let i = 0; i < TASK_PLAN_PENDING_MAX + 5; i += 1) flood.push(...updatePair(`u${i}`, 'completed', i));
  flood.push(...createPair(`u${TASK_PLAN_PENDING_MAX + 2}`, 'late', 900), ...createPair('u0', 'early', 901));
  assert.deepEqual(planOf(foldHistory(sequence(flood))), [[[`u${TASK_PLAN_PENDING_MAX + 2}`, 'late', 'pending'], ['u0', 'early', 'completed']]]);
});

test('accumulator cap: creates past 200 are ignored and flagged server-side', () => {
  const fold = createClaudeProgressFold('live', SID);
  const rows = [];
  for (let i = 0; i < TASK_PLAN_MAX_ITEMS + 3; i += 1) rows.push(...createPair(String(i), `t${i}`, i));
  for (const raw of sequence(rows)) fold.observe(raw, provider.normalizeMessage(raw, SID));
  assert.equal(fold.taskPlan.truncated, true);
});

test('notification status comes from the header only; quoted text and unknown values settle nothing', () => {
  const note = R('agentCompletedNotification');
  const toolUseId = R('agentCompletedUse').message.content[0].id;
  assert.deepEqual(claudeSettlements(note), [{ toolUseId, state: 'completed' }]);
  const quoted = copy(note);
  quoted.message.content = quoted.message.content.replace('<summary>', '<summary>said <status>failed</status> ');
  assert.deepEqual(claudeSettlements(quoted), [{ toolUseId, state: 'completed' }]);
  const headerless = copy(note);
  headerless.message.content = headerless.message.content.replace('<status>completed</status>', '')
    .replace('<result>', '<result><status>completed</status>');
  assert.deepEqual(claudeNotifiedTasks(headerless)[0].status, null);
  assert.deepEqual(claudeSettlements(headerless), []);
  const unknown = copy(note);
  unknown.message.content = unknown.message.content.replace('<status>completed', '<status>paused');
  assert.deepEqual(claudeSettlements(unknown), []);
  const typed = copy(note);
  delete typed.origin;
  assert.deepEqual(claudeSettlements(typed), [], 'text a human typed never settles');
});

test('history: background agents settle completed/failed via status rows; unseen ids invent nothing', () => {
  const out = foldHistory(sequence([
    R('humanPrompt'), R('agentCompletedUse'), R('agentFailedUse'),
    R('agentCompletedNotification'), R('agentFailedNotification'),
  ]));
  const settled = out.filter((m) => m.kind === 'status').map((m) => [m.subagent?.label, m.subagent?.state]);
  assert.deepEqual(settled, [['Review change', 'completed'], ['Diagnose gate', 'failed']]);
  const orphan = foldHistory(sequence([R('humanPrompt'), R('agentCompletedNotification')]));
  assert.equal(orphan.some((m) => m.kind === 'status'), false);
});

/**
 * Writes `rows` as the transcript of `sid` (plus optional subagent files) under
 * a temporary Claude projects root (HOME and CLAUDE_CONFIG_DIR point into the
 * temp dir) and registers it for user 1. `outside` writes the transcript
 * beside the root instead, so containment must reject it.
 */
async function withSession(
  rows: Row[], body: (file: string) => Promise<void>, sid = SID, agents: Record<string, Row[]> = {},
  outside = false,
): Promise<void> {
  const dir = await mkdtemp('/var/tmp/claude-task-plan-');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = path.join(dir, 'home');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'home', '.claude');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  resetHistorySnapshotCacheForTests();
  try {
    const base = outside ? path.join(dir, 'elsewhere') : path.join(dir, 'home', '.claude', 'projects', '-p');
    await mkdir(base, { recursive: true });
    const file = path.join(base, `${sid}.jsonl`);
    const jsonl = (list: Row[]) => `${list.map((row) => JSON.stringify(row)).join('\n')}\n`;
    await writeFile(file, jsonl(rows));
    for (const [agentId, agentRows] of Object.entries(agents)) {
      await mkdir(path.join(base, sid, 'subagents'), { recursive: true });
      await writeFile(path.join(base, sid, 'subagents', `agent-${agentId}.jsonl`), jsonl(agentRows));
    }
    getConnection().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'h', 'user')").run();
    sessionsDb.createSession(sid, 'claude', path.join(dir, 'project'), undefined, undefined, undefined, file);
    participantsDb.recordSpawn(sid, 1);
    await body(file);
  } finally {
    resetHistorySnapshotCacheForTests();
    closeConnection();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('paged history equals the full fold (fold runs before paging)', async () => {
  const rows = sequence([...TURN1.map(R), secondPrompt(), ...TURN2.map(R),
    R('agentCompletedUse'), R('agentCompletedNotification')]);
  await withSession(rows, async () => {
    const full = await sessionsService.fetchHistory(SID, 1, {});
    const progress = (list: NormalizedMessage[]) => list.filter((m) => m.plan || m.subagent)
      .map((m) => [m.id, m.plan ?? null, m.subagent ?? null]);
    const paged: NormalizedMessage[] = [];
    for (let offset = 0; ; offset += 4) {
      const page = await sessionsService.fetchHistory(SID, 1, { limit: 4, offset });
      paged.unshift(...page.messages);
      if (!page.hasMore) break;
    }
    assert.deepEqual(progress(paged), progress(full.messages));
    assert.equal(progress(full.messages).filter(([, plan]) => plan).length, 2);
  });
});

test('live resume: seeded from the transcript, a TaskUpdate for a prior-turn item continues the list', async () => {
  const prior = sequence([...TURN1.map(R), R('agentCompletedUse')]);
  await withSession(prior, async () => {
    const fold = createClaudeProgressFold('live', SID);
    assert.equal(await seedClaudeProgressFold(fold, SID), true);
    const toSdk = (row: Row): Row => {
      const { toolUseResult, sessionId, ...rest } = row;
      return { ...rest, session_id: sessionId, parent_tool_use_id: null,
        ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }) };
    };
    const live: NormalizedMessage[] = [];
    for (const raw of [...TURN2.map(R), R('agentCompletedNotification')].map(toSdk)) {
      const normalized = provider.normalizeMessage(raw, SID);
      live.push(...normalized, ...fold.observe(raw, normalized));
    }
    assert.deepEqual(planOf(live), [
      [['1', 'Say hello', 'completed'], ['2', 'Say bye', 'pending']],
      [['1', 'Say hello', 'completed']],
    ], 'live attaches the snapshot to every Task* result row');
    const settled = live.find((m) => m.kind === 'status');
    assert.deepEqual([settled?.subagent?.label, settled?.subagent?.state], ['Review change', 'completed']);
  });
});

test('history: a subagent\'s own Task* plan rides its last child tool item, with the parent id', async () => {
  const capture = JSON.parse(await readFile(path.join(HERE, '__fixtures__', 'claude-subagent-task-plan.real.json'), 'utf8'));
  const sid = capture.main[0].sessionId as string;
  const agentId = capture.main[2].toolUseResult.agentId as string;
  await withSession(capture.main, async () => {
    const history = await sessionsService.fetchHistory(sid, 1, {});
    const agentRow = history.messages.find((m) => m.kind === 'tool_use' && m.toolName === 'Agent');
    const children = (agentRow?.subagentTools ?? []) as Row[];
    assert.deepEqual(children.map((c) => c.toolName), ['ToolSearch', 'ToolSearch', 'TaskCreate', 'TaskUpdate']);
    const withPlan = children.filter((c) => c.plan);
    assert.equal(withPlan.length, 1, 'one snapshot per subagent run');
    assert.equal(withPlan[0].toolName, 'TaskUpdate');
    assert.deepEqual(withPlan[0].plan.items, [{ id: '1', label: 'Step C', status: 'in_progress' }]);
    assert.ok(children.every((c) => c.parentToolUseId === agentRow?.toolId));
  }, sid, { [agentId]: capture.subagent });
});

/**
 * Counts transcript reads opened while `body` runs: by name (fs.createReadStream)
 * and through a pinned descriptor (FileHandle#createReadStream, ADR-201 A1).
 */
async function countingReads(body: () => Promise<void>, hang = false): Promise<string[]> {
  const probe = await fs.promises.open(process.execPath, 'r');
  const handleProto = Object.getPrototypeOf(probe) as { createReadStream: (...args: unknown[]) => unknown };
  await probe.close();
  const original = fs.createReadStream;
  const originalPinned = handleProto.createReadStream;
  const opened: string[] = [];
  (fs as { createReadStream: unknown }).createReadStream = (file: fs.PathLike, ...rest: unknown[]) => {
    opened.push(String(file));
    if (hang) return new PassThrough();
    return (original as (...args: unknown[]) => fs.ReadStream)(file, ...rest);
  };
  handleProto.createReadStream = function pinned(this: { fd: number }, ...rest: unknown[]) {
    opened.push(`fd:${this.fd}`);
    return hang ? new PassThrough() : originalPinned.apply(this, rest);
  };
  try {
    await body();
  } finally {
    fs.createReadStream = original;
    handleProto.createReadStream = originalPinned;
  }
  return opened;
}

const PRIOR = (): Row[] => sequence([...TURN1.map(R), R('agentCompletedUse')]);

test('seed: a stored path outside every Claude projects root is never read; the fold stays empty', async () => {
  await withSession(PRIOR(), async () => {
    const fold = createClaudeProgressFold('live', SID);
    const reads = await countingReads(async () => {
      assert.equal(await seedClaudeProgressFold(fold, SID), false);
    });
    assert.deepEqual(reads, [], 'no read of an uncontained path');
    assert.equal(fold.taskPlan.snapshot(), null);
  }, SID, {}, true);
});

test('seed: an unresolved transcript (no row, missing file) leaves the fold empty', async () => {
  await withSession(PRIOR(), async (file) => {
    const unknown = createClaudeProgressFold('live', SID);
    assert.equal(await seedClaudeProgressFold(unknown, '00000000-0000-4000-8000-0000000000ff'), false);
    assert.equal(unknown.taskPlan.snapshot(), null);
    await rm(file);
    const missing = createClaudeProgressFold('live', SID);
    const reads = await countingReads(async () => {
      assert.equal(await seedClaudeProgressFold(missing, SID), false);
    });
    assert.deepEqual(reads, []);
    assert.equal(missing.taskPlan.snapshot(), null);
  });
});

test('seed: a transcript above the size cap is skipped without a read', async () => {
  await withSession(PRIOR(), async () => {
    const fold = createClaudeProgressFold('live', SID);
    const reads = await countingReads(async () => {
      assert.equal(await seedClaudeProgressFold(fold, SID, { maxBytes: 64 }), false);
    });
    assert.deepEqual(reads, []);
    assert.equal(fold.taskPlan.snapshot(), null);
  });
});

test('seeded live fold: within budget it continues the prior list; past budget a fresh fold is returned', async () => {
  await withSession(PRIOR(), async () => {
    const seeded = await createSeededLiveFold(SID, SID, { budgetMs: 5000 });
    assert.deepEqual(seeded.taskPlan.snapshot()?.items.map((i) => [i.id, i.status]), [['1', 'in_progress'], ['2', 'pending']]);

    let fold: ReturnType<typeof createClaudeProgressFold> | null = null;
    const started = Date.now();
    const reads = await countingReads(async () => {
      fold = await createSeededLiveFold(SID, SID, { budgetMs: 50 });
    }, true);
    const waited = Date.now() - started;
    assert.equal(reads.length, 1, 'the seed started reading a stream that never ends');
    assert.ok(waited < 1000, `first event waited ${waited} ms`);
    assert.equal(fold!.taskPlan.snapshot(), null, 'the partial seed is discarded');
  });
});

/** Last plan snapshot the history path attaches for `rows`, or null. */
const historyPlan = (rows: Row[]) => foldHistory(rows).filter((m) => m.plan).at(-1)?.plan ?? null;

test('B-1563 seed: an update buffered in turn N drops before turn N+1 creates its id, as in history', async () => {
  const rows = sequence([R('humanPrompt'), ...updatePair('1', 'completed', 1), secondPrompt(), ...createPair('1', 'Say hello', 2)]);
  const history = historyPlan(rows);
  assert.deepEqual(history?.items.map((i) => [i.id, i.status]), [['1', 'pending']]);
  await withSession(rows, async () => {
    const fold = createClaudeProgressFold('live', SID);
    assert.equal(await seedClaudeProgressFold(fold, SID), true);
    assert.deepEqual(fold.taskPlan.snapshot(), history, 'seeded live snapshot equals the history snapshot');
  });
});

test('B-1563 seed: a <task-notification> user row does not open a turn; the pending buffer survives it', async () => {
  const rows = sequence([R('humanPrompt'), R('agentCompletedUse'), ...updatePair('1', 'in_progress', 1),
    R('agentCompletedNotification'), ...createPair('1', 'Say hello', 2)]);
  const history = historyPlan(rows);
  assert.deepEqual(history?.items.map((i) => [i.id, i.status]), [['1', 'in_progress']]);
  await withSession(rows, async () => {
    const fold = createClaudeProgressFold('live', SID);
    assert.equal(await seedClaudeProgressFold(fold, SID), true);
    assert.deepEqual(fold.taskPlan.snapshot(), history);
    const live: NormalizedMessage[] = [];
    for (const raw of sequence(updatePair('1', 'completed', 3))) {
      const normalized = provider.normalizeMessage(raw, SID);
      fold.observe(raw, normalized);
      live.push(...normalized);
    }
    assert.deepEqual(planOf(live), [[['1', 'Say hello', 'completed']]], 'after the seed, new events fold live');
  });
});

test('B-1563 seed: a human prompt whose text is "tool_result" still closes its turn (structural check)', async () => {
  for (const content of ['tool_result', [{ type: 'text', text: 'tool_result' }]]) {
    const prompt: Row = { ...R('humanPrompt'), message: { role: 'user', content } };
    const rows = sequence([R('humanPrompt'), ...updatePair('1', 'completed', 1), prompt, ...createPair('1', 'Say hello', 2)]);
    assert.ok(JSON.stringify(prompt).includes('"tool_result"'), 'the raw line carries the old substring marker');
    const history = historyPlan(rows);
    assert.deepEqual(history?.items.map((i) => [i.id, i.status]), [['1', 'pending']]);
    await withSession(rows, async () => {
      const fold = createClaudeProgressFold('live', SID);
      assert.equal(await seedClaudeProgressFold(fold, SID), true);
      assert.deepEqual(fold.taskPlan.snapshot(), history, 'the prompt is a turn boundary in the seed too');
    });
  }
});
