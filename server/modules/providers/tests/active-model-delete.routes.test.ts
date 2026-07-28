/**
 * active-model-delete.routes.test.ts — HTTP contract of
 * `DELETE /api/providers/:provider/sessions/:sessionId/active-model` (B-252).
 *
 * Drives the REAL provider router over a REAL (throwaway) sqlite database and the
 * REAL nassaj-owned override store — no mocks, no stubbed visibility gate — so
 * what is asserted is the wire behaviour a browser gets. The override store lives
 * under `$HOME/.cloudcli/...`, so `HOME` is repointed at a temp dir for the run:
 * the singleton service reads/writes an isolated file and the operator's real
 * store is never touched (mirrors active-model.routes.test.ts).
 *
 * The DELETE unpins a session: it removes the stored explicit re-pick so the next
 * resumed turn follows the ordinary flow again. The response must report whether a
 * pin actually existed (`cleared`) and the model that WILL now drive the session —
 * always the provider-current value once the override is gone. Provider 'gemini'
 * is used because its `getCurrentActiveModel` returns a STATIC fallback (no
 * network / no transcript read), so the post-delete model is deterministic and
 * distinguishable from any stored override.
 *
 * Security: the route takes the session 'write' mandate — unpinning changes the
 * model the user's conversation resumes on — and, like the sibling POST/GET
 * (B-IDOR-SESSION), refuses with a 404 identical to a missing session so a probed
 * sessionId is never confirmed, and an unauthorized DELETE mutates nothing.
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
const OVERRIDE_MODEL = 'gemini-2.5-pro-public-override';
const PRIVATE_OVERRIDE_MODEL = 'gemini-2.5-pro-PRIVATE-secret';

// uuid v4 ids — the shared session-id validator accepts them.
const PUBLIC_PINNED_SID = randomUUID(); // pinned inside the "clear existing" test
const PUBLIC_UNPINNED_SID = randomUUID(); // never pinned → idempotent no-op
const PRIVATE_SID = randomUUID(); // pinned, in a private project, for the refusal test
const UNKNOWN_SID = '00000000-0000-4000-8000-000000000000';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';
let homeDir = '';
let storePath = '';
let originalHome: string | undefined;

let memberUser: TestUser;
let outsiderUser: TestUser;

let publicProjectPath = '';
let privateProjectPath = '';

const activeModelUrl = (provider: string, sessionId: string): string =>
  `/api/providers/${provider}/sessions/${sessionId}/active-model`;

async function request(
  urlPath: string,
  method: 'GET' | 'DELETE',
  user: TestUser | null,
): Promise<{ status: number; text: string }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, { method });
  return { status: response.status, text: await response.text() };
}

const get = (urlPath: string, user: TestUser | null) => request(urlPath, 'GET', user);
const del = (urlPath: string, user: TestUser | null) => request(urlPath, 'DELETE', user);

// Raw bytes of the override store, or null when the file does not exist. A DELETE
// that "performs no write" must leave this byte-for-byte identical.
const snapshotStore = (): string | null =>
  (fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null);

const readStoreEntries = (): Record<string, unknown> => {
  if (!fs.existsSync(storePath)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  return (parsed?.entries ?? {}) as Record<string, unknown>;
};

const storeKey = (sessionId: string): string => `${PROVIDER}:${sessionId}`;

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-del-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-del-ws-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activemodel-del-home-'));
  storePath = path.join(homeDir, '.cloudcli', 'provider-session-active-model-changes.json');
  // Isolate the override store (`$HOME/.cloudcli/...`) into a temp home so the
  // real operator store is neither read nor written by this test.
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  memberUser = userDb.createUser('activemodel_del_member', 'hash', 'user') as TestUser;
  outsiderUser = userDb.createUser('activemodel_del_outsider', 'hash', 'user') as TestUser;

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

  // The private session carries a distinctive pin so the refusal test can prove an
  // unauthorized DELETE neither discloses it nor clears it.
  await writeProviderSessionActiveModelChange(PROVIDER, {
    sessionId: PRIVATE_SID,
    model: PRIVATE_OVERRIDE_MODEL,
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

test('clears an existing pin: cleared=true, returns the model that will actually apply, and is idempotent', async () => {
  // Pin the public session through the same provider-agnostic store the route uses.
  await writeProviderSessionActiveModelChange(PROVIDER, {
    sessionId: PUBLIC_PINNED_SID,
    model: OVERRIDE_MODEL,
  });
  // Precondition: the GET reflects the explicit re-pick.
  const before = JSON.parse((await get(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), memberUser)).text);
  assert.equal(before.data.source, 'session-override');
  assert.equal(before.data.model, OVERRIDE_MODEL);

  const { status, text } = await del(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), memberUser);
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.success, true);

  // Contract shape: EXACTLY these five fields, no leakage of internal flags.
  assert.deepEqual(Object.keys(body.data).sort(), ['cleared', 'model', 'provider', 'sessionId', 'source']);
  assert.equal(body.data.provider, PROVIDER);
  assert.equal(body.data.sessionId, PUBLIC_PINNED_SID);
  assert.equal(body.data.cleared, true, 'an existing pin is reported as cleared');
  assert.equal(body.data.source, 'provider-current');
  // The returned model is the provider-current default: populated and NOT the
  // override that was just removed.
  assert.equal(typeof body.data.model, 'string');
  assert.ok(body.data.model.length > 0, 'the applied model is always populated');
  assert.notEqual(body.data.model, OVERRIDE_MODEL, 'the removed override is not what now applies');

  // The stored override entry is actually gone from disk.
  assert.equal(
    Object.prototype.hasOwnProperty.call(readStoreEntries(), storeKey(PUBLIC_PINNED_SID)),
    false,
    'the override entry must be deleted from the store',
  );

  // "The returned model = what will actually apply": a follow-up GET agrees byte
  // for byte and now reports no override.
  const after = JSON.parse((await get(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), memberUser)).text);
  assert.equal(after.data.source, 'provider-current');
  assert.equal(after.data.changed, false);
  assert.equal(after.data.model, body.data.model, 'DELETE reports the model the next resume will use');

  // Idempotent: a second DELETE on the now-unpinned session reports cleared=false.
  const second = JSON.parse((await del(activeModelUrl(PROVIDER, PUBLIC_PINNED_SID), memberUser)).text);
  assert.equal(second.data.cleared, false, 'a second unpin is a no-op');
  assert.equal(second.data.model, body.data.model, 'and still reports the applied model');
});

test('unpinning an unpinned session is an idempotent 200 no-op that writes nothing', async () => {
  const before = snapshotStore();
  const { status, text } = await del(activeModelUrl(PROVIDER, PUBLIC_UNPINNED_SID), memberUser);
  const after = snapshotStore();

  assert.equal(status, 200, 'a missing pin is not a 404');
  const body = JSON.parse(text);
  assert.equal(body.data.cleared, false, 'nothing to clear → cleared=false');
  assert.equal(body.data.source, 'provider-current');
  assert.ok(typeof body.data.model === 'string' && body.data.model.length > 0);

  // No write: the store bytes are byte-for-byte identical (a missing file stays
  // missing; an existing one is not rewritten).
  assert.equal(after, before, 'unpinning an unpinned session must not write the store');
  assert.equal(
    Object.prototype.hasOwnProperty.call(readStoreEntries(), storeKey(PUBLIC_UNPINNED_SID)),
    false,
    'no override entry may be created by unpinning',
  );
});

test('write mandate enforced: an outsider gets a 404 indistinguishable from an unknown id, and mutates nothing', async () => {
  const before = snapshotStore();
  const refused = await del(activeModelUrl(PROVIDER, PRIVATE_SID), outsiderUser);
  const unknown = await del(activeModelUrl(PROVIDER, UNKNOWN_SID), outsiderUser);
  const after = snapshotStore();

  assert.equal(refused.status, 404, 'refusal is a 404, not a 403');
  assert.equal(refused.status, unknown.status, 'same status — no existence tell');

  const refusedBody = JSON.parse(refused.text);
  const unknownBody = JSON.parse(unknown.text);
  assert.equal(refusedBody.error.code, 'SESSION_NOT_FOUND');
  assert.equal(refusedBody.error.code, unknownBody.error.code, 'same error code');

  // Normalizing each response's own (caller-supplied) id out proves the
  // existing-but-invisible session is byte-identical to a nonexistent one.
  const normalize = (text: string, sid: string): string => text.split(sid).join('<SID>');
  assert.equal(
    normalize(refused.text, PRIVATE_SID),
    normalize(unknown.text, UNKNOWN_SID),
    'identical once the caller-supplied id is normalized out',
  );
  assert.ok(!refused.text.includes(PRIVATE_OVERRIDE_MODEL), 'the victim pin never leaks to an unauthorized caller');

  // The refused DELETE mutated nothing: the store is unchanged and the victim's
  // pin survives intact.
  assert.equal(after, before, 'an unauthorized DELETE must not write the store');
  assert.deepEqual(
    (readStoreEntries()[storeKey(PRIVATE_SID)] as { model?: string })?.model,
    PRIVATE_OVERRIDE_MODEL,
    "the victim's pin must survive an unauthorized DELETE",
  );
});

test('an unresolvable caller (no req.user) is refused on a public session', async () => {
  const before = snapshotStore();
  const { status } = await del(activeModelUrl(PROVIDER, PUBLIC_UNPINNED_SID), null);
  assert.equal(status, 404, 'the write mandate refuses a null identity');
  assert.equal(snapshotStore(), before, 'a refused DELETE writes nothing');
});

test('a malformed session id is rejected with 400 without echoing it', async () => {
  const { status, text } = await del(
    `/api/providers/${PROVIDER}/sessions/..%2F..%2Fetc%2Fpasswd/active-model`,
    memberUser,
  );
  assert.equal(status, 400);
  assert.equal(JSON.parse(text).error.code, 'INVALID_SESSION_ID');
  assert.ok(!text.includes('passwd'), 'the rejected value is never reflected');
});
