import { beforeEach, expect, it, vi } from 'vitest';

import {
  clearOutbox,
  confirmOutboxEntry,
  createStuckOutboxDismissal,
  getOutboxSnapshot,
  markOutboxDispatchUnconfirmed,
  markOutboxFailed,
  recordOutboxEntry,
  selectStuckOutboxEntries,
  setOutboxBlobStore,
  setOutboxUser,
  STUCK_OUTBOX_STALE_AFTER_MS,
} from './messageOutbox';

const deleteMany = vi.fn(async (_keys: string[]) => undefined);

beforeEach(() => {
  localStorage.clear();
  clearOutbox();
  setOutboxUser('owner');
  setOutboxBlobStore({ put: async () => undefined, getMany: async () => [], deleteMany, clearAll: async () => undefined });
  deleteMany.mockClear();
});

const STALE = Date.now() - STUCK_OUTBOX_STALE_AFTER_MS - 1000;
const FRESH = Date.now();

it('selectStuckOutboxEntries: failed/unconfirmed are always stuck, pending only when stale and not in flight', () => {
  recordOutboxEntry({ id: 'failed', sessionId: 's1', projectId: 'p', text: 'a' });
  markOutboxFailed('failed', { code: 'transport' });
  recordOutboxEntry({ id: 'unconfirmed', sessionId: 's1', projectId: 'p', text: 'b' });
  markOutboxDispatchUnconfirmed('unconfirmed');
  recordOutboxEntry({ id: 'stale-pending', sessionId: 's2', projectId: 'p', text: 'c' });
  recordOutboxEntry({ id: 'fresh-pending', sessionId: 's3', projectId: 'p', text: 'd' });
  recordOutboxEntry({ id: 'live-pending', sessionId: 's4', projectId: 'p', text: 'e' });
  recordOutboxEntry({ id: 'delivered', sessionId: 's5', projectId: 'p', text: 'f' });
  confirmOutboxEntry('delivered');

  const all = getOutboxSnapshot().map((entry) =>
    entry.id === 'stale-pending' || entry.id === 'live-pending' ? { ...entry, createdAt: STALE } : entry);

  const stuck = selectStuckOutboxEntries(all, {
    now: FRESH,
    isSessionLive: (sessionId) => sessionId === 's4',
  });

  expect(stuck.map((entry) => entry.id).sort()).toEqual(['failed', 'stale-pending', 'unconfirmed']);
});

it('createStuckOutboxDismissal: removes this account stuck entries and their image blobs, keeps fresh/in-flight/delivered', async () => {
  recordOutboxEntry({ id: 'failed', sessionId: 's1', projectId: 'p', text: 'a', images: [new File(['x'], 'failed.png')] });
  markOutboxFailed('failed', { code: 'transport' });
  recordOutboxEntry({ id: 'fresh-pending', sessionId: 's2', projectId: 'p', text: 'b' });
  recordOutboxEntry({ id: 'delivered', sessionId: 's3', projectId: 'p', text: 'c' });
  confirmOutboxEntry('delivered');

  const stale = getOutboxSnapshot().find((entry) => entry.id === 'failed')!;
  expect(stale.imageNames).toEqual(['failed.png']);

  const dismissal = createStuckOutboxDismissal();
  expect(dismissal.count).toBe(1);
  expect(dismissal.texts).toEqual(['a']);

  const removed = await dismissal.commit();
  expect(removed).toBe(1);
  expect(getOutboxSnapshot().map((entry) => entry.id).sort()).toEqual(['delivered', 'fresh-pending']);
  expect(deleteMany).toHaveBeenCalledWith(['failed#0']);
});

it('does not touch another account\'s entries', () => {
  recordOutboxEntry({ id: 'mine-failed', sessionId: 's1', projectId: 'p', text: 'a' });
  markOutboxFailed('mine-failed', { code: 'transport' });
  setOutboxUser('other');
  recordOutboxEntry({ id: 'their-failed', sessionId: 's1', projectId: 'p', text: 'b' });
  markOutboxFailed('their-failed', { code: 'transport' });

  const dismissal = createStuckOutboxDismissal();
  expect(dismissal.count).toBe(1);
  expect(dismissal.texts).toEqual(['b']);
});

it('a stale action (account switched after the snapshot) is a no-op', async () => {
  recordOutboxEntry({ id: 'failed', sessionId: 's1', projectId: 'p', text: 'a' });
  markOutboxFailed('failed', { code: 'transport' });
  const dismissal = createStuckOutboxDismissal();

  setOutboxUser('other');
  recordOutboxEntry({ id: 'failed', sessionId: 's1', projectId: 'p', text: 'unrelated-same-id' });
  markOutboxFailed('failed', { code: 'transport' });

  const removed = await dismissal.commit();
  expect(removed).toBe(0);
  expect(getOutboxSnapshot()[0].text).toBe('unrelated-same-id');
});

it('a stuck entry that got delivered after the snapshot is skipped, not deleted', async () => {
  recordOutboxEntry({ id: 'failed-then-delivered', sessionId: 's1', projectId: 'p', text: 'a' });
  markOutboxFailed('failed-then-delivered', { code: 'transport' });
  const dismissal = createStuckOutboxDismissal();
  confirmOutboxEntry('failed-then-delivered');

  const removed = await dismissal.commit();
  expect(removed).toBe(0);
  expect(getOutboxSnapshot()).toHaveLength(1);
  expect(getOutboxSnapshot()[0].status).toBe('delivered');
});
