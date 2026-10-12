/**
 * ADR-200 §8 / M-6 — the secret list OpenCode redaction uses covers a grantor's
 * keys under a grant, every auth.json target, every session sender and the
 * data-dir owner. Collaborators are stubbed so each rule is pinned on its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || os.tmpdir()), 'oc-redaction-secrets-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** userId → own data home (honorGrants: false). */
const homes: Record<string, string> = {};
/** userId → vendor slot keys. */
const slots: Record<string, string[]> = {};
/** grantee → grantor. */
const grants: Record<string, number> = {};
/** sessionId → author ids. */
const authors: Record<string, number[]> = {};

function memberHome(userId: number, auth: Record<string, unknown> | null): void {
  const dir = path.join(root, `u${userId}`, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  if (auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  homes[String(userId)] = dir;
}

mock.module('@/modules/database/index.js', {
  namedExports: { messageAuthorsDb: { listAuthorIds: (sessionId: string) => authors[sessionId] ?? [] } },
});
mock.module('@/modules/providers/services/provider-secrets.service.js', {
  namedExports: {
    providerSecretsService: { getVendorRedactionSecrets: (userId: number) => slots[String(userId)] ?? [] },
  },
});
mock.module('@/services/isolation/credential-principal.js', {
  namedExports: {
    resolveCredentialPrincipal: (userId: number) => {
      const owner = grants[String(userId)];
      return owner ? { principalId: owner, grantedBy: owner } : { principalId: userId, grantedBy: null };
    },
  },
});
mock.module(new URL('./opencode-home.js', import.meta.url).href, {
  namedExports: {
    resolveOpenCodeDataHomeForUser: (userId: number, options: { honorGrants?: boolean }) => {
      assert.equal(options.honorGrants, false, 'own home only; the grantor is resolved explicitly');
      return homes[String(userId)] ?? path.join(root, 'missing');
    },
  },
});

const {
  collectOpenCodeSessionSecrets,
  collectOpenCodeTurnSecrets,
  readOpenCodeAuthSecrets,
} = await import('./opencode-redaction-secrets.js');

const AUTH_OWNER = {
  anthropic: { type: 'api', key: 'owner-anthropic-key-0001' },
  openai: { type: 'api', key: 'owner-openai-key-0002' },
  glm: { type: 'api', key: 'owner-glm-key-0003' },
  openrouter: { type: 'api', key: 'owner-openrouter-key-0004' },
  github: { type: 'oauth', access: 'owner-oauth-access-0005', refresh: 'owner-oauth-refresh-0006', expires: 1 },
};
memberHome(1, AUTH_OWNER);
slots['1'] = ['owner-token-plan-key-0007'];
memberHome(2, { openai: { type: 'api', key: 'grantee-openai-key-0008' } });
slots['2'] = ['grantee-token-plan-key-0009'];
grants['2'] = 1;
memberHome(3, { anthropic: { type: 'api', key: 'peer-anthropic-key-0010' } });
slots['3'] = [];
memberHome(4, null);
slots['4'] = ['reader-key-0011'];
authors.ses_shared = [2, 3];

test('every auth.json target and OAuth token is a secret (anthropic, openai, glm, openrouter)', () => {
  assert.deepEqual(readOpenCodeAuthSecrets(homes['1']).sort(), [
    'owner-anthropic-key-0001', 'owner-glm-key-0003', 'owner-oauth-access-0005',
    'owner-oauth-refresh-0006', 'owner-openai-key-0002', 'owner-openrouter-key-0004',
  ]);
  assert.deepEqual(readOpenCodeAuthSecrets(path.join(root, 'missing')), []);
  assert.deepEqual(readOpenCodeAuthSecrets(null), []);
});

test('ingest for a grant holder includes the grantor keys the turn runs on', () => {
  const secrets = collectOpenCodeTurnSecrets(2);
  for (const key of ['grantee-openai-key-0008', 'grantee-token-plan-key-0009', 'owner-token-plan-key-0007',
    ...readOpenCodeAuthSecrets(homes['1'])]) {
    assert.ok(secrets.includes(key), key);
  }
  assert.ok(!secrets.includes('peer-anthropic-key-0010'), 'an unrelated member is not in a turn list');
  assert.deepEqual(collectOpenCodeTurnSecrets(null), []);
});

test('read covers every sender (and their grantor), the data-dir owner and the dir auth.json', () => {
  const secrets = collectOpenCodeSessionSecrets('ses_shared');
  for (const key of ['grantee-openai-key-0008', 'peer-anthropic-key-0010', 'owner-openai-key-0002']) {
    assert.ok(secrets.includes(key), key);
  }
  assert.ok(!secrets.includes('reader-key-0011'), 'the reader is not a sender');

  const dirOnly = collectOpenCodeSessionSecrets('ses_unknown', { dataHome: homes['3'] });
  assert.deepEqual(dirOnly, ['peer-anthropic-key-0010']);
  const withOwner = collectOpenCodeSessionSecrets('ses_unknown', { extraUserIds: [4, null] });
  assert.deepEqual(withOwner, ['reader-key-0011']);
});
