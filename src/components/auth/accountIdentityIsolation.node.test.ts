import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { hasPendingAccountWork, purgeAccountIdentityState } from './accountIdentityIsolation';

async function withBrowser(run: () => Promise<void>, extras: Record<string, unknown> = {}): Promise<void> {
  const dom = new JSDOM('', { url: 'https://wallet.example.test' });
  const globals = {
    window: dom.window, localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage, Event: dom.window.Event, ...extras,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try { await run(); } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

test('identity purge announces disconnection then erases account data in both browser stores', async () => {
  await withBrowser(async () => {
    const sensitive = ['auth-token', 'draft_input_private', 'nassaj_outbox_user-1',
      'server-action-outcomes:private', 'cursorSessionId',
      'nassaj:session-workspace-generation:private-session'];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of sensitive) storage.setItem(key, 'private-account-data');
      storage.setItem('theme', 'dark');
    }
    assert.equal(hasPendingAccountWork(), true);
    let notified = false;
    window.addEventListener('auth:identity-changing', () => {
      notified = true;
      assert.equal(localStorage.getItem('draft_input_private'), 'private-account-data');
    }, { once: true });
    await purgeAccountIdentityState();
    assert.equal(notified, true);
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of sensitive) assert.equal(storage.getItem(key), null, key);
      assert.equal(storage.getItem('theme'), 'dark');
    }
    assert.equal(hasPendingAccountWork(), false);
  });
});

test('identity purge deletes both outbox databases and all runtime cache entries', async () => {
  const databases: string[] = [];
  const deletedCaches: string[] = [];
  await withBrowser(async () => {
    await purgeAccountIdentityState();
    assert.deepEqual(databases.sort(), ['nassaj-outbox', 'nassaj-outbox-v2']);
    assert.deepEqual(deletedCaches.sort(), ['account-a', 'account-b']);
  }, {
    indexedDB: { deleteDatabase(name: string) {
      databases.push(name);
      const request = { onsuccess: () => {} };
      queueMicrotask(() => request.onsuccess());
      return request;
    } },
    caches: {
      keys: async () => ['account-a', 'account-b'],
      delete: async (name: string) => { deletedCaches.push(name); return true; },
    },
  });
});

test('blocked outbox deletion rejects purge so the caller cannot hydrate the next identity', async () => {
  await withBrowser(async () => {
    await assert.rejects(purgeAccountIdentityState(), /indexeddb_delete_blocked/);
  }, {
    indexedDB: { deleteDatabase() {
      const request = { onblocked: () => {} };
      queueMicrotask(() => request.onblocked());
      return request;
    } },
  });
});
