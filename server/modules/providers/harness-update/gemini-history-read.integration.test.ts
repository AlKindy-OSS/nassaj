import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { AppError } from '@/shared/utils.js';

test('retired Gemini history remains HTTP-readable while active resolution stays refused', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-history-read-'));
  const transcript = path.join(fixtureRoot, 'legacy-gemini.jsonl');
  const sessionId = 'legacy-gemini-history-001';
  let server: Server | null = null;

  closeConnection();
  await initializeDatabase();
  try {
    const ownerId = userDb.createUser('legacy-gemini-owner', 'hash', 'user').id;
    await fs.writeFile(transcript, [
      JSON.stringify({ id: 'u1', type: 'user', content: 'old prompt', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'a1', type: 'gemini', content: 'old answer', timestamp: '2026-01-01T00:00:01Z' }),
    ].join('\n') + '\n');
    sessionsDb.createSession(sessionId, 'gemini', fixtureRoot, 'Legacy Gemini', undefined, undefined, transcript);
    participantsDb.recordSpawn(sessionId, ownerId);

    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: number } }).user = { id: ownerId };
      (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
      next();
    });
    app.use('/api/providers', providerRouter);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ code: error.code });
        return;
      }
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));

    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/sessions/${sessionId}/messages`);
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: Array<{ content?: string }>; total: number };
    assert.equal(body.total, 2);
    assert.deepEqual(body.messages.map((message) => message.content), ['old prompt', 'old answer']);

    assert.equal(providerRegistry.listProviders().some((provider) => provider.id === 'gemini'), false);
    assert.throws(() => providerRegistry.resolveProvider('gemini'), { code: 'UNSUPPORTED_PROVIDER' });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
