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
  it('keeps toolCount and normalizes author and categories', () => {
    const data = parsed();
    expect(data.toolCount).toBe(3);
    expect(data.messages[0].author).toBe('owner');
    expect(data.messages[1].parts.map((p) => (p.t === 'redacted' ? p.cat : p.t))).toEqual(['text', 'secret', 'path', 'network', 'image', 'system']);
  });

  it('treats an unknown category as a generic redaction and a bad toolCount as zero', () => {
    const data = parseTranscript(snapshot({ toolCount: -2, messages: [{ role: 'assistant', parts: [{ t: 'redacted', cat: 'weird' }] }] }))!;
    expect(data.toolCount).toBe(0);
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

  it('localizes the default title, labels authors and shows the tool marker', () => {
    const out = html(parsed());
    expect(out).toContain('<h1>محادثة مشتركة</h1>');
    expect(out).toContain('صاحب المحادثة');
    expect(out).toContain('المساعد');
    expect(out).toContain('استُخدمت 3 أدوات');
    expect(out).toContain('نسخة للقراءة فقط');
    expect(out).toContain('Claude');
  });

  it.each([[1, 'استُخدمت أداة واحدة'], [2, 'استُخدمت أداتان'], [11, 'استُخدمت 11 أداة']])('tool marker for %i', (n, label) => {
    expect(html(parsed({ toolCount: n }))).toContain(label);
  });

  it('omits the tool marker when no tools were used, and shows expiry only when provided', () => {
    expect(html(parsed({ toolCount: 0 }))).not.toContain('استُخدمت');
    expect(html(parsed())).not.toContain('ينتهي الرابط');
    expect(html(parsed({ expiresAt: '2026-11-01T00:00:00.000Z' }))).toContain('ينتهي الرابط');
  });

  it('keeps a custom title and renders English when asked', () => {
    expect(displayTitle('خطتي', AR)).toBe('خطتي');
    const out = html(parsed(), EN);
    expect(out).toContain('<h1>Shared conversation</h1>');
    expect(out).toContain('3 tools used');
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
  it('returns the credentials and erases the token from the URL', () => {
    const replaceState = vi.fn();
    expect(readCredentials({ pathname: '/s/abcdefghij0123', hash: '#token=xyz' }, { replaceState })).toEqual({ id: 'abcdefghij0123', token: 'xyz' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/s/abcdefghij0123');
  });

  it.each([['/s/abcdefghij0123', ''], ['/s/abcdefghij0123', '#other=1'], ['/s/short', '#token=x'], ['/x', '#token=x']])('returns null for %s %s', (pathname, hash) => {
    expect(readCredentials({ pathname, hash }, { replaceState: vi.fn() })).toBeNull();
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

describe('ShareApp states', () => {
  it('shows loading, then the transcript', async () => {
    vi.stubGlobal('fetch', respond(200, snapshot()));
    render(<ShareApp credentials={CREDS} language="ar" />);
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('محادثة مشتركة'));
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('uses the same generic message for every 404 and never fetches without a token', async () => {
    const fetchMock = respond(404);
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ShareApp credentials={CREDS} language="ar" />);
    await waitFor(() => screen.getByText(AR.rateLimited));
    fireEvent.click(screen.getByRole('button', { name: AR.retry }));
    await waitFor(() => expect(screen.getAllByRole("article").length).toBe(2));
  });

  it('shows a network error with retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    render(<ShareApp credentials={CREDS} language="en-GB" />);
    await waitFor(() => screen.getByText(EN.network));
    expect(screen.getByRole('button', { name: EN.retry })).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
  });
});
