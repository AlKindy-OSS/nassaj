import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _resetProviderSecretsServerKeyCache,
  deleteProviderKey,
  getProviderKey,
  hasProviderKey,
  isVendorSecretProvider,
  listProviderKeys,
  setProviderKey,
} from '@/services/isolation/provider-secrets-store.js';

/**
 * Points os.homedir at a throwaway directory and pins a deterministic server key
 * so encryption is stable for the duration of one test. Returns a restore fn.
 */
function withSandbox(): { homeDir: string; restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-secrets-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;

  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();

  return {
    homeDir,
    restore: () => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      if (originalKey === undefined) {
        delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
      } else {
        process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
      }
      _resetProviderSecretsServerKeyCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test('provider-secrets-store: set then get round-trips the key for a user', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('7', 'kimi', 'sk-kimi-abc123');
    assert.equal(getProviderKey('7', 'kimi'), 'sk-kimi-abc123');
    assert.equal(hasProviderKey('7', 'kimi'), true);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: stores ciphertext at rest (no plaintext on disk)', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('7', 'deepseek', 'sk-deepseek-secret-value');
    const file = path.join(sandbox.homeDir, '.nassaj-users', '7', '.provider-secrets', 'keys.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sk-deepseek-secret-value'), 'plaintext key must not appear on disk');
    assert.match(raw, /v1:/, 'record must use the versioned encrypted envelope');
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: per-user isolation — one user never reads another key', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('1', 'glm', 'sk-user1-glm');
    setProviderKey('2', 'glm', 'sk-user2-glm');

    assert.equal(getProviderKey('1', 'glm'), 'sk-user1-glm');
    assert.equal(getProviderKey('2', 'glm'), 'sk-user2-glm');
    // User 2 has no kimi key even though user 1 might; absence is null, no leak.
    setProviderKey('1', 'kimi', 'sk-user1-kimi');
    assert.equal(getProviderKey('2', 'kimi'), null);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: delete removes the key and is idempotent', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('5', 'kimi', 'sk-kimi-todelete');
    assert.equal(deleteProviderKey('5', 'kimi').removed, true);
    assert.equal(getProviderKey('5', 'kimi'), null);
    assert.equal(hasProviderKey('5', 'kimi'), false);
    // Deleting again is a no-op, not an error.
    assert.equal(deleteProviderKey('5', 'kimi').removed, false);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: listProviderKeys returns only ids with usable keys', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('9', 'kimi', 'sk-a');
    setProviderKey('9', 'glm', 'sk-b');
    const listed = listProviderKeys('9').sort();
    assert.deepEqual(listed, ['glm', 'kimi']);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: rejects unsupported providers and empty keys', () => {
  const sandbox = withSandbox();
  try {
    assert.equal(isVendorSecretProvider('kimi'), true);
    assert.equal(isVendorSecretProvider('claude'), false);
    assert.throws(() => setProviderKey('1', 'claude' as never, 'x'), /Unsupported secret provider/);
    assert.throws(() => setProviderKey('1', 'kimi', '  '), /non-empty/);
    // Reading an unsupported provider returns null rather than throwing.
    assert.equal(getProviderKey('1', 'claude' as never), null);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: a tampered record decrypts to null, never throws', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('3', 'kimi', 'sk-original');
    const file = path.join(sandbox.homeDir, '.nassaj-users', '3', '.provider-secrets', 'keys.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    // Flip the last char of the ciphertext segment to corrupt the auth tag/body.
    const original = parsed.kimi;
    parsed.kimi = original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A');
    fs.writeFileSync(file, JSON.stringify(parsed));
    assert.equal(getProviderKey('3', 'kimi'), null);
  } finally {
    sandbox.restore();
  }
});

test('provider-secrets-store: single-user (null userId) uses a shared home-root store', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey(null, 'deepseek', 'sk-single-user');
    assert.equal(getProviderKey(null, 'deepseek'), 'sk-single-user');
    const file = path.join(sandbox.homeDir, '.nassaj-provider-secrets', 'keys.json');
    assert.ok(fs.existsSync(file), 'null userId must resolve to the shared home-root store');
  } finally {
    sandbox.restore();
  }
});
