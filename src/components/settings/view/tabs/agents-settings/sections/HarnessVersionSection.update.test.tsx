/**
 * HarnessVersionSection.update.test.tsx — T-1871 stage 4 part B: the owner
 * update/rollback/recovery affordances built on the stage 3 server routes
 * (shared/harness-update.contract.ts; server/modules/providers/harness-update).
 *
 * Pins: the CONFIRMATION_REQUIRED dialog renders the SERVER's own textAr per
 * ack and disables confirm until every box is checked; restore-compatible only
 * shows for opencode/glm when the server offers it; rollback defaults to
 * scope 'binary' and switches to 'binary+data' only via the explicit checkbox;
 * a rollback_failed status surfaces the two recovery actions.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessSnapshotSummary, HarnessVersionStatus as WireStatus } from '../../../../../../../shared/harness-update.contract';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        (opts && name in opts ? String(opts[name]) : whole));
    },
    i18n: { language: 'ar' },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import HarnessVersionSection from './HarnessVersionSection';

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

const snapshot = (over: Partial<HarnessSnapshotSummary> = {}): HarnessSnapshotSummary => ({
  jobId: 'job-prior',
  createdAt: 1_000,
  expiresAt: 2_000,
  fromVersion: '1.1.0',
  toVersion: '1.2.0',
  state: 'succeeded',
  storeCount: 0,
  bytes: 0,
  dataRestore: { requiresAck: false, firstSpawnAt: null, spawnCount: 0, storesChanged: false, unknown: false },
  ...over,
});

function mockRoutes(overrides: Partial<Record<string, (init?: RequestInit) => Promise<Response>>> = {}, wire: WireStatus = baseWire) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(overrides)) {
      if (handler && url.endsWith(suffix)) return handler(init);
    }
    if (url.includes('/snapshots')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
    return Promise.resolve({ ok: true, status: 200, json: async () => wire } as Response);
  });
}

async function renderSection(props: Partial<ComponentProps<typeof HarnessVersionSection>> = {}) {
  render(<HarnessVersionSection agent="codex" viewerRole="owner" {...props} />);
  await screen.findByText(baseWire.installedVersion ?? '');
}

describe('HarnessVersionSection update/rollback/recovery (T-1871 stage 4)', () => {
  afterEach(() => { cleanup(); fetchMock.mockReset(); });

  it('opens the confirmation dialog with the server textAr and resends only once every box is checked', async () => {
    const required = [
      { kind: 'pinBreak', token: 'tok-1', expiresAt: Date.now() + 300_000, textEn: 'en pin', textAr: 'نص التوافق', facts: {} },
      { kind: 'dataLoss', token: 'tok-2', expiresAt: Date.now() + 300_000, textEn: 'en data', textAr: 'نص فقدان البيانات', facts: {} },
    ];
    let confirmedBody: unknown;
    mockRoutes({
      '/update': async (init) => {
        const parsed = init?.body ? JSON.parse(init.body as string) : {};
        if (!parsed.acks) return { ok: false, status: 409, json: async () => ({ code: 'CONFIRMATION_REQUIRED', required }) } as Response;
        confirmedBody = parsed;
        return { ok: true, status: 202, json: async () => ({ jobId: 'job-x', provider: 'codex', status: 'queued' }) } as Response;
      },
    });
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));

    await screen.findByText('نص التوافق');
    expect(screen.getByText('نص فقدان البيانات')).toBeTruthy();
    const confirmButton = screen.getByRole('button', { name: 'تأكيد' });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(confirmButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(checkboxes[1]);
    await waitFor(() => expect(confirmButton.hasAttribute('disabled')).toBe(false));

    fireEvent.click(confirmButton);
    await waitFor(() => expect(confirmedBody).toBeTruthy());
    expect(confirmedBody).toEqual({ acks: [{ kind: 'pinBreak', token: 'tok-1' }, { kind: 'dataLoss', token: 'tok-2' }] });
    await waitFor(() => expect(screen.queryByText('نص التوافق')).toBeNull());
  });

  it('shows an expired confirmation with a refresh action instead of confirm', async () => {
    const required = [{ kind: 'pinBreak', token: 'tok-old', expiresAt: Date.now() - 1, textEn: 'en', textAr: 'نص منتهي', facts: {} }];
    mockRoutes({
      '/update': async (init) => {
        const parsed = init?.body ? JSON.parse(init.body as string) : {};
        return parsed.acks
          ? { ok: true, status: 202, json: async () => ({ jobId: 'job-y', provider: 'codex', status: 'queued' }) } as Response
          : { ok: false, status: 409, json: async () => ({ code: 'CONFIRMATION_REQUIRED', required }) } as Response;
      },
    });
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await screen.findByText('نص منتهي');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تأكيد' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث الطلب' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(2));
  });

  it('offers "restore compatible" only when the server sends restoreCompatible (opencode)', async () => {
    mockRoutes({}, { ...baseWire, provider: 'opencode', restoreCompatible: { version: '1.17.18', verified: false } });
    render(<HarnessVersionSection agent="opencode" viewerRole="owner" />);
    await screen.findByText(baseWire.installedVersion ?? '');
    expect(screen.getByRole('button', { name: 'استرجاع الإصدار 1.17.18' })).toBeTruthy();
    expect(screen.getByText('لم يُجرَّب هذا الاسترجاع على هذا الخادم بعد.')).toBeTruthy();
  });

  it('does not offer "restore compatible" when the server sends no offer (codex)', async () => {
    mockRoutes();
    await renderSection();
    expect(screen.queryByRole('button', { name: /^استرجاع الإصدار/ })).toBeNull();
  });

  it('never fetches snapshots on mount; only on the explicit "rollback options" click, then defaults to scope binary and switches to binary+data only via the checkbox', async () => {
    let rollbackBody: unknown;
    let snapshotFetches = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/rollback')) { rollbackBody = init?.body ? JSON.parse(init.body as string) : {}; return Promise.resolve({ ok: true, status: 202, json: async () => ({ jobId: 'job-rb', provider: 'codex', status: 'queued' }) } as Response); }
      if (url.includes('/snapshots')) { snapshotFetches += 1; return Promise.resolve({ ok: true, status: 200, json: async () => [snapshot()] } as Response); }
      return Promise.resolve({ ok: true, status: 200, json: async () => baseWire } as Response);
    });
    await renderSection();
    // No snapshot request before the owner opens the rollback panel (qa release condition on 01c31f990).
    expect(snapshotFetches).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'خيارات الاسترجاع' }));
    expect(snapshotFetches).toBe(1);
    await screen.findByRole('button', { name: 'الرجوع إلى ما قبل آخر تحديث' });
    fireEvent.click(screen.getByRole('button', { name: 'الرجوع إلى ما قبل آخر تحديث' }));
    await waitFor(() => expect(rollbackBody).toEqual({ jobId: 'job-prior', scope: 'binary' }));

    fireEvent.click(screen.getByLabelText('مع البيانات'));
    fireEvent.click(screen.getByRole('button', { name: 'الرجوع إلى ما قبل آخر تحديث' }));
    await waitFor(() => expect(rollbackBody).toEqual({ jobId: 'job-prior', scope: 'binary+data' }));
  });

  it('shows "no rollback available" when the panel opens to an empty snapshot list', async () => {
    mockRoutes({});
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'خيارات الاسترجاع' }));
    await screen.findByText('لا توجد نسخة استرجاع لهذه الأداة.');
    expect(screen.queryByRole('button', { name: 'الرجوع إلى ما قبل آخر تحديث' })).toBeNull();
  });

  it('surfaces the two recovery actions once the followed job settles as rollback_failed', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/update')) return Promise.resolve({ ok: true, status: 202, json: async () => ({ jobId: 'job-fail', provider: 'codex', status: 'queued' }) } as Response);
      if (url.includes('/update-jobs/')) return Promise.resolve({
        ok: true, status: 200, json: async () => ({ jobId: 'job-fail', provider: 'codex', status: 'rollback_failed', phase: 'recovering', percent: 40, log: [], fromVersion: '1.2.0', toVersion: '1.3.0', error: { code: 'verify_failed', message: 'restore unverified' } }),
      } as Response);
      if (url.includes('/snapshots')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
      return Promise.resolve({ ok: true, status: 200, json: async () => baseWire } as Response);
    });
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await screen.findByRole('button', { name: 'إعادة محاولة الاسترجاع' });
    expect(screen.getByRole('button', { name: 'تأكيد' })).toBeTruthy();
    expect(screen.getByText('فشل الاسترجاع التلقائي؛ يلزم تدخّل المالك.')).toBeTruthy();
  });
});
