/**
 * B-1575: one login-token detector for the Codex writer and the backup
 * restore. refresh_token, id_token and access_token count; account_id alone
 * does not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexAuthAfterKeyRestore, hasCodexLoginTokens, withoutCodexApiKey } from './codex-auth-shape.js';

const KEY = 'sk' + '-proj-SHAPE-TEST-DUMMY';

test('each login token counts; account_id alone or empty values do not', () => {
  for (const field of ['refresh_token', 'id_token', 'access_token']) {
    assert.equal(hasCodexLoginTokens({ tokens: { [field]: 'dummy' } }), true, field);
  }
  assert.equal(hasCodexLoginTokens({ tokens: { account_id: 'acc' } }), false, 'account_id alone');
  assert.equal(hasCodexLoginTokens({ tokens: { refresh_token: '' } }), false, 'empty');
  assert.equal(hasCodexLoginTokens({ tokens: null }), false);
  assert.equal(hasCodexLoginTokens({}), false);
});

test('a key delete with only account_id drops the key and the apikey mode', () => {
  const next = withoutCodexApiKey({ auth_mode: 'apikey', OPENAI_API_KEY: KEY, tokens: { account_id: 'acc' } });
  assert.deepEqual(next, { tokens: { account_id: 'acc' } });
});

test('a key delete with a refresh token hands the mode back to ChatGPT', () => {
  const next = withoutCodexApiKey({ auth_mode: 'apikey', OPENAI_API_KEY: KEY, tokens: { refresh_token: 'rt' } });
  assert.deepEqual(next, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt' } });
});

test('a restore uses the same detector: account_id alone is a key-only file', () => {
  const merged = { auth_mode: 'chatgpt', OPENAI_API_KEY: KEY, tokens: { account_id: 'acc' } };
  assert.equal(codexAuthAfterKeyRestore({ auth_mode: 'chatgpt', tokens: { account_id: 'acc' } }, merged).auth_mode, 'apikey');
});

test('a restore over a refresh-token login keeps the recorded mode logic, not the key-only shape', () => {
  const merged = { auth_mode: 'chatgpt', OPENAI_API_KEY: KEY, tokens: { refresh_token: 'rt' } };
  const restored = codexAuthAfterKeyRestore({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt' } }, merged);
  assert.notEqual(restored.auth_mode, 'apikey');
  assert.equal(restored.OPENAI_API_KEY, KEY);
});
