/**
 * Storage policy client: the fetch/save path for the owner-only
 * `/api/system/storage-policy`, plus a tiny shared store for the per-file
 * attachment cap read from the member-readable `/api/system/attachment-limit`,
 * so the settings screen and every open composer see the same value (T-2116).
 * The server enforces the cap on upload; this copy only refuses early.
 */

import { authenticatedFetch } from './api';

export type StoragePolicy = {
  retentionDays: number;
  retentionDaysIsDefault: boolean;
  imageMaxMb: number;
  imageMaxMbIsDefault: boolean;
  imageMaxCount: number;
  imageMaxCountIsDefault: boolean;
  attachmentMaxMb: number;
  attachmentMaxMbIsDefault: boolean;
};

/** Server default for `attachmentMaxMb`; used while loading or when the read fails. */
export const DEFAULT_ATTACHMENT_MAX_MB = 50;
/** Upper bound of `attachmentMaxMb`; matches `ATTACHMENT_MAX_MB_BOUNDS` on the server. */
export const ATTACHMENT_MAX_MB_LIMIT = 200;

const STORAGE_POLICY_URL = '/api/system/storage-policy';
const ATTACHMENT_LIMIT_URL = '/api/system/attachment-limit';

/** Focus/visibility refreshes closer together than this reuse the last read. */
export const ATTACHMENT_LIMIT_REFRESH_MS = 10_000;

let attachmentMaxMb = DEFAULT_ATTACHMENT_MAX_MB;
let loadRequest: Promise<void> | null = null;
let lastLoadAt = 0;
const listeners = new Set<() => void>();

/** Reads the current policy; throws `Error(<status>)` on a non-OK response. */
export async function fetchStoragePolicy(): Promise<StoragePolicy> {
  const res = await authenticatedFetch(STORAGE_POLICY_URL);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as StoragePolicy;
}

/** Writes a partial policy; throws `Error(<status>)` on a non-OK response. */
export async function saveStoragePolicy(patch: Partial<Record<keyof StoragePolicy, number>>): Promise<StoragePolicy> {
  const res = await authenticatedFetch(STORAGE_POLICY_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(String(res.status));
  const next = (await res.json()) as StoragePolicy;
  publishStoragePolicy(next);
  return next;
}

/** Shares a freshly read or saved policy with subscribers; ignores invalid values. */
export function publishStoragePolicy(policy: Partial<StoragePolicy>): void {
  const next = policy.attachmentMaxMb;
  if (typeof next !== 'number' || !Number.isInteger(next) || next < 1 || next > ATTACHMENT_MAX_MB_LIMIT) return;
  if (next === attachmentMaxMb) return;
  attachmentMaxMb = next;
  listeners.forEach((listener) => listener());
}

/** Reads the effective attachment cap; any signed-in user may call it. */
async function fetchAttachmentLimit(): Promise<Partial<StoragePolicy>> {
  const res = await authenticatedFetch(ATTACHMENT_LIMIT_URL);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Partial<StoragePolicy>;
}

function startLoad(): void {
  lastLoadAt = Date.now();
  loadRequest = fetchAttachmentLimit().then(publishStoragePolicy, () => undefined);
}

/** Loads the cap once per page; a failure keeps the default without retry storms. */
export function ensureStoragePolicyLoaded(): void {
  if (!loadRequest) startLoad();
}

/**
 * Re-reads the cap so a limit changed in another tab or by the owner reaches an
 * open page (called on focus and when the page becomes visible). Throttled.
 */
export function refreshAttachmentLimit(): void {
  if (loadRequest && Date.now() - lastLoadAt < ATTACHMENT_LIMIT_REFRESH_MS) return;
  startLoad();
}

/** Current per-file attachment cap in MB (default until loaded). */
export function getAttachmentMaxMb(): number {
  return attachmentMaxMb;
}

/** Subscribes to cap changes; returns the unsubscribe function. */
export function subscribeStoragePolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: restores the default and forgets the cached request. */
export function resetStoragePolicyForTests(): void {
  attachmentMaxMb = DEFAULT_ATTACHMENT_MAX_MB;
  loadRequest = null;
  lastLoadAt = 0;
  listeners.clear();
}
