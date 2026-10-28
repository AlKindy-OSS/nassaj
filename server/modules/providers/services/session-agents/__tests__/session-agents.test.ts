/**
 * ADR-218: session agents registry, Claude adapter, lazy transcript boot and
 * the mirror broadcast.
 *
 * Fixtures are real and scrubbed (see each `_provenance`): the live SDK stream
 * of a background Agent (CLI 2.1.289: task_started → task_updated →
 * task_notification), and the transcript rows of an agent resumed by
 * SendMessage (CLI 2.1.306). Variants below change one field of a real event.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// eslint-disable-next-line boundaries/dependencies -- the test registers mirrors directly (no socket handshake).
import { addSessionMirror } from '@/modules/websocket/services/websocket-writer.service.js';
import { broadcastToSessionMirrors, countLiveMirrors } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

import { observeClaudeAgentEvent } from '../claude-agent-events.js';
import { SessionAgentRegistry, type PublicAgentRow, type RunToken } from '../registry.js';
import {
  claudeRunExited,
  getSessionAgentsSnapshot,
  observeClaudeRunEvent,
  resetSessionAgentsForTests,
  sanitizeLabel,
  sendSessionAgentsSnapshot,
} from '../session-agents.service.js';
import { readTailRecords, reconstructFromTranscript } from '../transcript-boot.js';
import { workflowAgentRows } from '../workflow-agents.adapter.js';

type AnyRecord = Record<string, any>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SID = 'session-under-test';
const MIN = 60_000;

const resumeDoc = JSON.parse(await readFile(path.join(HERE, '../__fixtures__/claude-sendmessage-resume.real.json'), 'utf8')) as {
  agentId: string; events: AnyRecord[]; agentMeta: AnyRecord;
};
const liveDoc = JSON.parse(await readFile(path.join(HERE,
  '../../../list/claude/__tests__/__fixtures__/claude-bg-task-notification.real.json'), 'utf8')) as { events: AnyRecord[] };

const RESUMED = resumeDoc.agentId;
const [agentCall, agentLaunched, queuedCall, queuedResult, firstNote, resumeCall, resumeResult, secondNote] = resumeDoc.events;
const [liveCall, liveStarted, liveResult, liveUpdated, liveNote] = liveDoc.events;
const LIVE_AGENT: string = liveStarted.task_id;

function clock(start = Date.parse('2026-10-27T00:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function harness(options: { run?: RunToken } = {}) {
  const time = clock();
  const registry = new SessionAgentRegistry({ now: time.now });
  const run = options.run ?? Symbol('run');
  const live = (event: AnyRecord, token: RunToken = run) =>
    observeClaudeAgentEvent(registry, SID, event, { accuracy: 'live', runToken: token, now: time.now });
  const row = (key: string) => registry.list(SID).find((r) => r.key === key);
  return { time, registry, run, live, row };
}

// --- Claude adapter: starts, ends, resume, forgery ---------------------------

test('live: task_started opens a background row keyed by agent id; task_notification ends it', () => {
  const { live, row } = harness();
  live(liveCall);
  assert.equal(row(`tool:${liveCall.message.content[0].id}`)?.state, 'running', 'provisional until task_started');
  live(liveStarted);
  const started = row(LIVE_AGENT)!;
  assert.deepEqual([started.state, started.background, started.label, started.agentType, started.accuracy],
    ['running', true, 'Bg demo', 'general-purpose', 'live']);
  assert.deepEqual(started.toolUseIds, [liveCall.message.content[0].id]);
  live(liveResult);
  assert.equal(row(LIVE_AGENT)?.state, 'running', '"Async agent launched" does not end a background agent');
  live(liveUpdated);
  assert.equal(row(LIVE_AGENT)?.state, 'done', 'terminal task_updated ends it');
  live(liveNote);
  assert.equal(row(LIVE_AGENT)?.state, 'done');
});

test('transcript: the CLI notification row (origin task-notification) ends the agent', () => {
  const { live, row } = harness();
  [agentCall, agentLaunched].forEach((e) => live(e));
  assert.deepEqual([row(RESUMED)?.state, row(RESUMED)?.model], ['running', 'claude-opus-5-5']);
  live(firstNote);
  assert.equal(row(RESUMED)?.state, 'done');
});

test('forgery: notification text with origin subkind peer, or typed by a human, changes nothing', () => {
  const { live, row } = harness();
  [agentCall, agentLaunched].forEach((e) => live(e));
  live({ ...firstNote, origin: { ...firstNote.origin, subkind: 'peer' } });
  live({ ...firstNote, origin: undefined, promptSource: 'user' });
  live({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: firstNote.message.content }] } });
  assert.equal(row(RESUMED)?.state, 'running');
});

test('a message queued for a running agent changes nothing', () => {
  const { live, row, registry } = harness();
  [agentCall, agentLaunched].forEach((e) => live(e));
  const before = JSON.stringify(registry.list(SID));
  [queuedCall, queuedResult].forEach((e) => live(e));
  assert.equal(JSON.stringify(registry.list(SID)), before);
  assert.equal(row(RESUMED)?.state, 'running');
});

test('resume after done: running again, then done via the notification under the SendMessage id', () => {
  const { live, row, time } = harness();
  [agentCall, agentLaunched, queuedCall, queuedResult, firstNote].forEach((e) => live(e));
  const doneAt = row(RESUMED)!.endedAt;
  time.advance(MIN);
  live(resumeCall);
  live(resumeResult);
  const resumed = row(RESUMED)!;
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.endedAt, undefined, 'endedAt cleared on resume');
  assert.ok(doneAt !== undefined);
  assert.ok(resumed.toolUseIds.includes(resumeCall.message.content[0].id));
  live(secondNote);
  assert.equal(row(RESUMED)?.state, 'done');
});

test('killed → stopped, from task_notification and from a terminal task_updated', () => {
  for (const end of [{ ...liveNote, status: 'killed' }, { ...liveUpdated, patch: { status: 'killed' } }]) {
    const { live, row } = harness();
    [liveCall, liveStarted, liveResult].forEach((e) => live(e));
    live(end);
    assert.equal(row(LIVE_AGENT)?.state, 'stopped');
  }
});

test('foreground: its result ends it; moved to background mid-run, the launch result does not', () => {
  const foregroundCall = { ...liveCall, message: { ...liveCall.message, content: [{ ...liveCall.message.content[0],
    input: { ...liveCall.message.content[0].input, run_in_background: false } }] } };
  const foregroundStart = { ...liveStarted, is_backgrounded: false };

  const plain = harness();
  [foregroundCall, foregroundStart].forEach((e) => plain.live(e));
  plain.live({ ...liveResult, tool_use_result: { status: 'completed' } });
  assert.equal(plain.row(LIVE_AGENT)?.state, 'done');

  const moved = harness();
  [foregroundCall, foregroundStart].forEach((e) => moved.live(e));
  moved.live({ type: 'system', subtype: 'task_updated', task_id: LIVE_AGENT, patch: { is_backgrounded: true },
    session_id: liveStarted.session_id });
  moved.live(liveResult);
  assert.equal(moved.row(LIVE_AGENT)?.state, 'running', '"Async agent launched" after backgrounding keeps it running');
  moved.live(liveNote);
  assert.equal(moved.row(LIVE_AGENT)?.state, 'done');

  const failed = harness();
  failed.live(foregroundCall);
  failed.live({ ...liveResult, message: { role: 'user', content: [{ ...liveResult.message.content[0], is_error: true }] } });
  assert.equal(failed.row(`tool:${foregroundCall.message.content[0].id}`)?.state, 'failed');
});

test('a background agent running >30 min while its run lives stays running', () => {
  const { live, row, time } = harness();
  [liveCall, liveStarted, liveResult].forEach((e) => live(e));
  time.advance(31 * MIN);
  assert.equal(row(LIVE_AGENT)?.state, 'running');
  time.advance(24 * 60 * MIN);
  assert.equal(row(LIVE_AGENT)?.state, 'running', 'no TTL on running rows');
});

test('run exit: an old run exiting leaves the new run\'s rows alone', () => {
  const oldRun = Symbol('old');
  const newRun = Symbol('new');
  const { live, row, registry, time } = harness({ run: oldRun });
  [liveCall, liveStarted].forEach((e) => live(e, oldRun));
  [agentCall, agentLaunched].forEach((e) => live(e, newRun));
  registry.runExited(SID, oldRun, time.now());
  assert.equal(row(LIVE_AGENT)?.state, 'unknown');
  assert.equal(row(RESUMED)?.state, 'running');
  [resumeCall].forEach((e) => live(e, newRun));
  live(resumeResult, newRun);
  registry.runExited(SID, oldRun, time.now());
  assert.equal(row(RESUMED)?.state, 'running', 'resumed under the new run');
  registry.runExited(SID, newRun, time.now());
  assert.equal(row(RESUMED)?.state, 'unknown');
});

test('malformed events, other task types and unknown ids are ignored', () => {
  const { live, registry } = harness();
  for (const event of [null, 'x', {}, { type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' },
    { type: 'system', subtype: 'task_started', task_id: 'w1', task_type: 'local_workflow' },
    { type: 'system', subtype: 'task_notification', task_id: 'nope', tool_use_id: 'nope', status: 'completed' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }]) {
    live(event as AnyRecord);
  }
  assert.deepEqual(registry.list(SID), []);
  observeClaudeAgentEvent(registry, null, liveStarted, { accuracy: 'live' });
  assert.deepEqual(registry.list(SID), []);
});

// --- Registry bounds -----------------------------------------------------------

test('caps: rows per session evict the oldest ended row first; sessions evict the oldest non-live', () => {
  const time = clock();
  const registry = new SessionAgentRegistry({ now: time.now, maxRowsPerSession: 3, maxSessions: 2 });
  const ctx = (at = time.now()) => ({ at, accuracy: 'live' as const, runToken: 'r' });
  registry.start(SID, { agentId: 'a1' }, ctx());
  registry.start(SID, { agentId: 'a2' }, ctx());
  registry.end(SID, { agentId: 'a2' }, 'done', ctx());
  registry.start(SID, { agentId: 'a3' }, ctx());
  registry.start(SID, { agentId: 'a4' }, ctx());
  assert.deepEqual(registry.list(SID).map((r) => r.key).sort(), ['a1', 'a3', 'a4'], 'ended a2 evicted first');
  registry.start(SID, { agentId: 'a5' }, ctx());
  assert.deepEqual(registry.list(SID).map((r) => r.key).sort(), ['a3', 'a4', 'a5'], 'then the oldest running row');

  registry.start('s-idle', { agentId: 'b1' }, ctx());
  registry.end('s-idle', { agentId: 'b1' }, 'done', ctx());
  registry.start('s-new', { agentId: 'c1' }, ctx());
  assert.equal(registry.sessionCount(), 2);
  assert.equal(registry.list('s-idle').length, 0, 'the session with no running row went first');
  assert.equal(registry.list(SID).length, 3, 'the live session survived');
});

test('ended rows age out after 30 minutes and empty sessions are dropped', () => {
  const time = clock();
  const registry = new SessionAgentRegistry({ now: time.now });
  registry.start(SID, { agentId: 'a1' }, { at: time.now(), accuracy: 'live' });
  registry.end(SID, { agentId: 'a1' }, 'done', { at: time.now(), accuracy: 'live' });
  time.advance(29 * MIN);
  assert.equal(registry.list(SID).length, 1);
  time.advance(2 * MIN);
  assert.equal(registry.list(SID).length, 0);
  assert.equal(registry.sessionCount(), 0);
});

test('adopt: reconstructed rows fill details but never override live state', () => {
  const { live, registry, row } = harness();
  [agentCall].forEach((e) => live(e));
  registry.adopt(SID, [{ key: RESUMED, sessionId: SID, source: 'claude-subagent', agentId: RESUMED,
    toolUseIds: [agentCall.message.content[0].id], label: 'from meta', agentType: 'frontend-dev', model: 'm',
    background: true, state: 'done', startedAt: 1, lastEventAt: Date.parse('2026-10-26T23:59:00Z'),
    endedAt: Date.parse('2026-10-26T23:59:00Z'), accuracy: 'reconstructed' }]);
  const merged = row(RESUMED)!;
  assert.deepEqual([merged.state, merged.accuracy, merged.model, merged.label],
    ['running', 'live', 'm', 'Implement sand selected states + fixes']);
  assert.equal(registry.list(SID).length, 1, 'provisional row re-keyed, not duplicated');
});

// --- Lazy boot -----------------------------------------------------------------

async function transcriptFixture(lines: string[], meta?: AnyRecord) {
  const dir = await realpath(await mkdtemp('/var/tmp/session-agents-boot-'));
  const file = path.join(dir, `${SID}.jsonl`);
  await writeFile(file, lines.map((l) => `${l}\n`).join(''));
  if (meta) {
    await mkdir(path.join(dir, SID, 'subagents'), { recursive: true });
    await writeFile(path.join(dir, SID, 'subagents', `agent-${RESUMED}.meta.json`), JSON.stringify(meta));
  }
  const fd = await open(file, 'r');
  const handle = { fd, realpath: file, stat: await stat(file, { bigint: true }), sessionId: SID, provider: 'claude' };
  return { dir, fd, handle };
}

test('boot tail: a window starting mid-line drops the cut line', async () => {
  const lines = [JSON.stringify({ pad: 'x'.repeat(200) }), JSON.stringify(agentCall), JSON.stringify(agentLaunched)];
  const { dir, fd } = await transcriptFixture(lines);
  try {
    const tail = lines[1].length + lines[2].length + 2 + 10;
    const records = await readTailRecords(fd, tail);
    assert.deepEqual(records.map((r) => r.uuid), [agentCall.uuid, agentLaunched.uuid]);
    assert.equal((await readTailRecords(fd, 1 << 20)).length, 3, 'whole file when it fits');
  } finally {
    await fd.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('boot: ended agents rebuilt, unended → unknown, unless a run is live; meta names a cut-off start', async () => {
  const events = [agentCall, agentLaunched, queuedCall, queuedResult, firstNote, resumeCall, resumeResult];
  const { dir, fd, handle } = await transcriptFixture(events.map((e) => JSON.stringify(e)), resumeDoc.agentMeta);
  const now = () => Date.parse('2026-10-26T20:10:00Z');
  try {
    const idle = await reconstructFromTranscript(SID, handle as never, { isRunLive: () => false, now });
    assert.deepEqual(idle.map((r) => [r.key, r.state, r.accuracy]), [[RESUMED, 'unknown', 'reconstructed']]);
    assert.equal(idle[0].runToken, undefined);
    const live = await reconstructFromTranscript(SID, handle as never, { isRunLive: () => true, now });
    assert.equal(live[0].state, 'running');

    const cut = JSON.stringify(resumeCall).length + JSON.stringify(resumeResult).length + 2;
    const resumedOnly = await reconstructFromTranscript(SID, handle as never,
      { isRunLive: () => false, now, tailBytes: cut + 5 });
    assert.deepEqual(resumedOnly.map((r) => [r.key, r.label, r.agentType]),
      [[RESUMED, resumeDoc.agentMeta.description, resumeDoc.agentMeta.agentType]], 'label from meta.json');
  } finally {
    await fd.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('boot: the full real sequence ends done', async () => {
  const { dir, fd, handle } = await transcriptFixture(resumeDoc.events.map((e) => JSON.stringify(e)));
  try {
    const rows = await reconstructFromTranscript(SID, handle as never, { isRunLive: () => true });
    assert.deepEqual(rows.map((r) => [r.key, r.state]), [[RESUMED, 'done']]);
  } finally {
    await fd.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Service: snapshot, broadcast, liveness ------------------------------------

function fakeSocket(userId: number) {
  const frames: AnyRecord[] = [];
  return { frames, socket: { readyState: 1, userId, send: (data: string) => frames.push(JSON.parse(data)) } };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('broadcast reaches every mirror with no writer or run; another session\'s socket gets nothing', async () => {
  const owner = fakeSocket(1);
  const viewer = fakeSocket(2);
  const elsewhere = fakeSocket(3);
  addSessionMirror('s-one', owner.socket as unknown as RealtimeClientConnection);
  addSessionMirror('s-one', viewer.socket as unknown as RealtimeClientConnection);
  addSessionMirror('s-two', elsewhere.socket as unknown as RealtimeClientConnection);
  resetSessionAgentsForTests({ deliver: broadcastToSessionMirrors, countMirrors: countLiveMirrors,
    providerOf: () => 'claude', reconstruct: async () => [], debounceMs: 5 });
  observeClaudeRunEvent('s-one', liveStarted, Symbol('run'));
  observeClaudeRunEvent('s-one', liveNote, Symbol('run'));
  await settle();
  for (const { frames } of [owner, viewer]) {
    assert.equal(frames.length, 1, 'one debounced snapshot');
    assert.equal(frames[0].type, 'session-agents');
    assert.deepEqual(frames[0].agents.map((r: PublicAgentRow) => [r.key, r.state]), [[LIVE_AGENT, 'done']]);
    assert.equal('runToken' in frames[0].agents[0], false);
  }
  assert.deepEqual(elsewhere.frames, []);
  assert.equal(broadcastToSessionMirrors('s-none', '{}'), 0);
  (viewer.socket as { readyState: number }).readyState = 3;
  assert.equal(broadcastToSessionMirrors('s-one', '{}'), 1, 'closed sockets are pruned');
});

test('no frame is built for a session nobody mirrors', async () => {
  let built = 0;
  resetSessionAgentsForTests({ countMirrors: () => 0, providerOf: () => { built += 1; return 'claude'; }, debounceMs: 1 });
  observeClaudeRunEvent('s-unwatched', liveStarted, Symbol('run'));
  await settle();
  assert.equal(built, 0);
});

test('snapshot: non-Claude unsupported; boot once; live rows first; labels sanitized', async () => {
  let boots = 0;
  const run = Symbol('run');
  resetSessionAgentsForTests({
    providerOf: (id) => (id === 's-codex' ? 'codex' : 'claude'),
    reconstruct: async () => {
      boots += 1;
      return [{ key: 'a-old', sessionId: 's', source: 'claude-subagent', agentId: 'a-old', toolUseIds: [],
        label: 'old\u0007 one', background: true, state: 'unknown', startedAt: Date.now() - MIN,
        lastEventAt: Date.now() - MIN, accuracy: 'reconstructed' }];
    },
    readWorkflowAgents: async (sessionId) => workflowAgentRows(sessionId, [{ sessionId, wfId: 'wf_1', status: 'running',
      agentsDone: 0, agentsTotal: 1, updatedAt: null, agentsTruncated: false, dormant: false,
      agents: [{ agentId: 'w1', ordinal: 1, status: 'stale', callCount: 0, currentTool: null, label: null,
        updatedAt: new Date(Date.now() - 2 * MIN).toISOString(), model: null, effort: null }] }], Date.now()),
  });
  assert.deepEqual(await getSessionAgentsSnapshot('s-codex'), { supported: false, agents: [] });
  observeClaudeRunEvent('s', { ...liveStarted, description: `${'x'.repeat(100)}\nsecond` }, run);
  const first = await getSessionAgentsSnapshot('s');
  await getSessionAgentsSnapshot('s');
  assert.equal(boots, 1, 'lazy boot is cached');
  assert.deepEqual(first.agents.map((r) => [r.key, r.state]),
    [[LIVE_AGENT, 'running'], ['a-old', 'unknown'], ['wf:wf_1:w1', 'unknown']]);
  assert.equal(first.agents[0].label.length, 80);
  assert.equal(first.agents[1].label, 'old one');
  assert.equal(first.agents[2].label, 'wf_1 #1');
  assert.equal(sanitizeLabel(undefined), undefined);

  const sent: AnyRecord[] = [];
  await sendSessionAgentsSnapshot('s-codex', (frame) => sent.push(frame as AnyRecord));
  await sendSessionAgentsSnapshot('s', (frame) => sent.push(frame as AnyRecord));
  assert.deepEqual(sent.map((f) => [f.type, f.sessionId]), [['session-agents', 's']], 'nothing for non-Claude');
});

test('run exit through the service: this run\'s rows unknown; unowned rows only once no run lives', async () => {
  let live = true;
  resetSessionAgentsForTests({ providerOf: () => 'claude', isRunLive: () => live,
    reconstruct: async () => [{ key: 'a-boot', sessionId: 's', source: 'claude-subagent', agentId: 'a-boot',
      toolUseIds: [], label: 'boot', background: true, state: 'running', startedAt: Date.now(),
      lastEventAt: Date.now(), accuracy: 'reconstructed' }] });
  const oldRun = Symbol('old');
  const newRun = Symbol('new');
  observeClaudeRunEvent('s', liveStarted, newRun);
  await getSessionAgentsSnapshot('s');
  claudeRunExited('s', oldRun);
  let states = Object.fromEntries((await getSessionAgentsSnapshot('s')).agents.map((r) => [r.key, r.state]));
  assert.deepEqual(states, { [LIVE_AGENT]: 'running', 'a-boot': 'running' });
  live = false;
  claudeRunExited('s', newRun);
  states = Object.fromEntries((await getSessionAgentsSnapshot('s')).agents.map((r) => [r.key, r.state]));
  assert.deepEqual(states, { [LIVE_AGENT]: 'unknown', 'a-boot': 'unknown' });
  claudeRunExited(null, newRun);
});

test('workflow rows: done/running/stale map to done/running/unknown', () => {
  const rows = workflowAgentRows('s', [{ sessionId: 's', wfId: 'wf_2', status: 'running', agentsDone: 1, agentsTotal: 3,
    updatedAt: '2026-10-27T00:00:00Z', agentsTruncated: false, dormant: false, agents: (['done', 'running', 'stale'] as const)
      .map((status, i) => ({ agentId: `w${i}`, ordinal: i + 1, status, callCount: 1, currentTool: null, label: `L${i}`,
        updatedAt: null, model: 'm', effort: 'high' })) }], 0);
  assert.deepEqual(rows.map((r) => [r.key, r.state, r.source, r.endedAt !== undefined]), [
    ['wf:wf_2:w0', 'done', 'workflow', true], ['wf:wf_2:w1', 'running', 'workflow', false],
    ['wf:wf_2:w2', 'unknown', 'workflow', false]]);
  assert.deepEqual(rows.map((r) => r.accuracy), ['live', 'live', 'reconstructed'], 'proven liveness is live');
});

test('workflow rows: an unproven workflow (orphan/unknown/frozen) stays reconstructed', () => {
  for (const status of ['orphan', 'unknown', 'frozen'] as const) {
    const rows = workflowAgentRows('s', [{ sessionId: 's', wfId: 'wf_3', status, agentsDone: 0, agentsTotal: 1,
      updatedAt: null, agentsTruncated: false, dormant: false, agents: [{ agentId: 'w0', ordinal: 1,
        status: 'running', callCount: 0, currentTool: null, label: null, updatedAt: null, model: null, effort: null }] }], 0);
    assert.equal(rows[0].accuracy, 'reconstructed', status);
  }
});
