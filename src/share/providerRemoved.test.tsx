/**
 * ADR-229 S5: a share link of a conversation whose harness was removed answers
 * 410 `provider_removed` (on the live meta route and on the legacy snapshot
 * route). The viewer says so plainly instead of the generic "unavailable" copy,
 * and offers no retry.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickLocale } from './i18n';
import { classifyFailure } from './liveClient';
import { loadShare } from './loadShare';
import { ShareApp } from './ShareApp';

const AR = pickLocale('ar');
const EN = pickLocale('en');
const CREDS = { id: 'abcdefghij0123', token: 't'.repeat(43) };
const removed = () => new Response(JSON.stringify({ error: { code: 'provider_removed' } }),
  { status: 410, headers: { 'Content-Type': 'application/json' } });
const routed = (routes: Record<string, () => Response>) => vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  const route = routes[path] ?? routes['*'];
  return route ? route() : new Response('{}', { status: 404 });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('share link of a removed harness (ADR-229 S5)', () => {
  it('classifies 410 provider_removed apart from an ordinary ended link', async () => {
    expect(await classifyFailure(removed())).toEqual({ kind: 'provider-removed' });
    expect(await classifyFailure(new Response('{}', { status: 410 }))).toEqual({ kind: 'ended' });
  });

  it('the legacy snapshot route reports it too', async () => {
    expect(await loadShare(CREDS, 'https://example.test/', vi.fn().mockResolvedValue(removed())))
      .toEqual({ kind: 'provider-removed' });
  });

  it.each([['ar', AR], ['en', EN]] as const)('shows the removed-tool message in %s with no retry', async (lang, strings) => {
    vi.stubGlobal('fetch', routed({ '*': removed }));
    render(<ShareApp credentials={CREDS} language={lang} />);
    await waitFor(() => screen.getByRole('alert'));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(strings.providerRemovedTitle);
    expect(alert.textContent).toContain(strings.providerRemoved);
    expect(alert.textContent).not.toContain(strings.unavailable);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a removed snapshot behind a snapshot meta shows the same message', async () => {
    vi.stubGlobal('fetch', routed({
      [`/api/share-view/${CREDS.id}/meta`]: () => new Response(JSON.stringify({ v: 2, mode: 'snapshot' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }),
      '*': removed,
    }));
    render(<ShareApp credentials={CREDS} language="en" />);
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain(EN.providerRemoved);
  });
});
