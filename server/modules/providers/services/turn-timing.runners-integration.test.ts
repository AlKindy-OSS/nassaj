import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, mock } from 'node:test';

type CompletedInput = {
  turnId: string;
  sessionId: string;
  assistantMessageId: string;
  startedAt: string;
  completedAt: string;
};

const completed = new Map<string, CompletedInput>();

mock.module('@/modules/database/index.js', {
  namedExports: {
    responseTurnMetricsDb: {
      recordCompleted(input: CompletedInput) {
        const previous = completed.get(input.turnId);
        if (previous) return { status: 'idempotent', metric: null };
        completed.set(input.turnId, input);
        return {
          status: 'inserted',
          metric: {
            ...input,
            durationMs: Date.parse(input.completedAt) - Date.parse(input.startedAt),
          },
        };
      },
      sumSessionDuration(sessionId: string) {
        return [...completed.values()]
          .filter((row) => row.sessionId === sessionId)
          .reduce((total, row) => total + Date.parse(row.completedAt) - Date.parse(row.startedAt), 0);
      },
    },
  },
});

const { createTurnTimer, settleTurnTiming } = await import('./turn-timing.service.js');

after(() => mock.restoreAll());

test('shared runner timing keeps no-answer unknown and settles a terminal turn once', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(Date.parse('2026-09-02T10:00:00.000Z'));
  const timer = createTurnTimer();

  assert.equal(timer.startedAt(), null, 'spawn time is not model activity');
  assert.deepEqual(settleTurnTiming({
    sessionId: 'no-answer', assistantMessageId: null, startedAt: timer.startedAt(),
    completedAt: '2026-09-02T10:00:05.000Z', turnId: 'no-answer-turn',
  }), {}, 'a terminal run without an answer must not invent a zero duration');

  timer.markModelActivity();
  t.mock.timers.tick(1_250);
  timer.markModelActivity();
  assert.equal(timer.startedAt(), '2026-09-02T10:00:00.000Z', 'later events do not move the start');

  const input = {
    sessionId: 'answered', assistantMessageId: 'assistant-1', startedAt: timer.startedAt(),
    completedAt: new Date().toISOString(), turnId: 'terminal-once',
  };
  assert.equal(settleTurnTiming(input).responseTurnMetric?.durationMs, 1_250);
  assert.deepEqual(settleTurnTiming(input), {}, 'a duplicate terminal cannot add a second metric');
  assert.equal(completed.size, 1);
});

const RUNNERS = [
  { provider: 'agy', file: '../../../agy-cli.js', outputGate: /const durableTiming = finalTranscriptMessage/ },
  { provider: 'cursor', file: '../../../cursor-cli.js', outputGate: /assistantMessageId: lastAssistantMessageId/ },
  { provider: 'hermes', file: '../../../hermes-cli.js', outputGate: /succeeded && sawAssistantOutput/ },
  { provider: 'kimi', file: '../../../kimi-agent-cli.js', outputGate: /code === 0 && sawAssistantOutput/ },
  { provider: 'opencode', file: '../../../opencode-cli.js', outputGate: /assistantMessageId: lastAssistantMessageId/ },
  { provider: 'qwen', file: '../../../qwen-cli.js', outputGate: /!failure && answer/ },
] as const;

test('Codex completion carries its durable rollout id to the live reply bridge', async () => {
  const codex = await readFile(new URL('../../../openai-codex.js', import.meta.url), 'utf8');
  assert.match(codex, /assistantMessageId: durableTurn\.assistantMessageId/,
    'Codex must persist timing under the durable rollout message id');
  assert.match(codex, /transcriptMessageId: durableTurn\.assistantMessageId/,
    'the completion must disclose that durable id so the live item_N reply can be joined');
  assert.match(codex, /\.\.\.durableTiming/,
    'the terminal frame must carry the durable-id bridge to the client');
});

for (const runner of RUNNERS) {
  test(`${runner.provider} wires model activity and successful answer settlement into its terminal frame`, async () => {
    const source = await readFile(new URL(runner.file, import.meta.url), 'utf8');
    assert.match(source, /import \{ createTurnTimer, settleTurnTiming \}/);
    assert.match(source, /const turnTimer = createTurnTimer\(\)/);
    assert.match(source, /turnTimer\.markModelActivity\(\)/);
    assert.match(source, runner.outputGate, 'settlement must require provider-attested answer output');
    assert.match(source, /settleTurnTiming\(\{/);
    assert.match(source, /startedAt: turnTimer\.startedAt\(\)/);
    assert.match(source, /completedAt: (?:new Date\(\)\.toISOString\(\)|processCompletedAt)/);
    assert.match(source, /\.\.\.durableTiming/,
      'the measured result must be attached to the provider terminal frame');
  });
}

test('cursor and Qwen guard competing terminal paths from duplicate persistence', async () => {
  const cursor = await readFile(new URL('../../../cursor-cli.js', import.meta.url), 'utf8');
  assert.match(cursor, /if \(timingSettled\) return \{\};\s*timingSettled = true;/,
    'Cursor can terminate on both result and child close');

  const qwen = await readFile(new URL('../../../qwen-cli.js', import.meta.url), 'utf8');
  assert.match(qwen, /if \(state\.finalized\) return;\s*state\.finalized = true;/,
    'Qwen can terminate on both child error and child close');
  assert.match(qwen, /child\.once\('close'/);
});

test('OpenCode recognizes its live stream_delta as the assistant answer', async () => {
  const opencode = await readFile(new URL('../../../opencode-cli.js', import.meta.url), 'utf8');
  assert.match(opencode, /msg\.kind === 'stream_delta' && msg\.content\?\.trim\(\)/,
    'the live normalizer never emits text/assistant, so that history-only shape cannot gate timing');
});

test('Qwen treats a trailing NDJSON answer without newline as model activity before finalization', async () => {
  const qwen = await readFile(new URL('../../../qwen-cli.js', import.meta.url), 'utf8');
  const closeHandler = qwen.slice(qwen.indexOf("child.once('close'"), qwen.indexOf('/** Builds the measured Qwen'));

  assert.match(closeHandler, /state\.buffer\.trim\(\)/);
  assert.match(closeHandler, /JSON\.parse\(state\.buffer\)/);
  assert.match(closeHandler, /event\?\.type === 'stream_event' \|\| event\?\.type === 'assistant'/);
  assert.ok(closeHandler.indexOf('turnTimer.markModelActivity()') < closeHandler.indexOf('parseQwenEvent(event'),
    'the unterminated final answer must start timing before it is parsed');
  assert.ok(closeHandler.indexOf('parseQwenEvent(event') < closeHandler.indexOf('void finalize(code)'),
    'the final answer must exist before settlement runs');
});
