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
import { after, before, beforeEach, test, mock } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cred-writer-'));
const ORIGINAL_XDG = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = sandbox;

// ADR-152 A1 §3.4: a credential reader/writer needs a member. The resolver is
// stubbed so member MEMBER maps onto this suite's sandbox tree, and any other
// actor is refused exactly like the real resolver.
const MEMBER = 7;
{
  const realResolver = await import('../../../../services/isolation/resolve-provider-env.js');
  mock.module(new URL('../../../../services/isolation/resolve-provider-env.js', import.meta.url).href, {
    namedExports: {
      ...realResolver,
      resolveProviderEnv: (actor: unknown, _provider: string, env: NodeJS.ProcessEnv = process.env) => {
        if (actor !== MEMBER && actor !== String(MEMBER)) {
          throw Object.assign(new Error('CREDENTIAL_ACTOR_REQUIRED'), { code: 'CREDENTIAL_ACTOR_REQUIRED', statusCode: 500 });
        }
        return { ...env, ...{ HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`, CODEX_HOME: process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`, KIMI_CODE_HOME: `${process.env.HOME}/.kimi` } };
      },
    },
  });
}
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
  const result = await writer.setApiKey(MEMBER, KEY);
  assert.deepEqual(result, { provider: 'opencode', configured: true });
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: KEY });
  assert.equal(await writer.isConfigured(MEMBER), true);
  // File is 0600 (owner-only).
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test('setApiKey merges: other providers in auth.json are preserved untouched', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    openai: { type: 'oauth', refresh: 'existing-oauth-token' },
    anthropic: { type: 'api', key: 'old-anthropic' },
  }));

  await writer.setApiKey(MEMBER, KEY, 'openrouter');
  const auth = readAuth();
  // The new target is added, the pre-existing entries are byte-for-byte intact.
  assert.deepEqual(auth.openrouter, { type: 'api', key: KEY });
  assert.deepEqual(auth.openai, { type: 'oauth', refresh: 'existing-oauth-token' });
  assert.deepEqual(auth.anthropic, { type: 'api', key: 'old-anthropic' });
});

test('setApiKey writes a glm entry as {type:api,key} into the same auth.json (GL-1)', async () => {
  const GLM_KEY = 'zai-glm-secret-DO-NOT-LEAK';
  const result = await writer.setApiKey(MEMBER, GLM_KEY, 'glm');
  assert.deepEqual(result, { provider: 'opencode', configured: true });
  // The glm entry uses opencode's native {type:'api',key} shape under the
  // provider id 'glm' — deliberately NOT 'anthropic' (would collide).
  assert.deepEqual(readAuth().glm, { type: 'api', key: GLM_KEY });
  assert.equal('anthropic' in readAuth(), false, 'glm never leaks into the anthropic id');
  assert.equal(await writer.isConfigured(MEMBER, 'glm'), true);
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

  await writer.setApiKey(MEMBER, 'glm-key-value', 'glm');
  const auth = readAuth();
  // New glm entry added...
  assert.deepEqual(auth.glm, { type: 'api', key: 'glm-key-value' });
  // ...and every pre-existing target survives byte-for-byte.
  assert.deepEqual(auth.anthropic, { type: 'api', key: 'builtin-anthropic-key' });
  assert.deepEqual(auth.openai, { type: 'oauth', refresh: 'existing-oauth-token' });
  assert.deepEqual(auth.openrouter, { type: 'api', key: 'existing-openrouter-key' });

  // Deleting glm removes only glm, leaving anthropic (regression guard for
  // "keep the existing anthropic target intact").
  await writer.deleteApiKey(MEMBER, 'glm');
  const after = readAuth();
  assert.equal('glm' in after, false, 'glm target removed');
  assert.deepEqual(after.anthropic, { type: 'api', key: 'builtin-anthropic-key' });
});

test('deleteApiKey removes only the requested target, leaving the rest', async () => {
  await writer.setApiKey(MEMBER, KEY, 'anthropic');
  await writer.setApiKey(MEMBER, 'other-key', 'openai');

  const result = await writer.deleteApiKey(MEMBER, 'anthropic');
  assert.deepEqual(result, { provider: 'opencode', configured: false });
  const auth = readAuth();
  assert.equal('anthropic' in auth, false, 'anthropic target removed');
  assert.deepEqual(auth.openai, { type: 'api', key: 'other-key' }, 'openai target preserved');
  // Idempotent: deleting again is a no-op.
  await writer.deleteApiKey(MEMBER, 'anthropic');
  assert.equal(await writer.isConfigured(MEMBER, 'anthropic'), false);
});

test('an unsupported target is rejected with 400 INVALID_CREDENTIAL_TARGET', async () => {
  await assert.rejects(
    () => writer.setApiKey(MEMBER, KEY, 'bogus'),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_CREDENTIAL_TARGET',
  );
});

test('an empty key is rejected with 400 INVALID_API_KEY', async () => {
  await assert.rejects(
    () => writer.setApiKey(MEMBER, '   '),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_API_KEY',
  );
});

test('a corrupt auth.json degrades to not-configured instead of throwing', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, '{ this is not json');
  assert.equal(await writer.isConfigured(MEMBER), false);
  // And a subsequent write recovers the file to valid JSON.
  await writer.setApiKey(MEMBER, KEY);
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: KEY });
});

/**
 * B-377 — the same-target overwrite.
 *
 * The suite above proves the FILE-level merge (a different provider's entry
 * survives). The destructive case was the one with no coverage: assigning over
 * the SAME target replaces whatever record stood there, and an opencode browser
 * login carries a refresh token this app never held and cannot mint again — so
 * one paste signed the user out of a vendor with no way back.
 */
test('B-377: refuses to overwrite an oauth login with an API key', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    JSON.stringify({ anthropic: { type: 'oauth', refresh: 'irreplaceable-token' } }),
  );

  await assert.rejects(
    () => writer.setApiKey(MEMBER, KEY),
    (err: unknown) => (err as { code?: string }).code === 'CREDENTIAL_IS_LOGIN',
  );
  // The login is still there, byte for byte.
  assert.deepEqual(readAuth().anthropic, { type: 'oauth', refresh: 'irreplaceable-token' });
});

test('B-377: refuses to DELETE an oauth login too', async () => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ glm: { type: 'oauth', refresh: 'r' } }));

  await assert.rejects(
    () => writer.deleteApiKey(MEMBER, 'glm'),
    (err: unknown) => (err as { code?: string }).code === 'CREDENTIAL_IS_LOGIN',
  );
  assert.deepEqual(readAuth().glm, { type: 'oauth', refresh: 'r' });
});

test('B-377: fail-closed by shape — an unknown auth kind is protected too', async () => {
  // Not an allow-list: whatever opencode adds next is refused without an edit
  // here, because only `type: 'api'` is treated as ours to replace.
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'device_code', code: 'x' } }));

  await assert.rejects(
    () => writer.setApiKey(MEMBER, KEY, 'openai'),
    (err: unknown) => (err as { code?: string }).code === 'CREDENTIAL_IS_LOGIN',
  );
});

test('B-377: replacing an existing API key still works — the intended path', async () => {
  await writer.setApiKey(MEMBER, 'sk-oc-first');
  await writer.setApiKey(MEMBER, 'sk-oc-second');
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: 'sk-oc-second' });
});

test('B-377: an entry with no `type` is treated as ours (legacy records)', async () => {
  // A record written before the type field existed must not become permanently
  // unwritable — the guard keys on a type that is present AND not 'api'.
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { key: 'legacy' } }));
  await writer.setApiKey(MEMBER, KEY);
  assert.deepEqual(readAuth().anthropic, { type: 'api', key: KEY });
});
