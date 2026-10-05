/**
 * codex-exec-command-history.test.ts — B-1489: current Codex rollouts record
 * shell commands as an `exec` script calling `tools.exec_command({cmd: ...})`.
 * History used to recognize only `tools.shell_command({command: ...})`, so
 * every such call was dropped (tool_use and its result) after a refresh, and
 * the client then discarded the live cards too (retainUnconfirmedRealtime).
 *
 * The fixtures follow the shape of a current Codex rollout (session_meta reduced
 * to identity fields; only the exec calls and their outputs kept). Every path,
 * UUID and call id in them is synthetic (B-1504).
 *
 * Runner: node:test via scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it, mock } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/codex-exec-command-'));
const transcript = path.join(sandbox, 'rollout.jsonl');
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-history-cursor-key' },
} });
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
const { HistoryReadLease } = await import('../../../services/history-budget.service.js');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const fixture = (name: string) => fs.readFileSync(
  path.join(import.meta.dirname, '../__fixtures__', name), 'utf8');
const FIXTURE = fixture('codex-exec-command-rollout.jsonl');
/** Running exec: `Script running with cell ID` → `wait` → final output (logs scrubbed). */
const RUNNING_FIXTURE = fixture('codex-exec-command-running-rollout.jsonl');
const MiB = 1024 * 1024;

async function history(text: string, withLease: boolean) {
  fs.writeFileSync(transcript, text);
  const provider = new CodexSessionsProvider();
  if (!withLease) return provider.fetchHistory('exec-command-session');
  const lease = new HistoryReadLease(new AbortController().signal);
  try {
    await lease.initialize(transcript);
    return await provider.fetchHistory('exec-command-session', { historyLease: lease });
  } finally {
    await lease.close();
  }
}

/** One synthetic `exec` custom tool call (and its completed output) in rollout shape. */
function execCall(callId: string, input: string): string {
  const call = { type: 'response_item', timestamp: '2026-10-01T20:26:35.617Z', payload: {
    type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input } };
  const output = { type: 'response_item', timestamp: '2026-10-01T20:26:35.680Z', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: 'ok' }] } };
  return `${JSON.stringify(call)}\n${JSON.stringify(output)}\n`;
}

/** History keeps toolInput as the JSON text the client parses (same as shell_command). */
const bashCommands = (messages: any[]) => messages
  .filter((row) => row.kind === 'tool_use')
  .map((row) => ({
    name: row.toolName,
    command: JSON.parse(row.toolInput).command,
    settled: Boolean(row.toolResult),
  }));

describe('B-1489: tools.exec_command history recovery', () => {
  for (const withLease of [false, true]) {
    it(`recovers every exec_command call of the real rollout (lease: ${withLease})`, async () => {
      const result = await history(FIXTURE, withLease);
      assert.deepEqual(bashCommands(result.messages), [
        { name: 'Bash', command: "rg --files -g '*'", settled: true },
        { name: 'Bash', command: "rg --files --hidden -g '!.git/**'", settled: true },
        { name: 'Bash', command: "rg --files --hidden -g '!.git/**'", settled: true },
      ]);
      const ids = result.messages.map((row: any) => row.id);
      assert.equal(new Set(ids).size, ids.length, 'history rows must be unique');
    });
  }

  it('reads quoted, multiline and single-quoted cmd keys and several calls per script', async () => {
    const script = [
      'const a = await tools.exec_command({"cmd":"git status","workdir":"/w"});',
      "const b = await tools.exec_command({\n  workdir: '/w',\n  cmd: 'ls -la',\n});",
      'text(a.output + b.output);',
    ].join('\n');
    const result = await history(execCall('call_multi', script), true);
    assert.deepEqual(bashCommands(result.messages),
      [{ name: 'Bash', command: 'git status\nls -la', settled: true }]);
  });

  it('never treats a cmd: outside an exec_command call as a command', async () => {
    const script = [
      'const meta = {cmd:"rm -rf /should-not-appear"};',
      'const r = await tools.exec_command({workdir: "/w", opts: {cmd: "nested-ignored"}, cmd: "pwd"});',
      'text(JSON.stringify({cmd: "also-ignored"}) + r.output);',
    ].join('\n');
    const result = await history(execCall('call_scope', script), false);
    assert.deepEqual(bashCommands(result.messages), [{ name: 'Bash', command: 'pwd', settled: true }]);
  });

  it('drops (as before) an exec whose cmd is computed rather than a literal', async () => {
    const script = 'const c = "ls"; const r = await tools.exec_command({cmd: c + " -la"});';
    const result = await history(execCall('call_computed', script), false);
    assert.deepEqual(bashCommands(result.messages), []);
    assert.equal(result.messages.filter((row: any) => row.kind === 'tool_result').length, 0,
      'the orphan output of an unrecognized exec must stay suppressed');
  });

  it('settles a running exec (cell, wait, output) as one card with its output', async () => {
    for (const withLease of [false, true]) {
      const result = await history(RUNNING_FIXTURE, withLease);
      const cards = result.messages.filter((row: any) => row.kind === 'tool_use');
      assert.equal(cards.length, 1);
      assert.equal(JSON.parse(cards[0].toolInput).command,
        'pm2 status; pm2 logs nassaj-dev --lines 260 --nostream 2>&1 | tail -n 420');
      assert.match(cards[0].toolResult?.content ?? '',
        /scrubbed log line 1\n\[PM2\] scrubbed log line 2/);
      assert.equal(result.messages.filter((row: any) => row.kind === 'tool_result').length, 0,
        'the wait output must fold into the card, not float as its own row');
    }
  });

  it('ignores exec_command text inside strings and comments', async () => {
    const script = [
      'text("tools.exec_command({cmd:\'phantom-string\'})");',
      '// tools.exec_command({cmd:"phantom-line-comment"})',
      '/* tools.exec_command({cmd:"phantom-block-comment"}) */',
      'const t = `tools.exec_command({cmd:"phantom-template"})`;',
      'const r = await tools.exec_command({cmd:"real"});',
      'mytools.exec_command({cmd:"phantom-identifier"});',
    ].join('\n');
    const result = await history(execCall('call_phantom', script), true);
    assert.deepEqual(bashCommands(result.messages),
      [{ name: 'Bash', command: 'real', settled: true }]);
  });

  it('caps the number of recovered commands per script', async () => {
    const script = Array.from({ length: 200 }, (_, i) => `await tools.exec_command({cmd:"c${i}"});`)
      .join('\n');
    const result = await history(execCall('call_many', script), false);
    assert.equal(JSON.parse(result.messages[0].toolInput).command.split('\n').length, 64);
  });

  for (const [label, unit] of [
    ['unclosed call heads', 'tools.exec_command({'],
    ['unclosed cmd properties', 'tools.exec_command({cmd:"x",'],
    ['closed calls with computed cmd', 'tools.exec_command({cmd:c});'],
  ]) {
    it(`scans ~1 MiB of adversarial ${label} in linear time`, async () => {
      const script = unit.repeat(Math.floor((MiB - 4096) / unit.length));
      const startedAt = performance.now();
      await history(execCall(`call_adversarial`, script), false);
      const elapsed = performance.now() - startedAt;
      // Quadratic scanning took >10 s at 200 KB; linear stays far below this bound even under load.
      assert.ok(elapsed < 500, `history took ${Math.round(elapsed)} ms`);
    });
  }
});
