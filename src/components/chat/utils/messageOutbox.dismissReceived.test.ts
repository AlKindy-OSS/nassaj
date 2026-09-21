import { beforeEach, expect, it, vi } from 'vitest';
import { bindOutboxSession, clearOutbox, confirmOutboxEntry, createDeliveredOutboxDismissal, getOutboxSnapshot, markOutboxFailed, recordOutboxEntry, setOutboxBlobStore, setOutboxUser } from './messageOutbox';

const deleteMany = vi.fn(async (_keys: string[]) => undefined);
function received(id: string, sessionId = 'session-a') {
  recordOutboxEntry({ id, sessionId, projectId: 'project', text: id, images: [new File(['image'], `${id}.png`)] });
  confirmOutboxEntry(id);
}
beforeEach(() => {
  localStorage.clear();
  clearOutbox();
  setOutboxUser('owner');
  setOutboxBlobStore({ put: async () => undefined, getMany: async () => [], deleteMany, clearAll: async () => undefined });
  deleteMany.mockClear();
});
it('dismisses received copies across sessions and only their attachments, preserving history storage', () => {
  localStorage.setItem('canonical-history', 'untouched');
  received('one'); received('two', 'session-b');
  recordOutboxEntry({ id: 'pending', sessionId: 'session-a', projectId: 'project', text: 'pending' });
  recordOutboxEntry({ id: 'failed', sessionId: 'session-a', projectId: 'project', text: 'failed' });
  markOutboxFailed('failed', { code: 'transport' });
  recordOutboxEntry({ id: 'unconfirmed', sessionId: 'session-a', projectId: 'project', text: 'unknown', status: 'unconfirmed' });
  expect(createDeliveredOutboxDismissal()()).toBe(2);
  expect(getOutboxSnapshot().map(entry => entry.id)).toEqual(['pending', 'failed', 'unconfirmed']);
  expect(deleteMany.mock.calls.flat(2).sort()).toEqual(['one#0', 'two#0']);
  expect(localStorage.getItem('canonical-history')).toBe('untouched');
});
it('does not remove newly received entries or entries changed after the action was rendered', () => {
  received('original');
  const dismiss = createDeliveredOutboxDismissal();
  bindOutboxSession('original', 'changed-session');
  received('later');
  expect(dismiss()).toBe(0);
  expect(getOutboxSnapshot()).toHaveLength(2);
  expect(deleteMany).not.toHaveBeenCalled();
});
it('a stale action cannot remove copies belonging to a different signed-in account', () => {
  received('same-id');
  const dismiss = createDeliveredOutboxDismissal();
  setOutboxUser('other');
  received('same-id');
  expect(dismiss()).toBe(0);
  expect(getOutboxSnapshot()[0].id).toBe('same-id');
});
it('does not remove local copies when browser persistence fails', () => {
  received('keep');
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(createDeliveredOutboxDismissal()()).toBe(0);
    expect(getOutboxSnapshot()).toHaveLength(1);
    expect(deleteMany).not.toHaveBeenCalled();
  } finally { write.mockRestore(); log.mockRestore(); }
});
