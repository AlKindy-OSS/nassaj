/**
 * T-1910 S4 — «أكمل من هنا» على بطاقة الجلسة المحجوبة.
 * RUNNER: vitest (jsdom). نقطتا الخادم مُحاكاتان عند حدّ authenticatedFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ContinueHerePanel from './ContinueHerePanel';

const fetchMock = vi.fn();

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

type FenceBody = Record<string, unknown>;

function reply(status: number, body: FenceBody) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** يوجّه GET إلى حالة الحجب وPOST إلى ردّ الإقرار. */
function route(getReplies: Array<ReturnType<typeof reply>>, postReply?: ReturnType<typeof reply>) {
  const queue = [...getReplies];
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return postReply ?? reply(200, { lifted: true });
    return queue.length > 1 ? queue.shift() : queue[0];
  });
}

const sessionFence = { fenced: true, scope: 'session', canAcknowledge: true, contained: true };

beforeEach(() => fetchMock.mockReset());
afterEach(cleanup);

describe('عرض الحالات', () => {
  it('لا يعرض شيئاً قبل أن يؤكّد الخادم الحجب (404)', async () => {
    route([reply(404, {})]);
    const { container } = render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('لا يعرض شيئاً لنطاقٍ غير session (يبقى رابط المالك للإعدادات)', async () => {
    route([reply(200, { fenced: true, scope: 'user_provider_purpose', canAcknowledge: true })]);
    const { container } = render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('لا يعرض شيئاً إذا لم يعد محجوباً', async () => {
    route([reply(200, { fenced: false, canAcknowledge: true })]);
    const { container } = render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('من لا يملك canAcknowledge يرى شرحاً بلا زرّ', async () => {
    route([reply(200, { ...sessionFence, canAcknowledge: false })]);
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    expect(await screen.findByTestId('continue-here-member-notice')).toBeTruthy();
    expect(screen.queryByText('outbox.continueHere.action')).toBeNull();
  });

  it('containment=not_provable: لا زرّ، ونصّ مسار المالك', async () => {
    route([reply(200, { ...sessionFence, containment: 'not_provable' })]);
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    expect((await screen.findByTestId('continue-here-not-provable')).textContent)
      .toBe('outbox.continueHere.error.not_provable');
    expect(screen.queryByText('outbox.continueHere.action')).toBeNull();
  });

  it.each(['contained', 'leases_open', 'not_contained'])('containment=%s يُبقي الزرّ', async (containment) => {
    route([reply(200, { ...sessionFence, containment })]);
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    expect(await screen.findByText('outbox.continueHere.action')).toBeTruthy();
  });

  it('حجب session مع canAcknowledge: النصّ والزرّ', async () => {
    route([reply(200, sessionFence)]);
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    expect(await screen.findByText('outbox.continueHere.notice')).toBeTruthy();
    expect(screen.getByText('outbox.continueHere.action')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/permission-fence');
  });
});

describe('خطوة التأكيد', () => {
  it('الزرّ لا يرسل POST؛ يفتح التأكيد، والإلغاء يعيده دون طلب', async () => {
    route([reply(200, sessionFence)]);
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    fireEvent.click(await screen.findByText('outbox.continueHere.action'));
    expect(screen.getByText('outbox.continueHere.confirmPrompt')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByText('outbox.continueHere.cancel'));
    expect(screen.getByText('outbox.continueHere.action')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('التأكيد يرسل POST ثم يعيد قراءة الحجب ويستدعي onLifted', async () => {
    route([reply(200, sessionFence), reply(200, { fenced: false, canAcknowledge: true })]);
    const onLifted = vi.fn();
    render(<ContinueHerePanel sessionId="s1" onLifted={onLifted} />);
    fireEvent.click(await screen.findByText('outbox.continueHere.action'));
    fireEvent.click(screen.getByText('outbox.continueHere.confirm'));
    await waitFor(() => expect(onLifted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/permission-fence/acknowledge', { method: 'POST' });
    const gets = fetchMock.mock.calls.filter(([, init]) => !init?.method);
    expect(gets.length).toBe(2);
  });

  it('lifted:false بسبب not_fenced يُعامل نجاحاً', async () => {
    route([reply(200, sessionFence)], reply(200, { lifted: false, reason: 'not_fenced' }));
    const onLifted = vi.fn();
    render(<ContinueHerePanel sessionId="s1" onLifted={onLifted} />);
    fireEvent.click(await screen.findByText('outbox.continueHere.action'));
    fireEvent.click(screen.getByText('outbox.continueHere.confirm'));
    await waitFor(() => expect(onLifted).toHaveBeenCalled());
  });
});

describe('أسباب الرفض', () => {
  it.each([
    [409, { reason: 'not_contained' }, 'not_contained'],
    [409, { reason: 'leases_open' }, 'leases_open'],
    [409, { reason: 'not_session_scope' }, 'not_session_scope'],
    [409, { reason: 'not_provable' }, 'not_provable'],
    [409, { reason: 'fence_changed' }, 'fence_changed'],
    [403, { code: 'unverified_actor' }, 'unverified_actor'],
    [403, { code: 'not_writer' }, 'forbidden'],
    [403, {}, 'forbidden'],
    [429, {}, 'rate_limited'],
    [500, {}, 'unknown'],
    [409, { reason: 'something_else' }, 'unknown'],
  ])('%i %j يعرض outbox.continueHere.error.%s ولا يستدعي onLifted', async (status, body, key) => {
    route([reply(200, sessionFence)], reply(status, body));
    const onLifted = vi.fn();
    render(<ContinueHerePanel sessionId="s1" onLifted={onLifted} />);
    fireEvent.click(await screen.findByText('outbox.continueHere.action'));
    fireEvent.click(screen.getByText('outbox.continueHere.confirm'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`outbox.continueHere.error.${key}`);
    expect(onLifted).not.toHaveBeenCalled();
    expect(screen.getByText('outbox.continueHere.action')).toBeTruthy();
  });

  it('فشل الشبكة يعرض unknown', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new Error('net');
      return reply(200, sessionFence);
    });
    render(<ContinueHerePanel sessionId="s1" onLifted={vi.fn()} />);
    fireEvent.click(await screen.findByText('outbox.continueHere.action'));
    fireEvent.click(screen.getByText('outbox.continueHere.confirm'));
    expect((await screen.findByRole('alert')).textContent).toBe('outbox.continueHere.error.unknown');
  });
});
