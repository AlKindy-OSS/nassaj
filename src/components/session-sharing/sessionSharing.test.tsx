import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import LiveShareDialog from './LiveShareDialog';
import SessionShareNotice from './SessionShareNotice';

const json = (status: number, body: unknown) => Promise.resolve({
  ok: status < 400, status, json: async () => body,
});
// Row shape as the server serializes it (listedShare), live and legacy snapshot.
const liveShare = (over: Record<string, unknown> = {}) => ({
  id: 's'.repeat(32), sessionId: 'abcd1234-x', mode: 'live', createdBy: 7, ownerUserId: 7,
  createdAt: '2026-10-01T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, revokeReason: null,
  upToMessageId: null, messageCount: null, redactionCounts: null, viewCount: 3, lastViewedAt: null, active: true,
  sessionTitle: null, createdByName: 'سارة', createdBySelf: true, ...over,
});
const snapshotShare = (over: Record<string, unknown> = {}) => liveShare({
  id: 'p'.repeat(32), mode: 'snapshot', upToMessageId: 'm9', messageCount: 4, redactionCounts: { secret: 1 }, ...over,
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
afterEach(() => { cleanup(); vi.useRealTimers(); });

const onCreate = (response: () => Promise<unknown>): Route => (url, init) =>
  (url.endsWith('/shares') && init?.method === 'POST' ? response() : undefined);
const onList = (shares: unknown[]): Route => (url, init) =>
  (url.endsWith('/shares') && (init?.method ?? 'GET') === 'GET' ? json(200, { shares }) : undefined);
type FetchCall = [string, { method?: string; body?: string }];
const calls = () => authenticatedFetch.mock.calls as FetchCall[];
const created = () => calls().filter(([url, init]) => url.endsWith('/shares') && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body ?? '{}'));

const openDialog = (canShare = true) =>
  render(<LiveShareDialog sessionId="sess-1" canShare={canShare} open onOpenChange={() => {}} />);
const createButton = () => screen.getByRole('button', { name: 'إنشاء الرابط' });
const URL_OK = 'https://h/s/' + 'a'.repeat(32) + '#token=T';

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

  it('hides it on 401', async () => {
    routes.push(eligibleAs({ error: { code: 'AUTH_REQUIRED' } }, 401));
    render(<SessionShareButton sessionId="s" />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(shareButton()).toBeNull();
  });

  it('asks once per session for the component lifetime', async () => {
    routes.push(eligibleAs({ canShare: true, canManage: true }));
    const view = render(<SessionShareButton sessionId="s" />);
    await screen.findByRole('button', { name: 'مشاركة المحادثة' });
    view.rerender(<SessionShareButton sessionId="s" />);
    expect(calls().filter(([url]) => url.endsWith('/eligibility'))).toHaveLength(1);
  });

  it('non-owner manager: list and revoke only, no create controls', async () => {
    routes.push(eligibleAs({ canShare: false, canManage: true }));
    routes.push(onList([liveShare({ createdBySelf: false, createdByName: 'منى' })]));
    render(<SessionShareButton sessionId="s" />);
    fireEvent.click(await screen.findByRole('button', { name: 'مشاركة المحادثة' }));
    await screen.findByRole('button', { name: 'إلغاء الرابط' });
    expect(screen.queryByRole('button', { name: 'إنشاء الرابط' })).toBeNull();
    expect(screen.queryByLabelText('مدة صلاحية الرابط')).toBeNull();
    expect(screen.getByText(/لصاحب الجلسة وحده/)).toBeTruthy();
    expect(calls().some(([url]) => url.includes('/preview'))).toBe(false);
  });
});

describe('owner create flow', () => {
  it('states the live, read-only terms in plain Arabic before creating', async () => {
    openDialog();
    await screen.findByText('لا توجد روابط مشتركة.');
    const text = document.body.textContent ?? '';
    for (const part of ['الصور والملفات النصية', 'تظهر الرسائل المستقبلية تلقائياً', 'تُخفى الأسرار المعروفة تلقائياً',
      'الملفات الثنائية', 'سجلّ متصفح', 'لا تحتفظ بالمرفقات']) expect(text).toContain(part);
    expect(text).not.toContain('أقصر');
    expect(calls().some(([url]) => url.includes('/preview'))).toBe(false);
  });

  it('creates with the 7-day default, shows the link once, copies it and never persists it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    routes.push(onCreate(() => json(201, { share: liveShare(), shareUrl: URL_OK })));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = openDialog();
    expect((screen.getByLabelText('مدة صلاحية الرابط') as HTMLSelectElement).value).toBe('7d');
    fireEvent.click(createButton());
    await screen.findByDisplayValue(URL_OK);
    expect(created()).toEqual([{ expiry: '7d' }]);
    fireEvent.click(screen.getByRole('button', { name: 'نسخ الرابط' }));
    await screen.findByText('تم النسخ');
    expect(writeText).toHaveBeenCalledWith(URL_OK);
    expect(setItem).not.toHaveBeenCalled();
    view.rerender(<LiveShareDialog sessionId="sess-1" canShare open={false} onOpenChange={() => {}} />);
    view.rerender(<LiveShareDialog sessionId="sess-1" canShare open onOpenChange={() => {}} />);
    expect(screen.queryByDisplayValue(URL_OK)).toBeNull();
    expect(document.body.textContent).not.toContain('token=');
    setItem.mockRestore();
    vi.unstubAllGlobals();
  });

  it('sends the chosen expiry', async () => {
    routes.push(onCreate(() => json(201, { share: liveShare(), shareUrl: URL_OK })));
    openDialog();
    fireEvent.change(screen.getByLabelText('مدة صلاحية الرابط'), { target: { value: '90d' } });
    fireEvent.click(createButton());
    await screen.findByDisplayValue(URL_OK);
    expect(created()).toEqual([{ expiry: '90d' }]);
  });

  it('lists live and legacy rows with a mode badge, tolerating null snapshot fields', async () => {
    routes.push(onList([liveShare(), snapshotShare()]));
    openDialog();
    await screen.findByText('نسخة قديمة');
    const items = within(screen.getByRole('region', { name: 'الروابط الحالية لهذه المحادثة' })).getAllByRole('listitem');
    expect(within(items[0]).getByText('حيّ')).toBeTruthy();
    expect(within(items[0]).queryByText('الرسائل')).toBeNull();
    expect(within(items[1]).getByText('نسخة قديمة')).toBeTruthy();
    expect(within(items[1]).getByText('الرسائل')).toBeTruthy();
  });

  it.each([
    [400, 'INVALID_INPUT', /مدة الصلاحية المختارة غير صالحة/],
    [403, 'OWNER_ONLY', /لصاحب الجلسة وحده/],
    [403, 'ACCESS_DENIED', /لا تملك صلاحية على روابط/],
    [404, 'SESSION_NOT_FOUND', /المحادثة غير موجودة/],
    [415, 'UNSUPPORTED_MEDIA_TYPE', /أعد تحميل الصفحة/],
    [422, 'SESSION_PROJECT_UNREGISTERED', /غير مسجّل/],
    [422, 'SESSION_PROJECT_ARCHIVED', /مؤرشف/],
    [429, 'SHARE_LIMIT_REACHED', /الحد الأقصى لعدد الروابط/],
    [429, 'RATE_LIMITED', /طلبات كثيرة/],
    [503, 'SHARING_NOT_CONFIGURED', /غير مفعّلة على هذا الخادم/],
    [401, 'AUTH_REQUIRED', /انتهت جلستك/],
    [410, 'SNAPSHOT_SHARES_RETIRED', /لم تعد متاحة/],
  ])('maps %s %s to its own message', async (status, code, message) => {
    routes.push(onCreate(() => json(status, { error: { code } })));
    openDialog();
    fireEvent.click(createButton());
    await screen.findByText(message);
    expect(document.body.textContent).not.toContain('جرّب محادثة أقصر');
  });

  it('keeps every create-error message distinct', () => {
    const errors = (arChat as unknown as { sessionShare: { errors: Record<string, string> } }).sessionShare.errors;
    const keys = ['invalidInput', 'ownerOnly', 'accessDenied', 'notFound', 'unsupportedType',
      'projectUnregistered', 'projectArchived', 'limitReached', 'rateLimited', 'notConfigured', 'authRequired', 'snapshotRetired'];
    expect(new Set(keys.map((key) => errors[key])).size).toBe(keys.length);
    expect(errors.tooLarge).toBeUndefined();
  });
});

describe('revoke and lists', () => {
  it('revokes from the per-session list only after confirmation and announces the change', async () => {
    routes.push(onList([liveShare({ createdBySelf: false, createdByName: 'منى' })]));
    routes.push((url) => (url.endsWith('/revoke') ? Promise.resolve({ ok: true, status: 204 }) : undefined));
    const changed = vi.fn();
    window.addEventListener('nassaj:session-shares-changed', changed);
    openDialog();
    expect(await screen.findByText('أنشأه: منى')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الرابط' }));
    expect(calls().some(([url]) => url.endsWith('/revoke'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await screen.findByText('مُلغى');
    expect(screen.queryByRole('button', { name: 'إلغاء الرابط' })).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener('nassaj:session-shares-changed', changed);
  });

  it('shows a list-load error with retry', async () => {
    routes.push((url, init) => (url.endsWith('/shares') && (init?.method ?? 'GET') === 'GET'
      ? json(429, { error: { code: 'RATE_LIMITED' } }) : undefined));
    openDialog();
    await screen.findByText(/طلبات كثيرة/);
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('shows the session title and the creator unless it is me; falls back to the short id', async () => {
    routes.push((url) => (url.endsWith('/mine') ? json(200, { shares: [
      liveShare({ sessionTitle: 'خطة الإطلاق', createdBySelf: false, createdByName: 'منى' }),
      liveShare({ id: 'q'.repeat(32), sessionTitle: null }),
    ] }) : undefined));
    render(<MySharesPanel />);
    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]).getByText('خطة الإطلاق')).toBeTruthy();
    expect(within(items[0]).getByText('أنشأه: منى')).toBeTruthy();
    expect(within(items[1]).getByText('abcd1234')).toBeTruthy();
    expect(within(items[1]).queryByText(/أنشأه:/)).toBeNull();
  });

  it('lists my shares without any token or URL and revokes', async () => {
    routes.push((url) => (url.endsWith('/mine') ? json(200, { shares: [liveShare(),
      liveShare({ id: 'r'.repeat(32), revokedAt: '2026-10-02T00:00:00Z', active: false })] }) : undefined));
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

describe('in-session notice', () => {
  const statusRoute = (count: () => number): Route => (url) =>
    (url.endsWith('/shares/status') ? json(200, { activeLiveLinks: count() }) : undefined);
  const noticeName = /رابط قراءة عام نشِط لهذه الجلسة/;

  it('shows while activeLiveLinks > 0 and stays hidden at 0', async () => {
    routes.push(statusRoute(() => 0));
    const view = render(<SessionShareNotice sessionId="s" />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
    routes.unshift(statusRoute(() => 2));
    render(<SessionShareNotice sessionId="s" />);
    expect((await screen.findByRole('status')).getAttribute('aria-label')).toMatch(noticeName);
  });

  it('needs no Bearer token (device-session members see it too)', async () => {
    auth.value = { token: null, user: { id: 7, role: 'user' } };
    routes.push(statusRoute(() => 1));
    render(<SessionShareNotice sessionId="s" />);
    await screen.findByRole('status');
  });

  it('polls every 60 s, disappears after revoke, and refreshes on a share change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let count = 1;
    routes.push(statusRoute(() => count));
    render(<SessionShareNotice sessionId="s" />);
    await screen.findByRole('status');
    const polls = () => calls().filter(([url]) => url.endsWith('/shares/status')).length;
    expect(polls()).toBe(1);
    count = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(polls()).toBe(2);
    count = 1;
    await act(async () => { window.dispatchEvent(new Event('nassaj:session-shares-changed')); });
    await screen.findByRole('status');
    expect(polls()).toBe(3);
  });

  it('keeps showing the last value when a poll is refused with 429', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let refuse = false;
    routes.push((url) => (url.endsWith('/shares/status')
      ? (refuse ? json(429, { error: { code: 'RATE_LIMITED' } }) : json(200, { activeLiveLinks: 1 })) : undefined));
    render(<SessionShareNotice sessionId="s" />);
    await screen.findByRole('status');
    refuse = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('does not poll while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    routes.push(statusRoute(() => 1));
    render(<SessionShareNotice sessionId="s" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(calls().some(([url]) => url.endsWith('/shares/status'))).toBe(false);
    visibility.mockRestore();
  });
});
