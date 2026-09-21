import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionFence } from './PermissionFencesSection';

// One stable `t`, like the real i18next: a fresh function per render would re-run
// the component's `load` effect (deps [t]) forever.
const { t } = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en' } }),
}));

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let fences: PermissionFence[] = [];
let loadStatus = 200;

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      return { ok: loadStatus < 400, status: loadStatus, json: async () => ({ fences, scopedFences: [] }) };
    }
    fences = [];
    return { ok: true, status: 200, json: async () => ({ operationId: 'op-1' }) };
  }),
}));

import PermissionFencesSection from './PermissionFencesSection';

const generationFence = (openLeases = 0): PermissionFence => ({
  generation: 1,
  reasonCode: 'RECONCILED_EFFECT_UNKNOWN',
  createdAtMs: Date.UTC(2026, 8, 10),
  openLeases,
  decision: { provider: 'claude', entrypoint: 'terminal.managed-claude', purpose: 'spawn', decidedAtMs: null },
});

describe('PermissionFencesSection', () => {
  beforeEach(() => {
    calls = [];
    fences = [];
    loadStatus = 200;
  });
  afterEach(() => cleanup());

  it('says there is nothing to lift when no fence exists', async () => {
    render(<PermissionFencesSection />);
    expect(await screen.findByText('permissionFences.none')).toBeTruthy();
  });

  it('lifts only after a reason and the acknowledgement, and never sends force', async () => {
    fences = [generationFence()];
    render(<PermissionFencesSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'permissionFences.liftButton' }));
    const confirm = screen.getByRole('button', { name: 'permissionFences.confirmLift' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'checked the terminal' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/system/permission-fences/lift');
    expect(post.body).toEqual({ generation: 1, reason: 'checked the terminal', acknowledgeExternalEffects: true });
    expect(await screen.findByText(/permissionFences\.lifted/u)).toBeTruthy();
    expect(await screen.findByText('permissionFences.none')).toBeTruthy();
  });

  it('offers no lift while runs are still open', async () => {
    fences = [generationFence(2)];
    render(<PermissionFencesSection />);
    expect(await screen.findByText(/permissionFences\.openLeases/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'permissionFences.liftButton' })).toBeNull();
  });

  it('tells a non-owner the screen is owner-only', async () => {
    loadStatus = 403;
    render(<PermissionFencesSection />);
    expect(await screen.findByText('permissionFences.forbidden')).toBeTruthy();
  });
});
