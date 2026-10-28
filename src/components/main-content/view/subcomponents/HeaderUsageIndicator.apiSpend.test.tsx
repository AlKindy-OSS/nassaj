/**
 * ADR-214 / T-2066: شارة إنفاق Anthropic API في الهيدر.
 *
 * المُثبَت: المبلغ بعد شارة «+»، و$0.00 فقط حين يؤكّد الخادم بيانات مجموعها صفر،
 * و«—» بلا بيانات (لا صفر مختلق)، وشارتا التعذّر (رفض المفتاح/تعذّر القراءة)،
 * والصمت عند none/loading، والظهور حتى حين لا نوافذ اشتراك، والإخفاء على مزوّد
 * غير Anthropic.
 *
 * ⚠️ قيم أوّلية فقط إلى `node:assert`، لا عناصر DOM.
 *
 * RUNNER: vitest (jsdom).
 */
import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const vars = opts ? Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',') : '';
      return vars ? `${key}(${vars})` : key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 7 } }),
}));

type UsageMode = 'windows' | 'empty' | 'loading';
let usageMode: UsageMode = 'windows';
vi.mock('../../../quick-settings-panel/hooks/useClaudeUsageShared', () => ({
  useClaudeUsageShared: (enabled: boolean) => {
    if (!enabled || usageMode === 'loading') return { status: 'loading', refetch: () => {} };
    const window = { utilization: 10, resetsAt: '2026-10-21T12:00:00.000Z' };
    return {
      status: 'success',
      refetch: () => {},
      data: {
        plan: 'max',
        session: usageMode === 'windows' ? window : null,
        weeklyAllModels: null,
        weeklySonnet: null,
        weeklyOpus: null,
        extraUsage: usageMode === 'windows'
          ? { enabled: true, usedCredits: 1000, monthlyLimit: 5000, utilization: 20, currency: 'USD' }
          : null,
        fetchedAt: '2026-10-21T08:00:00.000Z',
        stale: false,
      },
    };
  },
}));

let spendState: Record<string, unknown> = { status: 'none' };
const spendEnabled: boolean[] = [];
vi.mock('../../../quick-settings-panel/hooks/useAnthropicApiSpend', () => ({
  useAnthropicApiSpend: (enabled: boolean) => {
    spendEnabled.push(enabled);
    return enabled ? spendState : { status: 'idle' };
  },
}));

import { __resetSelectedProviderStore, setSelectedProvider } from '../../../../stores/selectedProviderStore';

import HeaderUsageIndicator from './HeaderUsageIndicator';

const BASE = {
  currency: 'USD',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-10-21T08:00:00.000Z',
  observedAt: '2026-10-21T08:00:00.000Z',
  excludesPriorityTier: true,
};

function success(spendCents: number, hasData: boolean) {
  return { status: 'success', data: { ...BASE, spendCents, hasData } };
}

function renderHeader(sessionProvider: string | null = 'claude') {
  const { container } = render(<HeaderUsageIndicator tabsMode="full" sessionProvider={sessionProvider} />);
  const badge = container.querySelector('[data-testid="api-spend-badge"]');
  const error = container.querySelector('[data-testid="api-spend-error-badge"]');
  return {
    text: container.textContent ?? '',
    badgeText: badge?.textContent ?? null,
    badgeAria: badge?.getAttribute('aria-label') ?? null,
    hasData: badge?.getAttribute('data-has-data') ?? null,
    errorAria: error?.getAttribute('aria-label') ?? null,
    lastIsSpend: badge !== null && container.firstElementChild?.lastElementChild?.contains(badge) === true,
  };
}

afterEach(cleanup);
beforeEach(() => {
  __resetSelectedProviderStore();
  usageMode = 'windows';
  spendState = { status: 'none' };
  spendEnabled.length = 0;
});

describe('HeaderUsageIndicator — شارة إنفاق Anthropic API', () => {
  it('amount: formatted cents, placed after the "+" badge, period in aria-label', () => {
    spendState = success(4217, true);
    const view = renderHeader();
    assert.equal(view.badgeText?.includes('$42.17'), true);
    assert.equal(view.lastIsSpend, true, 'spend badge comes last, after "+"');
    assert.equal(view.text.includes('+'), true);
    assert.equal(view.badgeAria?.includes('apiSpend.period'), true);
    assert.equal(view.badgeAria?.includes('October 1'), true);
  });

  it('negative spend (credits/refunds) is shown honestly', () => {
    spendState = success(-320, true);
    assert.equal(renderHeader().badgeText?.includes('-$3.20'), true);
  });

  it('both period ends are formatted in UTC, matching the "(UTC)" label', () => {
    const zones: Array<string | undefined> = [];
    const dateSpy = vi.spyOn(Date.prototype, 'toLocaleDateString');
    const stringSpy = vi.spyOn(Date.prototype, 'toLocaleString');
    spendState = success(4217, true);
    renderHeader();
    for (const call of [...dateSpy.mock.calls, ...stringSpy.mock.calls]) {
      zones.push((call[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone);
    }
    dateSpy.mockRestore();
    stringSpy.mockRestore();
    assert.equal(zones.length >= 2, true);
    assert.equal(zones.every((zone) => zone === 'UTC'), true, JSON.stringify(zones));
  });

  it('$0.00 only when hasData=true and spendCents=0', () => {
    spendState = success(0, true);
    const view = renderHeader();
    assert.equal(view.badgeText?.includes('$0.00'), true);
    assert.equal(view.hasData, 'true');
  });

  it('hasData=false ⇒ "—" and a no-data label, never $0', () => {
    spendState = success(0, false);
    const view = renderHeader();
    assert.equal(view.badgeText?.includes('apiSpend.noDataShort'), true);
    assert.equal(view.badgeText?.includes('0'), false);
    assert.equal(view.badgeAria?.includes('apiSpend.noData'), true);
    assert.equal(view.hasData, 'false');
  });

  it('502 API_SPEND_AUTH ⇒ error badge "Admin key rejected"', () => {
    spendState = { status: 'error', code: 'API_SPEND_AUTH' };
    const view = renderHeader();
    assert.equal(view.badgeText, null);
    assert.equal(view.errorAria, 'apiSpend.authErrorLabel');
  });

  it('502 API_SPEND_UNAVAILABLE ⇒ error badge "Couldn\'t read API spend"', () => {
    spendState = { status: 'error', code: 'API_SPEND_UNAVAILABLE' };
    const view = renderHeader();
    assert.equal(view.errorAria, 'apiSpend.unavailableLabel');
  });

  it('none (no key) and loading stay silent', () => {
    for (const state of [{ status: 'none' }, { status: 'loading' }, { status: 'idle' }]) {
      cleanup();
      spendState = state;
      const view = renderHeader();
      assert.equal(view.badgeText, null, state.status);
      assert.equal(view.errorAria, null, state.status);
    }
  });

  it('renders even when no subscription windows and no extra credits exist', () => {
    usageMode = 'empty';
    spendState = success(150, true);
    assert.equal(renderHeader().badgeText?.includes('$1.50'), true);
  });

  it('renders while subscription usage is still loading', () => {
    usageMode = 'loading';
    spendState = success(150, true);
    assert.equal(renderHeader().badgeText?.includes('$1.50'), true);
  });

  it('hidden and not requested for a non-Anthropic provider', () => {
    spendState = success(4217, true);
    setSelectedProvider('codex');
    const view = renderHeader(null);
    assert.equal(view.badgeText, null);
    assert.equal(view.errorAria, null);
    assert.equal(spendEnabled.includes(true), false);
  });
});
