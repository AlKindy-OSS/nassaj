import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentStore } from './attachmentStore';
import { classifyFailure, createLiveClient } from './liveClient';
import { mergeNewer, mergeOlder, reconcileTail } from './liveMerge';
import { pickLocale } from './i18n';
import { ShareApp } from './ShareApp';
import { CREDS, META, errorReply, installIntersectionObserver, msg, page, reply, scriptedFetch, setHidden } from './liveTestKit';
import { isCursor, parseLivePage, parseMeta, type LiveMessage } from './types';

const AR = pickLocale('ar');

describe('parsers', () => {
  it('accepts the cursor shape only', () => {
    expect(isCursor(`${'a'.repeat(22)}.${'B-_'.repeat(7)}x`)).toBe(true);
    for (const bad of ['', 'a.b', `${'a'.repeat(22)}${'b'.repeat(22)}`, `${'a'.repeat(22)}.${'b'.repeat(21)}!`, 5]) expect(isCursor(bad)).toBe(false);
  });

  it('drops unknown parts, rejects a message with a bad cursor and clamps retryAfterMs', () => {
    const ok = parseLivePage(page([msg(1, { parts: [{ t: 'text', text: 'a' }, { t: 'tool', name: 'x' }, { t: 'attachment-unavailable', kind: 'file' }] })], { retryAfterMs: 9_999_999 }));
    expect(ok?.messages[0].parts.map((p) => p.t)).toEqual(['text', 'attachment-unavailable']);
    expect(ok?.retryAfterMs).toBe(60_000);
    expect(parseLivePage(page([msg(1, { c: 'bad' })]))).toBeNull();
    expect(parseLivePage({ v: 1 })).toBeNull();
  });

  it('parses meta for both modes and rejects the unknown', () => {
    expect(parseMeta(META)).toMatchObject({ mode: 'live', meta: { title: 'Plan review' } });
    expect(parseMeta({ v: 2, mode: 'snapshot' })).toEqual({ mode: 'snapshot' });
    expect(parseMeta({ v: 2, mode: 'x' })).toBeNull();
    expect(parseMeta({ v: 1 })).toBeNull();
  });
});

describe('merge by k', () => {
  const m = (n: number) => msg(n) as unknown as LiveMessage;
  it('mergeNewer appends only unseen, mergeOlder prepends only unseen', () => {
    expect(mergeNewer([m(1), m(2)], [m(2), m(3)]).map((x) => x.k)).toEqual([m(1).k, m(2).k, m(3).k]);
    expect(mergeOlder([m(3), m(4)], [m(1), m(2), m(3)]).map((x) => x.k)).toEqual([m(1).k, m(2).k, m(3).k, m(4).k]);
    const same = [m(1)];
    expect(mergeNewer(same, [m(1)])).toBe(same);
  });

  it('reconcileTail keeps older held messages that precede the overlap, else replaces', () => {
    expect(reconcileTail([m(1), m(2), m(3)], [m(3), m(4)]).map((x) => x.k)).toEqual([m(1).k, m(2).k, m(3).k, m(4).k]);
    expect(reconcileTail([m(1), m(2)], [m(8), m(9)]).map((x) => x.k)).toEqual([m(8).k, m(9).k]);
    expect(reconcileTail([m(1)], [])).toEqual([]);
  });
});

describe('failure classification', () => {
  it.each([
    [404, 'SHARE_UNAVAILABLE', {}, 'ended'],
    [404, 'ATTACHMENT_GONE', {}, 'attachment-gone'],
    [404, undefined, {}, 'ended'],
    [413, 'ATTACHMENT_TOO_LARGE', {}, 'attachment-too-large'],
    [409, 'CURSOR_STALE', {}, 'cursor-stale'],
    [409, 'MAINTENANCE', {}, 'temporary'],
    [401, undefined, {}, 'ended'],
    [500, undefined, {}, 'temporary'],
  ])('%i %s -> %s', async (status, code, headers, kind) => {
    const res = code ? errorReply(status, code as string, {}, headers) : new Response('', { status });
    expect((await classifyFailure(res)).kind).toBe(kind);
  });

  it('429 uses Retry-After seconds, 503 uses retryAfterMs from the body', async () => {
    expect(await classifyFailure(errorReply(429, 'RATE_LIMITED', {}, { 'Retry-After': '17' }))).toEqual({ kind: 'rate-limited', retryAfterMs: 17_000 });
    expect(await classifyFailure(errorReply(503, 'HISTORY_UNAVAILABLE', { retryAfterMs: 8000 }))).toEqual({ kind: 'temporary', retryAfterMs: 8000 });
  });

  it('client builds the exact query shapes and never throws', async () => {
    const { fn, calls } = scriptedFetch({ '*': () => reply(200, page([])) });
    const client = createLiveClient(CREDS, 'https://n.example/s/x', fn);
    await client.messages({});
    await client.messages({ before: 'B' });
    await client.messages({ after: 'A' });
    expect(calls.map((c) => c.search.toString())).toEqual(['', 'before=B', 'after=A']);
    const failing = createLiveClient(CREDS, 'https://n.example/', vi.fn().mockRejectedValue(new TypeError('x')));
    expect(await failing.meta()).toMatchObject({ ok: false, failure: { kind: 'temporary' } });
  });
});

describe('AttachmentStore', () => {
  let created: string[];
  let revoked: string[];
  beforeEach(() => {
    created = []; revoked = [];
    let n = 0;
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: () => { const u = `blob:test/${n++}`; created.push(u); return u; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const png = () => ({ ok: true as const, value: { blob: new Blob(['x']), type: 'image/png' } });

  it('runs at most two fetches at once', async () => {
    let active = 0; let peak = 0;
    const release: Array<() => void> = [];
    const client = {
      meta: vi.fn(), messages: vi.fn(),
      attachment: vi.fn(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise<void>((resolve) => { release.push(resolve); });
        active -= 1;
        return png();
      }),
    };
    const store = new AttachmentStore(client);
    const all = ['a', 'b', 'c', 'd', 'e'].map((r) => store.load(r, 'image'));
    await Promise.resolve();
    await vi.waitFor(() => expect(client.attachment).toHaveBeenCalledTimes(2));
    while (release.length || active) { release.shift()?.(); await new Promise((r) => setTimeout(r, 0)); }
    expect((await Promise.all(all)).every((r) => r.status === 'ok')).toBe(true);
    expect(peak).toBe(2);
  });

  it('honours Retry-After before retrying and gives up with a failed marker', async () => {
    const sleeps: number[] = [];
    const client = {
      meta: vi.fn(), messages: vi.fn(),
      attachment: vi.fn()
        .mockResolvedValueOnce({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 7000 } })
        .mockResolvedValueOnce(png()),
    };
    const store = new AttachmentStore(client, async (ms) => { sleeps.push(ms); });
    expect((await store.load('a', 'image')).status).toBe('ok');
    expect(sleeps).toEqual([7000]);
    const failing = { ...client, attachment: vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'temporary', retryAfterMs: 1000 } }) };
    expect((await new AttachmentStore(failing, async () => {}).load('z', 'image')).status).toBe('failed');
    expect(failing.attachment).toHaveBeenCalledTimes(3);
  });

  it('maps gone and too-large, refuses non-raster images, revokes every URL on dispose', async () => {
    const outcomes: Record<string, unknown> = {
      gone: { ok: false, failure: { kind: 'attachment-gone' } },
      big: { ok: false, failure: { kind: 'attachment-too-large' } },
      svg: { ok: true, value: { blob: new Blob(['<svg/>']), type: 'image/svg+xml' } },
      ok: png(),
    };
    const client = { meta: vi.fn(), messages: vi.fn(), attachment: vi.fn(async (ref: string) => outcomes[ref]) } as never;
    const store = new AttachmentStore(client);
    expect((await store.load('gone', 'image')).status).toBe('gone');
    expect((await store.load('big', 'image')).status).toBe('too-large');
    expect((await store.load('svg', 'image')).status).toBe('failed');
    expect((await store.load('ok', 'image')).status).toBe('ok');
    expect(created).toHaveLength(1);
    store.dispose();
    expect(revoked).toEqual(created);
  });
});

describe('attachments in the viewer', () => {
  let io: ReturnType<typeof installIntersectionObserver>;
  let created: string[]; let revoked: string[];
  beforeEach(() => {
    created = []; revoked = [];
    io = installIntersectionObserver();
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: () => { const u = `blob:test/${created.length}`; created.push(u); return u; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    }));
    setHidden(false);
  });
  afterEach(() => { cleanup(); io.reset(); vi.unstubAllGlobals(); });

  const mount = async (script: Parameters<typeof scriptedFetch>[0]) => {
    const f = scriptedFetch({ '/meta': () => reply(200, META), ...script });
    vi.stubGlobal('fetch', f.fn);
    const view = render(<ShareApp credentials={CREDS} language="ar" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return { ...f, view };
  };
  const ref = (n: number) => `${'a'.repeat(22)}.${n}.${'b'.repeat(32)}`;

  it('renders an image from a blob: URL with the token header, and revokes it on unmount', async () => {
    const { calls, view } = await mount({
      '/messages': () => reply(200, page([msg(1, { parts: [{ t: 'text', text: 'see' }, { t: 'image', ref: ref(0) }] })])),
      [`/attachments/${ref(0)}`]: () => new Response(new Blob(['png-bytes']), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const img = document.querySelector('img.share-attachment-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:test/0');
    const attach = calls.find((c) => c.path.startsWith('/attachments/'))!;
    expect(attach.headers.get('X-Share-Token')).toBe(CREDS.token);
    view.unmount();
    expect(revoked).toEqual(['blob:test/0']);
  });

  it('shows per-attachment markers for 404 ATTACHMENT_GONE and 413, plus unavailable parts', async () => {
    await mount({
      '/messages': () => reply(200, page([msg(1, { parts: [
        { t: 'image', ref: ref(0) }, { t: 'image', ref: ref(1) },
        { t: 'attachment-unavailable', kind: 'file' }, { t: 'attachment-unavailable', kind: 'image' },
      ] })])),
      [`/attachments/${ref(0)}`]: () => errorReply(404, 'ATTACHMENT_GONE'),
      [`/attachments/${ref(1)}`]: () => errorReply(413, 'ATTACHMENT_TOO_LARGE'),
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByText(AR.attachment.gone)).toBeTruthy();
    expect(screen.getByText(AR.attachment.tooLarge)).toBeTruthy();
    expect(screen.getByText(AR.attachment.unavailableFile)).toBeTruthy();
    expect(screen.getByText(AR.attachment.unavailableImage)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('downloads a file only when asked, through a blob: URL', async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    const { calls } = await mount({
      '/messages': () => reply(200, page([msg(1, { parts: [{ t: 'file', ref: ref(0), name: 'report.txt' }] })])),
      [`/attachments/${ref(0)}`]: () => new Response('data', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
    });
    expect(calls.some((c) => c.path.startsWith('/attachments/'))).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /report\.txt/ })); await new Promise((r) => setTimeout(r, 20)); });
    expect(clicked).toEqual([{ href: 'blob:test/0', download: 'report.txt' }]);
    spy.mockRestore();
  });
});
