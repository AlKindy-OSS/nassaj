/**
 * T-2095: the "Turn changes" git-panel tab, against mocked route responses and
 * a real i18next instance (Arabic primary, English fallback).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/api', () => ({ authenticatedFetch }));

import commonAr from '../../../../i18n/locales/ar/common.json';
import commonEn from '../../../../i18n/locales/en/common.json';
import { rememberSessionWorkspaceGeneration } from '../../../../utils/sessionWorkspaceBinding';
import GitViewTabs from '../GitViewTabs';

import TurnChangesView from './TurnChangesView';

function i18nFor(lng: 'ar' | 'en') {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng, fallbackLng: 'en',
    resources: { ar: { common: commonAr }, en: { common: commonEn } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TURN_3 = {
  turnSeq: 3, status: 'complete', provider: 'claude', startedAt: '2026-11-18T00:00:00.000Z',
  completedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  counts: { added: 1, modified: 1, deleted: 0, withheld: 2 },
  files: [
    { path: 'src/app.ts', status: 'M' },
    { path: 'logo.png', status: 'A' },
    { path: 'config/.env', status: 'withheld', reason: 'secret_content' },
    { path: 'big.bin', status: 'withheld', reason: 'too_large', size: 9_000_000, phase: 'pre' },
  ],
  filesTruncated: true,
};
const TURN_2 = {
  turnSeq: 2, status: 'running', provider: 'codex', startedAt: null, completedAt: null,
  counts: { added: 0, modified: 0, deleted: 0, withheld: 0 }, files: [], filesTruncated: false,
};

type Route = (url: URL) => Response | undefined;
function serve(route: Route) {
  authenticatedFetch.mockImplementation(async (raw: string) => {
    const url = new URL(raw, 'https://nassaj.test');
    return route(url) ?? json({ error: 'Turn checkpoints not found' }, 404);
  });
}

function renderView(lng: 'ar' | 'en' = 'en', focusTurnSeq: number | null = null) {
  return render(
    <I18nextProvider i18n={i18nFor(lng)}>
      <TurnChangesView projectId="p-1" sessionId="session-1" focusTurnSeq={focusTurnSeq} isMobile={false} wrapText />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  authenticatedFetch.mockReset();
  rememberSessionWorkspaceGeneration('session-1', 'gen-1');
});
afterEach(cleanup);

describe('TurnChangesView', () => {
  it('lists turns newest first with provider, relative time, counts and a muted running label', async () => {
    serve((url) => (url.pathname.endsWith('/turn-checkpoints') ? json({ turns: [TURN_3, TURN_2], nextBefore: null }) : undefined));
    renderView();
    const rows = await screen.findAllByRole('button', { name: /Turn \d/ });
    expect(rows.map((row) => row.textContent?.match(/Turn \d/)?.[0])).toEqual(['Turn 3', 'Turn 2']);
    expect(rows[0].textContent).toContain('claude');
    expect(rows[0].textContent).toContain('5 minutes ago');
    expect(rows[0].getAttribute('aria-expanded')).toBe('false');
    expect(rows[1].textContent).toContain('Running');
  });

  it('expands a turn into file rows; withheld rows carry a lock, a label and the reason', async () => {
    serve((url) => (url.pathname.endsWith('/turn-checkpoints') ? json({ turns: [TURN_3], nextBefore: null }) : undefined));
    renderView();
    const row = await screen.findByRole('button', { name: /Turn 3/ });
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('src/app.ts').tagName).toBe('BDI');
    expect(screen.getByText('Secret content')).toBeTruthy();
    expect(screen.getAllByText(/Withheld, not captured/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Withheld before the turn/)).toBeTruthy();
    expect(screen.getByText(/Too large/)).toBeTruthy();
    expect(document.querySelector('[data-withheld-lock]')).toBeTruthy();
    expect(screen.getByText('Showing the first 500 files only')).toBeTruthy();
    // withheld paths are not diff buttons, never shown as unchanged
    expect(screen.queryByRole('button', { name: /config\/\.env/ })).toBeNull();
  });

  it('opens a file diff, with the truncation notice and the binary marker', async () => {
    serve((url) => {
      if (url.pathname.endsWith('/turn-checkpoints')) return json({ turns: [TURN_3], nextBefore: null });
      if (url.searchParams.get('path') === 'src/app.ts') return json({ path: 'src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b', truncated: true });
      if (url.searchParams.get('path') === 'logo.png') return json({ path: 'logo.png', diff: 'Binary files /dev/null and b/logo.png differ', truncated: false });
      return undefined;
    });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: /Turn 3/ }));
    const fileButton = screen.getByRole('button', { name: /src\/app\.ts/ });
    fireEvent.click(fileButton);
    expect(fileButton.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('+b')).toBeTruthy();
    expect(screen.getByText(/Large diff preview/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /logo\.png/ }));
    expect(await screen.findByText('Binary file')).toBeTruthy();
  });

  it('expands the turn the chip asked for', async () => {
    serve((url) => (url.pathname.endsWith('/turn-checkpoints') ? json({ turns: [TURN_3, TURN_2], nextBefore: null }) : undefined));
    renderView('en', 3);
    await waitFor(() => expect(screen.getByRole('button', { name: /Turn 3/ }).getAttribute('aria-expanded')).toBe('true'));
  });

  it('pages older turns through "Load older turns"', async () => {
    serve((url) => {
      if (!url.pathname.endsWith('/turn-checkpoints')) return undefined;
      return url.searchParams.get('before') === '3'
        ? json({ turns: [TURN_2], nextBefore: null })
        : json({ turns: [TURN_3], nextBefore: 3 });
    });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older turns' }));
    expect(await screen.findByRole('button', { name: /Turn 2/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older turns' })).toBeNull();
  });

  it('shows the empty block when no turn was recorded', async () => {
    serve((url) => (url.pathname.endsWith('/turn-checkpoints') ? json({ turns: [], nextBefore: null }) : undefined));
    renderView();
    expect(await screen.findByText('No recorded turns yet')).toBeTruthy();
  });

  it('shows one neutral message on 404, with no reason', async () => {
    serve(() => undefined);
    renderView();
    expect(await screen.findByText('Changes are not available for this conversation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers retry on a server error', async () => {
    let fail = true;
    serve((url) => {
      if (!url.pathname.endsWith('/turn-checkpoints')) return undefined;
      return fail ? json({ error: 'Turn checkpoints are unavailable' }, 500) : json({ turns: [TURN_3], nextBefore: null });
    });
    renderView();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: /Turn 3/ })).toBeTruthy();
  });

  it('renders Arabic labels', async () => {
    serve((url) => (url.pathname.endsWith('/turn-checkpoints') ? json({ turns: [TURN_3], nextBefore: null }) : undefined));
    renderView('ar');
    const row = await screen.findByRole('button', { name: /الدور 3/ });
    fireEvent.click(row);
    expect(screen.getByText('محتوى سرّي')).toBeTruthy();
    expect(screen.getByText(/محجوب قبل الدور/)).toBeTruthy();
  });
});

describe('GitViewTabs', () => {
  it('adds a fourth "Turn changes" tab', () => {
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <GitViewTabs activeView="changes" isHidden={false} changeCount={0} onChange={onChange} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Turn changes/ }));
    expect(onChange).toHaveBeenCalledWith('turns');
  });
});
