import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TurnAdapterRegistry } from './registry.js';
import { createExtendedCliAdapter, extendedCliAdapterInternals } from './extended-cli-adapter.js';
import type { EphemeralRoleHome, IsolatedCliProcessSpec } from './isolated-cli-cage.js';

const ROLE: EphemeralRoleHome = Object.freeze({
  id: 'role-test', directory: '/var/tmp/nassaj-turn-supervisor-roles/role-test',
  home: '/var/tmp/nassaj-turn-supervisor-roles/role-test/home',
  xdgConfig: '/var/tmp/nassaj-turn-supervisor-roles/role-test/config',
  xdgData: '/var/tmp/nassaj-turn-supervisor-roles/role-test/data',
  xdgState: '/var/tmp/nassaj-turn-supervisor-roles/role-test/state',
  xdgCache: '/var/tmp/nassaj-turn-supervisor-roles/role-test/cache',
  hermesHome: '/var/tmp/nassaj-turn-supervisor-roles/role-test/hermes', manifestPath: '/manifest',
});

const output = {
  qwen: `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'qwen answer' } })}\n`,
  opencode: `${JSON.stringify({ type: 'text', part: { type: 'text', text: 'opencode answer' } })}\n`,
  hermes: 'hermes answer\n',
} as const;

describe('extended CLI mechanical adapters', () => {
  for (const provider of ['qwen', 'opencode', 'hermes'] as const) {
    it(`${provider} pins, cages and capture-only executes`, async () => {
      let spec: IsolatedCliProcessSpec | undefined;
      let cleaned = false;
      const adapter = createExtendedCliAdapter(provider, {
        executableProbe: async () => true,
        versionProbe: async () => extendedCliAdapterInternals.EXACT_VERSIONS[provider],
        qwenCapabilityProbe: async () => true,
        hermesToolDefinitionProbe: async () => 0,
        resolveEnv: () => ({ PROVIDER_SECRET: 'server-only' }),
        createRoleHome: async () => ROLE,
        cleanupRoleHome: async (role) => { assert.equal(role, ROLE); cleaned = true; },
        spawnCapture: async (input) => {
          spec = input;
          assert.equal(input.role, ROLE);
          return { code: 0, stdout: output[provider], stderr: '' };
        },
      });
      const registry = new TurnAdapterRegistry([adapter]);
      const probe = await registry.probe({ provider, userId: 7 });
      assert.equal(probe.available, true);
      assert.ok(probe.capability);
      const events: unknown[] = [];
      const result = await registry.invoke({
        capability: probe.capability!, model: 'pinned-model', prompt: 'user request',
        hiddenContext: ['private role'], persist: false, effects: [],
        writer: { capture(event) { events.push(event); } },
      });
      assert.equal(result.text, `${provider} answer`);
      assert.equal(cleaned, true);
      assert.equal(spec?.cwd, process.cwd());
      assert.equal(
        spec?.env.PROVIDER_SECRET,
        provider === 'opencode' ? undefined : 'server-only',
        'the governed OpenCode launcher strips inherited secret-shaped variables',
      );
      assert.deepEqual(events, [{ type: 'text', text: `${provider} answer` }, { type: 'complete' }]);

      const args = spec?.args ?? [];
      assert.equal(args.some((arg) => ['--continue', '-c', '--resume', '-r', '--session', '--session-id'].includes(arg)), false);
      if (provider === 'qwen') {
        assert.deepEqual(args.slice(args.indexOf('--max-tool-calls'), args.indexOf('--max-tool-calls') + 2), ['--max-tool-calls', '0']);
        assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--approval-mode'));
        assert.ok(args.join(' ').includes('subagent'));
      } else if (provider === 'opencode') {
        assert.ok(args.includes('--pure')); assert.ok(args.includes('supervisor'));
        const config = JSON.parse(String(spec?.env.OPENCODE_CONFIG_CONTENT)) as { tools: Record<string, boolean>; agent: Record<string, { tools: Record<string, boolean> }> };
        assert.equal(config.tools['*'], false); assert.equal(config.tools.task, false);
        assert.equal(config.agent.supervisor.tools['*'], false);
      } else {
        assert.ok(args.includes('--safe-mode')); assert.deepEqual(args.slice(args.indexOf('--toolsets'), args.indexOf('--toolsets') + 2), ['--toolsets', '']);
        assert.ok(spec?.env.HERMES_SYSTEM_PROMPT?.includes('zero tools'));
      }
    });
  }

  it('fails closed without exact pins, Hermes zero-tool probe, or a successful prior probe', async () => {
    const common = {
      executableProbe: async () => true, versionProbe: async () => 'wrong',
      createRoleHome: async () => ROLE, cleanupRoleHome: async () => {},
      spawnCapture: async () => ({ code: 0, stdout: 'answer', stderr: '' }),
    };
    const qwen = createExtendedCliAdapter('qwen', common);
    assert.equal(await qwen.probe({ provider: 'qwen', userId: 1 }), false);
    await assert.rejects(qwen.invoke({
      provider: 'qwen', userId: 1, model: 'x', prompt: 'x', persist: false,
      writer: { capture() {} },
    }), /not pinned and probed/u);
    const hermes = createExtendedCliAdapter('hermes', {
      ...common, versionProbe: async () => '0.17.0', hermesToolDefinitionProbe: async () => 16,
    });
    assert.equal(await hermes.probe({ provider: 'hermes', userId: 1 }), false);
  });

  it('Qwen refuses capability when the installed help surface lacks any mechanical denial option', async () => {
    const adapter = createExtendedCliAdapter('qwen', {
      executableProbe: async () => true, versionProbe: async () => '0.21.12',
      qwenCapabilityProbe: async () => false,
    });
    assert.equal(await adapter.probe({ provider: 'qwen', userId: 1 }), false);
    await assert.rejects(adapter.invoke({
      provider: 'qwen', userId: 1, model: 'x', prompt: 'x', persist: false,
      writer: { capture() {} },
    }), /not pinned and probed/u);
  });

  it('never falls back on effects, cancellation, launch failure, or empty response', async () => {
    const controller = new AbortController(); controller.abort();
    const adapter = createExtendedCliAdapter('qwen', {
      executableProbe: async () => true, versionProbe: async () => '0.21.12',
      qwenCapabilityProbe: async () => true,
      createRoleHome: async () => ROLE, cleanupRoleHome: async () => {},
      spawnCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    assert.equal(await adapter.probe({ provider: 'qwen', userId: 1 }), true);
    const base = { provider: 'qwen' as const, userId: 1, model: 'x', prompt: 'x', persist: false as const, writer: { capture() {} } };
    await assert.rejects(adapter.invoke({ ...base, effects: [{}] }), /deny effects/u);
    await assert.rejects(adapter.invoke({ ...base, signal: controller.signal }), /aborted before launch/u);
    await assert.rejects(adapter.invoke(base), /no final assistant/u);
  });
});
