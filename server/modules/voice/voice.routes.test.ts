/**
 * voice.routes.test.ts — ADR-103 / T-1246.
 *
 * The properties that make this surface safe to ship, pinned end-to-end through
 * the REAL router, a REAL migrated SQLite database and the REAL encrypted
 * secrets store (sandboxed to a temp home). Only the provider call is faked —
 * no request leaves the machine.
 *
 *  1. FAIL-CLOSED. Absent row, '0', 'true', ' 1' — everything that is not
 *     exactly '1' leaves the transcription call answering 404.
 *  2. ASYMMETRIC GATE. The 404 covers the transcription call and the key writes;
 *     GET .../settings must still answer `enabled:false`, because it is the only
 *     way the client can explain why accurate mode is missing.
 *  3. ROLE GATES. `system` scope is owner/admin; `user` scope is any member, for
 *     themselves only; settings writes are owner-only; platform mode refuses
 *     every write.
 *  4. KEY RESOLUTION ORDER. Member key first, installation key second, 409
 *     NO_TRANSCRIPTION_KEY third — asserted on the bearer token the provider
 *     actually received, not on a status code that any of the three could give.
 *  5. UPLOAD LIMITS. An unlisted mime type is refused; a recording above the
 *     configured ceiling is a 413 and never reaches the provider.
 *  6. NO LEAK. Every response body in the suite is scanned for the key values.
 *
 * Runner: node:test via tsx (`npm run test:server`).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';

import {
  appConfigDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  stopReconcileScheduler,
} from '@/modules/database/index.js';
import { _resetProviderSecretsServerKeyCache } from '@/services/isolation/provider-secrets-store.js';

const OWNER_KEY = 'sk-INSTALLATION-KEY-DO-NOT-LEAK-0001';
const MEMBER_KEY = 'sk-MEMBER-KEY-DO-NOT-LEAK-0002';
const SECRET_VALUES = [OWNER_KEY, MEMBER_KEY];

/** Deterministic 32-byte AES key so the store writes no key file in the sandbox. */
const TEST_SERVER_KEY = Buffer.alloc(32, 11).toString('base64');

type ProviderCall = {
  url: string;
  authorization: string | null;
  model: string | null;
  language: string | null;
  fileType: string | null;
  fileBytes: number;
};

const providerCalls: ProviderCall[] = [];
let providerReply: () => Response = () =>
  new Response(JSON.stringify({ text: 'نص مفرَّغ', language: 'arabic' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = (async (input: unknown, init: { body?: unknown; headers?: unknown }) => {
  const form = init.body as FormData;
  const file = form.get('file');
  providerCalls.push({
    url: String(input),
    authorization: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
    model: (form.get('model') as string | null) ?? null,
    language: (form.get('language') as string | null) ?? null,
    fileType: file instanceof Blob ? file.type : null,
    fileBytes: file instanceof Blob ? file.size : 0,
  });
  return providerReply();
}) as unknown as typeof fetch;

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sandboxHome = '';
let tempDirectory = '';
const realHomedir = os.homedir;
const previousDatabasePath = process.env.DATABASE_PATH;
const previousServerKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const previousPlatform = process.env.VITE_IS_PLATFORM;

/** Every response body seen in the suite, scanned once at the end for leaks. */
const seenBodies: string[] = [];

type Caller = { id?: number; role?: string };

async function call(
  method: string,
  routePath: string,
  options: { as?: Caller; body?: unknown } = {},
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.as?.id !== undefined) headers['x-test-user'] = String(options.as.id);
  if (options.as?.role !== undefined) headers['x-test-role'] = options.as.role;
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  seenBodies.push(text);
  return { status: response.status, text, body: text ? JSON.parse(text) : {} };
}

async function postAudio(options: {
  as?: Caller;
  bytes?: number;
  mimeType?: string;
  language?: string;
} = {}) {
  const form = new FormData();
  const size = options.bytes ?? 32;
  form.append(
    'audio',
    new Blob([new Uint8Array(size).fill(1)], { type: options.mimeType ?? 'audio/webm' }),
    'recording.webm',
  );
  if (options.language !== undefined) form.append('language', options.language);
  const headers: Record<string, string> = {};
  if (options.as?.id !== undefined) headers['x-test-user'] = String(options.as.id);
  if (options.as?.role !== undefined) headers['x-test-role'] = options.as.role;
  const response = await fetch(`${baseUrl}/api/voice/transcription`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await response.text();
  seenBodies.push(text);
  return { status: response.status, text, body: text ? JSON.parse(text) : {} };
}

before(async () => {
  sandboxHome = await mkdtemp(path.join(os.tmpdir(), 'voice-routes-home-'));
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_SERVER_KEY;
  _resetProviderSecretsServerKeyCache();

  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-routes-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  stopReconcileScheduler();

  // Real rows for the callers: audit_log has an FK to users, and an audit row
  // that silently fails to write is exactly what this suite must be able to
  // assert on (auditLogDb.record swallows its own errors by design).
  const db = getConnection();
  for (const [id, role] of [[1, 'owner'], [2, 'user'], [3, 'admin'], [4, 'user']] as const) {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id,
      `member${id}`,
      'x',
      role,
    );
  }

  const { createVoiceRouter } = await import('@/modules/voice/voice.routes.js');

  const app = express();
  app.use(express.json());
  // Stands in for authenticateToken: headers decide identity and role, which is
  // exactly the contract the router reads (req.user.id / req.user.role).
  app.use((req, _res, next) => {
    const id = req.header('x-test-user');
    if (id) {
      (req as express.Request & { user?: unknown }).user = {
        id: Number(id),
        role: req.header('x-test-role') ?? 'user',
      };
    }
    next();
  });
  app.use('/api/voice', createVoiceRouter({ fetchImpl: fakeFetch }));

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  providerCalls.length = 0;
  providerReply = () =>
    new Response(JSON.stringify({ text: 'نص مفرَّغ', language: 'arabic' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  delete process.env.VITE_IS_PLATFORM;
  await rm(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  await rm(path.join(sandboxHome, '.nassaj-provider-secrets'), { recursive: true, force: true });
  for (const key of [
    'voice_transcription.enabled',
    'voice_transcription.base_url',
    'voice_transcription.model',
    'voice_transcription.max_mb',
  ]) {
    appConfigDb.set(key, '');
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  (os as unknown as { homedir: () => string }).homedir = realHomedir;
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousServerKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = previousServerKey;
  if (previousPlatform === undefined) delete process.env.VITE_IS_PLATFORM;
  else process.env.VITE_IS_PLATFORM = previousPlatform;
  _resetProviderSecretsServerKeyCache();
  await rm(sandboxHome, { recursive: true, force: true });
  await rm(tempDirectory, { recursive: true, force: true });
});

/** Turns the feature on and stores a key at the requested scope(s). */
const enable = () => appConfigDb.set('voice_transcription.enabled', '1');

const storeKey = async (scope: 'system' | 'user', as: Caller, apiKey: string) => {
  const response = await call('PUT', '/api/voice/transcription/key', {
    as,
    body: { apiKey, scope },
  });
  assert.equal(response.status, 200, response.text);
  return response;
};

// ─────────────────────────── 1. fail-closed ────────────────────────────────

test('fail-closed: only the exact string "1" opens the transcription call', async () => {
  for (const value of ['', '0', 'true', 'yes', 'on', ' 1', '1 ', '2']) {
    appConfigDb.set('voice_transcription.enabled', value);
    const response = await postAudio({ as: { id: 1, role: 'owner' } });
    assert.equal(response.status, 404, `value ${JSON.stringify(value)} must stay closed`);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  assert.equal(providerCalls.length, 0, 'a closed surface must never call the provider');
});

test('fail-closed: the key writes are 404 while the feature is off', async () => {
  const put = await call('PUT', '/api/voice/transcription/key', {
    as: { id: 1, role: 'owner' },
    body: { apiKey: OWNER_KEY, scope: 'system' },
  });
  assert.equal(put.status, 404);
  const del = await call('DELETE', '/api/voice/transcription/key?scope=system', {
    as: { id: 1, role: 'owner' },
  });
  assert.equal(del.status, 404);
});

// ──────────────────── 2. the settings read stays visible ───────────────────

test('GET settings answers (not 404) while the feature is off', async () => {
  const response = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 2, role: 'user' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.available, false);
  assert.equal(response.body.canManage, false);
  assert.equal(response.body.baseUrl, 'https://api.openai.com/v1');
  assert.equal(response.body.model, 'whisper-1');
  assert.equal(response.body.maxMb, 10);
  assert.deepEqual(response.body.key, { system: false, user: false });
});

test('canManage is the owner role, and `available` needs both the flag and a key', async () => {
  const asOwner = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
  });
  assert.equal(asOwner.body.canManage, true);

  const asAdmin = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 3, role: 'admin' },
  });
  assert.equal(asAdmin.body.canManage, false);

  enable();
  const noKey = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
  });
  assert.equal(noKey.body.enabled, true);
  assert.equal(noKey.body.available, false, 'enabled without a key is not available');

  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);
  const withKey = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
  });
  assert.deepEqual(withKey.body.key, { system: true, user: false });
  assert.equal(withKey.body.available, true);
});

// ─────────────────────────── 3. role gates ─────────────────────────────────

test('settings writes are owner-only and validate every field', async () => {
  const asAdmin = await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 3, role: 'admin' },
    body: { enabled: true },
  });
  assert.equal(asAdmin.status, 403);
  assert.equal(asAdmin.body.code, 'INSUFFICIENT_ROLE');

  const ok = await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
    body: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', maxMb: 15 },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.enabled, true);
  assert.equal(ok.body.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(ok.body.maxMb, 15);

  // Plain http to a remote host, credentials, and a query string are all refused.
  for (const baseUrl of [
    'http://api.openai.com/v1',
    'https://evil.example@api.openai.com/v1',
    'https://api.openai.com/v1?key=x',
    'ftp://api.openai.com/v1',
    'not-a-url',
  ]) {
    const bad = await call('PUT', '/api/voice/transcription/settings', {
      as: { id: 1, role: 'owner' },
      body: { baseUrl },
    });
    assert.equal(bad.status, 400, `${baseUrl} must be refused`);
    assert.equal(bad.body.code, 'INVALID_BASE_URL');
  }

  // …but loopback over http is allowed: nothing leaves the machine.
  const loopback = await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
    body: { baseUrl: 'http://127.0.0.1:8080/v1' },
  });
  assert.equal(loopback.status, 200, loopback.text);

  // The hard ceiling is not the owner's to raise.
  const tooBig = await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
    body: { maxMb: 100 },
  });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.code, 'INVALID_MAX_MB');
  const stillFifteen = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
  });
  assert.equal(stillFifteen.body.maxMb, 15, 'a refused patch must change nothing');
});

test('system scope is owner/admin; user scope is any member, for themselves only', async () => {
  enable();

  const member = await call('PUT', '/api/voice/transcription/key', {
    as: { id: 2, role: 'user' },
    body: { apiKey: MEMBER_KEY, scope: 'system' },
  });
  assert.equal(member.status, 403);
  assert.equal(member.body.code, 'INSUFFICIENT_ROLE');

  const admin = await storeKey('system', { id: 3, role: 'admin' }, OWNER_KEY);
  assert.deepEqual(admin.body, { scope: 'system', configured: true });

  await storeKey('user', { id: 2, role: 'user' }, MEMBER_KEY);

  // Member 2 sees their own key; member 4 does not.
  const mine = await call('GET', '/api/voice/transcription/settings', { as: { id: 2, role: 'user' } });
  assert.deepEqual(mine.body.key, { system: true, user: true });
  const theirs = await call('GET', '/api/voice/transcription/settings', { as: { id: 4, role: 'user' } });
  assert.deepEqual(theirs.body.key, { system: true, user: false });

  const badScope = await call('PUT', '/api/voice/transcription/key', {
    as: { id: 2, role: 'user' },
    body: { apiKey: MEMBER_KEY, scope: 'everyone' },
  });
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.code, 'INVALID_SCOPE');

  const anonymous = await call('PUT', '/api/voice/transcription/key', {
    body: { apiKey: MEMBER_KEY, scope: 'user' },
  });
  assert.equal(anonymous.status, 401);
});

test('platform mode refuses every write while reads keep working', async () => {
  enable();
  process.env.VITE_IS_PLATFORM = 'true';

  const settings = await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
    body: { enabled: false },
  });
  assert.equal(settings.status, 403);
  assert.equal(settings.body.code, 'PLATFORM_MODE_WRITE_REFUSED');

  const key = await call('PUT', '/api/voice/transcription/key', {
    as: { id: 1, role: 'owner' },
    body: { apiKey: OWNER_KEY, scope: 'system' },
  });
  assert.equal(key.status, 403);
  assert.equal(key.body.code, 'PLATFORM_MODE_WRITE_REFUSED');

  const read = await call('GET', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.canManage, false, 'the UI must not offer a button the route refuses');
});

// ─────────────────── 4. key resolution order ───────────────────────────────

test('resolution order: member key, then installation key, then 409', async () => {
  enable();

  const none = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NO_TRANSCRIPTION_KEY');
  assert.equal(providerCalls.length, 0);

  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);
  const viaSystem = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(viaSystem.status, 200, viaSystem.text);
  assert.equal(providerCalls.at(-1)?.authorization, `Bearer ${OWNER_KEY}`);

  await storeKey('user', { id: 2, role: 'user' }, MEMBER_KEY);
  const viaMember = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(viaMember.status, 200, viaMember.text);
  assert.equal(
    providerCalls.at(-1)?.authorization,
    `Bearer ${MEMBER_KEY}`,
    'a member with their own key must stop spending the installation key',
  );

  // Another member is unaffected by member 2's key.
  const other = await postAudio({ as: { id: 4, role: 'user' } });
  assert.equal(other.status, 200);
  assert.equal(providerCalls.at(-1)?.authorization, `Bearer ${OWNER_KEY}`);

  // Deleting the member key falls back to the installation key.
  const removed = await call('DELETE', '/api/voice/transcription/key?scope=user', {
    as: { id: 2, role: 'user' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { scope: 'user', configured: false });
  const afterDelete = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(afterDelete.status, 200);
  assert.equal(providerCalls.at(-1)?.authorization, `Bearer ${OWNER_KEY}`);
});

test('the request carries the configured model and endpoint; language only when asked', async () => {
  enable();
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);

  await postAudio({ as: { id: 2, role: 'user' } });
  const auto = providerCalls.at(-1);
  assert.equal(auto?.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(auto?.model, 'whisper-1');
  assert.equal(auto?.language, null, 'no hint ⇒ auto-detect');
  assert.equal(auto?.fileType, 'audio/webm');

  await postAudio({ as: { id: 2, role: 'user' }, language: 'ar' });
  assert.equal(providerCalls.at(-1)?.language, 'ar');

  const badLanguage = await postAudio({ as: { id: 2, role: 'user' }, language: '../../etc' });
  assert.equal(badLanguage.status, 400);
  assert.equal(badLanguage.body.code, 'INVALID_LANGUAGE');
});

// ───────────────────────── 5. upload limits ────────────────────────────────

test('an unlisted audio type never reaches the provider', async () => {
  enable();
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);

  const response = await postAudio({ as: { id: 2, role: 'user' }, mimeType: 'application/zip' });
  assert.equal(response.status, 415);
  assert.equal(response.body.code, 'UNSUPPORTED_AUDIO_TYPE');
  assert.equal(providerCalls.length, 0);
});

test('a recording above the configured ceiling is a 413 and is not forwarded', async () => {
  enable();
  appConfigDb.set('voice_transcription.max_mb', '1');
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);

  const tooBig = await postAudio({ as: { id: 2, role: 'user' }, bytes: 2 * 1024 * 1024 });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'AUDIO_TOO_LARGE');
  assert.equal(tooBig.body.maxMb, 1);
  assert.equal(providerCalls.length, 0);

  const fits = await postAudio({ as: { id: 2, role: 'user' }, bytes: 512 * 1024 });
  assert.equal(fits.status, 200, fits.text);
  assert.equal(providerCalls.length, 1);
});

test('an empty body is refused before any provider call', async () => {
  enable();
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);

  const response = await fetch(`${baseUrl}/api/voice/transcription`, {
    method: 'POST',
    headers: { 'x-test-user': '2', 'x-test-role': 'user', 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await response.text();
  seenBodies.push(text);
  assert.ok(response.status === 400 || response.status === 500, `got ${response.status}`);
  assert.equal(providerCalls.length, 0);
});

// ─────────────────── 6. provider failures, and no leak ─────────────────────

test('a provider 401 becomes 502 INVALID_TRANSCRIPTION_KEY, never a 401', async () => {
  enable();
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);
  providerReply = () =>
    new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${OWNER_KEY}` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

  const response = await postAudio({ as: { id: 2, role: 'user' } });
  // A 401 here would make the browser think the SESSION died and log the user
  // out (B-88); a rejected third-party key is an upstream failure.
  assert.notEqual(response.status, 401);
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'INVALID_TRANSCRIPTION_KEY');
  assert.ok(!response.text.includes(OWNER_KEY), 'the provider body must not be echoed');
});

test('a provider 429 is surfaced as a rate limit, other failures as 502', async () => {
  enable();
  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);

  providerReply = () => new Response('slow down', { status: 429 });
  const limited = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'TRANSCRIPTION_RATE_LIMITED');

  providerReply = () => new Response('boom', { status: 500 });
  const broken = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(broken.status, 502);
  assert.equal(broken.body.code, 'TRANSCRIPTION_FAILED');
});

test('the audit trail records the act, never the key, the audio or the text', async () => {
  enable();
  getConnection().prepare("DELETE FROM audit_log WHERE action LIKE 'voice_%'").run();

  await storeKey('system', { id: 1, role: 'owner' }, OWNER_KEY);
  await call('PUT', '/api/voice/transcription/settings', {
    as: { id: 1, role: 'owner' },
    body: { model: 'whisper-1' },
  });
  const spoken = await postAudio({ as: { id: 2, role: 'user' } });
  assert.equal(spoken.status, 200);

  const rows = getConnection()
    .prepare("SELECT action, metadata FROM audit_log WHERE action LIKE 'voice_%' ORDER BY id")
    .all() as Array<{ action: string; metadata: string | null }>;
  const actions = rows.map((row) => row.action);
  assert.deepEqual(actions, [
    'voice_transcription_key_set',
    'voice_transcription_settings_updated',
    'voice_transcription_used',
  ]);
  const recorded = JSON.stringify(rows);
  assert.ok(!recorded.includes(OWNER_KEY));
  assert.ok(!recorded.includes('نص مفرَّغ'), 'the transcript must never be audited');
  assert.deepEqual(JSON.parse(rows[2].metadata ?? '{}'), { keyScope: 'system', bytes: 32 });
});

test('no response body in this suite ever contained a key', () => {
  assert.ok(seenBodies.length > 20, 'the scan is only meaningful over the whole suite');
  for (const body of seenBodies) {
    for (const secret of SECRET_VALUES) {
      assert.ok(!body.includes(secret), `a response leaked ${secret.slice(0, 8)}…`);
    }
  }
});
