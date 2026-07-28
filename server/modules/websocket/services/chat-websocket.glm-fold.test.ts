/**
 * chat-websocket.glm-fold.test.ts — GLM is folded into its carrier (owner
 * decision 2026-07-26): it is a MODEL inside OpenCode, not an agent system of
 * its own, so it is gone from the settings screen and from the chat picker.
 *
 * The point of these tests is the OTHER half of that decision — what must NOT
 * break. Sessions stamped `glm` predate the fold and users still open them:
 *
 *  (A) A GLM chat turn is refused with a readable error and NO spawn — the
 *      tool-less raw-HTTP body (`spawnGlm`) is unreachable from the product now
 *      that its card is gone. This is the T-864 disable semantics: new runs are
 *      rejected, history stays readable.
 *  (B) A GLM AGENT turn with the carrier armed STILL dispatches — through
 *      opencode, with the model prefixed `glm/` (the ADR-062 GL-8 bypass). A
 *      historical GLM agent session therefore keeps running after the fold
 *      instead of dying with its card.
 *  (C) The refusal names the provider, so the UI can say something truthful
 *      about a session it can no longer run.
 *
 * Pure: module-mocked DB, no binary, no real WS.
 *
 * RUNNER: node:test (`npm run test:server`).
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => null,
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: {
      getSessionById: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { dispatchProviderCommand } = await import('./chat-websocket.service.js');

type SentPayload = {
  kind?: string;
  success?: boolean;
  error?: string;
  provider?: string;
};

function makeWriter() {
  const sent: SentPayload[] = [];
  const writer = {
    send: (payload: unknown) => {
      sent.push(payload as SentPayload);
    },
  } as unknown as WebSocketWriter;
  return { writer, sent };
}

function makeDeps() {
  const calls: string[] = [];
  const spawnLog: { name: string; opts: Record<string, unknown> }[] = [];

  const spawn =
    (name: string) =>
    async (_cmd: string, opts: unknown) => {
      calls.push(name);
      spawnLog.push({ name, opts: (opts ?? {}) as Record<string, unknown> });
    };

  const dependencies = {
    queryClaudeSDK: spawn('claude'),
    spawnCursor: spawn('cursor'),
    queryCodex: spawn('codex'),
    spawnGemini: spawn('gemini'),
    spawnAntigravity: spawn('antigravity'),
    spawnOpenCode: spawn('opencode'),
    spawnHermes: spawn('hermes'),
    spawnKimi: spawn('kimi'),
    spawnDeepSeek: spawn('deepseek'),
    spawnGlm: spawn('glm'),
    getSessionProvider: () => null,
  } as unknown as Parameters<typeof dispatchProviderCommand>[3];

  return { dependencies, calls, spawnLog };
}

/** Runs `fn` with the carrier fleet flag armed, restoring the env afterwards. */
async function withCarrierArmed(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.NASSAJ_OPENCODE_CARRIER;
  process.env.NASSAJ_OPENCODE_CARRIER = '1';
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NASSAJ_OPENCODE_CARRIER;
    } else {
      process.env.NASSAJ_OPENCODE_CARRIER = previous;
    }
  }
}

test('a GLM chat turn is refused and the tool-less raw-HTTP body is never spawned', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDeps();

  await dispatchProviderCommand(
    'glm-command',
    { command: 'hi', options: { model: 'glm-5.2' } },
    writer,
    dependencies,
  );

  assert.deepEqual(calls, [], 'spawnGlm must not run: GLM has no standalone body anymore');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'complete');
  assert.equal(sent[0]?.success, false);
  assert.equal(sent[0]?.provider, 'glm', 'the refusal names the session provider');
  assert.match(sent[0]?.error ?? '', /disabled/i);
  assert.match(sent[0]?.error ?? '', /readable/i, 'history is explicitly still readable');
});

test('a historical GLM agent session still runs — through the OpenCode carrier', async () => {
  await withCarrierArmed(async () => {
    const { writer, sent } = makeWriter();
    const { dependencies, calls, spawnLog } = makeDeps();

    await dispatchProviderCommand(
      'glm-command',
      { command: 'continue', options: { mode: 'agent', model: 'glm-5.2' } },
      writer,
      dependencies,
    );

    assert.deepEqual(calls, ['opencode'], 'the carrier — not spawnGlm — takes the turn');
    assert.deepEqual(sent, [], 'no refusal for a carried agent turn');
    assert.equal(spawnLog[0]?.opts.carrier, true, 'carrier mode is requested explicitly');
    assert.equal(
      spawnLog[0]?.opts.model,
      'glm/glm-5.2',
      'the model is provider-prefixed for opencode',
    );
  });
});

test('an already-prefixed carrier model is not double-prefixed', async () => {
  await withCarrierArmed(async () => {
    const { writer } = makeWriter();
    const { dependencies, spawnLog } = makeDeps();

    await dispatchProviderCommand(
      'glm-command',
      { command: 'continue', options: { mode: 'agent', model: 'glm/glm-5.2[1m]' } },
      writer,
      dependencies,
    );

    assert.equal(spawnLog[0]?.opts.model, 'glm/glm-5.2[1m]');
  });
});
