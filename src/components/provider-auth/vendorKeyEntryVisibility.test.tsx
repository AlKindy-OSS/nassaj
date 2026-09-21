/**
 * vendorKeyEntryVisibility.test.tsx — a client newer than its server must not
 * lock everyone out of the key entry (B-367).
 *
 * WHAT SHIPPED. B-362 added `writable` to `GET /:provider/api-key` so a member
 * is never offered a box that 403s. The client read it as
 * `Boolean(payload.data?.writable)` and rendered a refusal whenever it was
 * falsy. Then the client was rebuilt and the server was not — so the live server
 * answered `{provider, configured}` with no `writable`, `Boolean(undefined)`
 * came out `false`, and EVERY credential row printed "you do not have permission
 * to change this credential". Including the owner's. There was no place left in
 * the app to add a key at all.
 *
 * THE RULE. Absent ≠ denied. A field the server does not know about means the
 * server predates it, and the correct degradation is its OLD behaviour — allow
 * the write and let the 403 speak if it comes. Only an explicit `false` is a
 * refusal.
 *
 * These tests drive the real hook against a stubbed fetch, because the bug lived
 * exactly in the gap between what the server sends and what the component reads:
 * a component test with a hand-mocked hook would have asserted the shape we
 * wished for and passed all the way through the outage.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

// موضعُ السطح تنقّل مرّتين (‏T-1205 إلى صفحة الوكيل، وT-1219 عائداً إلى تبويب
// «المورّدون والاعتمادات» منزلاً وحيداً)، والاختبار يفحص **عقداً بين الخادم
// والسطح** (‏B-367) لا موضعَ السطح — فبقي حرفياً كما هو في المرّتين، ولم يتغيّر
// إلا سطرُ الاستيراد.
import VendorsSettingsTab from '../settings/view/tabs/vendors-settings/VendorsSettingsTab';

/** Answers every key-status GET with `data`, and every mutation with success. */
function serverAnswers(data: Record<string, unknown>) {
  fetchMock.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  }));
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('vendor key entry visibility across a client/server version skew (B-367)', () => {
  it('an older server that omits `writable` still gets entry boxes', async () => {
    // Exactly the outage: the deployed server predates B-362.
    serverAnswers({ provider: 'kimi', configured: false });

    render(<VendorsSettingsTab />);

    await waitFor(() => expect(screen.queryAllByPlaceholderText('Paste API key').length)
      .toBeGreaterThan(0));
    expect(
      screen.queryByText(/do not have permission/i),
      'a missing field was treated as a refusal — this is the outage',
    ).toBeNull();
  });

  it('an explicit `writable: false` still refuses, and says why', async () => {
    serverAnswers({
      provider: 'opencode',
      configured: false,
      writable: false,
      reason: 'shared_requires_admin',
    });

    render(<VendorsSettingsTab />);

    await waitFor(() => expect(screen.queryAllByText(/only an owner or admin/i).length)
      .toBeGreaterThan(0));
    expect(
      screen.queryAllByPlaceholderText('Paste API key'),
      'a refused slot must not render a box that fails on submit',
    ).toHaveLength(0);
  });

  it('an explicit `writable: true` renders the box', async () => {
    serverAnswers({ provider: 'kimi', configured: false, writable: true });

    render(<VendorsSettingsTab />);

    await waitFor(() => expect(screen.queryAllByPlaceholderText('Paste API key').length)
      .toBeGreaterThan(0));
    expect(screen.queryByText(/do not have permission/i)).toBeNull();
  });
});
