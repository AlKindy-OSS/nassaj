import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { displayTitle, pickLocale } from './i18n';
import { loadShare, readCredentials } from './loadShare';
import { ShareApp } from './ShareApp';
import { ShareTranscript } from './ShareTranscript';
import { parseTranscript, type ShareTranscriptData } from './types';

const AR = pickLocale('ar-SA');
const EN = pickLocale('en-US');
const CREDS = { id: 'abcdefghij0123', token: 't'.repeat(43) };

const snapshot = (over: Record<string, unknown> = {}) => ({
  v: 1, title: 'Shared conversation', createdAt: '2026-10-01T10:00:00.000Z', providerLabel: 'Claude', toolCount: 3,
  messages: [
    { role: 'user', author: 'owner', at: '2026-10-01T10:00:00.000Z', parts: [{ t: 'text', text: 'مرحبا **بك**' }] },
    { role: 'assistant', author: 'assistant', parts: [
      { t: 'text', text: 'Answer' },
      { t: 'redacted', cat: 'secret' },
      { t: 'redacted', cat: 'path', text: '<project>/src/app.ts' },
      { t: 'redacted', cat: 'network' },
      { t: 'redacted', cat: 'image' },
      { t: 'redacted', cat: 'system' },
    ] },
  ],
  ...over,
});
const parsed = (over?: Record<string, unknown>): ShareTranscriptData => parseTranscript(snapshot(over))!;
const html = (data: ShareTranscriptData, strings = AR) => renderToStaticMarkup(<ShareTranscript transcript={data} strings={strings} />);
const respond = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('parseTranscript (real v1 shape)', () => {
  it('ignores any toolCount sent by the server and normalizes author and categories', () => {
    const data = parsed();
    expect('toolCount' in data).toBe(false);
    expect(data.messages[0].author).toBe('owner');
    expect(data.messages[1].parts.map((p) => (p.t === 'redacted' ? p.cat : p.t))).toEqual(['text', 'secret', 'path', 'network', 'image', 'system']);
  });

  it('treats an unknown category as a generic redaction', () => {
    const data = parseTranscript(snapshot({ messages: [{ role: 'assistant', parts: [{ t: 'redacted', cat: 'weird' }] }] }))!;
    expect(data.messages[0].parts[0]).toEqual({ t: 'redacted', cat: undefined, text: undefined });
    expect(data.messages[0].author).toBe('assistant');
  });

  it('rejects the legacy system role', () => {
    expect(parseTranscript(snapshot({ messages: [{ role: 'system', parts: [] }] }))).toBeNull();
  });
});

describe('transcript rendering', () => {
  it('renders every redaction category as its own chip', () => {
    const out = html(parsed());
    for (const cat of ['secret', 'path', 'network', 'image', 'system']) expect(out).toContain(`data-cat="${cat}"`);
    expect(out).toContain('صورة محذوفة');
    expect(out).toContain('محتوى نظامي محذوف');
    expect(out).toContain('محتوى سرّي محذوف');
    expect(out).toContain('عنوان شبكة محذوف');
  });

  it('shows the path label text, isolated as LTR', () => {
    const out = html(parsed());
    expect(out).toContain('<bdi dir="ltr">&lt;project&gt;/src/app.ts</bdi>');
    expect(out).toContain('مسار محذوف: ');
  });

  it('falls back to the generic chip for an unknown category', () => {
    const data = parseTranscript(snapshot({ messages: [{ role: 'assistant', parts: [{ t: 'redacted' }] }] }))!;
    expect(html(data)).toContain('data-cat="generic"');
    expect(html(data)).toContain('محتوى محذوف');
  });

  it('localizes the default title and labels authors', () => {
    const out = html(parsed());
    expect(out).toContain('<h1>محادثة مشتركة</h1>');
    expect(out).toContain('المالك');
    expect(out).toContain('المساعد');
    expect(out).toContain('نسخة للقراءة فقط');
    expect(out).toContain('Claude');
  });

  it('never mentions tools, whatever toolCount the server sends', () => {
    const out = html(parsed({ toolCount: 7 }));
    expect(out).not.toContain('استُخدمت');
    expect(out).not.toMatch(/tool/i);
    expect(html(parsed({ toolCount: 7 }), EN)).not.toMatch(/tools? used/i);
  });

  it('shows expiry only when provided', () => {
    expect(html(parsed())).not.toContain('ينتهي الرابط');
    expect(html(parsed({ expiresAt: '2026-11-01T00:00:00.000Z' }))).toContain('ينتهي الرابط');
  });

  it('keeps a custom title and renders English when asked', () => {
    expect(displayTitle('خطتي', AR)).toBe('خطتي');
    const out = html(parsed(), EN);
    expect(out).toContain('<h1>Shared conversation</h1>');
    expect(out).toContain('Image removed');
  });

  it('sets one direction per message from its first strong character', () => {
    const out = html(parsed());
    expect(out.match(/class="share-body" dir="(rtl|ltr)"/g)).toEqual(['class="share-body" dir="rtl"', 'class="share-body" dir="ltr"']);
  });

  it('has landmarks and a heading order of h1, h2, h3', () => {
    const out = html(parsed());
    expect(out).toMatch(/<main[^>]*>/);
    expect(out.indexOf('<h1')).toBeLessThan(out.indexOf('<h2'));
    expect(out.indexOf('<h2')).toBeLessThan(out.indexOf('<h3'));
  });

  it('still renders no raw HTML or images from message text', () => {
    const data = parseTranscript(snapshot({ messages: [{ role: 'assistant', parts: [{ t: 'text', text: '<script>x</script>![a](http://e/x.png)' }] }] }))!;
    const out = html(data);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
  });
});

describe('readCredentials', () => {
  it('returns the credentials from the fragment and does not touch the URL', () => {
    expect(readCredentials({ pathname: '/s/abcdefghij0123', hash: '#token=xyz' })).toEqual({ id: 'abcdefghij0123', token: 'xyz' });
  });

  it.each([['/s/abcdefghij0123', ''], ['/s/abcdefghij0123', '#other=1'], ['/s/short', '#token=x'], ['/x', '#token=x']])('returns null for %s %s', (pathname, hash) => {
    expect(readCredentials({ pathname, hash })).toBeNull();
  });
});

describe('loadShare', () => {
  it('sends the token only as a header, without credentials or referrer', async () => {
    const fetchImpl = respond(200, snapshot());
    const result = await loadShare(CREDS, 'https://n.example/s/x', fetchImpl);
    expect(result.kind).toBe('ready');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://n.example/api/session-shares/abcdefghij0123');
    expect(init).toMatchObject({ headers: { 'X-Share-Token': CREDS.token }, credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it.each([[404, 'unavailable'], [403, 'unavailable'], [429, 'rate-limited'], [500, 'network'], [503, 'network']])('maps %i to %s', async (status, kind) => {
    expect((await loadShare(CREDS, 'https://n.example/', respond(status))).kind).toBe(kind);
  });

  it('maps a thrown fetch to network and a malformed body to unavailable', async () => {
    expect((await loadShare(CREDS, 'https://n.example/', vi.fn().mockRejectedValue(new TypeError('x')))).kind).toBe('network');
    expect((await loadShare(CREDS, 'https://n.example/', respond(200, { v: 9 }))).kind).toBe('unavailable');
    expect((await loadShare(CREDS, 'https://n.example/', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })))).kind).toBe('unavailable');
  });
});

const META_SNAPSHOT = { v: 2, mode: 'snapshot' };
const routed = (routes: Record<string, () => Response>) => vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  const route = routes[path] ?? routes['*'];
  return route ? route() : new Response('{}', { status: 404 });
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const legacyRoutes = (over: Record<string, () => Response> = {}) => ({
  [`/api/share-view/${CREDS.id}/meta`]: json(200, META_SNAPSHOT),
  [`/api/session-shares/${CREDS.id}`]: json(200, snapshot()),
  ...over,
});

describe('ShareApp states (legacy v1 fallback through meta)', () => {
  it('shows loading, then the v1 snapshot when meta says snapshot', async () => {
    const fetchMock = routed(legacyRoutes());
    vi.stubGlobal('fetch', fetchMock);
    render(<ShareApp credentials={CREDS} language="ar" />);
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('محادثة مشتركة'));
    expect(screen.getAllByRole('article').length).toBe(2);
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual([`/api/share-view/${CREDS.id}/meta`, `/api/session-shares/${CREDS.id}`]);
  });

  it('uses the same generic message for every 404 and never fetches without a token', async () => {
    const fetchMock = routed({ '*': json(404, { error: { code: 'SHARE_UNAVAILABLE' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<ShareApp credentials={CREDS} language="ar" />);
    await waitFor(() => screen.getByRole('alert'));
    const message = screen.getByRole('alert').textContent;
    expect(message).toContain(AR.unavailable);
    first.unmount();
    fetchMock.mockClear();
    render(<ShareApp credentials={null} language="ar" />);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers retry on rate limit and recovers', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', routed(legacyRoutes({
      [`/api/share-view/${CREDS.id}/meta`]: () => (++calls === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })
        : new Response(JSON.stringify(META_SNAPSHOT), { status: 200 })),
    })));
    render(<ShareApp credentials={CREDS} language="ar" />);
    await waitFor(() => screen.getByText(AR.rateLimited));
    fireEvent.click(screen.getByRole('button', { name: AR.retry }));
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(2));
  });

  it('shows a network error with retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    render(<ShareApp credentials={CREDS} language="en-GB" />);
    await waitFor(() => screen.getByText(EN.network));
    expect(screen.getByRole('button', { name: EN.retry })).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
  });
});
