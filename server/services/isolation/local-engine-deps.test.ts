/**
 * T-2098 qa item 8 — (a) a failed first load of the local-engine production deps
 * is retried on the next spawn instead of refusing forever; (b) the server list
 * the spawn reads is complete, so a member's 101st server is not `server_not_found`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2098-deps-'));
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, appConfigDb, localModelServersDb } =
  await import('@/modules/database/index.js');
const { authorizedLocalModelServers } = await import('@/services/isolation/local-model-config.js');
const { memoizeUntilRejected } = await import('@/services/isolation/apply-claude-local-engine-env.js');

await initializeDatabase();
after(() => { closeConnection(); fs.rmSync(sandbox, { recursive: true, force: true }); });

test('a rejected load is forgotten; a fulfilled one is cached', async () => {
  let calls = 0;
  const load = memoizeUntilRejected(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient import failure');
    return { ok: calls };
  });
  await assert.rejects(load(), /transient/u);
  assert.deepEqual(await load(), { ok: 2 });
  assert.deepEqual(await load(), { ok: 2 });
  assert.equal(calls, 2);
});

test("a member's 101st server is listed for the spawn", () => {
  appConfigDb.set('local_models.enabled', 'true');
  appConfigDb.set('local_models.consent_version', '1');
  const owner = userDb.createUser('paging-owner', 'hash', 'user');
  const ownerId = Number(owner.id);
  for (let index = 0; index < 101; index += 1) {
    const id = crypto.randomUUID();
    localModelServersDb.save({
      id, ownerId, providerId: `nassaj_local_${id.replaceAll('-', '')}`, name: `s${index}`,
      baseUrl: `http://10.0.0.${(index % 250) + 1}:8080/v1`, runtime: 'llamacpp', models: [],
    });
  }
  assert.equal(authorizedLocalModelServers(ownerId).length, 101);
});

test('the Claude local path has its own default-off switch, independent of OpenCode local models', async () => {
  const { claudeLocalEngineEnabled } = await import('@/services/isolation/local-model-config.js');
  appConfigDb.set('local_models.enabled', 'true');
  appConfigDb.set('local_models.consent_version', '1');
  assert.equal(claudeLocalEngineEnabled(), false, 'OpenCode local models on, Claude local path still off');
  appConfigDb.set('local_models.claude_enabled', 'true');
  assert.equal(claudeLocalEngineEnabled(), true);
  appConfigDb.set('local_models.enabled', 'false');
  assert.equal(claudeLocalEngineEnabled(), false, 'the master switch still governs');
  appConfigDb.set('local_models.enabled', 'true');
  appConfigDb.set('local_models.claude_enabled', 'false');
});
