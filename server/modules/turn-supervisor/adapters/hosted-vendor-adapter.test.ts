import assert from 'node:assert/strict';
import test from 'node:test';

import { AdapterTerminalProofAuthority } from '../resource-admission.js';

import { createCaptureOnlyWriter } from './capture-only-writer.js';
import { createHostedVendorAdapter } from './hosted-vendor-adapter.js';
import { HOSTED_CAPABILITIES, TurnAdapterRegistry } from './registry.js';
import { TurnAdapterError, type TurnCapabilityToken } from './types.js';

const successPayload = {
  content: [{ type: 'text', text: 'captured answer' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 3 },
};

test('hosted turn keeps hidden context in system and captures without transcript pollution', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = createHostedVendorAdapter({
    resolveCredential: () => 'secret-key',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json(successPayload);
    },
  });
  const registry = new TurnAdapterRegistry([adapter]);
  const probe = await registry.probe({ provider: 'kimi', userId: 'member-1' });
  assert.equal(probe.available, true);
  assert.equal(probe.capabilities?.persist, false);
  assert.deepEqual(probe.capabilities?.nativeDelegation, {
    supported: false,
    reason: 'hosted_completion_endpoint_has_no_native_delegation',
  });

  const writer = createCaptureOnlyWriter();
  const result = await registry.invoke({
    capability: probe.capability!,
    model: 'kimi-k2.6',
    prompt: 'visible user prompt',
    hiddenContext: ['private supervisor context'],
    system: 'trusted policy',
    persist: false,
    writer,
  });

  assert.equal(result.text, 'captured answer');
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.messages, [{ role: 'user', content: 'visible user prompt' }]);
  assert.equal(body.system, 'trusted policy\n\nprivate supervisor context');
  assert.equal('persist' in body, false, 'Anthropic wire must not receive an unsupported persist field');
  assert.deepEqual(writer.snapshot(), [
    { type: 'text', text: 'captured answer' },
    { type: 'usage', inputTokens: 7, outputTokens: 3 },
    { type: 'complete', stopReason: 'end_turn' },
  ]);
  assert.equal('send' in writer, false);
  assert.equal('append' in writer, false);
});

test('abort signal cancels the external request and is reported as aborted', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const adapter = createHostedVendorAdapter({
    resolveCredential: () => 'secret-key',
    fetchImpl: (_input, init) => {
      observedSignal = init?.signal;
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('cancelled', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    },
  });
  const registry = new TurnAdapterRegistry([adapter]);
  const probe = await registry.probe({ provider: 'deepseek', userId: 12 });
  const pending = registry.invoke({
    capability: probe.capability!,
    model: 'deepseek-v4-pro',
    prompt: 'work',
    persist: false,
    signal: controller.signal,
    writer: createCaptureOnlyWriter(),
  });
  await fetchStarted;
  controller.abort('user cancelled');

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof TurnAdapterError);
    assert.equal(error.code, 'aborted');
    return true;
  });
  assert.equal(observedSignal, controller.signal);
});

test('capture-only hosted envelope rejects requested effects before fetch', async () => {
  let fetches = 0;
  const registry = new TurnAdapterRegistry([
    createHostedVendorAdapter({
      resolveCredential: () => 'secret-key',
      fetchImpl: async () => {
        fetches += 1;
        return Response.json(successPayload);
      },
    }),
  ]);
  const probe = await registry.probe({ provider: 'glm', userId: 'member-2' });

  await assert.rejects(
    registry.invoke({
      capability: probe.capability!,
      model: 'glm-5.2',
      prompt: 'write a file',
      persist: false,
      effects: [{ type: 'filesystem-write' }],
      writer: createCaptureOnlyWriter(),
    }),
    (error: unknown) => error instanceof TurnAdapterError && error.code === 'effects_unsupported',
  );
  assert.equal(fetches, 0);
});

test('registry rejects forged tokens and issued tokens cannot be serialized or reused', async () => {
  let fetches = 0;
  const registry = new TurnAdapterRegistry([
    createHostedVendorAdapter({
      resolveCredential: () => 'secret-key',
      fetchImpl: async () => {
        fetches += 1;
        return Response.json(successPayload);
      },
    }),
  ]);
  const writer = createCaptureOnlyWriter();
  const forged = Object.freeze(Object.create(null)) as TurnCapabilityToken;
  await assert.rejects(
    registry.invoke({
      capability: forged,
      model: 'glm-5.2',
      prompt: 'forged',
      persist: false,
      writer,
    }),
    (error: unknown) => error instanceof TurnAdapterError && error.code === 'capability_forged',
  );

  const probe = await registry.probe({ provider: 'glm', userId: 'member-3' });
  assert.throws(() => JSON.stringify(probe.capability), /not serializable/);
  const invocation = {
    capability: probe.capability!,
    model: 'glm-5.2',
    prompt: 'legitimate',
    persist: false as const,
    writer,
  };
  await registry.invoke(invocation);
  await assert.rejects(
    registry.invoke(invocation),
    (error: unknown) => error instanceof TurnAdapterError && error.code === 'capability_used',
  );
  assert.equal(fetches, 1);
});

test('capability probe is server-authoritative and unsupported providers receive no token', async () => {
  const registry = new TurnAdapterRegistry([
    createHostedVendorAdapter({
      resolveCredential: (_provider, userId) => (userId === 'allowed' ? 'secret-key' : null),
      fetchImpl: async () => Response.json(successPayload),
    }),
  ]);

  assert.deepEqual(await registry.probe({ provider: 'claude', userId: 'allowed' }), {
    provider: 'claude',
    available: false,
    reason: 'unsupported_provider',
  });
  assert.deepEqual(await registry.probe({ provider: 'kimi', userId: 'denied' }), {
    provider: 'kimi',
    available: false,
    reason: 'missing_credential',
  });
  assert.equal(HOSTED_CAPABILITIES.effects, 'none');
});

test('only registry closes a settled execution into a terminal proof', async () => {
  const authority = new AdapterTerminalProofAuthority();
  const registry = new TurnAdapterRegistry([
    createHostedVendorAdapter({
      resolveCredential: () => 'secret-key',
      fetchImpl: async () => Response.json(successPayload),
    }),
  ], { issueTerminalProof: authority.bindIssuer(), now: () => 42 });
  registry.beginExecution('run-proof', 7);
  assert.equal(registry.closeExecution('run-proof', 7)?.adapterId,
    'hosted-vendor-ephemeral:no-dispatch');

  registry.beginExecution('run-settled', 8);
  const probe = await registry.probe({ provider: 'kimi', userId: 1 });
  await registry.invoke({
    capability: probe.capability!, model: 'model', prompt: 'prompt', persist: false,
    executionIdentity: { runId: 'run-settled', writerEpoch: 8 },
    writer: createCaptureOnlyWriter(),
  });
  const proof = registry.closeExecution('run-settled', 8);
  assert.ok(proof);
  assert.equal(proof?.adapterId, 'hosted-vendor-ephemeral');
  assert.equal(proof ? authority.verifies(proof) : false, true);
  assert.equal(registry.closeExecution('run-settled', 8), null, 'proof is one-shot');
});

test('undispatched registry scope is abandoned without terminal proof', () => {
  const authority = new AdapterTerminalProofAuthority();
  const registry = new TurnAdapterRegistry([], { issueTerminalProof: authority.bindIssuer() });
  registry.beginExecution('run', 1);
  assert.equal(registry.abandonUndispatchedExecution('run', 1), true);
  assert.equal(registry.closeExecution('run', 1), null);
});
