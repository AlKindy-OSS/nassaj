/**
 * HarnessVersionSection.display.test.tsx — status display without any
 * compatibility gate (owner decision 2026-09-29: no baseline/pin verdicts).
 *
 * Pins that a newer, never-reviewed release gets the normal update button,
 * that no compatibility badge is rendered, and that drift still renders both
 * versions and a date.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessVersionStatus as WireStatus } from '../../../../../../../shared/harness-update.contract';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts && name in opts ? String(opts[name]) : whole);
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

function respond(body: unknown) {
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response));
}

async function renderSection(wire: WireStatus, viewerRole = 'member') {
  respond(wire);
  render(<HarnessVersionSection agent="codex" viewerRole={viewerRole} />);
  // Let the initial fetch effect resolve.
  await screen.findByText(wire.installedVersion ?? '');
}

describe('HarnessVersionSection display', () => {
  afterEach(() => { cleanup(); fetchMock.mockReset(); });

  it('offers the update button for an unreviewed newer release (codex 0.156.0 → 0.159.0)', async () => {
    await renderSection({ ...baseWire, installedVersion: '0.156.0', latestVersion: '0.159.0' }, 'owner');
    expect(screen.getByText('يتوفر إصدار أحدث.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeTruthy();
    expect(screen.queryByText(/غير مجرَّب|غير متوافق|خط الأساس/)).toBeNull();
  });

  it('still offers the update when the latest-version probe failed', async () => {
    await renderSection({ ...baseWire, latestVersion: null, upToDate: null, reason: 'probe-failed' }, 'owner');
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة التحقق' })).toBeTruthy();
  });

  it('says it runs the latest version when up to date', async () => {
    await renderSection({ ...baseWire, latestVersion: '1.2.0', upToDate: true });
    expect(screen.getByText('تعمل بأحدث إصدار.')).toBeTruthy();
  });

  it('renders drift with both versions and the date', async () => {
    await renderSection({
      ...baseWire,
      drift: { detected: true, from: '1.0.0', to: '1.1.5', at: '2026-09-20T10:00:00.000Z' },
    });
    const drift = screen.getByTestId('harness-drift');
    expect(drift.textContent).toContain('تغيّر الإصدار من');
    expect(drift.textContent).toContain('1.0.0');
    expect(drift.textContent).toContain('1.1.5');
    expect(drift.textContent).toContain('في 2026-09-20');
  });
});
