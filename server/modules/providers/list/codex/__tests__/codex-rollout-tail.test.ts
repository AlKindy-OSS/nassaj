/**
 * ADR-199 P4b (Addendum B §20, B.3): live Codex subagents from the parent rollout tail.
 *
 * Fixture `codex-progress.real.json` (see its `_provenance`): the rollout of a real
 * `codex exec --json` 0.160.0 thread (user 1's CODEX_HOME, temp cwd) with spawn_agent,
 * SubAgentActivity, wait_agent and the child's FINAL_ANSWER, scrubbed. The same lines
 * feed the history fold, so the live/history id parity is checked on identical bytes.
 * Filler lines are synthetic padding only (budget and oversize cases).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { codexSessionMetaLine, codexSessionsSandbox, withPinnedTranscript } from '@/shared/__tests__/provider-root-sandbox.js';

let historyPath = '';
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: historyPath }) },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-history-cursor-key' },
} });
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
const {
  CODEX_TAIL_LIMITS, createCodexRunSubagentTail, readRolloutTick, startCodexRolloutTail,
} = await import('../codex-rollout-tail.js');
const { withTranscriptReadPermit } = await import('../codex-rollout-links.js');

type Row = Record<string, any>;
const real = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'codex-progress.real.json'), 'utf8')) as Row;
const THREAD = real.stream[0].thread_id as string;
const SPAWN_ID = 'call_e5656dae1b7a404980a968644f059dc3';
const NOW = () => new Date(2026, 9, 9, 10, 17, 5);
const FAST = { pollMs: 5, waitStepMs: 5, waitMaxMs: 60 };

const root = codexSessionsSandbox('rollout-tail-');
const outside = codexSessionsSandbox('rollout-tail-outside-');
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

let caseNo = 0;
/** A fresh `<root>/home-N` CODEX_HOME whose `sessions` root holds the rollout's date directory. */
function freshRoot(): { home: string; sessionsRoot: string; file: string } {
  caseNo += 1;
  const home = path.join(root, `home-${caseNo}`);
  const sessionsRoot = path.join(home, 'sessions');
  const dir = path.join(sessionsRoot, '2026', '10', '09');
  fs.mkdirSync(dir, { recursive: true });
  return { home, sessionsRoot, file: path.join(dir, `rollout-2026-10-09T10-17-05-${THREAD}.jsonl`) };
}

const lineOf = (entry: unknown) => `${JSON.stringify(entry)}\n`;
/**
 * Every Codex rollout opens with `session_meta` (the capture above was trimmed
 * after it); the tail binds the file to the thread by that header (ADR-201
 * A1.4), so the real-derived header is put back in front.
 */
const META = `${codexSessionMetaLine(THREAD)}\n`;
const rollout = () => [META, ...(real.rollout as Row[]).map(lineOf)];
/** Index of the spawn_agent line in {@link rollout} (after the header). */
const spawnIndex = () => (real.rollout as Row[]).findIndex((row) => row.payload.name === 'spawn_agent') + 1;

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Open fds of this process that resolve to `file`. */
function fdsOn(file: string): number {
  let count = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(file)) count += 1;
    } catch {
      // fd closed while scanning
    }
  }
  return count;
}

function tail(sessionsRoot: string, extra: Row = {}) {
  const signals: Row[] = [];
  const handle = startCodexRolloutTail({
    threadId: THREAD, sessionsRoot, resumed: false, now: NOW, limits: FAST,
    onSignal: (signal: Row) => signals.push(signal), ...extra,
  });
  return { handle, signals };
}

test('a labelled spawn appears live while the file grows, settles from the parent FINAL_ANSWER, same id as history', async () => {
  const { home, file: liveFile } = freshRoot();
  const lines = rollout();
  const cut = spawnIndex() + 1;
  fs.writeFileSync(liveFile, lines.slice(0, 1).join(''));
  const rows: Row[] = [];
  const run = createCodexRunSubagentTail({
    enabled: true, codexHome: () => home, signal: new AbortController().signal, sessionId: () => THREAD,
    emit: (row: Row) => rows.push(row),
    start: (options: Row) => startCodexRolloutTail({ ...options, now: NOW, limits: FAST } as any),
  });
  run.onThreadStarted(THREAD, false, null);
  fs.appendFileSync(liveFile, lines.slice(1, cut).join(''));
  await until(() => rows.length === 1);
  assert.equal(rows[0].kind, 'tool_use');
  assert.equal(rows[0].id, SPAWN_ID);
  assert.equal(rows[0].subagent.state, 'started');
  fs.appendFileSync(liveFile, lines.slice(cut).join(''));
  await until(() => rows.length === 2);
  assert.equal(rows[1].kind, 'tool_result');
  assert.equal(rows[1].toolId, SPAWN_ID);
  assert.equal(rows[1].subagent.state, 'completed');
  await run.stop({ drain: true });
  assert.equal(fdsOn(liveFile), 0, 'fd closed on complete');

  historyPath = liveFile;
  const history = (await withPinnedTranscript(historyPath, 'tail-parity', 'codex',
    (pinned) => new CodexSessionsProvider().fetchHistory('tail-parity', { transcript: pinned }))).messages as Row[];
  const [task] = history.filter((row) => row.subagent);
  assert.equal(task.id, rows[0].id, 'live and history share the spawn id, so dedup keeps one');
  assert.equal(task.subagent.id, rows[0].subagent.id);
  assert.equal(task.subagent.label, rows[0].subagent.label);
  assert.equal(task.subagent.state, rows[1].subagent.state);
  assert.ok(!JSON.stringify(rows).includes('gAAAA'), 'never the encrypted spawn message');
});

test('resume starts at the size when opened: earlier spawns are not re-emitted, new ones are', async () => {
  const { sessionsRoot, file } = freshRoot();
  fs.writeFileSync(file, rollout().join(''));
  const { handle, signals } = tail(sessionsRoot, { resumed: true, storedPath: file });
  await until(() => handle.phase === 'tailing');
  const next = JSON.parse(JSON.stringify(real.rollout[spawnIndex() - 1]));
  next.payload.call_id = 'call_resume_next';
  fs.appendFileSync(file, lineOf(next));
  await until(() => signals.length === 1);
  assert.deepEqual(signals.map((signal) => signal.callId), ['call_resume_next']);
  await handle.stop();
});

test('once a labelled spawn exists the anonymous collab card is hidden; a shown one may still settle', async () => {
  const { home, file: liveFile } = freshRoot();
  const rows: Row[] = [];
  const run = createCodexRunSubagentTail({
    enabled: true, codexHome: () => home, signal: new AbortController().signal, sessionId: () => THREAD,
    emit: (row: Row) => rows.push(row),
    start: (options: Row) => startCodexRolloutTail({ ...options, now: NOW, limits: FAST } as any),
  });
  const collab = (uuid: string, progressPhase: string, progressOpened: boolean) =>
    ({ itemType: 'collab_tool_call', uuid, progressPhase, progressOpened });
  fs.writeFileSync(liveFile, META);
  run.onThreadStarted(THREAD, false, null);
  assert.equal(run.hidesCollab(collab('shown', 'started', false)), false, 'no spawn yet: anonymous card shows');
  fs.appendFileSync(liveFile, rollout().slice(1, spawnIndex() + 1).join(''));
  await until(() => rows.length === 1);
  assert.equal(run.hidesCollab(collab('later', 'started', false)), true);
  assert.equal(run.hidesCollab(collab('later', 'completed', true)), true, 'a hidden card stays hidden to the end');
  assert.equal(run.hidesCollab(collab('shown', 'completed', true)), false, 'an already shown card settles');
  assert.equal(run.hidesCollab({ itemType: 'todo_list', uuid: 'plan' }), false);
  await run.stop();
});

test('rotation, replacement, symlink swap and truncation each stop the tail and close the fd', async () => {
  const mutations: Array<[string, (file: string) => void]> = [
    ['rotation', (file) => fs.renameSync(file, `${file}.1`)],
    ['replacement', (file) => { fs.rmSync(file); fs.writeFileSync(file, rollout().join('')); }],
    ['symlink swap', (file) => { fs.copyFileSync(file, `${file}.copy`); fs.rmSync(file); fs.symlinkSync(`${file}.copy`, file); }],
    ['truncation', (file) => fs.truncateSync(file, 10)],
  ];
  for (const [name, mutate] of mutations) {
    const { sessionsRoot, file } = freshRoot();
    fs.writeFileSync(file, rollout().slice(0, 1).join(''));
    const { handle, signals } = tail(sessionsRoot);
    await until(() => handle.phase === 'tailing');
    await new Promise((resolve) => setTimeout(resolve, 20));
    mutate(file);
    await until(() => handle.phase === 'closed');
    assert.equal(fdsOn(fs.realpathSync(sessionsRoot)), 0, `${name}: fd closed`);
    fs.appendFileSync(file, rollout().slice(1).join(''));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signals.length, 0, `${name}: nothing read after the stop`);
    await handle.stop();
  }
});

test('a symlinked rollout and a stored path outside the principal root are never opened', async () => {
  const { sessionsRoot, file } = freshRoot();
  const target = path.join(sessionsRoot, 'real.jsonl');
  fs.writeFileSync(target, rollout().join(''));
  fs.symlinkSync(target, file);
  const linked = tail(sessionsRoot);
  await until(() => linked.handle.phase === 'closed');
  assert.equal(linked.signals.length, 0, 'symlink candidate rejected');

  const foreign = path.join(outside, `rollout-2026-10-09T10-17-05-${THREAD}.jsonl`);
  fs.writeFileSync(foreign, rollout().join(''));
  const other = freshRoot();
  const escaped = tail(other.sessionsRoot, { storedPath: foreign });
  await until(() => escaped.handle.phase === 'closed');
  assert.equal(escaped.signals.length, 0, 'path outside the run root rejected');
  assert.equal(fdsOn(foreign), 0);
});

test('missing file: bounded retries, then a silent give-up within the wait window', async () => {
  const { sessionsRoot } = freshRoot();
  let permits = 0;
  const started = Date.now();
  const { handle, signals } = tail(sessionsRoot, {
    permit: <T>(signal: AbortSignal | undefined, read: () => Promise<T>) => { permits += 1; return withTranscriptReadPermit(signal, read); },
  });
  await until(() => handle.phase === 'closed');
  assert.ok(Date.now() - started < 1000);
  assert.equal(permits, Math.floor(FAST.waitMaxMs / FAST.waitStepMs) + 1, 'one permit per attempt');
  assert.equal(signals.length, 0);
  assert.equal(CODEX_TAIL_LIMITS.waitMaxMs, 5000, 'production give-up is 5 s');
  assert.equal(CODEX_TAIL_LIMITS.waitStepMs, 250);
});

test('the fd is closed after cancel (abort signal) and after process exit (stop without drain)', async () => {
  for (const how of ['cancel', 'exit']) {
    const { sessionsRoot, file } = freshRoot();
    fs.writeFileSync(file, rollout().join(''));
    const ac = new AbortController();
    const { handle } = tail(sessionsRoot, { signal: ac.signal });
    await until(() => handle.phase === 'tailing');
    assert.equal(fdsOn(file), 1, `${how}: exactly one fd while tailing`);
    if (how === 'cancel') ac.abort(); else await handle.stop();
    await until(() => handle.phase === 'closed');
    await handle.stop();
    assert.equal(fdsOn(file), 0, `${how}: fd closed`);
  }
});

test('the read permit is taken per tick and released between ticks', async () => {
  const { sessionsRoot, file } = freshRoot();
  fs.writeFileSync(file, rollout().join(''));
  const events: Array<[string, number]> = [];
  const { handle } = tail(sessionsRoot, {
    limits: { ...FAST, pollMs: 15 },
    permit: async <T>(signal: AbortSignal | undefined, read: () => Promise<T>) => withTranscriptReadPermit(signal, async () => {
      events.push(['acquire', Date.now()]);
      try { return await read(); } finally { events.push(['release', Date.now()]); }
    }),
  });
  await until(() => events.filter(([kind]) => kind === 'release').length >= 5);
  await handle.stop();
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index][0], index % 2 === 0 ? 'acquire' : 'release', 'never held across a pause');
  }
  for (let index = 2; index < events.length; index += 2) {
    assert.ok(events[index][1] - events[index - 1][1] >= 10, 'a pause separates release and the next acquire');
  }
});

test('byte budget: ordinary lines are read ~256 KB per tick; a spawn behind a >1 MB line arrives in one tick', async () => {
  const { file } = freshRoot();
  const spawnLine = rollout()[spawnIndex()];
  const filler = lineOf({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(10_000) } });
  fs.writeFileSync(file, filler.repeat(100) + spawnLine);
  const limits = { ...CODEX_TAIL_LIMITS };
  const handle = await open(file, 'r');
  try {
    const state = { offset: 0, carry: [] as Buffer[], carryBytes: 0, discarding: false };
    const seen: string[] = [];
    let ticks = 0;
    while (!seen.some((line) => line.includes('"spawn_agent"'))) {
      ticks += 1;
      await readRolloutTick(handle, state, limits, (line: Buffer) => seen.push(line.toString('utf8')));
      if (ticks === 1) {
        assert.ok(state.offset <= limits.tickBytes + limits.chunkBytes, 'one tick stops at the budget (+ one chunk)');
      }
      assert.ok(ticks < 10);
    }
    assert.ok(ticks >= 3, `~1 MB of ordinary lines takes several 256 KB ticks (took ${ticks})`);

    fs.writeFileSync(file, lineOf({ payload: { type: 'function_call_output', output: 'y'.repeat(2 * 1024 * 1024) } }) + spawnLine);
    const fresh = { offset: 0, carry: [] as Buffer[], carryBytes: 0, discarding: false };
    const lines: string[] = [];
    await readRolloutTick(handle, fresh, limits, (line: Buffer) => lines.push(line.toString('utf8')));
    assert.deepEqual(lines, [spawnLine.trimEnd()], 'oversize line discarded unparsed; spawn in the same tick');
  } finally {
    await handle.close();
  }
});

test('a torn trailing line is buffered until its newline arrives', async () => {
  const { file } = freshRoot();
  const spawnLine = rollout()[spawnIndex()];
  fs.writeFileSync(file, spawnLine.slice(0, 100));
  const handle = await open(file, 'r');
  try {
    const state = { offset: 0, carry: [] as Buffer[], carryBytes: 0, discarding: false };
    const lines: string[] = [];
    await readRolloutTick(handle, state, CODEX_TAIL_LIMITS, (line: Buffer) => lines.push(line.toString('utf8')));
    assert.equal(lines.length, 0);
    fs.appendFileSync(file, spawnLine.slice(100));
    await readRolloutTick(handle, state, CODEX_TAIL_LIMITS, (line: Buffer) => lines.push(line.toString('utf8')));
    assert.deepEqual(lines, [spawnLine.trimEnd()]);
  } finally {
    await handle.close();
  }
});

test('only the parent rollout is opened: a child rollout beside it never gets an fd', async () => {
  const { sessionsRoot, file } = freshRoot();
  const childThread = real.rollout.find((row: Row) => row.payload?.item?.agent_thread_id).payload.item.agent_thread_id;
  const child = path.join(path.dirname(file), `rollout-2026-10-09T10-17-42-${childThread}.jsonl`);
  fs.writeFileSync(child, rollout().join(''));
  fs.writeFileSync(file, META);
  const { handle, signals } = tail(sessionsRoot);
  await until(() => handle.phase === 'tailing');
  fs.appendFileSync(file, rollout().slice(1).join(''));
  await until(() => signals.length === 2);
  assert.equal(fdsOn(child), 0);
  assert.equal(fdsOn(file), 1);
  await handle.stop();
  assert.deepEqual(signals.map((signal) => signal.kind), ['spawn', 'settle']);
});

/** Takes every permit of the process-wide read gate (4) until `release` is called. */
async function holdAllPermits(): Promise<{ release: () => Promise<void> }> {
  const openers: Array<() => void> = [];
  const held = Array.from({ length: 4 }, () => withTranscriptReadPermit(undefined,
    () => new Promise<void>((resolve) => { openers.push(resolve); })));
  await until(() => openers.length === 4);
  return { release: async () => { openers.forEach((open) => open()); await Promise.all(held); } };
}

test('T-1992 drain is bounded: with every permit held, stop returns within drainTimeoutMs and closes the fd', async () => {
  assert.equal(CODEX_TAIL_LIMITS.drainTimeoutMs, 1000, 'production drain bound is 1 s');
  const { sessionsRoot, file } = freshRoot();
  fs.writeFileSync(file, rollout().slice(0, spawnIndex() + 1).join(''));
  const { handle, signals } = tail(sessionsRoot, { limits: { ...FAST, drainTimeoutMs: 150 } });
  await until(() => handle.spawnSeen);
  const gate = await holdAllPermits();
  try {
    fs.appendFileSync(file, rollout().slice(spawnIndex() + 1).join(''));
    const started = Date.now();
    await handle.stop({ drain: true });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100 && elapsed < 600, `drain gave up at its bound (${elapsed} ms)`);
    assert.equal(handle.phase, 'closed');
    assert.equal(fdsOn(file), 0, 'fd closed although the drain never got a permit');
    assert.equal(signals.filter((signal) => signal.kind === 'settle').length, 0, 'the skipped drain read nothing');
  } finally {
    await gate.release();
  }
});

test('T-1992 drain is skipped without a spawn: stop never waits for a permit', async () => {
  const { sessionsRoot, file } = freshRoot();
  fs.writeFileSync(file, rollout().slice(0, spawnIndex()).join(''));
  const { handle } = tail(sessionsRoot);
  await until(() => handle.phase === 'tailing');
  const gate = await holdAllPermits();
  try {
    const started = Date.now();
    await handle.stop({ drain: true });
    assert.equal(handle.spawnSeen, false);
    assert.ok(Date.now() - started < 100, 'no spawn seen: completion is not held by the read gate');
    assert.equal(fdsOn(file), 0);
  } finally {
    await gate.release();
  }
});

test('T-1992 features.multi_agent gate: disabled opens no fd, takes no permit, polls nothing; enabled tails', async () => {
  for (const enabled of [false, true]) {
    const { home, file } = freshRoot();
    fs.writeFileSync(file, rollout().slice(0, spawnIndex() + 1).join(''));
    let starts = 0;
    let permits = 0;
    const rows: Row[] = [];
    const run = createCodexRunSubagentTail({
      enabled, codexHome: () => home, signal: new AbortController().signal, sessionId: () => THREAD,
      emit: (row: Row) => rows.push(row),
      start: (options: Row) => {
        starts += 1;
        return startCodexRolloutTail({ ...options, now: NOW, limits: FAST,
          permit: <T>(signal: AbortSignal | undefined, read: () => Promise<T>) => { permits += 1; return withTranscriptReadPermit(signal, read); },
        } as any);
      },
    });
    run.onThreadStarted(THREAD, false, null);
    if (enabled) {
      await until(() => rows.length === 1);
      assert.equal(fdsOn(file), 1, 'enabled: the parent rollout is tailed');
    } else {
      await new Promise((resolve) => setTimeout(resolve, 4 * FAST.pollMs + 20));
      assert.equal(fdsOn(file), 0, 'disabled: no fd');
      assert.equal(rows.length, 0);
      assert.equal(run.hidesCollab({ itemType: 'collab_tool_call', uuid: 'c', progressPhase: 'started' }), false);
    }
    assert.equal(starts, enabled ? 1 : 0, 'disabled: no tail is started, so nothing polls');
    assert.equal(permits > 0, enabled, 'disabled: no permit is taken');
    await run.stop({ drain: true });
    assert.equal(fdsOn(file), 0);
  }
});
