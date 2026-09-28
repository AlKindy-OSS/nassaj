import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { setCodexRuntimeEvaluatorForTests } from '../../../shared/codex-runtime-compat.js';

import { codexCliAdapterInternals, createCodexCliAdapter } from './codex-cli-adapter.js';

// The stand-in identity below is not a real release; accept it for the compat verdict.
setCodexRuntimeEvaluatorForTests(async () => ({ compatible: true, version: '0.156.0', reason: null, checks: {} }));

// T-1872: a frozen machine-release identity stands in for ~/.local/bin/codex.
const machineIdentity = Object.freeze({
  executablePath: '/machine/releases/0.156.0/bin/codex', pathDirs: Object.freeze(['/machine/releases/0.156.0/codex-path']),
}) as never;
const machine = { acquireIdentity: () => machineIdentity, assertUnchanged: () => {} };

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
    let launch: { binary: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const events: unknown[] = [];
    let checked = 0;
    const adapter = createCodexCliAdapter({
      governanceProbe: () => true,
      executableProbe: async () => true,
      acquireIdentity: machine.acquireIdentity,
      assertUnchanged: (identity) => { assert.equal(identity, machineIdentity); checked += 1; },
      resolveEnv: () => ({ CODEX_HOME: '/isolated/codex', PATH: '/usr/bin' }),
      spawnCapture: async ({ binary, args, env }) => {
        launch = { binary, args, env };
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
    assert.equal(launch?.binary, '/machine/releases/0.156.0/bin/codex', 'never a PATH `codex`');
    assert.equal(launch?.env.PATH, '/machine/releases/0.156.0/codex-path:/usr/bin');
    assert.equal(checked, 1, 'identity re-checked immediately before spawn');
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
      governanceProbe: () => true, executableProbe: async () => true, ...machine,
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

  it('T-1872: a missing or changed machine release refuses before any spawn', async () => {
    let spawned = 0;
    const base = {
      provider: 'codex' as const, userId: 1, model: 'gpt', prompt: 'x',
      persist: false as const, writer: { capture() {} },
    };
    const missing = createCodexCliAdapter({
      governanceProbe: () => true, executableProbe: async () => true,
      acquireIdentity: () => { throw Object.assign(new Error('CODEX_MACHINE_CLI_MISSING'), { code: 'CODEX_MACHINE_CLI_MISSING' }); },
      spawnCapture: async () => { spawned += 1; return { code: 0, stdout: jsonl(), stderr: '' }; },
    });
    await assert.rejects(missing.invoke(base), (error: Error & { code?: string }) =>
      error.code === 'provider_unavailable' && /Codex غير مثبّت على الجهاز/u.test(error.message));
    const changed = createCodexCliAdapter({
      governanceProbe: () => true, executableProbe: async () => true,
      acquireIdentity: machine.acquireIdentity,
      assertUnchanged: () => { throw Object.assign(new Error('CODEX_RUNTIME_CHANGED'), { code: 'CODEX_RUNTIME_CHANGED' }); },
      spawnCapture: async () => { spawned += 1; return { code: 0, stdout: jsonl(), stderr: '' }; },
    });
    await assert.rejects(changed.invoke(base), /could not be launched/u);
    const incompatible = createCodexCliAdapter({
      governanceProbe: () => true, executableProbe: async () => true,
      acquireIdentity: machine.acquireIdentity,
      assertCompatible: async () => {
        throw Object.assign(new Error('نسخة Codex على الجهاز (0.99.0) غير متوافقة مع نسّاج: x'), {
          code: 'CODEX_RUNTIME_INCOMPATIBLE' });
      },
      spawnCapture: async () => { spawned += 1; return { code: 0, stdout: jsonl(), stderr: '' }; },
    });
    await assert.rejects(incompatible.invoke(base), (error: Error & { code?: string }) =>
      error.code === 'provider_unavailable' && /غير متوافقة مع نسّاج/u.test(error.message));
    assert.equal(spawned, 0);
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
