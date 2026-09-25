import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

import express from 'express';

import { AccountWalletService } from '@/modules/account-wallet/index.js';
import {
  closeConnection,
  deviceAccountSessionsDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

let cancelled = false;
let finishClone: (() => void) | null = null;
mock.module(new URL('./services/project-clone.service.js', import.meta.url).href, {
  namedExports: {
    startCloneProject: async (
      _input: unknown,
      handlers: { onProgress: (message: string) => void },
    ) => {
      handlers.onProgress('clone-started');
      const waitForCompletion = new Promise<void>((resolve) => { finishClone = resolve; });
      return {
        waitForCompletion,
        cancel: () => {
          cancelled = true;
          handlers.onProgress('late-old-account-progress');
          finishClone?.();
        },
      };
    },
  },
});

const { default: projectsRouter } = await import('./projects.routes.js');

test('production clone SSE cancels work on device invalidation without Accept', async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser('clone_sse_owner', 'hash', 'owner');
  const device = deviceAccountSessionsDb.create(user.id, 60_000);
  const resolved = deviceAccountSessionsDb.resolve(device.secret)!;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const row = userDb.getUserById(user.id)!;
    (request as express.Request & { user?: unknown }).user = {
      ...row,
      userId: row.id,
      authenticationKind: 'device_session',
      authorizationGeneration: row.authorization_generation,
      deviceSessionId: resolved.principal.deviceSessionId,
      slotId: resolved.principal.slotId,
      deviceGeneration: resolved.principal.generation,
    };
    next();
  });
  app.use('/api/projects', projectsRouter);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const ticketResponse = await fetch(`${baseUrl}/api/projects/clone-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/var/tmp',
        githubUrl: 'https://github.com/example/repository',
      }),
    });
    assert.equal(ticketResponse.status, 201);
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const response = await fetch(`${baseUrl}/api/projects/clone-progress?ticket=${ticket}`);
    assert.equal(response.status, 200);
    const body = response.text();
    const service = new AccountWalletService({
      findLocalCredential: () => null,
      verifyPassword: async () => false,
      decoyPasswordHash: 'unused',
    });
    service.logoutAll(resolved.principal, resolved.principal.generation);
    assert.equal(await body,
      'data: {"type":"progress","message":"clone-started"}\n\n'
      + 'event: identity_revoked\ndata: {}\n\n');
    assert.equal(cancelled, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});
