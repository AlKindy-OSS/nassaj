import { vi } from 'vitest';

export const CREDS = { id: 'abcdefghij0123', token: 't'.repeat(43) };
export const BASE = `/api/share-view/${CREDS.id}`;
const pad = (s: string) => (s + 'A'.repeat(22)).slice(0, 22);
export const key = (n: number) => pad(`k${n}`);
export const cursor = (n: number) => `${key(n)}.${pad(`m${n}`)}`;
export const REVISION = 'r'.repeat(43);

export type Part = Record<string, unknown>;
export const msg = (n: number, over: Record<string, unknown> = {}) => ({
  k: key(n), c: cursor(n), role: n % 2 ? 'user' : 'assistant', author: n % 2 ? 'owner' : 'assistant',
  at: '2026-10-13T10:00:00.000Z', parts: [{ t: 'text', text: `message ${n}` }], ...over,
});
export const page = (messages: unknown[], over: Record<string, unknown> = {}) => ({
  v: 2, revision: REVISION, running: false, stale: false, moreBefore: false, moreAfter: false,
  retryAfterMs: 5000, messages, ...over,
});
export const META = { v: 2, mode: 'live', title: 'Plan review', providerLabel: 'Claude', expiresAt: '2026-10-20T00:00:00.000Z' };

export const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export const errorReply = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  reply(status, { error: { code, ...extra } }, headers);

export interface Call { path: string; search: URLSearchParams; headers: Headers }

/** Scripted fetch: handlers are looked up by path suffix; each may be a queue of responses. */
export function scriptedFetch(script: Record<string, Array<() => Response> | (() => Response)>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://n.example');
    const suffix = url.pathname.slice(BASE.length);
    calls.push({ path: suffix, search: url.searchParams, headers: new Headers(init?.headers) });
    const queue = queues.get(suffix) ?? queues.get('*');
    if (!queue) return errorReply(404, 'SHARE_UNAVAILABLE');
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next();
  });
  return { fn, calls, messageCalls: () => calls.filter((c) => c.path === '/messages') };
}

type Observer = { cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void; els: Set<Element> };
const observers = new Set<Observer>();

/** IntersectionObserver double: lazy attachment placeholders intersect at once, the rest on demand. */
export function installIntersectionObserver() {
  class MockIO {
    private readonly o: Observer;
    constructor(cb: Observer['cb']) { this.o = { cb, els: new Set() }; observers.add(this.o); }
    observe(el: Element) {
      this.o.els.add(el);
      if (el.classList.contains('share-attachment-pending')) {
        queueMicrotask(() => this.o.cb([{ isIntersecting: true, target: el }]));
      }
    }
    disconnect() { observers.delete(this.o); }
    unobserve() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', MockIO);
  return {
    fire(className: string, isIntersecting: boolean) {
      for (const o of [...observers]) {
        for (const el of o.els) if (el.classList.contains(className)) o.cb([{ isIntersecting, target: el }]);
      }
    },
    reset() { observers.clear(); },
  };
}

export function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
