/**
 * T-2095: every provider path of the main WS dispatch runs inside
 * withTurnCheckpoint, so every turn ends with exactly one `turn_checkpoint`
 * frame and that frame follows the turn's own `complete`. Covers the direct
 * SDK paths (Claude, Codex) taken when mechanical supervision is off, next to
 * the admitted CLI paths.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
    },
    sessionsDb: { getSessionById: () => null },
    participantsDb: { isParticipant: () => true },
    sessionWorkspaceModesDb: { readLegacyEligibility: () => ({ eligible: true }), markOverlay: () => undefined },
    sessionOutcomesDb: { getOutcomeForBroadcast: () => null },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { abortSessionTurn, dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

type Frame = { kind?: string; provider?: string };

function makeWriter() {
  const sent: Frame[] = [];
  const writer = { send: (payload: unknown) => { sent.push(payload as Frame); } } as unknown as WebSocketWriter;
  return { writer, sent };
}

/** Fake adapters that end their turn with a `complete` frame on the given writer. */
function makeDependencies() {
  const finish = (provider: string) => async (_command: unknown, _options: unknown, writer: WebSocketWriter) => {
    writer.send({ kind: 'complete', provider, exitCode: 0, success: true, sessionId: `${provider}-s` });
  };
  return {
    queryClaudeSDK: finish('claude'),
    queryCodex: finish('codex'),
    spawnAntigravity: finish('antigravity'),
    spawnOpenCode: finish('opencode'),
    spawnCursor: finish('cursor'),
    spawnGlm: finish('glm'),
    getSessionProvider: () => null,
  } as unknown as Parameters<typeof dispatchProviderCommand>[3];
}

for (const provider of ['claude', 'codex', 'antigravity', 'opencode']) {
  test(`${provider}: one turn_checkpoint frame, after the turn's complete`, async () => {
    const { writer, sent } = makeWriter();
    await dispatchProviderCommand(
      `${provider}-command`,
      { command: 'hi', options: { cwd: process.cwd(), clientMsgId: `cm-${provider}` } },
      writer,
      makeDependencies(),
      7,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const kinds = sent.map((frame) => frame.kind);
    assert.equal(kinds.filter((kind) => kind === 'turn_checkpoint').length, 1, `${provider}: ${kinds.join(',')}`);
    assert.ok(kinds.lastIndexOf('complete') < kinds.indexOf('turn_checkpoint'), `${provider}: ${kinds.join(',')}`);
  });
}

/** Supervisors that refuse every turn, so the direct path must be taken; `calls` records any use. */
function refusingSupervisors(calls: string[]) {
  const supervisor = (name: string) => ({
    enabled: () => false,
    enabledCell: () => false,
    supports: () => false,
    execute: async () => { calls.push(name); throw new Error('supervised path taken'); },
  });
  return { hostedTurnSupervisor: supervisor('hosted'), cliTurnSupervisor: supervisor('cli') };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: the direct path rethrows a provider error and still sends the checkpoint frame`, async () => {
    const { writer, sent } = makeWriter();
    const supervisorCalls: string[] = [];
    const providerCalls: string[] = [];
    const fail = async () => { providerCalls.push(provider); throw new Error(`${provider} exploded`); };
    const dependencies = {
      ...(makeDependencies() as object),
      ...refusingSupervisors(supervisorCalls),
      ...(provider === 'claude' ? { queryClaudeSDK: fail } : { queryCodex: fail }),
    } as Parameters<typeof dispatchProviderCommand>[3];
    await assert.rejects(dispatchProviderCommand(
      `${provider}-command`,
      { command: 'hi', options: { cwd: process.cwd(), clientMsgId: `cm-throw-${provider}` } },
      writer, dependencies, 7,
    ), new RegExp(`${provider} exploded`));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(providerCalls, [provider], 'the direct SDK adapter ran');
    assert.deepEqual(supervisorCalls, [], 'no supervisor ran the turn');
    assert.equal(sent.filter((frame) => frame.kind === 'turn_checkpoint').length, 1);
  });

  test(`${provider}: a revoked run never pays for a checkpoint capture on the direct path`, async () => {
    const { writer } = makeWriter();
    Object.defineProperty(writer, 'runFenceRevoked', { value: true });
    const captures: string[] = [];
    const providerCalls: string[] = [];
    const dependencies = {
      ...(makeDependencies() as object),
      queryClaudeSDK: async () => { providerCalls.push('claude'); },
      queryCodex: async () => { providerCalls.push('codex'); },
      turnCheckpoint: async (_ctx: unknown, run: () => Promise<unknown>) => { captures.push(provider); return run(); },
    } as Parameters<typeof dispatchProviderCommand>[3];
    await dispatchProviderCommand(
      `${provider}-command`,
      { command: 'hi', options: { cwd: process.cwd(), clientMsgId: `cm-revoked-${provider}` } },
      writer, dependencies, 7,
    );
    assert.deepEqual(captures, []);
    assert.deepEqual(providerCalls, []);
  });
}

for (const provider of ['claude', 'codex', 'opencode']) {
  test(`${provider}: a stop during the pre-turn capture keeps the provider from starting`, { timeout: 10_000 }, async () => {
    const { writer, sent } = makeWriter();
    const providerCalls: string[] = [];
    let enterPreCapture: () => void = () => {};
    let releasePreCapture: () => void = () => {};
    const inPreCapture = new Promise<void>((resolve) => { enterPreCapture = resolve; });
    const preCaptureDone = new Promise<void>((resolve) => { releasePreCapture = resolve; });
    const spy = async () => { providerCalls.push(provider); };
    const dependencies = {
      ...(makeDependencies() as object),
      queryClaudeSDK: spy, queryCodex: spy, spawnOpenCode: spy,
      turnCheckpoint: async (_ctx: unknown, run: () => Promise<unknown>) => {
        enterPreCapture();
        await preCaptureDone;
        return run();
      },
    } as Parameters<typeof dispatchProviderCommand>[3];
    const turnKey = `cm-stop-${provider}`;
    const connection = { socket: provider };
    Object.defineProperty(writer, 'ws', { value: connection });
    const dispatched = dispatchProviderCommand(
      `${provider}-command`, { command: 'hi', options: { cwd: process.cwd(), clientMsgId: turnKey } },
      writer, dependencies, 7,
    );
    await inPreCapture;
    const outcome = await abortSessionTurn(dependencies as never, '', provider as never, 7, connection, turnKey);
    releasePreCapture();
    await dispatched;
    assert.equal(outcome.success, true, 'the stop found the pending turn');
    assert.deepEqual(providerCalls, [], 'the provider never started');
    const final = sent.at(-1) as Record<string, unknown>;
    assert.equal(final.kind, 'complete');
    assert.equal(final.aborted, true);
    assert.equal(final.notStarted, true);
    assert.equal(final.clientMsgId, turnKey);
  });
}
