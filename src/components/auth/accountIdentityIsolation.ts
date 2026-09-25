import { clearOutbox } from '../chat/utils/messageOutbox';

import { AUTH_TOKEN_STORAGE_KEY } from './constants';

const accountBoundKey = (key: string) => key === AUTH_TOKEN_STORAGE_KEY
  || key.startsWith('draft_input_')
  || key.startsWith('nassaj_outbox_')
  || key.startsWith('server-action-outcomes:')
  || key.startsWith('nassaj:session-workspace-generation:')
  || key === 'cursorSessionId';

/** True when switching would hide an unsent draft or queued message. */
export function hasPendingAccountWork(): boolean {
  const isPending = (key: string) => key.startsWith('draft_input_') || key.startsWith('nassaj_outbox_');
  return Object.keys(localStorage).some(isPending) || Object.keys(sessionStorage).some(isPending);
}

function removeAccountBoundStorage(storage: Storage): void {
  Object.keys(storage).filter(accountBoundKey).forEach((key) => storage.removeItem(key));
}

function deleteDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`indexeddb_delete_failed:${name}`));
    request.onblocked = () => reject(new Error(`indexeddb_delete_blocked:${name}`));
  });
}

async function clearRuntimeCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const keys = await caches.keys();
  const removed = await Promise.all(keys.map((key) => caches.delete(key)));
  if (removed.some((value) => !value)) throw new Error('cache_storage_cleanup_failed');
}

/**
 * Erases account-scoped browser state before the next wallet identity hydrates.
 * A caller must treat rejection as a locked state and never paint another
 * account over the prior identity's cache (ADR-163).
 */
export async function purgeAccountIdentityState(): Promise<void> {
  window.dispatchEvent(new Event('auth:identity-changing'));
  clearOutbox();
  removeAccountBoundStorage(localStorage);
  removeAccountBoundStorage(sessionStorage);
  await Promise.all([
    ...['nassaj-outbox', 'nassaj-outbox-v2'].map(deleteDatabase),
    clearRuntimeCaches(),
  ]);
}
