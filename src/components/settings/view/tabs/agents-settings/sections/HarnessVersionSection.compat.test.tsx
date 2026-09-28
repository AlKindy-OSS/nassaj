/**
 * HarnessVersionSection.compat.test.tsx — display-only compatibility and
 * drift badges (T-1871 stage 4 part A, ADR-159 Addendum 4).
 *
 * Server side (T-1871 stage 2, commit 566371ebb) added optional `compatibility`
 * / `targetCompatibility` / `drift` to `HarnessVersionStatus`. This file pins
 * that every compatibility state renders a text label (never color-only,
 * WCAG 1.4.1), that `baseline` never says "tested", and that drift renders
 * both versions and a date. No update/rollback affordance is exercised here —
 * that surface is still stage 3, not this task's scope.
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

async function renderSection(wire: WireStatus) {
  respond(wire);
  render(<HarnessVersionSection agent="codex" viewerRole="member" />);
  // Let the initial fetch effect resolve.
  await screen.findByText(wire.installedVersion ?? '');
}

describe('HarnessVersionSection compatibility badges', () => {
  afterEach(() => { cleanup(); fetchMock.mockReset(); });

  it('renders "compatible" with a text label and reason', async () => {
    await renderSection({
      ...baseWire,
      compatibility: { state: 'compatible', reason: 'pin-match', referenceVersion: '1.2.0', asOf: null, blockedModes: [] },
    });
    expect(screen.getByText('متوافق')).toBeTruthy();
    expect(screen.getByText('يطابق الإصدار المعتمد المثبَّت.')).toBeTruthy();
  });

  it('renders "baseline" with the date and never says "tested"', async () => {
    await renderSection({
      ...baseWire,
      compatibility: { state: 'baseline', reason: 'baseline-match', referenceVersion: '1.2.0', asOf: '2026-09-27', blockedModes: [] },
    });
    expect(screen.getByText('خط الأساس بتاريخ 2026-09-27')).toBeTruthy();
    expect(screen.queryByText(/تم اختباره|تم فحصه/)).not.toBeTruthy();
  });

  it('renders "untested"', async () => {
    await renderSection({
      ...baseWire,
      compatibility: { state: 'untested', reason: 'not-baselined', referenceVersion: null, asOf: null, blockedModes: [] },
    });
    expect(screen.getByText('غير مجرَّب')).toBeTruthy();
    expect(screen.getByText('لا تتوفر بيانات خط أساس لهذا الإصدار.')).toBeTruthy();
  });

  it('renders "incompatible" with the glm-carrier-blocked reason and reference version', async () => {
    await renderSection({
      ...baseWire,
      provider: 'glm',
      compatibility: { state: 'incompatible', reason: 'glm-carrier-blocked', referenceVersion: '1.17.18', asOf: null, blockedModes: ['glm-carrier'] },
    });
    expect(screen.getByText('غير متوافق')).toBeTruthy();
    expect(screen.getByText('GLM متوقف: نسّاج يقبل ناقل opencode 1.17.18 فقط.')).toBeTruthy();
  });

  it('renders a generic message for an unrecognised "-blocked" reason', async () => {
    await renderSection({
      ...baseWire,
      compatibility: { state: 'incompatible', reason: 'newmode-blocked', referenceVersion: null, asOf: null, blockedModes: ['newmode'] },
    });
    expect(screen.getByText('هذا الوضع متوقف لنسّاج: newmode.')).toBeTruthy();
  });

  it('renders the target (latest) compatibility next to its version', async () => {
    await renderSection({
      ...baseWire,
      targetCompatibility: { state: 'untested', reason: 'not-baselined', referenceVersion: null, asOf: null, blockedModes: [] },
    });
    expect(screen.getByText('أحدث نسخة:')).toBeTruthy();
    expect(screen.getByText('1.3.0')).toBeTruthy();
    expect(screen.getByText('غير مجرَّب')).toBeTruthy();
  });

  it('renders drift with both versions and the date', async () => {
    await renderSection({
      ...baseWire,
      drift: { detected: true, from: '1.0.0', to: '1.1.5', at: '2026-09-20T10:00:00.000Z' },
    });
    const drift = screen.getByTestId('harness-drift');
    expect(drift.textContent).toContain('تغيّرت من');
    expect(drift.textContent).toContain('1.0.0');
    expect(drift.textContent).toContain('1.1.5');
    expect(drift.textContent).toContain('بتاريخ 2026-09-20');
  });

  it('renders nothing extra when the server has not sent compatibility data yet', async () => {
    await renderSection(baseWire);
    expect(screen.queryByText('الإصدار المثبَّت:')).toBeNull();
    expect(screen.queryByText('أحدث نسخة:')).toBeNull();
  });
});
