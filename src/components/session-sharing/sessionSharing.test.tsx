import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arChat from '../../i18n/locales/ar/chat.json';

const lookup = (key: string): string | undefined => key.split('.').reduce<unknown>(
  (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
  arChat,
) as string | undefined;

const translation = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('react-i18next', () => ({ useTranslation: () => translation.value }));
translation.value = {
  t: (key: string, options?: Record<string, unknown>) => {
    const template = lookup(key) ?? String(options?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
  },
  i18n: { language: 'ar' },
};

const auth = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../auth/context/AuthContext', () => ({ useOptionalAuth: () => auth.value }));

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', () => ({ authenticatedFetch }));

import MySharesPanel from './MySharesPanel';
import SessionShareButton from './SessionShareButton';
import SessionShareDialog from './SessionShareDialog';

const counts = { system: 0, image: 0, secret: 0, path: 0, network: 0, toolCount: 0, thinking: 0, other: 0 };
const previewOf = (over: Record<string, unknown> = {}) => ({
  snapshot: { title: 't', messages: [{ role: 'user', author: 'owner', parts: [
    { t: 'text', text: 'مرحبا ' }, { t: 'redacted', cat: 'secret' }] }] },
  upToMessageId: 'm1', previewSha256: 'a'.repeat(64), counts, blockers: [], ...over,
});
const json = (status: number, body: unknown) => Promise.resolve({
  ok: status < 400, status, json: async () => body,
});
const share = (over: Record<string, unknown> = {}) => ({
  id: 's'.repeat(22), sessionId: 'abcd1234-x', sessionTitle: null, createdByName: 'سارة', createdBySelf: true, createdBy: 7, ownerUserId: 7, createdAt: '2026-10-01T10:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, messageCount: 4, viewCount: 3, lastViewedAt: null,
  active: true, ...over,
});

type Route = (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined;
let routes: Route[] = [];
beforeEach(() => {
  routes = [];
  auth.value = { token: 'jwt', user: { id: 7, role: 'user' } };
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    for (const route of routes) {
      const hit = route(url, init);
      if (hit) return hit;
    }
    if (url.endsWith('/shares') && init?.method === 'GET') return json(200, { shares: [] });
    return json(500, { error: { code: 'X' } });
  });
});
afterEach(cleanup);

const onPreview = (response: () => Promise<unknown>): Route => (url) =>
  (url.endsWith('/shares/preview') ? response() : undefined);
const onCreate = (response: () => Promise<unknown>): Route => (url, init) =>
  (url.endsWith('/shares') && init?.method === 'POST' ? response() : undefined);
type FetchCall = [string, { method?: string; body?: string }];
const sent = (suffix: string) => (authenticatedFetch.mock.calls as FetchCall[])
  .filter(([url, init]) => url.endsWith(suffix) && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body ?? '{}'));

const openDialog = () => render(<SessionShareDialog sessionId="sess-1" canShare open onOpenChange={() => {}} />);
const reviewBox = () => screen.getByRole('checkbox', { name: /راجعتُ المحتوى/ });
const createButton = () => screen.getByRole('button', { name: 'إنشاء الرابط' });

const eligibleAs = (body: unknown, status = 200): Route => (url) =>
  (url.endsWith('/shares/eligibility') ? json(status, body) : undefined);
const shareButton = () => screen.queryByRole('button', { name: 'مشاركة المحادثة' });

describe('visibility (server eligibility)', () => {
  it('shows the button when canShare', async () => {
    routes.push(eligibleAs({ canShare: true, canManage: true }));
    render(<SessionShareButton sessionId="s" />);
    await screen.findByRole('button', { name: 'مشاركة المحادثة' });
  });

  it('hides it when neither canShare nor canManage', async () => {
    routes.push(eligibleAs({ canShare: false, canManage: false }));
    render(<SessionShareButton sessionId="s" />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(shareButton()).toBeNull();
  });

  it('hides it on 401 and without a Bearer token (no request at all)', async () => {
    routes.push(eligibleAs({ error: { code: 'AUTH_REQUIRED' } }, 401));
    const view = render(<SessionShareButton sessionId="s" />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(shareButton()).toBeNull();
    view.unmount();
    authenticatedFetch.mockClear();
    auth.value = { token: null, user: { id: 7, role: 'user' } };
    render(<SessionShareButton sessionId="s" />);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(shareButton()).toBeNull();
  });

  it('asks once per session for the component lifetime', async () => {
    routes.push(eligibleAs({ canShare: true, canManage: true }));
    const view = render(<SessionShareButton sessionId="s" />);
    await screen.findByRole('button', { name: 'مشاركة المحادثة' });
    view.rerender(<SessionShareButton sessionId="s" />);
    const asked = (authenticatedFetch.mock.calls as Array<[string]>).filter(([url]) => url.endsWith('/eligibility'));
    expect(asked).toHaveLength(1);
  });

  // Manage-only: e.g. the session owner of an unregistered project (write members never manage).
  it('opens list/revoke mode without any create flow when only canManage', async () => {
    routes.push(eligibleAs({ canShare: false, canManage: true }));
    routes.push((url, init) => (url.endsWith('/shares') && init?.method === 'GET' ? json(200, { shares: [share()] }) : undefined));
    render(<SessionShareButton sessionId="s" />);
    fireEvent.click(await screen.findByRole('button', { name: 'مشاركة المحادثة' }));
    await screen.findByRole('button', { name: 'إلغاء الرابط' });
    expect(screen.queryByRole('button', { name: 'إنشاء الرابط' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((authenticatedFetch.mock.calls as FetchCall[]).some(([url]) => url.endsWith('/preview'))).toBe(false);
  });
});

describe('dialog flow', () => {
  it('explains device-cookie mode and never calls the API', () => {
    auth.value = { token: null, user: { id: 7, role: 'user' } };
    openDialog();
    expect(screen.getByRole('alert').textContent).toContain('جلسة الجهاز');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('shows highlighted redactions with a counts summary', async () => {
    routes.push(onPreview(() => json(200, previewOf({ counts: { ...counts, secret: 2, path: 1, toolCount: 3, thinking: 1 } }))));
    openDialog();
    await screen.findByText(/حُذف:/);
    expect(screen.getByText(/2 أسرار محتملة، 1 مسارات/).textContent).toContain('3 استدعاءات أدوات');
    expect(document.querySelector('mark[data-redaction="secret"]')).toBeTruthy();
  });

  it('shows the reason per blocker and offers no create button', async () => {
    routes.push(onPreview(() => json(200, previewOf({ blockers: [{ code: 'FOREIGN_AUTHOR', count: 2 }] }))));
    openDialog();
    await screen.findByText(/كتبها شخص آخر/);
    expect(screen.queryByRole('button', { name: 'إنشاء الرابط' })).toBeNull();
  });

  it('gates creation on the unattributed confirmation and re-previews with it', async () => {
    routes.push(onPreview(() => {
      const confirmed = authenticatedFetch.mock.calls.at(-1)?.[1]?.body?.includes('confirmUnattributed');
      return json(200, previewOf({ blockers: confirmed ? [] : [{ code: 'UNATTRIBUTED_NEEDS_CONFIRMATION', count: 3 }] }));
    }));
    routes.push(onCreate(() => json(201, { share: share(), shareUrl: 'https://h/s/id#token=T' })));
    openDialog();
    const confirm = await screen.findByRole('checkbox', { name: /3 رسالة غير منسوبة/ });
    expect((screen.getByRole('button', { name: 'إنشاء الرابط' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    await waitFor(() => expect(sent('/shares/preview')).toContainEqual({ confirmUnattributed: true }));
    await waitFor(() => expect(sent('/shares/preview')).toContainEqual({ confirmUnattributed: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'إنشاء الرابط' })).toBeTruthy());
    fireEvent.click(await screen.findByRole('checkbox', { name: /راجعتُ المحتوى/ }));
    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton());
    await screen.findByDisplayValue('https://h/s/id#token=T');
    expect(sent('/shares')[0]).toMatchObject({ confirmUnattributed: true, expiry: '30d' });
  });

  it('requires review and a second confirm when secrets were found', async () => {
    routes.push(onPreview(() => json(200, previewOf({ counts: { ...counts, secret: 1 } }))));
    routes.push(onCreate(() => json(201, { share: share(), shareUrl: 'https://h/s/id#token=T' })));
    openDialog();
    await screen.findByRole('button', { name: 'إنشاء الرابط' });
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reviewBox());
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /أسرار محتملة/ }));
    fireEvent.change(screen.getByLabelText('مدة صلاحية الرابط'), { target: { value: '7d' } });
    fireEvent.click(createButton());
    await screen.findByText('لن يظهر الرابط مرة أخرى', { exact: false });
    expect(sent('/shares')[0]).toEqual({
      expiry: '7d', upToMessageId: 'm1', previewSha256: 'a'.repeat(64),
      reviewedRedactions: true, confirmPossibleSecrets: true,
    });
  });

  it('shows the link once, in the dialog only, and never persists it', async () => {
    routes.push(onPreview(() => json(200, previewOf())));
    routes.push(onCreate(() => json(201, { share: share(), shareUrl: 'https://h/s/id#token=SECRET' })));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = openDialog();
    await screen.findByRole('button', { name: 'إنشاء الرابط' });
    fireEvent.click(reviewBox());
    fireEvent.click(createButton());
    await screen.findByDisplayValue('https://h/s/id#token=SECRET');
    expect(setItem).not.toHaveBeenCalled();
    view.rerender(<SessionShareDialog sessionId="sess-1" canShare open={false} onOpenChange={() => {}} />);
    view.rerender(<SessionShareDialog sessionId="sess-1" canShare open onOpenChange={() => {}} />);
    expect(screen.queryByDisplayValue('https://h/s/id#token=SECRET')).toBeNull();
    expect(document.body.textContent).not.toContain('SECRET');
    setItem.mockRestore();
  });

  it('re-previews and asks for fresh review on 409 SNAPSHOT_CHANGED', async () => {
    let previews = 0;
    routes.push(onPreview(() => { previews += 1; return json(200, previewOf({ previewSha256: String(previews).repeat(64) })); }));
    routes.push(onCreate(() => json(409, { error: { code: 'SNAPSHOT_CHANGED' } })));
    openDialog();
    await screen.findByRole('button', { name: 'إنشاء الرابط' });
    fireEvent.click(reviewBox());
    fireEvent.click(createButton());
    await screen.findByText(/تغيّرت المحادثة منذ المعاينة/);
    await waitFor(() => expect(previews).toBe(2));
    await waitFor(() => expect((reviewBox() as HTMLInputElement).checked).toBe(false));
  });

  it.each([
    [409, 'SHARE_BLOCKED', /لم يعد النشر مسموحاً/],
    [413, 'SNAPSHOT_TOO_LARGE', /أكبر من أن تُشارك/],
    [429, 'RATE_LIMITED', /طلبات كثيرة/],
    [401, 'AUTH_REQUIRED', /انتهت جلستك/],
    [403, 'ACCESS_DENIED', /لا تملك صلاحية/],
  ])('maps %s %s to a clear message', async (status, code, message) => {
    routes.push(onPreview(() => json(200, previewOf())));
    routes.push(onCreate(() => json(status, { error: { code } })));
    openDialog();
    await screen.findByRole('button', { name: 'إنشاء الرابط' });
    fireEvent.click(reviewBox());
    fireEvent.click(createButton());
    await screen.findByText(message);
  });

  it('shows preview-time errors with a retry', async () => {
    routes.push(onPreview(() => json(403, { error: { code: 'ACCESS_DENIED' } })));
    openDialog();
    await screen.findByText(/لا تملك صلاحية/);
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });
});

describe('revoke and lists', () => {
  it('revokes from the per-session list only after confirmation', async () => {
    routes.push(onPreview(() => json(200, previewOf())));
    routes.push((url, init) => (url.endsWith('/shares') && init?.method === 'GET' ? json(200, { shares: [share({ createdBySelf: false, createdByName: 'منى' })] }) : undefined));
    routes.push((url, init) => (url.endsWith('/revoke') ? Promise.resolve({ ok: true, status: 204, init }) : undefined));
    openDialog();
    expect((await screen.findByText('أنشأه: منى'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الرابط' }));
    expect((authenticatedFetch.mock.calls as FetchCall[]).some(([url]) => url.endsWith('/revoke'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await screen.findByText('مُلغى');
    expect(screen.queryByRole('button', { name: 'إلغاء الرابط' })).toBeNull();
  });

  it('shows the session title and the creator unless it is me; falls back to the short id', async () => {
    routes.push((url) => (url.endsWith('/mine') ? json(200, { shares: [
      share({ sessionTitle: 'خطة الإطلاق', createdBySelf: false, createdByName: 'منى' }),
      share({ id: 'q'.repeat(22), sessionTitle: null }),
    ] }) : undefined));
    render(<MySharesPanel />);
    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]).getByText('خطة الإطلاق')).toBeTruthy();
    expect(within(items[0]).getByText('أنشأه: منى')).toBeTruthy();
    expect(within(items[1]).getByText('abcd1234')).toBeTruthy();
    expect(within(items[1]).queryByText(/أنشأه:/)).toBeNull();
  });

  it('lists my shares without any token or URL and revokes', async () => {
    routes.push((url) => (url.endsWith('/mine') ? json(200, { shares: [share(), share({ id: 'r'.repeat(22), revokedAt: '2026-10-02T00:00:00Z', active: false })] }) : undefined));
    routes.push((url) => (url.endsWith('/revoke') ? Promise.resolve({ ok: true, status: 204 }) : undefined));
    const { container } = render(<MySharesPanel />);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(container.textContent).not.toMatch(/token=|https?:\/\//);
    fireEvent.click(within(items[0]).getByRole('button', { name: 'إلغاء الرابط' }));
    fireEvent.click(within(items[0]).getByRole('button', { name: 'تأكيد الإلغاء' }));
    await waitFor(() => expect(within(screen.getAllByRole('listitem')[0]).getByText('مُلغى')).toBeTruthy());
  });

  it('explains device-cookie mode in the panel', () => {
    auth.value = { token: null, user: { id: 7, role: 'user' } };
    render(<MySharesPanel />);
    expect(screen.getByRole('status').textContent).toContain('جلسة الجهاز');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
