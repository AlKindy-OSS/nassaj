/**
 * retired-body.hermes-history.test.ts — T-1953 (ADR-192).
 *
 * The Hermes body is deleted: no launcher, no provider module, no login, no
 * updater. What must survive is the ability to LIST and OPEN the conversations
 * it left behind, through the history-only reader in `provider.registry.ts`.
 *
 * The fixtures reproduce the SHAPE of the records found on a real node (read
 * only; no content was copied), which differs from what today's shared writer
 * emits and is therefore not covered by a write-then-read round trip:
 *   - the session row has `jsonl_path = NULL`; the transcript is found by the
 *     project hash under `~/.nassaj-vendor-sessions/hermes/<md5>/<uuid>.jsonl`;
 *   - line 1 is `{type:'meta', projectPath, sessionName}`;
 *   - every other line is `{type:'message', message:{role, content}}` with NO
 *     message id and NO timestamp;
 *   - most transcripts hold a single user line and no reply (a failed run);
 *   - a long one holds consecutive user lines and multi-line replies.
 *
 * It lives at the server root because it crosses the providers, projects and
 * database modules on purpose (the module boundary lint forbids that from
 * inside `server/modules/<name>/`).
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { getProjectSessionsPage } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { vendorProjectHash, vendorProviderRoot } from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { AppError } from '@/shared/utils.js';

import { sessionBucketKey } from '../shared/sessionBuckets.js';

const USER_ONLY_SESSION = '00000002-0000-4000-8000-0000000000e1';
const MULTI_TURN_SESSION = '00000002-0000-4000-8000-0000000000e2';

/** One recorded line, in the historical shape: no message id, no timestamp. */
const messageLine = (role: 'user' | 'assistant', content: string): string =>
  JSON.stringify({ type: 'message', message: { role, content } });

/** Role order and line breaks follow the historical multi-turn shape: u a u a a u a u u. */
const MULTI_TURN: ReadonlyArray<readonly ['user' | 'assistant', string]> = [
  ['user', 'first question'],
  ['assistant', 'first answer'],
  ['user', 'second question'],
  ['assistant', 'second answer, part one'],
  ['assistant', 'second answer\npart two\n\nwith a blank line'],
  ['user', 'third question'],
  ['assistant', 'third answer\non two lines'],
  ['user', 'fourth question, never answered'],
  ['user', 'fifth question, never answered'],
];

let server: Server;
let baseUrl = '';
let requesterId = 0;
let projectPath = '';
let projectId = '';

type HistoryMessage = { role?: string; content?: string; provider?: string };
type HistoryResponse = { status: number; messages: HistoryMessage[]; raw: string };

async function readHistory(sessionId: string): Promise<HistoryResponse> {
  const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/messages`);
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) as { messages?: HistoryMessage[] } : {};
  return { status: response.status, messages: body.messages ?? [], raw };
}

/** Where the body recorded a conversation: `<root>/hermes/<md5 of the project path>/<session id>.jsonl`. */
const transcriptFile = (sessionId: string): string =>
  path.join(vendorProviderRoot('hermes'), vendorProjectHash(projectPath), `${sessionId}.jsonl`);

/** Writes a transcript file byte-for-byte in the historical shape, bypassing today's writer. */
async function writeHistoricalTranscript(sessionId: string, sessionName: string, lines: string[]): Promise<void> {
  const file = transcriptFile(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const meta = JSON.stringify({ type: 'meta', projectPath, sessionName });
  await fs.writeFile(file, `${[meta, ...lines].join('\n')}\n`, 'utf8');
}

before(async () => {
  closeConnection();
  await initializeDatabase();
  requesterId = userDb.createUser('hermes-history-owner', 'hash', 'owner').id;

  projectPath = path.join(os.homedir(), 'hermes-history-project');
  await fs.mkdir(projectPath, { recursive: true });
  projectId = projectsDb.createProjectPath(projectPath, null, requesterId).project.project_id;

  // The historical rows carry no jsonl_path: the reader must find the file itself.
  for (const [sessionId, name] of [[USER_ONLY_SESSION, 'user only'], [MULTI_TURN_SESSION, 'multi turn']] as const) {
    sessionsDb.createSession(sessionId, 'hermes', projectPath, name);
    participantsDb.recordSpawn(sessionId, requesterId);
    assert.equal(sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null, null, 'fixture row has no jsonl_path');
  }
  await writeHistoricalTranscript(USER_ONLY_SESSION, 'user only', [messageLine('user', 'a question with no reply')]);
  await writeHistoricalTranscript(
    MULTI_TURN_SESSION, 'multi turn', MULTI_TURN.map(([role, content]) => messageLine(role, content)),
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: Record<string, unknown> }).user = {
      id: requesterId, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'session', authorizationGeneration: 1,
    };
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  await fs.rm(projectPath, { recursive: true, force: true });
  // Only the two files this test wrote: the provider root may hold real history
  // when the file is run outside the isolating runner.
  for (const sessionId of [USER_ONLY_SESSION, MULTI_TURN_SESSION]) {
    await fs.rm(transcriptFile(sessionId), { force: true });
  }
});

describe('hermes is no longer a provider', () => {
  it('is absent from the registry, so nothing can launch, authenticate or configure it', () => {
    assert.equal(providerRegistry.listProviders().some((provider) => provider.id === 'hermes'), false);
    assert.throws(
      () => providerRegistry.resolveProvider('hermes'),
      (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
    );
  });

  it('keeps a history reader, and an unknown id still has none', () => {
    assert.equal(typeof providerRegistry.resolveHistorySessions('hermes').fetchHistory, 'function');
    for (const unknown of ['no-such-provider', 'constructor', 'toString', '__proto__']) {
      assert.throws(
        () => providerRegistry.resolveHistorySessions(unknown),
        (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
        unknown,
      );
    }
  });
});

describe('a historical hermes conversation still lists and opens', () => {
  it('lists both conversations in the hermes bucket of the project payload', async () => {
    const page = await getProjectSessionsPage(projectId, { currentUserId: requesterId }) as unknown as
      Record<string, Array<{ id: string }>>;
    const bucket = page[sessionBucketKey('hermes')];
    assert.ok(Array.isArray(bucket), 'the hermes bucket exists');
    const listed = bucket.map((session) => session.id);
    assert.ok(listed.includes(USER_ONLY_SESSION), 'the user-only conversation is listed');
    assert.ok(listed.includes(MULTI_TURN_SESSION), 'the multi-turn conversation is listed');
  });

  it('opens a transcript that holds a single user line and no reply', async () => {
    const history = await readHistory(USER_ONLY_SESSION);
    assert.equal(history.status, 200, history.raw);
    assert.deepEqual(
      history.messages.map((message) => [message.role, message.content]),
      [['user', 'a question with no reply']],
    );
  });

  it('opens a multi-turn transcript in recorded order, line breaks intact, without message ids', async () => {
    const history = await readHistory(MULTI_TURN_SESSION);
    assert.equal(history.status, 200, history.raw);
    assert.deepEqual(
      history.messages.map((message) => [message.role, message.content]),
      MULTI_TURN.map(([role, content]) => [role, content]),
    );
  });

  it('attributes every message to hermes through the history-only reader', async () => {
    const history = await providerRegistry.resolveHistorySessions('hermes')
      .fetchHistory(MULTI_TURN_SESSION, { projectPath });
    assert.equal(history.total, MULTI_TURN.length);
    assert.ok(history.messages.every((message) => message.provider === 'hermes'));
  });
});
