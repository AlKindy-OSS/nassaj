import { afterEach, expect, it, vi } from 'vitest';

import { hasPendingAccountWork, purgeAccountIdentityState } from './accountIdentityIsolation';

afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('removes account-scoped drafts, credentials and receipts while retaining device preferences', async () => {
  localStorage.setItem('auth-token', 'legacy-token');
  localStorage.setItem('draft_input_project-a', 'private draft');
  localStorage.setItem('theme', 'dark');
  sessionStorage.setItem('cursorSessionId', 'session-a');
  sessionStorage.setItem('sidebar-width', '300');
  const event = vi.fn();
  window.addEventListener('auth:identity-changing', event);

  await purgeAccountIdentityState();

  expect(localStorage.getItem('auth-token')).toBeNull();
  expect(localStorage.getItem('draft_input_project-a')).toBeNull();
  expect(sessionStorage.getItem('cursorSessionId')).toBeNull();
  expect(localStorage.getItem('theme')).toBe('dark');
  expect(sessionStorage.getItem('sidebar-width')).toBe('300');
  expect(event).toHaveBeenCalledOnce();
  window.removeEventListener('auth:identity-changing', event);
});

it('detects account-bound drafts and outbox entries before a switch', () => {
  expect(hasPendingAccountWork()).toBe(false);
  sessionStorage.setItem('draft_input_project-a', 'private draft');
  expect(hasPendingAccountWork()).toBe(true);
});

it('rejects cleanup when a runtime cache cannot be removed', async () => {
  vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['account-cache']), delete: vi.fn().mockResolvedValue(false) });
  await expect(purgeAccountIdentityState()).rejects.toThrow('cache_storage_cleanup_failed');
});
