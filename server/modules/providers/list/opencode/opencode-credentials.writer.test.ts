/**
 * opencode-credentials.writer.test.ts — T-866/B2.
 *
 * Proves the opencode API-key writer merges into opencode's native auth.json
 * without disturbing other providers' entries, deletes only the requested
 * target, validates targets, and never persists a torn/leaky file. userId=null
 * resolves to the operator data dir (no isolation/DB), pinned to a sandbox via
 * XDG_DATA_HOME so the suite is hermetic. Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cred-writer-'));
const ORIGINAL_XDG = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = sandbox;

const { OpenCodeCredentialsWriter } = await import('./opencode-credentials.writer.js');

const authPath = path.join(sandbox, 'opencode', 'auth.json');
const writer = new OpenCodeCredentialsWriter();
const KEY = 'sk-oc-secret-DO-NOT-LEAK';

function readAuth(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(authPath, 'utf8'));
}

before(() => {});

beforeEach(() => {
  fs.rmSync(path.join(sandbox, 'opencode'), { recursive: true, force: true });
});

after(() => {
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIGINAL_XDG;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('capability advertises native_file + the internal targets (incl. glm)', () => {
  assert.deepEqual(writer.getWriterCapability(), {
    method: 'native_file',
    targets: ['anthropic', 'openai', 'openrouter', 'glm'],
  });
});

test('setApiKey writes {type:api,key} for the default (anthropic) target', async () => {
  const result = await writer.setApiKey(null, KEY);
  assert.deepEqual(result, { provider: 'opencode', configured: true });
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: KEY });
  assert.equal(await writer.isConfigured(null), true);
  // File is 0600 (owner-only).
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test('setApiKey merges: other providers in auth.json are preserved untouched', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    openai: { type: 'oauth', refresh: 'existing-oauth-token' },
    anthropic: { type: 'api', key: 'old-anthropic' },
  }));

  await writer.setApiKey(null, KEY, 'openrouter');
  const auth = readAuth();
  // The new target is added, the pre-existing entries are byte-for-byte intact.
  assert.deepEqual(auth.openrouter, { type: 'api', key: KEY });
  assert.deepEqual(auth.openai, { type: 'oauth', refresh: 'existing-oauth-token' });
  assert.deepEqual(auth.anthropic, { type: 'api', key: 'old-anthropic' });
});

test('setApiKey writes a glm entry as {type:api,key} into the same auth.json (GL-1)', async () => {
  const GLM_KEY = 'zai-glm-secret-DO-NOT-LEAK';
  const result = await writer.setApiKey(null, GLM_KEY, 'glm');
  assert.deepEqual(result, { provider: 'opencode', configured: true });
  // The glm entry uses opencode's native {type:'api',key} shape under the
  // provider id 'glm' — deliberately NOT 'anthropic' (would collide).
  assert.deepEqual(readAuth().glm, { type: 'api', key: GLM_KEY });
  assert.equal('anthropic' in readAuth(), false, 'glm never leaks into the anthropic id');
  assert.equal(await writer.isConfigured(null, 'glm'), true);
  // Same isolated, cage-covered file — 0600.
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test('glm merges without disturbing the existing anthropic/openai/openrouter targets', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    anthropic: { type: 'api', key: 'builtin-anthropic-key' },
    openai: { type: 'oauth', refresh: 'existing-oauth-token' },
    openrouter: { type: 'api', key: 'existing-openrouter-key' },
  }));

  await writer.setApiKey(null, 'glm-key-value', 'glm');
  const auth = readAuth();
  // New glm entry added...
  assert.deepEqual(auth.glm, { type: 'api', key: 'glm-key-value' });
  // ...and every pre-existing target survives byte-for-byte.
  assert.deepEqual(auth.anthropic, { type: 'api', key: 'builtin-anthropic-key' });
  assert.deepEqual(auth.openai, { type: 'oauth', refresh: 'existing-oauth-token' });
  assert.deepEqual(auth.openrouter, { type: 'api', key: 'existing-openrouter-key' });

  // Deleting glm removes only glm, leaving anthropic (regression guard for
  // "keep the existing anthropic target intact").
  await writer.deleteApiKey(null, 'glm');
  const after = readAuth();
  assert.equal('glm' in after, false, 'glm target removed');
  assert.deepEqual(after.anthropic, { type: 'api', key: 'builtin-anthropic-key' });
});

test('deleteApiKey removes only the requested target, leaving the rest', async () => {
  await writer.setApiKey(null, KEY, 'anthropic');
  await writer.setApiKey(null, 'other-key', 'openai');

  const result = await writer.deleteApiKey(null, 'anthropic');
  assert.deepEqual(result, { provider: 'opencode', configured: false });
  const auth = readAuth();
  assert.equal('anthropic' in auth, false, 'anthropic target removed');
  assert.deepEqual(auth.openai, { type: 'api', key: 'other-key' }, 'openai target preserved');
  // Idempotent: deleting again is a no-op.
  await writer.deleteApiKey(null, 'anthropic');
  assert.equal(await writer.isConfigured(null, 'anthropic'), false);
});

test('an unsupported target is rejected with 400 INVALID_CREDENTIAL_TARGET', async () => {
  await assert.rejects(
    () => writer.setApiKey(null, KEY, 'bogus'),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_CREDENTIAL_TARGET',
  );
});

test('an empty key is rejected with 400 INVALID_API_KEY', async () => {
  await assert.rejects(
    () => writer.setApiKey(null, '   '),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_API_KEY',
  );
});

test('a corrupt auth.json degrades to not-configured instead of throwing', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, '{ this is not json');
  assert.equal(await writer.isConfigured(null), false);
  // And a subsequent write recovers the file to valid JSON.
  await writer.setApiKey(null, KEY);
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: KEY });
});
