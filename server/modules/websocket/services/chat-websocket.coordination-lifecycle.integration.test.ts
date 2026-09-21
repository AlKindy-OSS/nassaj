import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, userDb, messageCoordinationDb } from '@/modules/database/index.js';
import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import { handleChatConnection, dispatchProviderCommand as rawDispatchProviderCommand } from '@/modules/websocket/services/chat-websocket.service.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

test('not-started retry dispatches once more, terminal retry replays verdict, mismatch rejects', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP ?? os.tmpdir(), 'coordination-lifecycle-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  try {
    const userId = userDb.createUser('coord-lifecycle', 'hash', 'user').id;
    projectsDb.createProjectPath(process.cwd(), 'coordination lifecycle', userId);
    const sent: Array<Record<string, unknown>> = [];
    const writer = { send: (payload: Record<string, unknown>) => sent.push(payload) } as unknown as WebSocketWriter;
    let launches = 0;
    const boundSessionId = (clientMsgId: string) => `new-bound-session-${clientMsgId}`;
    const dependencies = {
      queryClaudeSDK: async (_command: string, _options: { clientMsgId: string }, runWriter: WebSocketWriter) => {
        launches += 1;
        if (launches >= 3) {
          // Each launch is a fresh overlay; a provider session id can only ever be
          // bound to one overlay (session-workspace-overlay), so mint one per launch.
          const sessionId = boundSessionId(_options.clientMsgId);
          runWriter.send({ kind: 'session_created', sessionId } as never);
          if (launches >= 4) {
            // Simulate the SDK's raw trusted acceptance seam, independent from normalized frames.
            messageCoordinationDb.markStarted({ clientMsgId: _options.clientMsgId, userId, provider: 'claude', sessionId });
            runWriter.send({ kind: 'text', role: 'assistant', sessionId, content: 'started' } as never);
            runWriter.send({ kind: 'error', sessionId, code: 'aborted' } as never);
          }
        } else if (launches === 1) {
          runWriter.send({ kind: 'error', code: 'session_busy', notStarted: true, content: 'busy' } as never);
        } else {
          runWriter.send({ kind: 'complete', success: true, exitCode: 0, content: 'done' } as never);
        }
      },
      spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
      spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
      spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
      getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
    } as never;
    const message = {
      command: 'same payload',
      options: { clientMsgId: 'retry-id', coordinationLevel: 'delegate' },
    } as never;

    await dispatchProviderCommand('claude-command', message, writer, dependencies, userId);
    assert.equal(sent[sent.length - 1].sameClientMsgIdRetryable, true);
    await dispatchProviderCommand('claude-command', message, writer, dependencies, userId);
    assert.equal(launches, 2, 'proven not_started claim may be retried exactly once');

    const beforeReplay = sent.length;
    await dispatchProviderCommand('claude-command', message, writer, dependencies, userId);
    assert.equal(launches, 2, 'terminal/lost-verdict retry must not launch again');
    assert.deepEqual(sent[sent.length - 1], sent[beforeReplay - 1], 'stored terminal verdict is replayed');
    assert.equal(sent[sent.length - 1].sameClientMsgIdRetryable, false);

    await dispatchProviderCommand('claude-command', {
      ...message, command: 'changed payload',
    } as never, writer, dependencies, userId);
    assert.equal(launches, 2);
    assert.equal(sent[sent.length - 1].code, 'client_msg_id_fingerprint_mismatch');

    for (const clientMsgId of ['creation-only', 'activity-then-abort']) {
      await dispatchProviderCommand('claude-command', {
        command: 'same payload', options: { clientMsgId, coordinationLevel: 'delegate' },
      } as never, writer, dependencies, userId);
      const receipt = messageCoordinationDb.readDelivery({
        clientMsgId, userId, provider: 'claude', sessionId: boundSessionId(clientMsgId),
      });
      assert.ok(receipt);
      if (clientMsgId === 'creation-only') {
        assert.equal(receipt.acceptedAt, null);
        assert.equal(receipt.lifecycleStatus, 'claimed');
      } else {
        assert.ok(receipt.acceptedAt);
        assert.equal(receipt.lifecycleStatus, 'terminal');
        assert.equal(JSON.parse(receipt.verdictJson!).code, 'aborted');
        // B1007: a failed new lease is not evidence that this earlier accepted run did not start.
        const frames: Record<string, unknown>[] = [];
        let callback: (raw: unknown) => Promise<void> = async () => {};
        const socket = {
          readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)),
          on: (event: string, cb: typeof callback) => { if (event === 'message') callback = cb; },
        };
        handleChatConnection(socket as never, { user: { id: userId } } as never, {
          ...(dependencies as object),
          acquireWriterLease: async () => { throw new Error('lease unavailable'); },
        } as never);
        const duplicate = { type: 'claude-command', command: 'same payload',
          options: { clientMsgId, coordinationLevel: 'delegate' } };
        await callback(JSON.stringify(duplicate));
        assert.equal(frames.at(-1)?.deliveryDisposition, 'not_started');
        assert.ok(messageCoordinationDb.readDelivery({
          clientMsgId, userId, provider: 'claude', sessionId: boundSessionId(clientMsgId),
        })?.acceptedAt, 'lease error does not rewrite the existing accepted receipt');
        const beforeRetry = launches;
        await dispatchProviderCommand('claude-command', duplicate as never, writer, dependencies, userId);
        assert.equal(launches, beforeRetry, 'same-ID retry still passes the durable claim and never launches twice');
        assert.equal(sent.at(-1)?.sameClientMsgIdRetryable, false);

      }
    }

  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
