/* eslint-disable boundaries/dependencies -- integration test drives the project membership service through the provider route. */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AccountWalletService } from '@/modules/account-wallet/index.js';
import {
  closeConnection,
  deviceAccountSessionsDb,
  initializeDatabase,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
  type WorkspaceTopologyFence,
} from '@/modules/database/index.js';
import { removeMember } from '@/modules/projects/services/project-visibility-management.service.js';
import { AppError } from '@/shared/utils.js';

import providerRouter, { retainDistinctWorkspaceFence } from './provider.routes.js';
import { providerModelsService } from './services/provider-models.service.js';
import { sessionConversationsSearchService } from './services/session-conversations-search.service.js';

test('search fence set deduplicates registered project tokens but retains projectless consent', () => {
  const processInstance = {};
  const subjectAccessToken = {};
  const projectStructureToken = {};
  const first = {
    kind: 'project', processInstance, projectId: 'project-a', userId: 7,
    subjectAccessToken, projectStructureToken,
  } as const;
  const equivalent = { ...first };
  const changed = { ...first, projectStructureToken: {} };
  const fences = new Set<WorkspaceTopologyFence>();
  assert.equal(retainDistinctWorkspaceFence(fences, first), first);
  assert.equal(retainDistinctWorkspaceFence(fences, equivalent), first);
  assert.equal(retainDistinctWorkspaceFence(fences, changed), changed);
  assert.equal(fences.size, 2);

  const projectlessBase = {
    kind: 'projectless', processInstance, userId: 7, resolvedPath: '/workspace/unregistered',
    workspaceTopologyToken: {}, consent: 'read',
  } as const;
  retainDistinctWorkspaceFence(fences, { ...projectlessBase, sessionId: 'session-a' });
  retainDistinctWorkspaceFence(fences, { ...projectlessBase, sessionId: 'session-b' });
  assert.equal(fences.size, 4);
});

test('production search SSE fences a device without requiring Accept', async (context) => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser('search_sse_owner', 'hash', 'owner');
  const device = deviceAccountSessionsDb.create(user.id, 60_000);
  const resolved = deviceAccountSessionsDb.resolve(device.secret)!;
  let aborted = false;
  let searchStarted!: () => void;
  const started = new Promise<void>((resolve) => { searchStarted = resolve; });
  context.mock.method(
    sessionConversationsSearchService,
    'search',
    async ({ signal, onProgress }) => {
      onProgress({
        projectResult: null,
        totalMatches: 0,
        scannedProjects: 0,
        totalProjects: 1,
      });
      searchStarted();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }, { once: true }));
      // A backing producer can finish after cancellation; its old-account
      // progress must never reach the now-revoked HTTP stream.
      onProgress({ projectResult: null, totalMatches: 99, scannedProjects: 1, totalProjects: 1 });
    },
  );

  const app = express();
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
    (request as express.Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity =
      () => deviceAccountSessionsDb.isPrincipalCurrent(resolved.principal);
    next();
  });
  app.use('/api/providers', providerRouter);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=needle`);
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('content-type')?.includes('text/event-stream'), false);
    const body = response.text();
    await started;
    const service = new AccountWalletService({
      findLocalCredential: () => null,
      verifyPassword: async () => false,
      decoyPasswordHash: 'unused',
    });
    service.logoutAll(resolved.principal, resolved.principal.generation);
    assert.equal(await body,
      'event: progress\ndata: {"totalMatches":0,"scannedProjects":0,"totalProjects":1}\n\n'
      + 'event: identity_revoked\ndata: {}\n\n');
    assert.equal(aborted, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});

test('membership removal generation fences late search progress', async (context) => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  await initializeDatabase();
  const creator = userDb.createUser('search_project_creator', 'hash', 'user');
  const member = userDb.createUser('search_project_member', 'hash', 'user');
  const project = projectsDb.createProjectPath(process.cwd(), 'Search project', creator.id).project!;
  sessionsDb.createSession('search-project-session', 'claude', process.cwd());
  projectMembersDb.add(project.project_id, member.id, 'member', creator.id);
  const device = deviceAccountSessionsDb.create(member.id, 60_000);
  const resolved = deviceAccountSessionsDb.resolve(device.secret)!;
  const admittedGeneration = member.authorization_generation;
  let searchStarted!: () => void;
  let releaseSearch!: () => void;
  const started = new Promise<void>((resolve) => { searchStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseSearch = resolve; });
  context.mock.method(sessionConversationsSearchService, 'search', async ({ authorizeSession, onProgress }) => {
    assert.equal(authorizeSession?.('search-project-session', process.cwd()), true);
    onProgress({ projectResult: null, totalMatches: 0, scannedProjects: 0, totalProjects: 1 });
    searchStarted();
    await release;
    assert.equal(authorizeSession?.('search-project-session', process.cwd()), false);
    onProgress({ projectResult: null, totalMatches: 99, scannedProjects: 1, totalProjects: 1 });
  });

  const app = express();
  app.use((request, _response, next) => {
    (request as express.Request & { user?: unknown }).user = {
      ...member,
      userId: member.id,
      authenticationKind: 'device_session',
      authorizationGeneration: admittedGeneration,
      deviceSessionId: resolved.principal.deviceSessionId,
      slotId: resolved.principal.slotId,
      deviceGeneration: resolved.principal.generation,
    };
    (request as express.Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity =
      () => deviceAccountSessionsDb.isPrincipalCurrent(resolved.principal);
    next();
  });
  app.use('/api/providers', providerRouter);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=needle`);
    const body = response.text();
    await started;
    removeMember(project.project_id, member.id, creator.id);
    assert.equal(userDb.getRawById(member.id)?.authorization_generation, admittedGeneration);
    releaseSearch();
    assert.equal(await body,
      'event: progress\ndata: {"totalMatches":0,"scannedProjects":0,"totalProjects":1}\n\n'
      + 'event: access_fence\ndata: {"type":"access_fence","code":"project_access_changed"}\n\n');
  } finally {
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});

test('JWT search checks identity on empty progress and done boundaries', async (context) => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser('search_jwt_boundary', 'hash', 'user');
  let current = true;
  let searchStarted!: () => void;
  let releaseSearch!: () => void;
  const started = new Promise<void>((resolve) => { searchStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseSearch = resolve; });
  context.mock.method(sessionConversationsSearchService, 'search', async ({ onProgress }) => {
    onProgress({ projectResult: null, totalMatches: 0, scannedProjects: 0, totalProjects: 0 });
    searchStarted();
    await release;
  });

  const app = express();
  app.use((request, _response, next) => {
    (request as express.Request & { user?: unknown }).user = {
      ...user,
      userId: user.id,
      authenticationKind: 'session',
      authorizationGeneration: user.authorization_generation,
    };
    (request as express.Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity =
      () => current;
    next();
  });
  app.use('/api/providers', providerRouter);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=needle`);
    const body = response.text();
    await started;
    current = false;
    releaseSearch();
    assert.equal(await body,
      'event: progress\ndata: {"totalMatches":0,"scannedProjects":0,"totalProjects":0}\n\n'
      + 'event: access_fence\ndata: {"type":"access_fence","code":"identity_changed"}\n\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});

test('catalog refresh becoming stale reports post-effect unknown and discloses no models', async (context) => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser('catalog_jwt_boundary', 'hash', 'user');
  let current = true;
  context.mock.method(providerModelsService, 'getProviderModels', async () => {
    current = false;
    return {
      models: { DEFAULT: 'secret-model', OPTIONS: [] },
      cache: { state: 'refreshed' },
      revalidating: false,
    } as never;
  });

  const app = express();
  app.use((request, _response, next) => {
    (request as express.Request & { user?: unknown }).user = {
      ...user, id: user.id, authenticationKind: 'session',
      authorizationGeneration: user.authorization_generation,
    };
    (request as express.Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity =
      () => current;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((error: unknown, _request: express.Request, response: express.Response,
    _next: express.NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        code: error.code,
        ...(error.details && typeof error.details === 'object' ? error.details : {}),
      });
      return;
    }
    response.status(500).json({ code: 'internal_error' });
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/providers/qwen/models`);
    assert.equal(response.status, 409);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      code: 'identity_changed', notStarted: false, effectState: 'outcome_unknown',
    });
    assert.equal(JSON.stringify(body).includes('secret-model'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});
