import assert from 'node:assert/strict';
import test from 'node:test';

import { createOidcCodeStore } from './oidc-code.store.js';
import { createOidcPkceStore } from './oidc-pkce.store.js';
import { createOidcStepUpGrantStore } from './oidc-step-up-grant.store.js';

const transaction = (suffix: string) => `${'a'.repeat(42)}${suffix}`;
// ADR-194 D9: every non-test entry binds the active config version at start.
const V = { configVersion: 3 } as const;

test('OIDC PKCE state is single-use, browser-bound, and hard-capped', () => {
  const store = createOidcPkceStore({ maxEntries: 2 });
  const browserA = transaction('A');
  const browserB = transaction('B');

  assert.equal(store.store('state-a', { nonce: 'nonce-a', codeVerifier: 'verifier-a', browserTransaction: browserA, ...V }), true);
  assert.equal(store.consume('state-a', browserB), null, 'a callback from another browser cannot consume state');
  assert.equal(store.consume('state-a', browserA), null, 'a failed cross-browser attempt still makes state single-use');

  assert.equal(store.store('state-b', { nonce: 'nonce-b', codeVerifier: 'verifier-b', browserTransaction: browserA, ...V }), true);
  assert.equal(store.store('state-c', { nonce: 'nonce-c', codeVerifier: 'verifier-c', browserTransaction: browserA, ...V }), true);
  assert.equal(store.store('state-d', { nonce: 'nonce-d', codeVerifier: 'verifier-d', browserTransaction: browserA, ...V }), false);
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

test('T-1939 slice 5: a PKCE entry carries its purpose; login is the default and binds no user', () => {
  const store = createOidcPkceStore();
  const browser = transaction('A');
  const secrets = { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, ...V };

  assert.equal(store.store('login-state', secrets), true);
  assert.deepEqual(store.consume('login-state', browser), {
    nonce: 'n', codeVerifier: 'v', purpose: 'login', configVersion: 3,
  });

  assert.equal(store.store('link-state', { ...secrets, purpose: 'link', userId: 12, requestedAtMs: 1_700 }), true);
  assert.deepEqual(store.consume('link-state', browser), {
    nonce: 'n', codeVerifier: 'v', purpose: 'link', userId: 12, requestedAtMs: 1_700, configVersion: 3,
  });
});

test('T-1939 slice 5: malformed purpose bindings are refused at store time', () => {
  const store = createOidcPkceStore();
  const secrets = { nonce: 'n', codeVerifier: 'v', browserTransaction: transaction('A'), ...V };
  const invalid: Array<Record<string, unknown>> = [
    { purpose: 'admin' },
    { purpose: 'link' },
    { purpose: 'link', userId: 0, requestedAtMs: 1 },
    { purpose: 'link', userId: 1.5, requestedAtMs: 1 },
    { purpose: 'link', userId: 3, requestedAtMs: Number.NaN },
    { purpose: 'login', userId: 3 },
    { userId: 3, requestedAtMs: 1 },
    { configVersion: undefined },
    { configVersion: -1 },
    { configVersion: 1.5 },
    { purpose: 'login', extra: 'x' },
  ];
  for (const binding of invalid) {
    assert.equal(store.store('s', { ...secrets, ...binding } as never), false, JSON.stringify(binding));
  }
  assert.equal(store.size, 0);
});

test('T-1939 6B: consumeWithOutcome names only the purpose of an expired or foreign state', async () => {
  const store = createOidcPkceStore({ ttlMs: 1 });
  const browser = transaction('A');
  const stepUp = { purpose: 'step_up', userId: 7, requestedAtMs: 1, audience: 'connector_owner', ...V } as const;
  assert.equal(store.store('expired', { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, ...stepUp }), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(store.consumeWithOutcome('expired', browser), { entry: null, stalePurpose: 'step_up' });
  assert.deepEqual(store.consumeWithOutcome('expired', browser), { entry: null, stalePurpose: null },
    'still single use: the second answer knows nothing');
  assert.deepEqual(store.consumeWithOutcome('never-stored', browser), { entry: null, stalePurpose: null });

  const live = createOidcPkceStore();
  assert.equal(live.store('foreign', { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, ...V }), true);
  assert.deepEqual(live.consumeWithOutcome('foreign', transaction('B')), { entry: null, stalePurpose: 'login' });
  assert.equal(live.store('ok', { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, ...stepUp }), true);
  assert.deepEqual(live.consumeWithOutcome('ok', browser), {
    entry: { nonce: 'n', codeVerifier: 'v', ...stepUp }, stalePurpose: null,
  });
});

const HASH = 'a'.repeat(64);

test('ADR-194 D2: a test entry binds owner, config hash and draft version, and nothing else', () => {
  const store = createOidcPkceStore();
  const browser = transaction('A');
  const secrets = { nonce: 'n', codeVerifier: 'v', browserTransaction: browser };
  const binding = { purpose: 'test', ownerUserId: 1, configHash: HASH, draftVersion: 4 } as const;
  assert.equal(store.store('test-state', { ...secrets, ...binding }), true);
  assert.equal(store.consume('test-state', transaction('B')), null, 'another browser transaction cannot use it');
  assert.equal(store.store('test-state', { ...secrets, ...binding }), true);
  assert.deepEqual(store.consume('test-state', browser), { nonce: 'n', codeVerifier: 'v', ...binding });

  const invalid: Array<Record<string, unknown>> = [
    { ...binding, ownerUserId: 0 },
    { ...binding, configHash: 'short' },
    { ...binding, draftVersion: -1 },
    { ...binding, configVersion: 3 },
    { ...binding, userId: 1 },
    { ...binding, audience: 'connector_owner' },
    { purpose: 'test' },
  ];
  for (const bad of invalid) {
    assert.equal(store.store('bad', { ...secrets, ...bad } as never), false, JSON.stringify(bad));
  }
});

test('ADR-194 D9: an unredeemed code can be discarded and a grant revoked', () => {
  const codes = createOidcCodeStore();
  const browser = transaction('A');
  assert.equal(codes.store('code-x', { token: 'jwt', userId: 7, browserTransaction: browser }), true);
  assert.equal(codes.discard('code-x'), true);
  assert.equal(codes.discard('code-x'), false);
  assert.equal(codes.consume('code-x', browser), null);

  const grants = createOidcStepUpGrantStore();
  const grant = grants.issue({ userId: 7, audience: 'connector_owner', browserTransaction: browser });
  assert.equal(typeof grant, 'string');
  assert.equal(grants.revoke(grant as string), true);
  assert.equal(grants.consume(grant as string, { userId: 7, audience: 'connector_owner', browserTransaction: browser }),
    false);
  assert.equal(grants.revoke(42 as never), false);
});
