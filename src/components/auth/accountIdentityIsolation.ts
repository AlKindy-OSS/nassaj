import { clearOutbox } from '../chat/utils/messageOutbox';

import { AUTH_TOKEN_STORAGE_KEY } from './constants';

const accountBoundKey = (key: string) => key === AUTH_TOKEN_STORAGE_KEY
  || key.startsWith('draft_input_')
  || key.startsWith('nassaj_outbox_')
  || key.startsWith('server-action-outcomes:')
  || key.startsWith('nassaj:session-workspace-generation:')
  || key === 'cursorSessionId';

/** True for a stored draft or outbox record that still holds unsent content. */
function holdsPendingWork(storage: Storage, key: string): boolean {
  const raw = storage.getItem(key);
  if (key.startsWith('draft_input_')) return Boolean(raw?.trim());
  if (!key.startsWith('nassaj_outbox_')) return false;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown } | unknown[] | null;
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    // An unknown shape may still be content: warn rather than lose it.
    return Array.isArray(entries) ? entries.length > 0 : true;
  } catch {
    return true;
  }
}

/** True when switching would hide an unsent draft or queued message (B-1534). */
export function hasPendingAccountWork(): boolean {
  return [localStorage, sessionStorage].some((storage) =>
    Object.keys(storage).some((key) => holdsPendingWork(storage, key)));
}

function removeAccountBoundStorage(storage: Storage): void {
  Object.keys(storage).filter(accountBoundKey).forEach((key) => storage.removeItem(key));
}

/** How long a delete may wait for open connections to yield before failing closed. */
export const DATABASE_DELETE_BLOCKED_TIMEOUT_MS = 5_000;

function deleteDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (error?: Error) => {
      if (blockedTimer) clearTimeout(blockedTimer);
      if (error) reject(error); else resolve();
    };
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => settle();
    request.onerror = () => settle(request.error ?? new Error(`indexeddb_delete_failed:${name}`));
    // `blocked` is not a failure: the delete stays queued until every open
    // connection closes on `versionchange` (B-1531). Fail closed only when a
    // connection never yields.
    request.onblocked = () => {
      blockedTimer ??= setTimeout(
        () => settle(new Error(`indexeddb_delete_blocked:${name}`)),
        DATABASE_DELETE_BLOCKED_TIMEOUT_MS,
      );
    };
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
