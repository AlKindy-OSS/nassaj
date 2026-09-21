import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { codexCliAdapterInternals, createCodexCliAdapter } from './codex-cli-adapter.js';

function jsonl(text = 'done'): string {
  return [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } }),
  ].join('\n');
}

describe('Codex CLI Turn Supervisor adapter', () => {
  it('probes server-side governance and executable state', async () => {
    const adapter = createCodexCliAdapter({
      governanceProbe: () => true, executableProbe: async () => true,
    });
    assert.equal(await adapter.probe({ provider: 'codex', userId: 4 }), true);
    const refused = createCodexCliAdapter({
      governanceProbe: () => false, executableProbe: async () => true,
    });
    assert.equal(await refused.probe({ provider: 'codex', userId: 4 }), false);
  });

  it('launches the actual ephemeral/read-only/no-native-agent CLI contract and captures only', async () => {
    let launch: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const events: unknown[] = [];
    const adapter = createCodexCliAdapter({
      governanceProbe: () => true,
      executableProbe: async () => true,
      resolveEnv: () => ({ CODEX_HOME: '/isolated/codex' }),
      spawnCapture: async ({ args, env }) => {
        launch = { args, env };
        return { code: 0, stdout: jsonl('captured'), stderr: '' };
      },
    });
    const result = await adapter.invoke({
      provider: 'codex', userId: 9, model: 'gpt-5.3-codex', prompt: 'task',
      hiddenContext: ['strict role'], persist: false, effects: [],
      writer: { capture(event) { events.push(event); } },
    });
    assert.equal(result.text, 'captured');
    assert.equal(launch?.env.CODEX_HOME, '/isolated/codex');
    const args = launch?.args ?? [];
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--strict-config'));
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.some((value) => value.startsWith('developer_instructions=') && value.includes('Do not use tools')));
    assert.deepEqual(events, [
      { type: 'text', text: 'captured' },
      { type: 'usage', inputTokens: 11, outputTokens: 7 },
      { type: 'complete' },
    ]);
  });

  it('fails closed on effects, non-ephemeral invocation, empty final output and abort', async () => {
    const adapter = createCodexCliAdapter({
      governanceProbe: () => true, executableProbe: async () => true,
      spawnCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const base = {
      provider: 'codex' as const, userId: 1, model: 'gpt', prompt: 'x',
      persist: false as const, writer: { capture() {} },
    };
    await assert.rejects(adapter.invoke({ ...base, effects: [{}] }), /deny effects/u);
    await assert.rejects(adapter.invoke({ ...base }), /no final assistant/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter.invoke({ ...base, signal: controller.signal }), /aborted before launch/u);
  });

  it('aborts and reaps the entire CLI process group before settling', async () => {
    const directory = await mkdtemp('/var/tmp/nassaj-codex-tree-');
    const marker = `${directory}/late-child-write`;
    const controller = new AbortController();
    try {
      const pending = codexCliAdapterInternals.spawnCapture({
        binary: '/bin/bash',
        args: ['-c', 'sleep 1; printf x > "$1"', '_', marker],
        cwd: directory, env: process.env, signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(pending, /aborted/u);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await assert.rejects(access(marker));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
