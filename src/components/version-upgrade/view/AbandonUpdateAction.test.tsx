/**
 * AbandonUpdateAction — owner-only "stop stuck update": visibility rules,
 * confirm flow, success refresh and server-error mapping. The API is mocked;
 * i18n is real so the Arabic copy is asserted as the owner will read it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';
import type { UpdateJobSnapshot } from '../updateJobClient';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

let role: string | undefined = 'owner';
vi.mock('../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { role } }),
}));

const { AbandonUpdateAction, abandonErrorKey } = await import('./AbandonUpdateAction');
const { abandonUpdateJob, normalizeUpdateJob } = await import('../updateJobClient');

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { ar: { common: arCommon }, en: { common: enCommon } },
  lng: 'ar',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const CONFIRM_TEXT = 'سيوقف هذا محاولة التحديث العالقة دون إعادة تشغيل الخادم، وبعدها تستطيع بدء تحديث جديد. هل تريد المتابعة؟';
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const job = (extra: Partial<UpdateJobSnapshot> = {}): UpdateJobSnapshot => ({ state: 'staging', abandonable: true, ...extra });

function renderAction(snapshot: UpdateJobSnapshot, onAbandoned = vi.fn(), jobId: string | null = 'job-1') {
  render(
    <I18nextProvider i18n={i18n}>
      <AbandonUpdateAction job={snapshot} jobId={jobId} onAbandoned={onAbandoned} />
    </I18nextProvider>,
  );
  return onAbandoned;
}

beforeEach(() => {
  role = 'owner';
  authenticatedFetch.mockReset();
  i18n.changeLanguage('ar');
});
afterEach(() => cleanup());

describe('visibility rules', () => {
  it('shows the button for an owner when abandonable', () => {
    renderAction(job());
    expect(screen.getByRole('button', { name: 'إيقاف التحديث العالق' })).not.toBeNull();
  });

  it('hides it from an admin (the endpoint is owner-only)', () => {
    role = 'admin';
    renderAction(job());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides it from a regular member and from a signed-out view', () => {
    role = 'user';
    renderAction(job());
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    role = undefined;
    renderAction(job());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides it when abandonable is false or absent, or the job id is unknown', () => {
    renderAction(job({ abandonable: false }));
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    renderAction({ state: 'staging' });
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    renderAction(job(), vi.fn(), null);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains a blocked reason on a live job instead of the button', () => {
    renderAction(job({ abandonable: false, abandonBlockedReason: 'in_flight_restart' }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/إعادة التشغيل جارية/)).not.toBeNull();
  });

  it('shows no hint for a terminal reason or a member', () => {
    renderAction(job({ abandonable: false, abandonBlockedReason: 'terminal' }));
    expect(screen.queryByText(/لا يمكن إيقاف/)).toBeNull();
    cleanup();
    role = 'user';
    renderAction(job({ abandonable: false, abandonBlockedReason: 'gate_closed' }));
    expect(screen.queryByText(/لا يمكن إيقاف/)).toBeNull();
  });

  it('normalizes the contract fields strictly', () => {
    const ok = normalizeUpdateJob({ state: 'staging', abandonable: true, abandonBlockedReason: null });
    expect(ok.abandonable).toBe(true);
    const bad = normalizeUpdateJob({ state: 'staging', abandonable: 'yes', abandonBlockedReason: 'weird' });
    expect(bad.abandonable).toBeUndefined();
    expect(bad.abandonBlockedReason).toBeUndefined();
    expect(normalizeUpdateJob({ state: 'failed', abandonBlockedReason: 'terminal' }).abandonBlockedReason)
      .toBe('terminal');
  });
});

describe('confirm flow', () => {
  it('asks in plain Arabic and sends nothing until confirmed', () => {
    renderAction(job());
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التحديث العالق' }));
    expect(screen.getByText(CONFIRM_TEXT)).not.toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('cancelling closes the dialog without a request', async () => {
    renderAction(job());
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التحديث العالق' }));
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByText(CONFIRM_TEXT)).toBeNull());
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('serves the English copy too', () => {
    i18n.changeLanguage('en');
    renderAction(job());
    fireEvent.click(screen.getByRole('button', { name: 'Stop stuck update' }));
    expect(screen.getByText(/without restarting the server/)).not.toBeNull();
  });
});

describe('success', () => {
  it('posts { confirm: true } to /abandon, refreshes through onAbandoned and shows a status', async () => {
    const fresh = { job: { state: 'failed', abandonable: false }, abandoned: true };
    authenticatedFetch.mockResolvedValue(reply(200, fresh));
    const onAbandoned = renderAction(job());
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التحديث العالق' }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، أوقف التحديث' }));
    await waitFor(() => expect(onAbandoned).toHaveBeenCalledWith(fresh.job));
    const [url, init] = authenticatedFetch.mock.calls[0];
    expect(url).toBe('/api/system/update/jobs/job-1/abandon');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ confirm: true });
    expect((await screen.findByRole('status')).textContent).toContain('أُوقفت محاولة التحديث العالقة');
    expect(screen.queryByText(CONFIRM_TEXT)).toBeNull();
  });
});

describe('error mapping', () => {
  async function confirmWith(response: Response | Error) {
    if (response instanceof Error) authenticatedFetch.mockRejectedValue(response);
    else authenticatedFetch.mockResolvedValue(response);
    const onAbandoned = renderAction(job());
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التحديث العالق' }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، أوقف التحديث' }));
    const alert = await screen.findByRole('alert');
    return { alert, onAbandoned };
  }

  it.each([
    ['in_flight_restart', /إعادة التشغيل جارية/],
    ['gate_closed', /بوابة التحديث مغلقة/],
    ['head_moved_unverified', /حالة الشيفرة تغيّرت/],
    ['terminal', /انتهى هذا التحديث أصلاً/],
  ])('maps 409 update_not_abandonable (%s) to plain Arabic', async (reason, pattern) => {
    const { alert, onAbandoned } = await confirmWith(
      reply(409, { error: { code: 'update_not_abandonable', message: 'x', reason } }),
    );
    expect(alert.textContent).toMatch(pattern);
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('maps 404, 403, 429, a network failure and an unknown error', async () => {
    expect(abandonErrorKey('update_job_not_found', 404, null)).toBe('jobNotFound');
    expect(abandonErrorKey('', 403, null)).toBe('forbidden');
    expect(abandonErrorKey('', 429, null)).toBe('rateLimited');
    expect(abandonErrorKey('network', 0, null)).toBe('network');
    expect(abandonErrorKey('update_not_abandonable', 409, null)).toBe('notAbandonable.unknown');
    expect(abandonErrorKey('boom', 500, null)).toBe('unknown');
    const { alert } = await confirmWith(reply(404, { error: { code: 'update_job_not_found', message: 'x' } }));
    expect(alert.textContent).toMatch(/لم يعد هذا التحديث موجوداً/);
  });

  it('reports a network failure without throwing', async () => {
    const { alert } = await confirmWith(new Error('offline'));
    expect(alert.textContent).toMatch(/تعذّر الوصول إلى الخادم/);
  });

  it('keeps the button available to retry after an error', async () => {
    await confirmWith(reply(403, { error: { code: 'forbidden', message: 'x' } }));
    expect(screen.getByRole('button', { name: 'إيقاف التحديث العالق' })).not.toBeNull();
  });
});

describe('abandonUpdateJob', () => {
  it('encodes the job id and never throws on an unreadable body', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('x'); } });
    const result = await abandonUpdateJob(fetcher, 'a/b');
    expect(fetcher.mock.calls[0][0]).toBe('/api/system/update/jobs/a%2Fb/abandon');
    expect(result).toEqual({ kind: 'error', code: 'unknown', status: 500, reason: null });
  });

  it('ignores a hostile reason value', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(409, { error: { code: 'update_not_abandonable', reason: '<img>' } }));
    expect(await abandonUpdateJob(fetcher, 'j')).toMatchObject({ code: 'update_not_abandonable', reason: null });
  });
});
