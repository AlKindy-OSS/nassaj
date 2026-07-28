/**
 * active-model.routes.test.ts — HTTP contract of
 * `GET /api/providers/:provider/sessions/:sessionId/active-model` (T-1028 / B-248).
 *
 * Drives the REAL provider router over a REAL (throwaway) sqlite database and the
 * REAL nassaj-owned override store — no mocks, no stubbed visibility gate — so
 * what is asserted is the wire behaviour a browser gets. The override store lives
 * under `$HOME/.cloudcli/...`, so `HOME` is repointed at a temp dir for the run:
 * the singleton service reads/writes an isolated file and the operator's real
 * store is never touched.
 *
 * The endpoint must reflect the model the NEXT resumed turn will actually use —
 * an explicit in-conversation re-pick when one is stored, otherwise the provider's
 * own per-session active model (which itself degrades to the catalog default) —
 * NOT the caller's global picker. Provider 'gemini' is used because its
 * `getCurrentActiveModel` returns a STATIC fallback with no network / no transcript
 * read, so the "no override → default" branch is deterministic.
 *
 * Security: the route takes the session 'read' mandate and, like the sibling POST
 * (B-IDOR-SESSION), refuses with a 404 identical to a missing session so a probed
 * sessionId is never confirmed to an unauthorized caller.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError, writeProviderSessionActiveModelChange } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';

type TestUser = { id: number; role: string };

const PROVIDER = 'gemini';
const OVERRIDE_MODEL = 'gemini-2.5-pro-override';

// uuid v4 ids — the shared session-id validator accepts them.
const PUBLIC_PINNED_SID = randomUUID(); // has an explicit stored re-pick
const PUBLIC_UNPINNED_SID = randomUUID(); // no override → provider default
const PRIVATE_SID = randomUUID(); // in a private project, for the refusal test
const UNKNOWN_SID = '00000000-0000-4000-8000-000000000000';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';
let homeDir = '';
let originalHome: string | undefined;

let memberUser: TestUser;
let outsiderUser: TestUser;

let publicProjectPath = '';
let privateProjectPath = '';

async function get(
  urlPath: string,
  user: TestUser | null,
): Promise<{ status: number; text: string }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`);
  return { status: response.status, text: await response.text() };
}

const activeModelUrl = (provider: string, sessionId: string): string =>
  `/api/providers/${provider}/sessions/${sessionId}/active-model`;

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-ws-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-home-'));
  // Isolate the override store (`$HOME/.cloudcli/...`) into a temp home so the
  // real operator store is neither read nor written by this test.
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  memberUser = userDb.createUser('activemodel_member', 'hash', 'user') as TestUser;
  outsiderUser = userDb.createUser('activemodel_outsider', 'hash', 'user') as TestUser;

  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'public-proj-'));
  privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'private-proj-'));

  projectsDb.createProjectPath(publicProjectPath, 'Public Project', memberUser.id);
  const privateCreated = projectsDb.createProjectPath(
    privateProjectPath,
    'Private Project',
    memberUser.id,
  );
  projectsDb.setProjectVisibility(privateCreated.project?.project_id as string, 'private');

  sessionsDb.createSession(PUBLIC_PINNED_SID, PROVIDER, publicProjectPath);
  sessionsDb.createSession(PUBLIC_UNPINNED_SID, PROVIDER, publicProjectPath);
  sessionsDb.createSession(PRIVATE_SID, PROVIDER, privateProjectPath);

  // Persist an explicit in-conversation re-pick for ONE public session, through
  // the same provider-agnostic store the route reads.
  await writeProviderSessionActiveModelChange(PROVIDER, {
    sessionId: PUBLIC_PINNED_SID,
    model: OVERRIDE_MODEL,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
        return;
      }
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
    },
  );

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('explicit stored re-pick is returned with source "session-override"', async () => {
  const { status, text } = await get(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), memberUser);
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    provider: PROVIDER,
    sessionId: PUBLIC_PINNED_SID,
    model: OVERRIDE_MODEL,
    source: 'session-override',
    supported: true,
    changed: true,
  });
});

test('no override falls back to the provider default with source "provider-current"', async () => {
  const { status, text } = await get(activeModelUrl(PROVIDER, PUBLIC_UNPINNED_SID), memberUser);
  assert.equal(status, 200);
  const { data } = JSON.parse(text);
  assert.equal(data.provider, PROVIDER);
  assert.equal(data.sessionId, PUBLIC_UNPINNED_SID);
  assert.equal(data.source, 'provider-current');
  assert.equal(data.changed, false);
  assert.equal(data.supported, true);
  // The default is populated (never null/empty → never a 500) and is NOT the
  // other session's stored override — i.e. the pin does not bleed across sessions.
  assert.equal(typeof data.model, 'string');
  assert.ok(data.model.length > 0, 'the default model is always populated');
  assert.notEqual(data.model, OVERRIDE_MODEL);
});

test('read authorization is enforced: an outsider gets a 404 indistinguishable from an unknown id', async () => {
  const refused = await get(activeModelUrl(PROVIDER, PRIVATE_SID), outsiderUser);
  const unknown = await get(activeModelUrl(PROVIDER, UNKNOWN_SID), outsiderUser);

  assert.equal(refused.status, 404, 'refusal is a 404, not a 403');
  assert.equal(refused.status, unknown.status, 'same status — no existence tell');

  const refusedBody = JSON.parse(refused.text);
  const unknownBody = JSON.parse(unknown.text);
  assert.equal(refusedBody.error.code, 'SESSION_NOT_FOUND');
  assert.equal(refusedBody.error.code, unknownBody.error.code, 'same error code');

  // The shared gate echoes the CALLER'S OWN requested id (which they already
  // know) — never the session's real data. Normalizing each response's own id
  // out proves the existing-but-invisible session is byte-identical to a
  // nonexistent one: existence is not disclosed.
  const normalize = (text: string, sid: string): string => text.split(sid).join('<SID>');
  assert.equal(
    normalize(refused.text, PRIVATE_SID),
    normalize(unknown.text, UNKNOWN_SID),
    'identical once the caller-supplied id is normalized out',
  );
  assert.ok(!refused.text.includes(OVERRIDE_MODEL), 'no model leaks to an unauthorized caller');
});

test('an unresolvable caller (no req.user) is refused on a public session', async () => {
  const { status } = await get(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), null);
  assert.equal(status, 404);
});

test('a malformed session id is rejected without echoing it', async () => {
  const { status, text } = await get(
    `/api/providers/${PROVIDER}/sessions/..%2F..%2Fetc%2Fpasswd/active-model`,
    memberUser,
  );
  assert.equal(status, 400);
  assert.ok(!text.includes('passwd'), 'the rejected value is never reflected');
});

test('the route performs no writes: an unpinned session gains no override entry', async () => {
  await get(activeModelUrl(PROVIDER, PUBLIC_UNPINNED_SID), memberUser);
  const storePath = path.join(homeDir, '.cloudcli', 'provider-session-active-model-changes.json');
  if (fs.existsSync(storePath)) {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.ok(
      !Object.prototype.hasOwnProperty.call(store.entries ?? {}, `${PROVIDER}:${PUBLIC_UNPINNED_SID}`),
      'reading an unpinned session must not create an override entry',
    );
  }
  // The unknown id was NOT adopted into the sessions table by asking about it.
  assert.equal(sessionsDb.getSessionById(UNKNOWN_SID), null);
});
