/**
 * ADR-214 / T-2066 — the 'admin-billing' namespace (a member's Anthropic Admin key).
 *
 * Pinned:
 *  1. Member-scoped CRUD, isolated between members, encrypted at rest (0600).
 *  2. The operator-wide scope is refused — through the dedicated wrappers AND
 *     through the generic namespaced API, so no call site can create a shared
 *     Admin key that would show every member the organization's spend.
 *  3. Spawn-env guard: no spawn/env resolver reads this namespace; only the
 *     spend service may read the key.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _resetProviderSecretsServerKeyCache,
  deleteAnthropicAdminKey,
  deleteNamespacedSecret,
  getAnthropicAdminKey,
  getNamespacedSecret,
  SECRET_NAMESPACES,
  setAnthropicAdminKey,
  setNamespacedSecret,
  SYSTEM_SECRET_SCOPE,
} from '@/services/isolation/provider-secrets-store.js';

const KEY_A = 'sk-ant-admin01-' + 'MemberAFakeKey_123';
const KEY_B = 'sk-ant-admin01-' + 'MemberBFakeKey_456';

function withSandbox(): { homeDir: string; restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-admin-billing-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;
  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();
  return {
    homeDir,
    restore: () => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      if (originalKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
      else process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
      _resetProviderSecretsServerKeyCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test('admin-billing is a declared namespace', () => {
  assert.ok(SECRET_NAMESPACES.includes('admin-billing'));
});

test('member CRUD is isolated, encrypted at rest and 0600', () => {
  const sandbox = withSandbox();
  try {
    setAnthropicAdminKey(1, KEY_A);
    setAnthropicAdminKey(2, KEY_B);
    assert.equal(getAnthropicAdminKey(1), KEY_A);
    assert.equal(getAnthropicAdminKey(2), KEY_B);
    assert.equal(getAnthropicAdminKey(3), null);

    const file = path.join(sandbox.homeDir, '.nassaj-users', '1', '.provider-secrets', 'keys.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(KEY_A), 'plaintext never on disk');
    assert.ok(raw.includes('admin-billing:anthropic'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(sandbox.homeDir, '.nassaj-provider-secrets', 'keys.json')));

    assert.equal(deleteAnthropicAdminKey(1).removed, true);
    assert.equal(deleteAnthropicAdminKey(1).removed, false);
    assert.equal(getAnthropicAdminKey(1), null);
    assert.equal(getAnthropicAdminKey(2), KEY_B, 'deleting A leaves B untouched');
  } finally {
    sandbox.restore();
  }
});

test('the operator-wide scope is refused by the wrappers and the generic API', () => {
  const sandbox = withSandbox();
  try {
    const scope = SYSTEM_SECRET_SCOPE as unknown as number;
    assert.throws(() => setAnthropicAdminKey(scope, KEY_A), /member-scoped/);
    assert.throws(() => getAnthropicAdminKey(scope), /member-scoped/);
    assert.throws(() => deleteAnthropicAdminKey(scope), /member-scoped/);
    assert.throws(() => setNamespacedSecret(SYSTEM_SECRET_SCOPE, 'admin-billing', 'anthropic', KEY_A), /member-scoped/);
    assert.throws(() => getNamespacedSecret(SYSTEM_SECRET_SCOPE, 'admin-billing', 'anthropic'), /member-scoped/);
    assert.throws(() => deleteNamespacedSecret(SYSTEM_SECRET_SCOPE, 'admin-billing', 'anthropic'), /member-scoped/);
    for (const implicit of [null, undefined, '']) {
      assert.throws(() => getAnthropicAdminKey(implicit as unknown as number), TypeError);
    }
    // Other namespaces keep their operator-wide slot.
    setNamespacedSecret(SYSTEM_SECRET_SCOPE, 'speech', 'whisper', 'sk-whisper-test');
    assert.equal(getNamespacedSecret(SYSTEM_SECRET_SCOPE, 'speech', 'whisper'), 'sk-whisper-test');
  } finally {
    sandbox.restore();
  }
});

/** Every non-test server source file, relative to the repo root. */
function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
        out.push(path.relative(process.cwd(), full));
      }
    }
  };
  walk(path.join(process.cwd(), 'server'));
  return out;
}

test('spawn-env guard: only the spend service reads the Admin key', () => {
  const allowed = new Set([
    'server/services/isolation/provider-secrets-store.js',
    'server/modules/providers/services/usage/anthropic-api-spend.service.ts',
  ]);
  const readers = serverSources().filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return /admin-billing|getAnthropicAdminKey/.test(text);
  });
  assert.ok(readers.length >= 2, 'the scan saw the store and the service');
  assert.deepEqual(readers.filter(file => !allowed.has(file)), []);

  for (const resolver of [
    'server/services/isolation/resolve-provider-env.js',
    'server/services/isolation/resolve-provider-env-strict.js',
    'server/services/isolation/provider-slot-key.js',
  ]) {
    const text = fs.readFileSync(resolver, 'utf8');
    assert.ok(!/admin-billing|AnthropicAdminKey|getNamespacedSecret/.test(text), resolver);
  }
});
