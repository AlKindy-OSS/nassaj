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
  deleteNamespacedSecret,
  getNamespacedSecret,
  hasNamespacedSecret,
  isVendorSecretProvider,
  listConnectorSecrets,
  listProviderKeys,
  setNamespacedSecret,
  setProviderKey,
  setSharedVendorKey,
  getSharedVendorKey,
  SYSTEM_SECRET_SCOPE,
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

test('provider-secrets-store: the shared vendor slot uses the home-root store', () => {
  const sandbox = withSandbox();
  try {
    setSharedVendorKey('deepseek', 'sk-single-user');
    assert.equal(getSharedVendorKey('deepseek'), 'sk-single-user');
    const file = path.join(sandbox.homeDir, '.nassaj-provider-secrets', 'keys.json');
    assert.ok(fs.existsSync(file), 'the shared slot must resolve to the home-root store');
  } finally {
    sandbox.restore();
  }
});

// T-1260 — the rename is only enforcement if the vendor API actually refuses the
// scope. Without this, a caller could import SYSTEM_SECRET_SCOPE (still exported
// for connector/speech secrets) and rebuild `?? SYSTEM_SCOPE` under a new name.
test('provider-secrets-store: the vendor key API refuses the operator-wide scope', () => {
  const sandbox = withSandbox();
  try {
    assert.throws(() => getProviderKey(SYSTEM_SECRET_SCOPE, 'kimi'), TypeError);
    assert.throws(() => hasProviderKey(SYSTEM_SECRET_SCOPE, 'kimi'), TypeError);
    assert.throws(() => setProviderKey(SYSTEM_SECRET_SCOPE, 'kimi', 'sk-x'), TypeError);
    assert.throws(() => deleteProviderKey(SYSTEM_SECRET_SCOPE, 'kimi'), TypeError);
  } finally {
    sandbox.restore();
  }
});

/**
 * T-1122: the store used to accept null/undefined/'' and quietly answer from the
 * system store. That is how B-342 stayed invisible — a catalog client asked with
 * a hardcoded `null`, read an empty directory, and reported "no key" instead of
 * "you forgot to say who". An implicit scope is now a caller bug, in EVERY
 * environment (`.env` sets NODE_ENV=production, so a dev-only throw would never
 * fire on the box that matters).
 */
test('provider-secrets-store: an implicit scope throws instead of silently using the system store', () => {
  const sandbox = withSandbox();
  try {
    for (const implicit of [null, undefined, '']) {
      assert.throws(
        () => getProviderKey(implicit as never, 'deepseek'),
        /userId is required/,
        `implicit scope ${JSON.stringify(implicit)} must throw`,
      );
      assert.throws(
        () => setProviderKey(implicit as never, 'deepseek', 'sk-x'),
        /userId is required/,
      );
      assert.throws(
        () => deleteProviderKey(implicit as never, 'deepseek'),
        /userId is required/,
      );
    }
  } finally {
    sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// T-1225 / ADR-098 — namespaced secrets (external connectors)
// ---------------------------------------------------------------------------

/**
 * The load-bearing compatibility claim: connector secrets share the vendor keys'
 * file, envelope, and permissions, and adding them must not disturb a single
 * existing record. This asserts the ACTUAL legacy on-disk shape (a bare provider
 * id, not `vendor:kimi`) rather than a shape invented for the test — a prefixed
 * fixture would pass while every real member tree silently lost its keys.
 */
test('namespaced secrets: connector records coexist with unprefixed legacy vendor keys', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey(7, 'kimi', 'sk-vendor-kimi');
    setNamespacedSecret(7, 'connector', 'canva', 'sk-canva-live');

    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(sandbox.homeDir, '.nassaj-users', '7', '.provider-secrets', 'keys.json'),
        'utf8',
      ),
    ) as Record<string, string>;

    assert.deepEqual(
      Object.keys(onDisk).sort(),
      ['connector:canva', 'kimi'],
      'vendor keys stay bare; only connectors are prefixed',
    );
    assert.match(onDisk.kimi, /^v1:/, 'legacy record keeps the v1 envelope');
    assert.equal(getProviderKey(7, 'kimi'), 'sk-vendor-kimi', 'vendor read is unaffected');
    assert.equal(getNamespacedSecret(7, 'connector', 'canva'), 'sk-canva-live');
    assert.deepEqual(listProviderKeys(7), ['kimi'], 'connectors never leak into the vendor list');
    assert.deepEqual(listConnectorSecrets(7), ['canva']);
  } finally {
    sandbox.restore();
  }
});

/** A connector secret belongs to one member only — the isolation the whole feature rests on. */
test('namespaced secrets: connector secrets are per-scope and never bleed across members', () => {
  const sandbox = withSandbox();
  try {
    setNamespacedSecret(1, 'connector', 'wafeq', 'sk-member-one');
    assert.equal(getNamespacedSecret(2, 'connector', 'wafeq'), null);
    assert.equal(hasNamespacedSecret(2, 'connector', 'wafeq'), false);
    assert.deepEqual(listConnectorSecrets(2), []);
    assert.equal(getNamespacedSecret(SYSTEM_SECRET_SCOPE, 'connector', 'wafeq'), null);
  } finally {
    sandbox.restore();
  }
});

/**
 * A ':' in a connector id would make `connector:a:b` ambiguous against a future
 * (namespace, id) pair, so the charset is closed rather than escaped.
 */
test('namespaced secrets: malformed ids and unknown namespaces are rejected on write and read', () => {
  const sandbox = withSandbox();
  try {
    for (const bad of ['a:b', '', '../escape', '-leading', 'x'.repeat(65)]) {
      assert.throws(() => setNamespacedSecret(1, 'connector', bad, 'v'), /Secret id must match/);
      assert.throws(() => getNamespacedSecret(1, 'connector', bad), /Secret id must match/);
    }
    assert.throws(
      () => setNamespacedSecret(1, 'oauth' as never, 'canva', 'v'),
      /Unsupported secret namespace/,
    );
    assert.throws(
      () => setNamespacedSecret(1, 'vendor', 'canva', 'v'),
      /Unsupported secret provider/,
      'the vendor namespace keeps its closed whitelist',
    );
  } finally {
    sandbox.restore();
  }
});

/** Deletion is idempotent and leaves neighbouring records untouched. */
test('namespaced secrets: delete removes only the named connector', () => {
  const sandbox = withSandbox();
  try {
    setNamespacedSecret(3, 'connector', 'canva', 'a');
    setNamespacedSecret(3, 'connector', 'google-drive', 'b');
    setProviderKey(3, 'glm', 'sk-glm');

    assert.deepEqual(deleteNamespacedSecret(3, 'connector', 'canva'), {
      namespace: 'connector',
      id: 'canva',
      removed: true,
    });
    assert.deepEqual(deleteNamespacedSecret(3, 'connector', 'canva'), {
      namespace: 'connector',
      id: 'canva',
      removed: false,
    });
    assert.deepEqual(listConnectorSecrets(3), ['google-drive']);
    assert.equal(getProviderKey(3, 'glm'), 'sk-glm');
  } finally {
    sandbox.restore();
  }
});

/** An implicit scope must throw here too — the B-342 guard covers the new surface. */
test('namespaced secrets: an implicit scope throws on every namespaced entry point', () => {
  const sandbox = withSandbox();
  try {
    for (const implicit of [null, undefined, '']) {
      assert.throws(
        () => setNamespacedSecret(implicit as never, 'connector', 'canva', 'v'),
        /userId is required/,
      );
      assert.throws(
        () => getNamespacedSecret(implicit as never, 'connector', 'canva'),
        /userId is required/,
      );
      assert.throws(
        () => deleteNamespacedSecret(implicit as never, 'connector', 'canva'),
        /userId is required/,
      );
      assert.throws(() => listConnectorSecrets(implicit as never), /userId is required/);
    }
  } finally {
    sandbox.restore();
  }
});

/** A file written by this store must never be group/world readable. */
test('namespaced secrets: the keys file stays 0600 after a connector write', () => {
  const sandbox = withSandbox();
  try {
    setNamespacedSecret(9, 'connector', 'canva', 'sk-x');
    const filePath = path.join(
      sandbox.homeDir, '.nassaj-users', '9', '.provider-secrets', 'keys.json',
    );
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.ok(!raw.includes('sk-x'), 'plaintext must never reach the file');
  } finally {
    sandbox.restore();
  }
});
