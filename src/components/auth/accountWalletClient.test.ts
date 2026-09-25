import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

import {
  AccountWalletError,
  finishWalletIdentityTransition,
  isAccountWallet,
  mutateAccountWallet,
  readAccountWallet,
} from './accountWalletClient';
import {
  beginIdentityTransition,
  getIdentityBarrierSnapshot,
  stabilizeIdentityBarrier,
} from './accountIdentityBarrier';

afterEach(() => {
  mock.restoreAll();
  stabilizeIdentityBarrier(getIdentityBarrierSnapshot().version);
});

test('generation-only add/remove requests lightweight reconciliation without identity purge', () => {
  const version = beginIdentityTransition('add');
  assert.equal(finishWalletIdentityTransition(version, 'slot_a', 'slot_a', 'add'), false);
  assert.equal(getIdentityBarrierSnapshot().phase, 'committed');
  assert.equal(getIdentityBarrierSnapshot().reason, 'wallet_generation_changed');
});

test('an active slot change commits identity reconciliation', () => {
  const version = beginIdentityTransition('switch');
  assert.equal(finishWalletIdentityTransition(version, 'slot_a', 'slot_b', 'switch'), true);
  assert.equal(getIdentityBarrierSnapshot().phase, 'committed');
});

test('wallet validation rejects malformed, duplicated, oversized and inconsistent accounts', () => {
  const account = { slotId: 'slot-a', displayName: 'A', avatarUrl: null, isActive: true, lastUsedAt: 1 };
  assert.equal(isAccountWallet({ generation: 1, activeSlotId: 'slot-a', accounts: [account] }), true);
  for (const invalid of [
    { generation: -1, activeSlotId: null, accounts: [] },
    { generation: 1, activeSlotId: 'missing', accounts: [{ ...account, isActive: false }] },
    { generation: 1, activeSlotId: 'slot-a', accounts: [account, account] },
    { generation: 1, activeSlotId: 'slot-a', accounts: [{ ...account, displayName: '' }] },
    { generation: 1, activeSlotId: 'slot-a', accounts: [{ ...account, avatarUrl: 'x'.repeat(2_049) }] },
    { generation: 1, activeSlotId: 'slot-a', accounts: [{ ...account, isActive: false }] },
    { generation: 1, activeSlotId: null, accounts: [{ ...account, isActive: true }] },
    { generation: 1, activeSlotId: 'slot-a', accounts: Array.from({ length: 6 }, (_, index) => ({ ...account, slotId: `slot-${index}`, isActive: index === 0 })) },
  ]) assert.equal(isAccountWallet(invalid), false);
});

test('wallet reads send cookies without legacy authorization and disable caching', async () => {
  const wallet = { generation: 1, activeSlotId: null, accounts: [] };
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json(wallet));
  assert.deepEqual(await readAccountWallet(), wallet);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, '/api/auth/accounts');
  assert.equal(options?.credentials, 'same-origin');
  assert.equal(options?.cache, 'no-store');
  assert.equal(options?.headers, undefined);
});

test('authoritative wallet reconciliation rejects a malformed wallet', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ generation: 9, activeSlotId: 'slot_a' }));
  await assert.rejects(readAccountWallet(), (error) => (
    error instanceof AccountWalletError && error.code === 'invalid_wallet_response'
  ));
});

test('remove obtains slot-bound CSRF and passes the supplied generation exactly once', async () => {
  let calls = 0;
  const fetch = mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ csrfToken: 'scoped-token' })
    : Response.json({ generation: 8, activeSlotId: 'slot_a', accounts: [] }));
  const controller = new AbortController();
  await mutateAccountWallet('/api/auth/accounts/slot_a', 'DELETE', 'remove',
    { expectedGeneration: 7 }, { slotId: 'slot_a', signal: controller.signal });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(fetch.mock.calls[0].arguments[0], '/api/auth/accounts/csrf?action=remove&slotId=slot_a');
  const [, request] = fetch.mock.calls[1].arguments;
  assert.equal(request?.method, 'DELETE');
  assert.equal(request?.body, '{"expectedGeneration":7}');
  assert.equal(request?.signal?.aborted, false);
  controller.abort();
  assert.equal(request?.signal?.aborted, true);
  assert.deepEqual(request?.headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': 'scoped-token' });
});

test('a generation conflict preserves the fresh wallet and never replays the mutation', async () => {
  const wallet = { generation: 8, activeSlotId: 'slot_other', accounts: [
    { slotId: 'slot_other', displayName: 'Other account', isActive: true, lastUsedAt: null },
  ] };
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ csrfToken: 'scoped-token' })
    : Response.json({ code: 'wallet_generation_conflict', wallet }, { status: 409 }));
  await assert.rejects(mutateAccountWallet('/api/auth/accounts/switch', 'POST', 'switch',
    { expectedGeneration: 7, slotId: 'slot_a' }), (error) => {
    assert.ok(error instanceof AccountWalletError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'wallet_generation_conflict');
    assert.deepEqual(error.wallet, wallet);
    return true;
  });
  assert.equal(calls, 2);
});

test('missing CSRF prevents the mutation request', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(mutateAccountWallet('/api/auth/accounts/add', 'POST', 'add', {}),
    (error) => error instanceof AccountWalletError && error.code === 'csrf_token_missing');
  assert.equal(fetch.mock.callCount(), 1);
});

test('lost mutation response is marked uncertain and never retried', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ csrfToken: 'scoped-token' });
    throw new TypeError('connection closed after request');
  });
  await assert.rejects(mutateAccountWallet('/api/auth/accounts/switch', 'POST', 'switch',
    { expectedGeneration: 7, slotId: 'slot_other' }), (error) => {
    assert.ok(error instanceof AccountWalletError);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.code, 'wallet_mutation_outcome_unknown');
    return true;
  });
  assert.equal(calls, 2);
});

test('body stream failure after mutation headers is uncertain and never replayed', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ csrfToken: 'scoped-token' });
    return {
      ok: true,
      status: 200,
      json: async () => { throw new TypeError('response body stream terminated'); },
    } as unknown as Response;
  });
  await assert.rejects(mutateAccountWallet('/api/auth/accounts/switch', 'POST', 'switch',
    { expectedGeneration: 7, slotId: 'slot_other' }), (error) => {
    assert.ok(error instanceof AccountWalletError);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.code, 'wallet_mutation_outcome_unknown');
    return true;
  });
  assert.equal(calls, 2);
});

test('invalid mutation success payload is uncertain and never replayed', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ csrfToken: 'scoped-token' })
    : Response.json({ ok: true }));
  await assert.rejects(mutateAccountWallet('/api/auth/accounts/add', 'POST', 'add',
    { expectedGeneration: 7, email: 'local@example.test', password: 'secret' }), (error) => {
    assert.ok(error instanceof AccountWalletError);
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  assert.equal(calls, 2);
});

test('truncated JSON and invalid response bodies remain uncertain after a mutation', async () => {
  for (const [body, status] of [
    ['{"generation":', 200], ['null', 200], ['true', 200],
    ['[]', 200], ['<html>proxy error</html>', 502], ['{"error":"Internal server error"}', 500],
  ] as const) {
    let calls = 0;
    const fetch = mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? Response.json({ csrfToken: 'scoped-token' }) : new Response(body, { status }));
    try {
      await assert.rejects(mutateAccountWallet('/api/auth/accounts/add', 'POST', 'add',
        { expectedGeneration: 7 }), (error) => error instanceof AccountWalletError && error.outcomeUnknown);
      assert.equal(calls, 2);
    } finally { fetch.mock.restore(); }
  }
});
