// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import '../../../shared/__tests__/stub-harness-binaries.js';
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
  manifestPath: '/manifest',
});

const output = {
  qwen: `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'qwen answer' } })}\n`,
  opencode: `${JSON.stringify({ type: 'text', part: { type: 'text', text: 'opencode answer' } })}\n`,
} as const;

describe('extended CLI mechanical adapters', () => {
  for (const provider of ['qwen', 'opencode'] as const) {
    it(`${provider} pins, cages and capture-only executes`, async () => {
      let spec: IsolatedCliProcessSpec | undefined;
      let cleaned = false;
      const adapter = createExtendedCliAdapter(provider, {
        executableProbe: async () => true,
        versionProbe: async () => extendedCliAdapterInternals.EXACT_VERSIONS[provider] ?? '1.18.40',
        qwenCapabilityProbe: async () => true,
        opencodeCapabilityProbe: async () => true,
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
      } else {
        assert.ok(args.includes('--pure')); assert.ok(args.includes('supervisor'));
        const config = JSON.parse(String(spec?.env.OPENCODE_CONFIG_CONTENT)) as { tools: Record<string, boolean>; agent: Record<string, { tools: Record<string, boolean> }> };
        assert.equal(config.tools['*'], false); assert.equal(config.tools.task, false);
        assert.equal(config.agent.supervisor.tools['*'], false);
      }
    });
  }

  it('fails closed without the exact pin or a successful prior probe', async () => {
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
  });

  it('accepts any reporting opencode release but refuses a silent or missing binary', async () => {
    const make = (versionProbe: () => Promise<string>, executableProbe = async () => true, capable = true) =>
      createExtendedCliAdapter('opencode', {
        binary: '/fake/opencode', executableProbe, versionProbe, opencodeCapabilityProbe: async () => capable,
        createRoleHome: async () => ROLE, cleanupRoleHome: async () => {},
        spawnCapture: async () => ({ code: 0, stdout: 'answer', stderr: '' }),
      });
    for (const version of ['1.18.32', '1.18.40', '2.0.0']) {
      assert.equal(await make(async () => version).probe({ provider: 'opencode', userId: 1 }), true, version);
    }
    assert.equal(await make(async () => '').probe({ provider: 'opencode', userId: 1 }), false);
    const missing = make(async () => '1.18.40', async () => false);
    assert.equal(await missing.probe({ provider: 'opencode', userId: 1 }), false);
    const incapable = make(async () => '1.18.40', async () => true, false);
    assert.equal(await incapable.probe({ provider: 'opencode', userId: 1 }), false, 'capability probe fails closed');
    await assert.rejects(incapable.invoke({
      provider: 'opencode', userId: 1, model: 'x', prompt: 'x', persist: false, writer: { capture() {} },
    }), /not pinned and probed/u);
  });

  it('opencode capability: the resolved supervisor agent must have every tool off and deny *', () => {
    const { opencodeAgentIsToolless, OPENCODE_RUN_FLAGS, opencodeSpec } = extendedCliAdapterInternals;
    const deny = { permission: '*', action: 'deny', pattern: '*' };
    const doc = (tools: Record<string, boolean>, permission = [{ permission: '*', action: 'allow' }, deny]) =>
      `log line\n${JSON.stringify({ name: 'supervisor', tools, permission })}\n`;
    assert.equal(opencodeAgentIsToolless(doc({ bash: false, read: false, task: false })), true);
    assert.equal(opencodeAgentIsToolless(doc({ bash: false, read: true })), false, 'one tool left on');
    assert.equal(opencodeAgentIsToolless(doc({})), false, 'schema ignored: no tools resolved');
    assert.equal(opencodeAgentIsToolless(doc({ bash: false }, [{ permission: '*', action: 'allow' }])), false);
    assert.throws(() => opencodeAgentIsToolless('{not json}'));
    assert.equal(opencodeAgentIsToolless('no json at all'), false);
    const args = opencodeSpec({ binary: 'o', cwd: '/', env: {}, model: 'm', prompt: 'p', system: 's' }).args;
    for (const flag of OPENCODE_RUN_FLAGS) assert.ok(args.includes(flag), `cell uses ${flag}`);
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

  it('T-1906: the opencode cell refuses qwen-plan/* before any role home or spawn', async () => {
    let spawned = false;
    let roleCreated = false;
    const adapter = createExtendedCliAdapter('opencode', {
      executableProbe: async () => true, versionProbe: async () => '1.18.40',
      opencodeCapabilityProbe: async () => true,
      resolveEnv: () => ({}),
      createRoleHome: async () => { roleCreated = true; return ROLE; }, cleanupRoleHome: async () => {},
      spawnCapture: async () => { spawned = true; return { code: 0, stdout: output.opencode, stderr: '' }; },
    });
    assert.equal(await adapter.probe({ provider: 'opencode', userId: 1 }), true);
    await assert.rejects(adapter.invoke({
      provider: 'opencode', userId: 1, model: 'qwen-plan/qwen3-coder-plus', prompt: 'x', persist: false,
      writer: { capture() {} },
    }), (error: { code?: string }) => error.code === 'credential_unavailable');
    assert.equal(spawned, false);
    assert.equal(roleCreated, false);
  });
});
