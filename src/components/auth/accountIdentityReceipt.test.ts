import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  authUserKey,
  clearIdentityCompletionReceipt,
  readIdentityCompletionReceipt,
  receiptMatchesIdentity,
  writeIdentityCompletionReceipt,
} from './accountIdentityReceipt';

const wallet = { generation: 7, activeSlotId: 'slot-b', accounts: [] };
const dom = new JSDOM('', { url: 'https://wallet.example.test' });
const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', {
  value: dom.window.sessionStorage,
  configurable: true,
});

after(() => {
  dom.window.close();
  if (previousSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', previousSessionStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

test('completion receipt proves only the same active slot and hydrated user', () => {
  assert.equal(writeIdentityCompletionReceipt('c:tab', wallet, { id: 2, username: 'B' }), true);
  const receipt = readIdentityCompletionReceipt();
  assert.deepEqual(receipt, {
    version: 'c:tab',
    walletGeneration: 7,
    activeSlotId: 'slot-b',
    userKey: 'id:2',
  });
  assert.equal(receiptMatchesIdentity(receipt, wallet, { id: 2, username: 'B' }), true);
  assert.equal(receiptMatchesIdentity(
    receipt,
    { ...wallet, activeSlotId: 'slot-a' },
    { id: 2, username: 'B' },
  ), false);
  assert.equal(receiptMatchesIdentity(receipt, wallet, { id: 1, username: 'A' }), false);
});

test('completion receipt rejects malformed or cleared values', () => {
  sessionStorage.setItem('nassaj_identity_completion_v1', '{"version":"wrong"}');
  assert.equal(readIdentityCompletionReceipt(), null);
  assert.equal(authUserKey({ username: 'A' }), 'username:A');
  clearIdentityCompletionReceipt();
  assert.equal(readIdentityCompletionReceipt(), null);
});
