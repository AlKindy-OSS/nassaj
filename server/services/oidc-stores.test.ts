import assert from 'node:assert/strict';
import test from 'node:test';

import { createOidcCodeStore } from './oidc-code.store.js';
import { createOidcPkceStore } from './oidc-pkce.store.js';

const transaction = (suffix: string) => `${'a'.repeat(42)}${suffix}`;

test('OIDC PKCE state is single-use, browser-bound, and hard-capped', () => {
  const store = createOidcPkceStore({ maxEntries: 2 });
  const browserA = transaction('A');
  const browserB = transaction('B');

  assert.equal(store.store('state-a', { nonce: 'nonce-a', codeVerifier: 'verifier-a', browserTransaction: browserA }), true);
  assert.equal(store.consume('state-a', browserB), null, 'a callback from another browser cannot consume state');
  assert.equal(store.consume('state-a', browserA), null, 'a failed cross-browser attempt still makes state single-use');

  assert.equal(store.store('state-b', { nonce: 'nonce-b', codeVerifier: 'verifier-b', browserTransaction: browserA }), true);
  assert.equal(store.store('state-c', { nonce: 'nonce-c', codeVerifier: 'verifier-c', browserTransaction: browserA }), true);
  assert.equal(store.store('state-d', { nonce: 'nonce-d', codeVerifier: 'verifier-d', browserTransaction: browserA }), false);
  assert.equal(store.size, 2);
});

test('OIDC hand-off code is browser-bound, single-use, and hard-capped', () => {
  const store = createOidcCodeStore({ maxEntries: 1 });
  const browserA = transaction('A');
  const browserB = transaction('B');

  assert.equal(store.store('code-a', { token: 'jwt-a', userId: 7, browserTransaction: browserA }), true);
  assert.equal(store.store('code-b', { token: 'jwt-b', userId: 8, browserTransaction: browserA }), false);
  assert.equal(store.consume('code-a', browserB), null);
  assert.equal(store.consume('code-a', browserA), null);

  assert.equal(store.store('code-b', { token: 'jwt-b', userId: 8, browserTransaction: browserA }), true);
  assert.deepEqual(store.consume('code-b', browserA), { token: 'jwt-b', userId: 8 });
  assert.equal(store.consume('code-b', browserA), null);
});
