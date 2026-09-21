import assert from 'node:assert/strict';
import test from 'node:test';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createCaptureOnlyWriter } from './capture-only-writer.js';
import {
  CLAUDE_SDK_CAPABILITIES,
  createClaudeSdkTurnAdapter,
  isClaudeSdkMechanicalEnabled,
} from './claude-sdk-adapter.js';
import { TurnAdapterRegistry } from './registry.js';
import { TurnAdapterError } from './types.js';

function success(text = 'captured claude answer'): SDKMessage {
  return {
    type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 4 },
  } as unknown as SDKMessage;
}

test('Claude mechanical capability is server-flagged and defaults disabled', async () => {
  assert.equal(isClaudeSdkMechanicalEnabled({}), false);
  assert.equal(isClaudeSdkMechanicalEnabled({
    NASSAJ_TURN_SUPERVISOR_CLAUDE_CHAT_SDK_MECHANICAL: '1',
  }), true);
  const registry = new TurnAdapterRegistry([createClaudeSdkTurnAdapter({
    enabled: () => false,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
  })]);
  assert.deepEqual(await registry.probe({ provider: 'claude', userId: 7 }), {
    provider: 'claude', available: false, reason: 'missing_credential',
  });
  assert.deepEqual(CLAUDE_SDK_CAPABILITIES.nativeDelegation, {
    supported: false, reason: 'supervisor_disables_native_delegation',
  });
});

test('Claude SDK role is ephemeral, capture-only, toolless and keeps hidden context out of prompt', async () => {
  let observed: { prompt: string; options: Options } | undefined;
  const adapter = createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    resolveEnvironment: () => ({ PATH: process.env.PATH }),
    queryFactory: (input) => {
      observed = input;
      return (async function* stream() { yield success(); })();
    },
  });
  const registry = new TurnAdapterRegistry([adapter]);
  const probe = await registry.probe({ provider: 'claude', userId: 'member-7' });
  assert.equal(probe.available, true);
  assert.deepEqual(probe.capabilities, CLAUDE_SDK_CAPABILITIES);
  const writer = createCaptureOnlyWriter();
  const result = await registry.invoke({
    capability: probe.capability!, model: 'claude-sonnet-4-6', prompt: 'visible request',
    system: 'trusted system', hiddenContext: ['private supervisor role'], persist: false, writer,
  });

  assert.equal(result.text, 'captured claude answer');
  assert.equal(observed?.prompt, 'visible request');
  assert.equal(observed?.options.persistSession, false);
  assert.deepEqual(observed?.options.settingSources, []);
  assert.deepEqual(observed?.options.tools, []);
  assert.deepEqual(observed?.options.allowedTools, []);
  assert.deepEqual(observed?.options.disallowedTools, ['Agent', 'Task']);
  assert.deepEqual(observed?.options.agents, {});
  assert.deepEqual(observed?.options.mcpServers, {});
  assert.equal(observed?.options.permissionMode, 'dontAsk');
  assert.equal(observed?.options.systemPrompt, 'trusted system\n\nprivate supervisor role');
  assert.deepEqual(await observed?.options.canUseTool?.('Agent', {}, {
    signal: new AbortController().signal,
  }), {
    behavior: 'deny',
    message: 'Turn Supervisor internal roles have no effect or native-spawn authority.',
    interrupt: true,
  });
  assert.deepEqual(writer.snapshot(), [
    { type: 'text', text: 'captured claude answer' },
    { type: 'usage', inputTokens: 8, outputTokens: 4 },
    { type: 'complete', stopReason: 'end_turn' },
  ]);
  assert.equal('send' in writer, false);
  assert.equal('append' in writer, false);
});

test('Claude adapter aborts the SDK process and rejects requested or emitted effects', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const adapter = createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    resolveEnvironment: () => ({ PATH: process.env.PATH }),
    queryFactory: ({ options }) => (async function* stream() {
      started();
      await new Promise<void>((_resolve, reject) => options.abortController?.signal.addEventListener(
        'abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true },
      ));
      yield success();
    })(),
  });
  const registry = new TurnAdapterRegistry([adapter]);
  const probe = await registry.probe({ provider: 'claude', userId: 7 });
  const pending = registry.invoke({
    capability: probe.capability!, model: 'claude-sonnet-4-6', prompt: 'work', persist: false,
    signal: controller.signal, writer: createCaptureOnlyWriter(),
  });
  await ready;
  controller.abort('user cancelled');
  await assert.rejects(pending, (error: unknown) => (
    error instanceof TurnAdapterError && error.code === 'aborted'
  ));

  const effectsProbe = await registry.probe({ provider: 'claude', userId: 7 });
  await assert.rejects(registry.invoke({
    capability: effectsProbe.capability!, model: 'claude-sonnet-4-6', prompt: 'write',
    persist: false, effects: [{ kind: 'filesystem_write' }], writer: createCaptureOnlyWriter(),
  }), (error: unknown) => error instanceof TurnAdapterError && error.code === 'effects_unsupported');
});

test('Claude adapter fail-closes if any tool_use escapes the empty tool set', async () => {
  const adapter = createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    resolveEnvironment: () => ({ PATH: process.env.PATH }),
    queryFactory: () => (async function* stream() {
      yield {
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Agent', input: {} }] },
      } as unknown as SDKMessage;
    })(),
  });
  const registry = new TurnAdapterRegistry([adapter]);
  const probe = await registry.probe({ provider: 'claude', userId: 7 });
  await assert.rejects(registry.invoke({
    capability: probe.capability!, model: 'claude-sonnet-4-6', prompt: 'delegate', persist: false,
    writer: createCaptureOnlyWriter(),
  }), (error: unknown) => error instanceof TurnAdapterError && error.code === 'effects_unsupported');
});
