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
let extra: Record<string, unknown> = {};

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      return { ok: loadStatus < 400, status: loadStatus, json: async () => ({ fences, scopedFences: [], ...extra }) };
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

const sessionFence = (scopeKey: string): PermissionFence => ({
  generation: 1,
  scopeKind: 'session',
  scopeKey,
  reasonCode: 'RECONCILED_EFFECT_UNKNOWN',
  createdAtMs: Date.UTC(2026, 8, 10),
  openLeases: 0,
  decision: null,
});

describe('PermissionFencesSection', () => {
  beforeEach(() => {
    calls = [];
    fences = [];
    loadStatus = 200;
    extra = {};
  });
  afterEach(() => cleanup());

  it('says there is nothing to lift when no fence exists', async () => {
    render(<PermissionFencesSection />);
    expect(await screen.findByText('permissionFences.none')).toBeTruthy();
  });

  it('lists recent acknowledgements newest first with committed state', async () => {
    const row = (operationId: string, committed: boolean, atMs: number) => ({
      operationId, sessionId: `sess-${operationId}`, actorUserId: 7, actorDeviceSessionId: 'd',
      decisionOwnerUserId: 3, decisionId: 'x', atMs, committed,
    });
    extra = {
      recentAcknowledgementsAvailable: true,
      recentAcknowledgements: [row('b', true, 2000), row('a', false, 1000)],
    };
    render(<PermissionFencesSection />);
    const box = await screen.findByTestId('recent-acknowledgements');
    const items = box.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('sess-b');
    expect(items[0].textContent).toContain('"actor":7');
    expect(items[0].textContent).toContain('"owner":3');
    expect(items[0].textContent).toContain('permissionFences.committed');
    expect(items[1].textContent).toContain('permissionFences.notCommitted');
  });

  it('shows the empty note when available with no rows', async () => {
    extra = { recentAcknowledgementsAvailable: true, recentAcknowledgements: [] };
    render(<PermissionFencesSection />);
    expect(await screen.findByText('permissionFences.recentEmpty')).toBeTruthy();
  });

  it('says the log is unreliable when unavailable, without listing rows', async () => {
    extra = { recentAcknowledgementsAvailable: false, recentAcknowledgements: [] };
    render(<PermissionFencesSection />);
    expect(await screen.findByText('permissionFences.recentUnavailable')).toBeTruthy();
    expect(screen.queryByText('permissionFences.recentEmpty')).toBeNull();
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

describe('B-1076 fenceFilter (deep link from the outbox card)', () => {
  beforeEach(() => {
    calls = [];
    loadStatus = 200;
  });
  afterEach(() => cleanup());

  it('shows only the session fence matching an exact-match filter', async () => {
    fences = [sessionFence('sess-target'), sessionFence('sess-other'), generationFence()];
    render(<PermissionFencesSection fenceFilter="sess-target" />);
    await screen.findByText('permissionFences.filteredWarning');
    expect(screen.getByText('permissionFences.kindScoped {"scope":"sess-target"}')).toBeTruthy();
    expect(screen.queryByText('permissionFences.kindScoped {"scope":"sess-other"}')).toBeNull();
    expect(screen.queryByText(/permissionFences\.kindGeneration/u)).toBeNull();
  });

  it('"show all" clears the filter and restores every fence', async () => {
    fences = [sessionFence('sess-target'), generationFence()];
    render(<PermissionFencesSection fenceFilter="sess-target" />);
    fireEvent.click(await screen.findByText('permissionFences.showAll'));
    expect(screen.getByText('permissionFences.kindScoped {"scope":"sess-target"}')).toBeTruthy();
    expect(screen.getByText(/permissionFences\.kindGeneration/u)).toBeTruthy();
    expect(screen.queryByText('permissionFences.filteredWarning')).toBeNull();
  });

  it('B-1076: a new deep-link filter while mounted resets a prior "show all"', async () => {
    fences = [sessionFence('sess-a'), sessionFence('sess-b')];
    const { rerender } = render(<PermissionFencesSection fenceFilter="sess-a" />);
    fireEvent.click(await screen.findByText('permissionFences.showAll'));
    expect(screen.queryByText('permissionFences.filteredWarning')).toBeNull();

    // A second outbox card's deep link arrives for a DIFFERENT session while
    // this section is still mounted (no remount) — the stale "show all" must
    // not silently keep the owner looking at the wrong (unfiltered) list.
    rerender(<PermissionFencesSection fenceFilter="sess-b" />);
    await screen.findByText('permissionFences.filteredWarning');
    expect(screen.getByText('permissionFences.kindScoped {"scope":"sess-b"}')).toBeTruthy();
    expect(screen.queryByText('permissionFences.kindScoped {"scope":"sess-a"}')).toBeNull();
  });

  it.each([
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    'x'.repeat(10_000),
    '../../etc/passwd',
    'a b',
  ])('rejects a malicious or oversized filter and shows every fence: %j', async (poison) => {
    fences = [sessionFence('sess-target'), generationFence()];
    render(<PermissionFencesSection fenceFilter={poison} />);
    expect(await screen.findByText(/permissionFences\.kindGeneration/u)).toBeTruthy();
    expect(screen.queryByText('permissionFences.filteredWarning')).toBeNull();
    // The rejected value is never rendered raw, and no script tag is injected.
    expect(document.body.querySelector('script[src]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<script>alert');
  });

  it('an unmatched exact filter yields the empty state, not a silent unfiltered list', async () => {
    fences = [sessionFence('sess-other')];
    render(<PermissionFencesSection fenceFilter="sess-target" />);
    await screen.findByText('permissionFences.filteredWarning');
    expect(await screen.findByText('permissionFences.none')).toBeTruthy();
  });
});
