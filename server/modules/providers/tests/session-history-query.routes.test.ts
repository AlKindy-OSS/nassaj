import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';

let server: Server;
let baseUrl = '';
const sessionId = '00000001-0000-4000-8000-000000000001';

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: 1 };
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
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

for (const query of ['payload=small', 'payload=', 'limit=1junk', 'limit=-1', 'limit=501', 'offset=2.5']) {
  test(`history query rejects ${query} before provider or cache access`, async () => {
    const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/messages?${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'INVALID_QUERY_PARAMETER');
  });
}
