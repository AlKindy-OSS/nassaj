/**
 * ADR-227 "DSH local corrector" / T-2108 — acceptance (1) in the owner's terms: "a
 * DeepSeek Harness chat on my real local model server writes hello.txt with مرحبا
 * and reads it back". The real runtime, database, launch seam, corrector, layer,
 * policy plugin and broker, and the REAL dsh against a REAL llama.cpp server; the
 * version gate is the committed registry (run `node scripts/prove-local-engine.mjs
 * dsh` first). The member has no DeepSeek key at all.
 *
 * Runs only when NASSAJ_TEST_DSH_BIN (a dsh lib/bin.js), NASSAJ_TEST_LOCAL_SERVER_URL
 * (`http://<private literal>:<port>/v1`), NASSAJ_TEST_LOCAL_MODEL and optionally
 * NASSAJ_TEST_LOCAL_SERVER_KEY / NASSAJ_TEST_LOCAL_CONTEXT are set and the server
 * answers; skipped otherwise. NASSAJ_TEST_DSH_GOVERNANCE names a governance file to
 * run with (the base-prompt measurement uses the real one; default: a stub).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

const REAL = {
  bin: process.env.NASSAJ_TEST_DSH_BIN ?? '',
  url: process.env.NASSAJ_TEST_LOCAL_SERVER_URL ?? '',
  model: process.env.NASSAJ_TEST_LOCAL_MODEL ?? '',
  key: process.env.NASSAJ_TEST_LOCAL_SERVER_KEY ?? '',
  window: Number(process.env.NASSAJ_TEST_LOCAL_CONTEXT ?? 32768),
};

/** True when the configured real server answers its model list. */
function reachable(): boolean {
  if (!REAL.url || !REAL.model) return false;
  const headers = REAL.key ? ['-H', `Authorization: Bearer ${REAL.key}`] : [];
  return spawnSync('curl', ['-sf', '-m', '5', ...headers, `${REAL.url.replace(/\/+$/u, '')}/models`], { timeout: 10_000 }).status === 0;
}
const SKIP = !REAL.bin || !fs.existsSync(REAL.bin) ? 'NASSAJ_TEST_DSH_BIN not set' : (!reachable() ? 'no reachable NASSAJ_TEST_LOCAL_SERVER_URL' : false);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-real-'));
const saved: Record<string, string | undefined> = {};
after(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

it('a DSH chat on my real local model writes hello.txt and reads it back', { skip: SKIP, timeout: 600_000 }, async (t) => {
  const home = path.join(sandbox, 'operator-home');
  const workspace = path.join(sandbox, 'workspace');
  for (const dir of [path.join(home, '.claude'), workspace, path.join(sandbox, 'managed')]) fs.mkdirSync(dir, { recursive: true });
  const governance = process.env.NASSAJ_TEST_DSH_GOVERNANCE;
  fs.writeFileSync(path.join(home, '.claude', 'AGENTS.md'), governance ? fs.readFileSync(governance) : '# governance\n');
  const env = { HOME: home, DATABASE_PATH: path.join(sandbox, 'db.sqlite'), DSH_PATH: fs.realpathSync(REAL.bin),
    NASSAJ_PROVIDER_SECRETS_KEY: crypto.randomBytes(32).toString('base64') };
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  const db = await import('@/modules/database/index.js');
  await db.initializeDatabase();
  const secrets = await import('@/services/isolation/provider-secrets-store.js');
  secrets._resetProviderSecretsServerKeyCache();
  const { createDshRuntime } = await import('@/modules/providers/list/dsh/dsh-acp-runtime.js');
  for (const [key, value] of [['local_models.enabled', 'true'], ['local_models.consent_version', '1'], ['local_models.dsh_enabled', 'true']]) {
    db.appConfigDb.set(key, value);
  }
  const owner = db.userDb.createUser('dsh-real-owner', 'hash', 'user');
  const id = crypto.randomUUID();
  const server = { id, ownerId: Number(owner.id), providerId: `nassaj_local_${id.replaceAll('-', '')}`, name: 'real', baseUrl: REAL.url,
    runtime: 'llamacpp', models: [{ id: REAL.model, contextWindow: REAL.window }] };
  db.localModelServersDb.save(server);
  db.localModelServersDb.setVerifiedAddresses(server, [new URL(REAL.url).hostname]);
  if (REAL.key) secrets.setLocalModelSecret(Number(owner.id), id, REAL.key);

  const runtime = createDshRuntime({ managedSettingsDir: path.join(sandbox, 'managed') });
  const frames: Array<Record<string, any>> = [];
  const writer = { userId: Number(owner.id), ws: Object.assign(new EventEmitter(), { readyState: 1 }), send: (f: Record<string, any>) => frames.push(f),
    setSessionId() {} };
  try {
    await runtime.spawnDsh('Create a file named hello.txt in the current directory containing exactly the word: مرحبا . '
      + 'Then read the file back with a tool and reply with its exact contents.',
    { cwd: workspace, permissionMode: 'bypassPermissions', model: `${server.providerId}/${REAL.model}` }, writer);
  } finally {
    await runtime.stopDshProcesses();
  }
  const done = frames.find((f) => f.kind === 'complete');
  const reply = frames.filter((f) => f.kind === 'stream_delta').map((f) => f.content).join('');
  t.diagnostic(`frames: ${frames.map((f) => f.kind).join(',')}; reply: ${reply.slice(0, 200)}`);
  assert.equal(done?.exitCode, 0, JSON.stringify(frames.filter((f) => f.kind !== 'stream_delta')).slice(0, 2000));
  assert.equal(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8').trim(), 'مرحبا');
  assert.ok(frames.some((f) => f.kind === 'tool_use'), 'the model used tools');
  assert.match(reply, /مرحبا/u);
  const sessionId = frames.find((f) => f.kind === 'session_created')?.newSessionId;
  assert.match(String(db.sessionsDb.getSessionEnginePin(sessionId)?.engine), /^local:/u);
  db.closeConnection();
});
