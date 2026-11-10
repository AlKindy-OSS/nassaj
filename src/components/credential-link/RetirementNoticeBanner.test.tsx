/**
 * RetirementNoticeBanner — the one-time owner notice (ADR-152 A1 §3.10, D3):
 * what changed, which providers were shared, which had an install-wide key (or
 * "unknown"), the members active at retirement who now need their own account
 * or a grant, that owner accounts must link too, a link to the grants page, and
 * an acknowledge button that POSTs and hides it. Members never fetch it.
 * RUNNER: vitest (jsdom), against the real locale files.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arCommon from '../../i18n/locales/ar/common.json';
import enCommon from '../../i18n/locales/en/common.json';

let locale: Record<string, unknown> = arCommon;
function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    locale,
  );
  return typeof value === 'string' ? value : undefined;
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (lookup(key) ?? `MISSING:${key}`)
      .replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? '')),
    i18n: { get language() { return locale === enCommon ? 'en' : 'ar'; } },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const openSettings = vi.fn();
vi.mock('../../contexts/PaletteOpsContext', () => ({ usePaletteOps: () => ({ openSettings }) }));

import RetirementNoticeBanner from './RetirementNoticeBanner';

const NOTICE = {
  retiredAt: '2026-11-05T07:00:00.000Z',
  sharedProviders: ['claude', 'agy'],
  orgKeyProviders: ['kimi'],
  members: [{ userId: 6, username: 'ebtehal' }, { userId: 7, username: 'sara' }],
  ownersMustLinkOwnAccount: true,
};

function answer(notice: unknown, ackStatus = 204) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: ackStatus < 400, status: ackStatus, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { notice } }) });
  });
}
const strip = (text: string | null | undefined) => (text ?? '').replace(/[⁦-⁩]/g, '');

beforeEach(() => { locale = arCommon; fetchMock.mockReset(); openSettings.mockReset(); });
afterEach(cleanup);

describe('RetirementNoticeBanner', () => {
  it('a non-owner never asks for the notice', async () => {
    answer(NOTICE);
    const { container } = render(<RetirementNoticeBanner isOwner={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no notice', async () => {
    answer(null);
    const { container } = render(<RetirementNoticeBanner isOwner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/credential-sharing/retirement-notice'));
    expect(container.firstChild).toBeNull();
  });

  it('says what changed, who and what was affected, and links to the grants', async () => {
    answer(NOTICE);
    render(<RetirementNoticeBanner isOwner />);
    const region = await screen.findByRole('region', { name: 'أُلغي الوضع المشترك لحسابات الوكلاء' });
    const text = strip(region.textContent);
    expect(text).toContain('لا يُستعمل حساب أحد لعمل غيره');
    expect(text).toContain('الوكلاء الذين كانوا مشتركين: Claude، Antigravity');
    expect(text).toContain('Kimi');
    expect(text).toContain('ebtehal');
    expect(text).toContain('sara');
    expect(text).toContain('يحتاج كل منهم الآن حسابه الخاص أو مشاركةً');
    expect(text).toContain('حسابات المالك مشمولة');
    expect(text).not.toContain('MISSING');

    fireEvent.click(screen.getByRole('button', { name: 'افتح إعدادات المشاركة' }));
    expect(openSettings).toHaveBeenCalledWith('agents', {
      tab: 'agents', agent: 'claude', category: 'account', section: 'credential-grants',
    });
  });

  it('org-key providers unknown says so', async () => {
    answer({ ...NOTICE, orgKeyProviders: 'unknown', members: [] });
    render(<RetirementNoticeBanner isOwner />);
    const region = await screen.findByRole('region');
    expect(strip(region.textContent)).toContain('تعذّر وقت الإلغاء معرفة');
    expect(strip(region.textContent)).toContain('لم يكن عضو آخر نشطاً');
  });

  it('acknowledge POSTs once and hides the banner', async () => {
    answer(NOTICE);
    render(<RetirementNoticeBanner isOwner />);
    fireEvent.click(await screen.findByRole('button', { name: 'فهمت' }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/credential-sharing/retirement-notice/ack', { method: 'POST' });
  });

  it('a failed acknowledge keeps the banner and says so', async () => {
    answer(NOTICE, 429);
    render(<RetirementNoticeBanner isOwner />);
    fireEvent.click(await screen.findByRole('button', { name: 'فهمت' }));
    expect(await screen.findByText('تعذّر إخفاء التنبيه. حاول مرة أخرى.')).toBeTruthy();
    expect(screen.getByRole('region')).toBeTruthy();
  });

  it('English locale has every string', async () => {
    locale = enCommon;
    answer(NOTICE);
    render(<RetirementNoticeBanner isOwner />);
    const region = await screen.findByRole('region', { name: 'Shared agent accounts have been retired' });
    expect(strip(region.textContent)).toContain('Agents that were shared: Claude, Antigravity');
    expect(region.textContent).not.toContain('MISSING');
  });
});
