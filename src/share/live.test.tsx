import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pickLocale } from './i18n';
import { ShareApp } from './ShareApp';
import {
  CREDS, META, errorReply, installIntersectionObserver, cursor, msg, page, reply, scriptedFetch, setHidden,
} from './liveTestKit';

const AR = pickLocale('ar');
const EN = pickLocale('en');
let io: ReturnType<typeof installIntersectionObserver>;
const scrollTo = vi.fn();
const scrollBy = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  io = installIntersectionObserver();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollBy', scrollBy);
  setHidden(false);
});
afterEach(() => {
  cleanup();
  io.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  scrollTo.mockClear();
  scrollBy.mockClear();
});

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = async (script: Parameters<typeof scriptedFetch>[0], language = 'ar') => {
  const fetchMock = scriptedFetch({ '/meta': () => reply(200, META), ...script });
  vi.stubGlobal('fetch', fetchMock.fn);
  const view = render(<ShareApp credentials={CREDS} language={language} />);
  await flush();
  return { ...fetchMock, view };
};
const texts = () => screen.queryAllByRole('article').map((a) => a.textContent ?? '');

describe('live viewer: loading and requests', () => {
  it('sends GET with the token header only, loads the latest page and shows neutral labels', async () => {
    const { calls } = await mount({ '/messages': () => reply(200, page([msg(1), msg(2), msg(3, { author: 'member' })])) });
    expect(calls.map((c) => c.path)).toEqual(['/meta', '/messages']);
    for (const c of calls) {
      expect(c.headers.get('X-Share-Token')).toBe(CREDS.token);
      expect([...c.search.keys()]).toEqual([]);
    }
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Plan review');
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(labels).toEqual([AR.owner, AR.assistant, AR.member]);
    expect(screen.getByText(AR.live.badgeLive)).toBeTruthy();
  });

  it('shows no tool count or tool wording anywhere', async () => {
    await mount({ '/messages': () => reply(200, page([msg(1), msg(2)]), ) });
    expect(document.body.textContent).not.toMatch(/أدوات|أداة|tools? used/i);
  });
});

describe('live viewer: polling', () => {
  it('polls every 5 s with after, appends new messages and dedupes by k', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(1), msg(2)])),
        () => reply(200, page([msg(2), msg(3)])),
      ],
    });
    expect(texts()).toHaveLength(2);
    await flush(4999);
    expect(messageCalls()).toHaveLength(1);
    await flush(1);
    const second = messageCalls()[1];
    expect(second.search.get('after')).toBe(cursor(2));
    expect(texts()).toHaveLength(3);
    expect(texts().filter((t) => t.includes('message 2'))).toHaveLength(1);
  });

  it('keeps fetching immediately while moreAfter is true', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(1)])),
        () => reply(200, page([msg(2)], { moreAfter: true })),
        () => reply(200, page([msg(3)])),
      ],
    });
    await flush(5000);
    expect(messageCalls()).toHaveLength(3);
    expect(texts()).toHaveLength(3);
  });

  it('pauses while the tab is hidden and resumes with an immediate poll when visible', async () => {
    const { messageCalls } = await mount({ '/messages': () => reply(200, page([msg(1)])) });
    setHidden(true);
    await flush(30_000);
    expect(messageCalls()).toHaveLength(1);
    setHidden(false);
    await flush(0);
    expect(messageCalls()).toHaveLength(2);
  });

  it('raises the delay to the server retryAfterMs hint', async () => {
    const { messageCalls } = await mount({ '/messages': () => reply(200, page([msg(1)], { retryAfterMs: 12_000 })) });
    await flush(11_999);
    expect(messageCalls()).toHaveLength(1);
    await flush(1);
    expect(messageCalls()).toHaveLength(2);
  });

  it('shows the working indicator while running', async () => {
    await mount({ '/messages': () => reply(200, page([msg(1)], { running: true })) });
    expect(screen.getByText(AR.live.working)).toBeTruthy();
  });
});

describe('live viewer: failures', () => {
  it('CURSOR_STALE reloads from the tail and dedupes by k', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(1), msg(2)])),
        () => errorReply(409, 'CURSOR_STALE'),
        () => reply(200, page([msg(2), msg(3)])),
      ],
    });
    await flush(5000);
    const calls = messageCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].search.get('after')).toBe(cursor(2));
    expect([...calls[2].search.keys()]).toEqual([]);
    expect(texts()).toHaveLength(3);
    expect(texts().filter((t) => t.includes('message 2'))).toHaveLength(1);
    expect(screen.queryByText(AR.live.retrying)).toBeNull();
  });

  it('404 on a poll stops polling, keeps content and shows the ended state', async () => {
    const { messageCalls } = await mount({
      '/messages': [() => reply(200, page([msg(1)])), () => errorReply(404, 'SHARE_UNAVAILABLE')],
    });
    await flush(5000);
    expect(screen.getByText(AR.live.badgeEnded)).toBeTruthy();
    expect(screen.getByText(AR.live.endedTitle)).toBeTruthy();
    expect(texts()).toHaveLength(1);
    await flush(60_000);
    expect(messageCalls()).toHaveLength(2);
  });

  it('404 before anything loaded shows the uniform unavailable page', async () => {
    const { messageCalls } = await mount({ '/messages': () => errorReply(404, 'SHARE_UNAVAILABLE') });
    expect(screen.getByRole('alert').textContent).toContain(AR.unavailable);
    await flush(60_000);
    expect(messageCalls()).toHaveLength(1);
  });

  it('503 keeps the content, shows a notice and backs off exponentially', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(1)])),
        () => errorReply(503, 'HISTORY_UNAVAILABLE', { retryAfterMs: 3000 }, { 'Retry-After': '3' }),
        () => errorReply(503, 'HISTORY_UNAVAILABLE', { retryAfterMs: 3000 }, { 'Retry-After': '3' }),
        () => reply(200, page([msg(1), msg(2)])),
      ],
    });
    await flush(5000);
    expect(messageCalls()).toHaveLength(2);
    expect(screen.getByText(AR.live.retrying, { exact: false })).toBeTruthy();
    expect(texts()).toHaveLength(1);
    await flush(2999);
    expect(messageCalls()).toHaveLength(2);
    await flush(1);
    expect(messageCalls()).toHaveLength(3);
    await flush(5999);
    expect(messageCalls()).toHaveLength(3);
    await flush(1);
    expect(messageCalls()).toHaveLength(4);
    expect(texts()).toHaveLength(2);
    expect(screen.queryByText(AR.live.retrying, { exact: false })).toBeNull();
  });

  it('429 waits for Retry-After seconds and keeps the content', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(1)])),
        () => errorReply(429, 'RATE_LIMITED', {}, { 'Retry-After': '40' }),
        () => reply(200, page([msg(1), msg(2)])),
      ],
    });
    await flush(5000);
    expect(screen.getByText(AR.live.rateLimitedNotice, { exact: false })).toBeTruthy();
    await flush(39_999);
    expect(messageCalls()).toHaveLength(2);
    await flush(1);
    expect(messageCalls()).toHaveLength(3);
    expect(texts()).toHaveLength(2);
  });

  it('a maintenance 409 is transient, not terminal', async () => {
    const { messageCalls } = await mount({
      '/messages': [() => reply(200, page([msg(1)])), () => errorReply(409, 'MAINTENANCE'), () => reply(200, page([msg(1), msg(2)]))],
    });
    await flush(5000);
    expect(screen.queryByText(AR.live.badgeEnded)).toBeNull();
    await flush(5000);
    expect(messageCalls()).toHaveLength(3);
    expect(texts()).toHaveLength(2);
  });
});

describe('live viewer: paging up', () => {
  it('loads older pages when the top sentinel is reached and prepends without duplicates', async () => {
    const { messageCalls } = await mount({
      '/messages': [
        () => reply(200, page([msg(3), msg(4)], { moreBefore: true })),
        () => reply(200, page([msg(1), msg(2), msg(3)], { moreBefore: false })),
        () => reply(200, page([])),
      ],
    });
    await act(async () => { io.fire('live-older', true); });
    await flush(0);
    const older = messageCalls()[1];
    expect(older.search.get('before')).toBe(cursor(3));
    expect(texts().map((t) => /message (\d)/.exec(t)![1])).toEqual(['1', '2', '3', '4']);
    expect(document.querySelector('.live-older')).toBeNull();
    expect(scrollBy).toHaveBeenCalled();
  });

  it('shows a retry control when an older page fails and keeps the loaded content', async () => {
    await mount({
      '/messages': [
        () => reply(200, page([msg(3)], { moreBefore: true })),
        () => errorReply(503, 'HISTORY_UNAVAILABLE', { retryAfterMs: 2000 }),
        () => reply(200, page([msg(2)])),
        () => reply(200, page([])),
      ],
    });
    await act(async () => { io.fire('live-older', true); });
    await flush(0);
    expect(screen.getByText(AR.live.olderFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: AR.live.loadOlder }));
    await flush(0);
    expect(texts()).toHaveLength(2);
  });
});

describe('live viewer: new messages pill', () => {
  it('does not jump when the reader is scrolled up and offers a pill instead', async () => {
    await mount({
      '/messages': [() => reply(200, page([msg(1), msg(2)])), () => reply(200, page([msg(3), msg(4)]))],
    }, 'en');
    scrollTo.mockClear();
    await act(async () => { io.fire('live-bottom', false); });
    await flush(5000);
    expect(texts()).toHaveLength(4);
    expect(scrollTo).not.toHaveBeenCalled();
    const pill = screen.getByRole('button', { name: EN.live.newMessages(2) });
    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: EN.live.newMessages(2) })).toBeNull();
  });

  it('follows the tail without a pill when the reader is at the bottom', async () => {
    await mount({
      '/messages': [() => reply(200, page([msg(1)])), () => reply(200, page([msg(2)]))],
    }, 'en');
    await act(async () => { io.fire('live-bottom', true); });
    scrollTo.mockClear();
    await flush(5000);
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.queryByText(/new message/)).toBeNull();
  });
});

describe('live viewer: direction and locale', () => {
  it('uses RTL for Arabic and LTR for English with one direction per message body', async () => {
    await mount({ '/messages': () => reply(200, page([msg(1, { parts: [{ t: 'text', text: 'مرحبا' }] }), msg(2)])) });
    expect(document.documentElement.dir).toBe('rtl');
    const bodies = [...document.querySelectorAll('.share-body')].map((b) => b.getAttribute('dir'));
    expect(bodies).toEqual(['rtl', 'ltr']);
    cleanup();
    await mount({ '/messages': () => reply(200, page([msg(1)])) }, 'en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('renders truncated and secret redactions as chips', async () => {
    await mount({ '/messages': () => reply(200, page([msg(2, { parts: [{ t: 'text', text: 'x' }, { t: 'redacted', cat: 'truncated' }, { t: 'redacted', cat: 'secret' }] })])) });
    expect(screen.getByText(AR.redaction.truncated)).toBeTruthy();
    expect(screen.getByText(AR.redaction.secret)).toBeTruthy();
  });
});
