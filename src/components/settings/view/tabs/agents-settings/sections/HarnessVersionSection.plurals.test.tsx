/**
 * HarnessVersionSection.plurals.test.tsx — B-1468 QA round 2 finding: Arabic
 * needs all six CLDR plural categories (`_zero/_one/_two/_few/_many/_other`)
 * for STORE_ACCESS_UNPROVABLE_PROCESSES. i18next resolves a missing category
 * as a missing KEY, not as "use _other" — so a 2- or 11-process refusal fell
 * through `fallbackLng: 'en'` and showed the English sentence inside the
 * Arabic UI. This runs a REAL i18next instance (not the `t = defaultValue`
 * mock the sibling test files use) so the resolver actually exercises
 * `Intl.PluralRules('ar')`, which is the only thing that can catch this.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessVersionStatus as WireStatus } from '../../../../../../../shared/harness-update.contract';
import settingsAr from '../../../../../../i18n/locales/ar/settings.json';
import settingsEn from '../../../../../../i18n/locales/en/settings.json';

const fetchMock = vi.fn();
vi.mock('../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import HarnessVersionSection from './HarnessVersionSection';

// `fallbackLng: 'en'` on purpose — this IS the chain that leaked English text
// into the Arabic UI when an Arabic plural category key was missing.
const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'ar',
  fallbackLng: 'en',
  resources: { ar: { settings: settingsAr }, en: { settings: settingsEn } },
  interpolation: { escapeValue: false },
});

const baseWire: WireStatus = {
  provider: 'codex',
  state: 'updatable',
  installedVersion: '1.2.0',
  latestVersion: '1.3.0',
  upToDate: false,
  updatable: true,
  reason: null,
  checkedAt: '2026-09-27T00:00:00.000Z',
  updating: false,
  activeJobId: null,
};

function refuseWith(uncheckedProcesses: { pid: number; comm: string }[]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: false, status: 423,
        json: async () => ({ code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable', uncheckedProcesses }),
      } as Response);
    }
    if (url.includes('/snapshots')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
    return Promise.resolve({ ok: true, status: 200, json: async () => baseWire } as Response);
  });
}

async function drawAndTriggerUpdate() {
  render(
    <I18nextProvider i18n={i18n}>
      <HarnessVersionSection agent="codex" viewerRole="owner" />
    </I18nextProvider>,
  );
  await screen.findByText(baseWire.installedVersion ?? '');
  fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
  return screen.findByRole('alert');
}

describe('HarnessVersionSection STORE_ACCESS_UNPROVABLE — real Arabic plural resolution', () => {
  afterEach(() => { cleanup(); fetchMock.mockReset(); });

  it('2 processes (Arabic dual) stays Arabic — no fallback to the English sentence', async () => {
    refuseWith([{ pid: 100, comm: 'sqlite3' }, { pid: 200, comm: 'codex' }]);
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('العمليتين التاليتين');
    expect(alert.textContent).not.toMatch(/not permitted|could not confirm/i);
  });

  it('11 processes (Arabic "many") stays Arabic — no fallback to the English sentence', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ pid: 1000 + i, comm: `proc${i}` }));
    refuseWith(many);
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('العمليات التالية');
    expect(alert.textContent).not.toMatch(/not permitted|could not confirm/i);
  });

  it('1 process (Arabic singular) still resolves — regression guard alongside the new forms', async () => {
    refuseWith([{ pid: 4242, comm: 'sqlite3' }]);
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('العملية التالية');
    expect(alert.textContent).not.toMatch(/not permitted|could not confirm/i);
  });
});

/** B-1468: the 202-accepted path — the job itself fails with STORE_ACCESS_UNPROVABLE. */
function failJobWith(error: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ jobId: 'job-x', provider: 'codex', status: 'queued' }) } as Response);
    }
    if (url.includes('/update-jobs/')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          jobId: 'job-x', provider: 'codex', status: 'failed', phase: 'done', percent: 100, log: [],
          fromVersion: '1.2.0', toVersion: '1.3.0', error: { code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable', ...error },
        }),
      } as Response);
    }
    if (url.includes('/snapshots')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
    return Promise.resolve({ ok: true, status: 200, json: async () => baseWire } as Response);
  });
}

describe('HarnessVersionSection — a job that fails with STORE_ACCESS_UNPROVABLE (B-1468)', () => {
  afterEach(() => { cleanup(); fetchMock.mockReset(); void i18n.changeLanguage('ar'); });

  it('names the job error processes through the same text as the 423 path', async () => {
    failJobWith({ uncheckedProcesses: [{ pid: 4242, comm: 'sqlite3', reason: 'fd_unreadable' }] });
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('العملية التالية');
    expect(alert.textContent).toContain('sqlite3 (pid 4242)');
    expect(alert.textContent).toContain('ملفاتها المفتوحة غير مقروءة');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows "+N more" with the Arabic dual when the server capped the list', async () => {
    failJobWith({ uncheckedProcesses: [{ pid: 1, comm: 'a' }], uncheckedProcessCount: 3 });
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('+عمليتان أخريان');
    // The sentence counts every unchecked process (3 → Arabic "few"), not only the shown one.
    expect(alert.textContent).toContain('العمليات التالية');
  });

  it('uses the Arabic "few" and "many" forms for larger hidden counts', async () => {
    failJobWith({ uncheckedProcesses: [{ pid: 1, comm: 'a' }], uncheckedProcessCount: 6 });
    expect((await drawAndTriggerUpdate()).textContent).toContain('+5 عمليات أخرى');
    cleanup();
    failJobWith({ uncheckedProcesses: [{ pid: 1, comm: 'a' }], uncheckedProcessCount: 12 });
    expect((await drawAndTriggerUpdate()).textContent).toContain('+11 عملية أخرى');
  });

  it('renders "+N more" in English', async () => {
    await i18n.changeLanguage('en');
    failJobWith({ uncheckedProcesses: [{ pid: 1, comm: 'a', reason: 'identity_unverified' }], uncheckedProcessCount: 2 });
    render(
      <I18nextProvider i18n={i18n}>
        <HarnessVersionSection agent="codex" viewerRole="owner" />
      </I18nextProvider>,
    );
    await screen.findByText(baseWire.installedVersion ?? '');
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('+1 more');
    expect(alert.textContent).toContain('identity not confirmed');
    expect(alert.textContent).toContain('following processes');
  });

  it('falls back to the honest "could not verify" text when the job error names no process', async () => {
    failJobWith({});
    const alert = await drawAndTriggerUpdate();
    expect(alert.textContent).toContain('تعذّر التأكد من أن ملفات بيانات الأداة محمية');
  });
});
