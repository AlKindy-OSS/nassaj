/**
 * ADR-205 D2/D3 projection behaviour over injected effects: cursor paging,
 * parse budget and refresh floor, stale and unavailable answers, deadline,
 * abort, bounds, and provider neutrality of the shared modules.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { createBoundedSemaphore } from './bounded-semaphore.js';
import { verifyAttachmentRef } from './session-share-live-keys.js';
import {
  LIVE_PROJECTION_LIMITS, LiveProjectionError, createLiveProjection, type LiveMessagesResponse, type LiveProjectionDeps,
} from './session-share-live-projection.js';

const OWNER = 7;
const SESSION = 'session-a';
const share = { shareId: 'c'.repeat(32), refKey: randomBytes(32) };
type Row = { role: 'user' | 'assistant' | 'tool'; content: string; userId?: number; images?: string[] };

/** A controllable history source and clock. */
function world(rows: Row[], limits: LiveProjectionDeps['limits'] = {}) {
  const state = {
    rows, revision: 'r1', kind: 'file' as 'file' | 'metadata', bytes: 100 as number | null, running: false,
    oversized: false, readFailed: false, fetches: 0, peeks: 0, now: 1_000_000,
    gate: null as Promise<void> | null, fetchError: null as unknown,
  };
  const normalized = (): NormalizedMessage[] => state.rows.map((row, i) => ({
    id: `gen-${Math.random()}`, sessionId: SESSION, timestamp: new Date().toISOString(), provider: 'x',
    ...(row.role === 'tool' ? { kind: 'tool_use', toolName: 'Bash', toolId: `t${i}` }
      : { kind: 'text', role: row.role, content: row.content, userId: row.userId, images: row.images }),
  }) as NormalizedMessage);
  const deps: LiveProjectionDeps = {
    fetchHistory: async () => {
      state.fetches += 1;
      if (state.gate) await state.gate;
      if (state.fetchError) throw state.fetchError;
      const messages = state.readFailed ? [] : normalized();
      return { messages, total: messages.length, hasMore: false, offset: 0, limit: null, revision: state.revision,
        ...(state.readFailed ? { readFailed: true as const } : {}) };
    },
    peek: async () => { state.peeks += 1; return { revision: state.revision, kind: state.kind, bytes: state.bytes }; },
    isRunning: () => state.running,
    isSourceOversized: () => state.oversized,
    projectRoot: () => '/srv/project',
    home: () => '/home/operator',
    isTextFile: () => true,
    now: () => state.now,
    semaphore: createBoundedSemaphore({ runners: 1, queue: 4, waitMs: 5000 }),
    limits,
  };
  return { state, projection: createLiveProjection(deps), deps };
}

/** Alternating user/assistant text with a tool row after every assistant reply. */
function history(turns: number, prefix = ''): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < turns; i += 1) {
    rows.push({ role: 'user', content: `${prefix}u${i}`, userId: OWNER }, { role: 'assistant', content: `${prefix}a${i}` }, { role: 'tool', content: '' });
  }
  return rows;
}

const texts = (response: LiveMessagesResponse) => response.messages.map((m) => (m.parts[0] as { text: string }).text);
const read = (w: ReturnType<typeof world>, extra: { before?: string; after?: string; signal?: AbortSignal } = {}) =>
  w.projection.readMessages({ sessionId: SESSION, ownerUserId: OWNER, share, ...extra });
const isCode = (code: string) => (error: unknown) => error instanceof LiveProjectionError && error.code === code;

test('the newest page holds the 50 newest public messages in order, with no tool rows', async () => {
  const w = world(history(40));
  const page = await read(w);
  assert.equal(page.v, 2);
  assert.equal(page.messages.length, 50);
  assert.deepEqual(texts(page).slice(-2), ['u39', 'a39']);
  assert.equal(page.moreBefore, true);
  assert.equal(page.moreAfter, false);
  assert.ok(page.messages.every((m) => /^[A-Za-z0-9_-]{22}$/.test(m.k) && m.c.startsWith(`${m.k}.`)));
  assert.equal(page.messages.find((m) => m.role === 'user')?.author, 'owner');
  assert.equal(page.messages.find((m) => m.role === 'assistant')?.author, 'assistant');
  assert.equal(page.retryAfterMs, LIVE_PROJECTION_LIMITS.floorIdleMs);
  assert.equal(JSON.stringify(page).includes('"total"') || JSON.stringify(page).includes('"offset"'), false);
});

test('before pages walk to the beginning with no gap and no duplicate', async () => {
  const w = world(history(120));
  const seen: string[] = [];
  let page = await read(w);
  seen.unshift(...texts(page));
  while (page.moreBefore) {
    page = await read(w, { before: page.messages[0].c });
    seen.unshift(...texts(page));
  }
  assert.equal(seen.length, 240);
  assert.equal(new Set(seen).size, 240);
  assert.deepEqual(seen.slice(0, 2), ['u0', 'a0']);
  assert.equal(w.state.fetches, 1, 'one parse served the whole scroll');
});

test('after pages stay gap-free and duplicate-free while rows (tool rows included) are appended', async () => {
  const w = world(history(3));
  const first = await read(w);
  const seen = texts(first);
  let anchor = first.messages.at(-1)!.c;
  for (let round = 0; round < 3; round += 1) {
    w.state.rows = [...w.state.rows, ...history(150, `r${round}-`)];
    w.state.revision = `r${round + 2}`;
    w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
    let page: LiveMessagesResponse;
    do {
      page = await read(w, { after: anchor });
      assert.ok(page.messages.length <= 200);
      seen.push(...texts(page));
      if (page.messages.length) anchor = page.messages.at(-1)!.c;
    } while (page.moreAfter);
  }
  assert.equal(seen.length, 6 + 3 * 300);
  assert.equal(new Set(seen).size, seen.length);
});

test('a rewritten anchor answers CURSOR_STALE; unchanged messages keep their keys for client deduplication', async () => {
  const w = world(history(5));
  const before = await read(w);
  const anchor = before.messages[3];
  w.state.rows = w.state.rows.map((row) => (row.content === 'a1' ? { ...row, content: 'a1 edited' } : row));
  w.state.revision = 'r2';
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  await assert.rejects(read(w, { before: anchor.c }), isCode('CURSOR_STALE'));
  const reloaded = await read(w);
  const keys = new Set(before.messages.map((m) => m.k));
  assert.equal(reloaded.messages.filter((m) => keys.has(m.k)).length, 9, 'only the edited message has a new key');
  await assert.rejects(read(w, { before: `${anchor.k}.${'A'.repeat(22)}` }), isCode('CURSOR_STALE'), 'forged cursor');
});

test('per-response byte cap holds, and a lone message larger than the cap is returned alone', async () => {
  const big = (n: number) => 'x'.repeat(n);
  const w = world([{ role: 'user', content: big(1_500_000) }, { role: 'assistant', content: big(1_500_000) },
    { role: 'user', content: big(1_500_000) }, { role: 'assistant', content: big(1_500_000) }]);
  const page = await read(w);
  assert.equal(page.messages.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= 4 * 1024 * 1024);
  const huge = world([{ role: 'user', content: `${'y\n'.repeat(1_048_000)}` }]);
  assert.equal((await read(huge)).messages.length, 1);
});

test('N concurrent viewers cost one parse; inside the floor no peek; an equal peek costs no parse', async () => {
  const w = world(history(10));
  const pages = await Promise.all(Array.from({ length: 10 }, () => read(w)));
  assert.equal(w.state.fetches, 1);
  assert.ok(pages.every((page) => page.messages.length === 20));
  const peeks = w.state.peeks;
  await read(w);
  assert.equal(w.state.peeks, peeks, 'inside the floor the source is not touched');
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  await read(w);
  assert.equal(w.state.peeks, peeks + 1);
  assert.equal(w.state.fetches, 1);
  w.state.revision = 'r2';
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  await read(w);
  assert.equal(w.state.fetches, 2);
});

test('refresh floor: 10 s while running, 15 s over 20 MiB, 3 s idle; metadata revisions reload after 60 s', async () => {
  const w = world(history(2));
  w.state.running = true;
  assert.equal((await read(w)).retryAfterMs, LIVE_PROJECTION_LIMITS.floorRunningMs);
  assert.equal((await read(w)).running, true);
  const large = world(history(2));
  large.state.bytes = 21 * 1024 * 1024;
  assert.equal((await read(large)).retryAfterMs, LIVE_PROJECTION_LIMITS.floorLargeMs);
  const metadata = world(history(2));
  metadata.state.kind = 'metadata';
  metadata.state.bytes = null;
  await read(metadata);
  metadata.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  await read(metadata);
  assert.equal(metadata.state.fetches, 1, 'equal metadata revision inside 60 s');
  metadata.state.now += LIVE_PROJECTION_LIMITS.metadataRefreshMs;
  await read(metadata);
  assert.equal(metadata.state.fetches, 2, 'metadata entries reload after 60 s even when unchanged');
});

test('N3: scrolling past memo capacity always progresses and keeps one parse per floor', async () => {
  const w = world(history(150), { entryBytes: 6_000, loadMessages: 60, rawRetainBytes: 0 });
  const seen: string[] = [];
  let page = await read(w);
  seen.unshift(...texts(page));
  let floorWaits = 0;
  while (page.moreBefore) {
    try {
      page = await read(w, { before: page.messages[0].c });
      seen.unshift(...texts(page));
    } catch (error) {
      assert.ok(isCode('HISTORY_UNAVAILABLE')(error));
      assert.ok((error as LiveProjectionError).retryAfterMs! > 0);
      w.state.now += (error as LiveProjectionError).retryAfterMs!;
      floorWaits += 1;
    }
    assert.ok(floorWaits < 50, 'terminates');
  }
  assert.equal(new Set(seen).size, 300);
  assert.equal(seen.length, 300);
  assert.ok(w.state.fetches <= floorWaits + 1, 'never more than one parse per floor interval');
  assert.ok(w.state.fetches >= 2 && floorWaits >= 1, 'the scroll really outgrew one parse');
  assert.ok(w.projection.inspect(SESSION)!.memoBytes <= 6_000 + 2_000);
});

test('readFailed: 503 and nothing cached; with a previous entry the old projection is served stale', async () => {
  const w = world(history(3));
  w.state.readFailed = true;
  await assert.rejects(read(w), isCode('HISTORY_UNAVAILABLE'));
  assert.equal(w.projection.inspect(SESSION), undefined);
  await assert.rejects(read(w), isCode('HISTORY_UNAVAILABLE'));
  assert.equal(w.state.fetches, 2, 'a failed read is never cached');
  w.state.readFailed = false;
  await read(w);
  w.state.readFailed = true;
  w.state.revision = 'r2';
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  const stale = await read(w);
  assert.equal(stale.stale, true);
  assert.equal(stale.messages.length, 6);
});

test('HISTORY_REVISION_CHANGED is served as unchanged with a retry hint, or 503 without an entry', async () => {
  const w = world(history(3));
  w.state.fetchError = Object.assign(new Error('changed'), { code: 'HISTORY_REVISION_CHANGED' });
  await assert.rejects(read(w), isCode('HISTORY_UNAVAILABLE'));
  w.state.fetchError = null;
  await read(w);
  w.state.fetchError = Object.assign(new Error('changed'), { code: 'HISTORY_REVISION_CHANGED' });
  w.state.revision = 'r2';
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  const page = await read(w);
  assert.equal(page.stale, false);
  assert.ok(page.retryAfterMs > 0);
  assert.equal(page.messages.length, 6);
});

test('N7: a request past the deadline gets 503 with retryAfterMs, or the previous entry as stale; never a throw of another kind', async () => {
  const w = world(history(3), { deadlineMs: 30 });
  let open!: () => void;
  w.state.gate = new Promise((resolve) => { open = resolve; });
  await assert.rejects(read(w), (error) => isCode('HISTORY_UNAVAILABLE')(error) && (error as LiveProjectionError).retryAfterMs! > 0);
  open();
  w.state.gate = null;
  await read(w);
  w.state.gate = new Promise(() => undefined);
  w.state.revision = 'r2';
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs;
  const stale = await read(w);
  assert.equal(stale.stale, true);
  assert.equal(stale.messages.length, 6);
});

test('an aborted request leaves the semaphore queue and stops the sanitize loop', async () => {
  const w = world(history(30));
  let open!: () => void;
  const hold = await w.deps.semaphore.acquire();
  const controller = new AbortController();
  const pending = read(w, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.deps.semaphore.stats().queued, 1);
  controller.abort(new Error('client closed'));
  await assert.rejects(pending, /client closed/);
  assert.equal(w.deps.semaphore.stats().queued, 0);
  hold();
  // A parse that started before the abort completes and fills the entry, unsanitized.
  w.state.gate = new Promise((resolve) => { open = resolve; });
  const second = new AbortController();
  const started = read(w, { signal: second.signal });
  await new Promise((resolve) => setImmediate(resolve));
  second.abort(new Error('gone'));
  await assert.rejects(started, /gone/);
  open();
  await new Promise((resolve) => setImmediate(resolve));
  const entry = w.projection.inspect(SESSION)!;
  assert.equal(entry.order.length, 60);
  assert.equal(entry.memo.size, 0, 'sanitizing stopped once the last waiter left');
});

test('sourceOversized and a full guest semaphore both answer a retryable 503', async () => {
  const oversized = world(history(2));
  oversized.state.oversized = true;
  await assert.rejects(read(oversized), isCode('HISTORY_UNAVAILABLE'));
  assert.equal(oversized.state.fetches, 0);
  const full = world(history(2));
  full.deps.semaphore = createBoundedSemaphore({ runners: 1, queue: 0, waitMs: 10 });
  const busy = createLiveProjection(full.deps);
  const hold = await full.deps.semaphore.acquire();
  await assert.rejects(busy.readMessages({ sessionId: SESSION, ownerUserId: OWNER, share }), isCode('HISTORY_UNAVAILABLE'));
  hold();
});

test('entries expire 5 minutes after the last guest request, global LRU evicts idle sessions, drop removes one', async () => {
  const w = world(history(2), { globalBytes: 1 });
  await read(w);
  await w.projection.readMessages({ sessionId: 'session-b', ownerUserId: OWNER, share });
  assert.equal(w.projection.inspect(SESSION), undefined, 'least recently used session evicted over the global cap');
  const ttl = world(history(2));
  await read(ttl);
  ttl.state.now += LIVE_PROJECTION_LIMITS.ttlMs + 1;
  await ttl.projection.readMessages({ sessionId: 'session-b', ownerUserId: OWNER, share });
  assert.equal(ttl.projection.inspect(SESSION), undefined);
  ttl.projection.drop('session-b');
  assert.equal(ttl.projection.inspect('session-b'), undefined);
});

test('attachment parts carry per-share refs that map back to server-only locators', async () => {
  const png = `data:image/png;base64,${Buffer.from('img').toString('base64')}`;
  const w = world([{ role: 'user', content: 'look', images: [png] }]);
  const page = await read(w);
  const part = page.messages[0].parts[1] as { t: string; ref: string };
  assert.equal(part.t, 'image');
  const decoded = verifyAttachmentRef(share, part.ref)!;
  assert.equal(decoded.k, page.messages[0].k);
  const resolved = await w.projection.resolveAttachment({ sessionId: SESSION, ownerUserId: OWNER, share, ref: part.ref });
  assert.deepEqual(resolved, { locator: { source: 'embedded-image', dataUri: png }, projectRoot: '/srv/project',
    home: '/home/operator' });
  assert.ok(!JSON.stringify(page).includes('base64'), 'bytes never ride in the message response');
});

test('D4: a forged ref, another share\'s ref, a wrong index and a vanished message resolve to null', async () => {
  const png = `data:image/png;base64,${Buffer.from('img').toString('base64')}`;
  const w = world([{ role: 'user', content: 'look', images: [png] }]);
  const ref = ((await read(w)).messages[0].parts[1] as { ref: string }).ref;
  const ask = (candidate: string, keys = share) => w.projection.resolveAttachment({ sessionId: SESSION, ownerUserId: OWNER,
    share: keys, ref: candidate });
  assert.equal(await ask(`${ref.slice(0, -1)}${ref.endsWith('A') ? 'B' : 'A'}`), null, 'MAC forgery');
  assert.equal(await ask(ref, { shareId: 'd'.repeat(32), refKey: share.refKey }), null, 'other share id');
  assert.equal(await ask(ref, { shareId: share.shareId, refKey: randomBytes(32) }), null, 'rotated (revoked) ref key');
  const [k] = ref.split('.');
  const { mintAttachmentRef } = await import('./session-share-live-keys.js');
  assert.equal(await ask(mintAttachmentRef(share, k, 5)), null, 'index past the message attachments');
  w.state.rows = [{ role: 'user', content: 'rewritten' }];
  w.state.revision = 'r2';
  w.state.now += 60_000;
  assert.equal(await ask(ref), null, 'stale ref after a rewrite: ATTACHMENT_GONE');
});

test('D4: an attachment of a message evicted from the memo re-projects within the parse budget', async () => {
  const png = `data:image/png;base64,${Buffer.from('img').toString('base64')}`;
  const w = world([{ role: 'user', content: 'look', images: [png] }, ...history(3)]);
  const ref = ((await read(w)).messages[0].parts[1] as { ref: string }).ref;
  const entry = w.projection.inspect(SESSION)!;
  entry.memo.clear();
  entry.memoBytes = 0;
  entry.raw = null;
  const early = await w.projection.resolveAttachment({ sessionId: SESSION, ownerUserId: OWNER, share, ref })
    .catch((error: unknown) => error);
  assert.ok(isCode('HISTORY_UNAVAILABLE')(early), 'inside the refresh floor: 503 with retryAfterMs, no extra parse');
  assert.equal(w.state.fetches, 1);
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs + 1;
  w.state.revision = 'r2';
  const resolved = await w.projection.resolveAttachment({ sessionId: SESSION, ownerUserId: OWNER, share, ref });
  assert.equal(resolved?.locator.source, 'embedded-image');
  assert.equal(w.state.fetches, 2, 'one re-projection parse');
});

test('the shared live modules contain no provider identifiers (D9)', () => {
  // 'cursor' is also the paging term, so that provider counts only as a quoted id.
  const providers = /\b(claude|codex|opencode|antigravity|agy|kimi|glm|deepseek|qwen|hermes|gemini)\b|['"`]cursor['"`]/i;
  for (const file of ['session-share-live-projection.ts', 'session-share-live-page.ts', 'session-share-live-rows.ts',
    'session-share-live-attachments.ts', 'session-share-live-keys.ts', 'session-share-public-row.ts']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.equal(providers.test(source), false, `${file} names a provider`);
  }
});

test('T-2016: raw rows are released after the floor even on memoized polls, and the timer evicts idle entries', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = world(history(2));
  await read(w);
  assert.ok(w.projection.inspect(SESSION)!.raw, 'raw is held inside the floor');
  w.state.now += LIVE_PROJECTION_LIMITS.floorIdleMs + 1;
  await read(w);
  assert.equal(w.projection.inspect(SESSION)!.raw, null, 'a poll after the floor leaves no raw rows');
  w.state.now += LIVE_PROJECTION_LIMITS.ttlMs + 1;
  t.mock.timers.tick(30_000);
  assert.equal(w.projection.inspect(SESSION), undefined, 'evicted after the TTL with no further request');
});
