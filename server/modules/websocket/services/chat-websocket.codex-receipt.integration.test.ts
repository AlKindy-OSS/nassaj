import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeDatabase, closeConnection, projectsDb, userDb, messageCoordinationDb, sessionsDb, sessionWorkspaceModesDb } from '@/modules/database/index.js';
import { codexReceiptPayloadHash } from '@/modules/providers/index.js';
import { attachCodexCompletionProof } from '@/shared/utils.js';

import { dispatchProviderCommand as rawDispatch } from './chat-websocket.service.js';
import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';
import type { WebSocketWriter } from './websocket-writer.service.js';

const dispatch = dispatchAuthorizedProviderCommand.bind(null, rawDispatch as never);
test('actual dispatch persists private native proof, strips public live/replay frames and tolerates failed receipt writes', async () => {
  await initializeDatabase();
  const original = messageCoordinationDb.recordVerdict;
  try {
    const owner = userDb.createUser('native-proof-owner', 'hash', 'user').id;
    projectsDb.createProjectPath(process.cwd(), 'native receipt', owner);
    const frames: any[] = [];
    const writer = { send: (frame: unknown) => frames.push(frame) } as unknown as WebSocketWriter;
    const proof = { version: 'codex_user_v1' as const, userMessageId: 'native-user', turnId: 'turn-native', payloadSha256: 'a'.repeat(64) };
    let launches = 0;
    const dependencies = {
      queryCodex: async (_command: string, options: { clientMsgId: string }, runWriter: WebSocketWriter) => {
        launches++;
        const sessionId = `native-session-${options.clientMsgId}`;
        runWriter.send({ kind: 'session_created', sessionId, provider: 'codex' } as never);
        runWriter.send(attachCodexCompletionProof({ kind: 'complete', sessionId, provider: 'codex', clientMsgId: options.clientMsgId }, proof) as never);
      },
      queryClaudeSDK: async () => {}, spawnCursor: async () => {}, spawnGemini: async () => {}, spawnAntigravity: async () => {},
      spawnHermes: async () => {}, spawnKimi: async () => {}, spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
      getSessionProvider: () => 'codex', getActiveClaudeSDKSessions: () => [],
    } as never;
    const message = { command: 'same request', options: { clientMsgId: 'native-client', coordinationLevel: 'direct' } } as never;
    await dispatch('codex-command', message, writer, dependencies, owner);
    assert.equal(launches, 1);
    const row = messageCoordinationDb.readDelivery({ clientMsgId: 'native-client', sessionId: 'native-session-native-client', userId: owner, provider: 'codex' });
    assert.deepEqual(JSON.parse(row!.verdictJson!).codexUserProof, proof);
    assert.ok(frames.every(frame => !Object.hasOwn(frame, 'codexUserProof')));
    await dispatch('codex-command', message, writer, dependencies, owner);
    assert.equal(launches, 1); assert.ok(frames.every(frame => !Object.hasOwn(frame, 'codexUserProof')));
    messageCoordinationDb.recordVerdict = () => { throw new Error('synthetic receipt write failure'); };
    await dispatch('codex-command', { command: 'another request', options: { clientMsgId: 'failed-client', coordinationLevel: 'direct' } } as never, writer, dependencies, owner);
    assert.equal(launches, 2);
    const failed = messageCoordinationDb.readDelivery({ clientMsgId: 'failed-client', sessionId: 'native-session-failed-client', userId: owner, provider: 'codex' });
    assert.equal(failed?.verdictJson, null);
    assert.ok(frames.every(frame => !Object.hasOwn(frame, 'codexUserProof')));
    messageCoordinationDb.recordVerdict = original;

    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const otherImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAC';
    const imageOnly = { command: '', options: {
      clientMsgId: 'native-image-only', coordinationLevel: 'direct', images: [{ data: image, name: 'one.png' }],
    } } as never;
    await dispatch('codex-command', imageOnly, writer, {
      ...dependencies,
      queryCodex: async (command: string, options: { clientMsgId: string; images: Array<{ data: string }> }, runWriter: WebSocketWriter) => {
        launches++;
        assert.equal(command, '');
        assert.deepEqual(options.images, [{ data: image, name: 'one.png' }]);
        const sessionId = `native-session-${options.clientMsgId}`;
        runWriter.send({ kind: 'session_created', sessionId, provider: 'codex' } as never);
        runWriter.send(attachCodexCompletionProof({ kind: 'complete', sessionId, provider: 'codex', clientMsgId: options.clientMsgId }, {
          version: 'codex_user_v1', userMessageId: 'native-image-user', turnId: 'native-image-turn',
          payloadSha256: codexReceiptPayloadHash('', [image])!,
        }) as never);
      },
    } as never, owner);
    assert.equal(launches, 3);
    const imageDelivery = messageCoordinationDb.readDelivery({ clientMsgId: 'native-image-only',
      sessionId: 'native-session-native-image-only', userId: owner, provider: 'codex' });
    assert.equal(imageDelivery?.content, '');
    assert.ok(JSON.parse(imageDelivery!.verdictJson!).codexUserProof);

    await dispatch('codex-command', imageOnly, writer, dependencies, owner);
    assert.equal(launches, 3, 'an identical image retry must replay without a second provider effect');
    await dispatch('codex-command', { command: '', options: { clientMsgId: 'native-image-only', coordinationLevel: 'direct',
      images: [{ data: otherImage }] } } as never, writer, dependencies, owner);
    assert.equal(launches, 3, 'the same id with different image bytes must fail its fingerprint');
    assert.equal(frames.at(-1)?.code, 'client_msg_id_fingerprint_mismatch');

    const ordered = { command: '', options: { clientMsgId: 'ordered-images', coordinationLevel: 'direct',
      images: [{ data: image }, { data: otherImage }] } } as never;
    await dispatch('codex-command', ordered, writer, dependencies, owner);
    assert.equal(launches, 4);
    await dispatch('codex-command', { command: '', options: { clientMsgId: 'ordered-images', coordinationLevel: 'direct',
      images: [{ data: otherImage }, { data: image }] } } as never, writer, dependencies, owner);
    assert.equal(launches, 4, 'attachment order is part of the immutable request fingerprint');
    assert.equal(frames.at(-1)?.code, 'client_msg_id_fingerprint_mismatch');

    for (const [clientMsgId, images, code] of [
      ['blank-image-turn', [], 'empty_turn'],
      ['invalid-image-turn', [{ data: 'data:image/png;base64,***' }], 'invalid_image_attachments'],
      ['too-many-images', Array.from({ length: 16 }, () => ({ data: image })), 'invalid_image_attachments'],
      ['unsupported-proof-image', [{ data: 'data:image/svg+xml;base64,PHN2Zy8+' }], 'codex_image_receipt_unsupported'],
    ] as const) {
      await dispatch('codex-command', { command: '', options: { clientMsgId, coordinationLevel: 'direct', images } } as never,
        writer, dependencies, owner);
      assert.equal(frames.at(-1)?.code, code);
    }
    await dispatch('codex-command', { command: 'text', options: { clientMsgId: 'text-invalid-image', coordinationLevel: 'direct',
      images: [{ data: 'data:image/png;base64,***' }] } } as never, writer, dependencies, owner);
    assert.equal(frames.at(-1)?.code, 'invalid_image_attachments');
    await dispatch('codex-command', { command: { forged: true }, options: { clientMsgId: 'invalid-command', coordinationLevel: 'direct' } } as never,
      writer, dependencies, owner);
    assert.equal(frames.at(-1)?.code, 'invalid_turn_content');

    let cursorResumes = 0;
    sessionsDb.createSession('cursor-resume-control', 'cursor', process.cwd());
    sessionWorkspaceModesDb.markShared('cursor-resume-control', process.cwd(), 'cursor');
    await dispatch('cursor-resume', { command: '', sessionId: 'cursor-resume-control',
      options: { sessionId: 'cursor-resume-control', resume: true } } as never, writer, {
      ...dependencies, getSessionProvider: () => 'cursor',
      spawnCursor: async (command: string) => { cursorResumes++; assert.equal(command, ''); },
    } as never, owner);
    assert.equal(cursorResumes, 1, 'the server-routed cursor resume control must preserve its empty command');
    assert.equal(launches, 4, 'blank, malformed, oversized or unsupported attachments must never reach Codex');
  } finally { messageCoordinationDb.recordVerdict = original; closeConnection(); }
});
