/**
 * B-1666 #2/#3 — the active-run light window (light400) and stream-gap
 * recovery must keep working while the transcript grows.
 *
 * The fake server below replays the REAL contract of sessions.service.ts /
 * session-history-light.service.ts (pinned by sessions.service.revision-race
 * test on the server side): any request whose `revision` no longer matches is
 * answered 409 HISTORY_REVISION_CHANGED — never 200 with another revision —
 * and a read that overlaps a write is ALSO 409 HISTORY_REVISION_CHANGED even
 * without a `revision` (torn read). Mocked at the authenticatedFetch boundary
 * so the real store and the real hook issue every request.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { canAutomaticallyReadHistory, useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const PROJECT = { projectId: 'p1', path: '/synthetic', fullPath: '/synthetic' } as any;
const SID = 's-growing';
const noOp = () => {};

type FakeServer = { rows: NormalizedMessage[]; revision: number; tornReads: number; growAfterFirst: boolean };
let server: FakeServer;
let requests: URL[];

function row(index: number): NormalizedMessage {
  const second = String(index % 60).padStart(2, '0');
  const minute = String(Math.floor(index / 60)).padStart(2, '0');
  return {
    id: `m-${index}`, sessionId: SID, kind: 'text', role: index % 2 ? 'assistant' : 'user',
    provider: 'claude', timestamp: `2026-10-17T10:${minute}:${second}.000Z`, content: `row ${index}`,
  };
}

function conflict() {
  return { ok: false, status: 409, headers: new Headers(),
    json: async () => ({ error: { code: 'HISTORY_REVISION_CHANGED' } }) };
}

function respond(url: URL) {
  const query = url.searchParams;
  const current = `rev-${server.revision}`;
  if (query.has('revision') && query.get('revision') !== current) return conflict();
  if (server.tornReads > 0) { server.tornReads -= 1; return conflict(); }
  const light = query.get('payload') === 'light';
  const limit = query.has('limit') ? Number(query.get('limit')) : server.rows.length;
  const page = server.rows.slice(-limit).map((message) => (light && message.role === 'assistant'
    ? { ...message, deferredPayload: { fields: ['toolInput'] } } : message));
  const body = { messages: page, total: server.rows.length, hasMore: limit < server.rows.length,
    nextCursor: null, historySchema: 1, payloadMode: light ? 'light' : 'full', revision: current };
  if (server.growAfterFirst) {
    server.growAfterFirst = false;
    server.rows = [...server.rows, row(server.rows.length), row(server.rows.length + 1)];
    server.revision += 1;
  }
  return { ok: true, json: async () => body };
}

type Props = { id: string; external?: number; processing?: Set<string> };
function mount(initial: Props) {
  return renderHook(({ id, external = 0, processing }: Props) => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({
      selectedSession: { id, __provider: 'claude' } as any, selectedProject: PROJECT,
      ws: null, sendMessage: noOp, resetStreamingState: noOp, pendingViewSessionRef: pending,
      sessionStore: store, externalMessageUpdate: external, processingSessions: processing,
    });
    return { store, ...state };
  }, { initialProps: initial });
}

const light400 = () => requests.filter((u) => u.searchParams.get('limit') === '400');
const slotOf = (result: { current: { store: ReturnType<typeof useSessionStore> } }, id = SID) =>
  result.current.store.getSessionSlot(id);

beforeEach(() => {
  server = { rows: Array.from({ length: 60 }, (_, i) => row(i)), revision: 1, tornReads: 0, growAfterFirst: false };
  requests = [];
  publishServerCapabilities({ capabilities: { lightHistory: { supported: true, enabled: true, schema: 1 } } });
  authenticatedFetch.mockReset().mockImplementation(async (raw: string) => {
    const url = new URL(raw, 'https://synthetic.test');
    if (!url.pathname.endsWith('/messages')) return { ok: false, status: 404, json: async () => ({}) };
    requests.push(url);
    return respond(url);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B-1666 — light400 during a growing transcript', () => {
  it('widens without a revision, adopts the new one and re-queues enrichment after the run', async () => {
    server.growAfterFirst = true; // the transcript grows right after the opening read
    const processing = new Set([SID]);
    const view = mount({ id: SID, processing });

    await waitFor(() => expect(slotOf(view.result)?.historyRevision).toBe('rev-2'), { timeout: 3000 });
    expect(light400().every((u) => !u.searchParams.has('revision'))).toBe(true);
    expect(view.result.current.historyError).toBeNull();
    expect(slotOf(view.result)?.serverMessages).toHaveLength(62);

    view.rerender({ id: SID, processing: new Set() });
    await waitFor(() => expect(requests.some((u) => u.searchParams.get('payload') === 'full'
      && u.searchParams.get('revision') === 'rev-2')).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(slotOf(view.result)?.historyPayloadMode).toBe('full'));
    expect(view.result.current.historyError).toBeNull();
  });

  it('retries a torn read with back-off and never leaves a blocking error', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    server.tornReads = 10;

    act(() => view.result.current.requestStreamGapRecovery(SID));
    await waitFor(() => expect(view.result.current.historyError?.code).toBe('HISTORY_REVISION_CHANGED'),
      { timeout: 4000 });
    expect(light400()).toHaveLength(4); // one read + three bounded retries, no loop
    expect(view.result.current.historyError?.operation).toBe('deferred');
    expect(canAutomaticallyReadHistory(view.result.current.historyError)).toBe(true);

    server.tornReads = 0;
    act(() => view.result.current.requestStreamGapRecovery(SID));
    await waitFor(() => expect(view.result.current.historyError).toBeNull());
    expect(slotOf(view.result)?.serverMessages).toHaveLength(60);
  }, 10000);

  it('a torn read that heals on retry leaves no error', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    server.tornReads = 1;

    act(() => view.result.current.requestStreamGapRecovery(SID));
    await waitFor(() => expect(light400()).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(slotOf(view.result)?.serverMessages).toHaveLength(60));
    expect(view.result.current.historyError).toBeNull();
  });

  it('a session switch during the back-off discards the retry', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    server.tornReads = 1;

    act(() => view.result.current.requestStreamGapRecovery(SID));
    await waitFor(() => expect(light400()).toHaveLength(1));
    view.rerender({ id: 's-other' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(light400().filter((u) => u.pathname.includes(SID))).toHaveLength(1);
    expect(slotOf(view.result)?.serverMessages).toHaveLength(20);
  });
});

describe('B-1666 — a parked revision conflict does not stop live reads', () => {
  it('external update refreshes and clears a parked deferred conflict', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    act(() => view.result.current.store.setHistoryError(SID,
      { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'deferred'));
    server.rows = [...server.rows, row(60)];
    server.revision = 2;

    view.rerender({ id: SID, external: 1 });
    await waitFor(() => expect(view.result.current.historyError).toBeNull());
    expect(view.result.current.chatMessages.some((m: any) => m.id === 'm-60')).toBe(true);
    expect(slotOf(view.result)?.historyRevision).toBe('rev-2');
  });

  it.each(['reconnect', 'initial'] as const)('a %s conflict is transient too', async (operation) => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    act(() => view.result.current.store.setHistoryError(SID,
      { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, operation));

    view.rerender({ id: SID, external: 1 });
    await waitFor(() => expect(view.result.current.historyError).toBeNull());
  });

  it('mergeTailFromServer clears a parked deferred conflict', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    act(() => view.result.current.store.setHistoryError(SID,
      { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'deferred'));

    await act(async () => { await view.result.current.store.mergeTailFromServer(SID); });
    expect(view.result.current.historyError).toBeNull();
  });

  it('a non-rebase deferred failure still waits for manual recovery', async () => {
    const view = mount({ id: SID });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    const before = requests.length;
    act(() => view.result.current.store.setHistoryError(SID,
      { ok: false, status: 413, code: 'HISTORY_BUDGET_EXCEEDED', retryAfterMs: null }, 'deferred'));

    view.rerender({ id: SID, external: 1 });
    act(() => view.result.current.requestStreamGapRecovery(SID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toHaveLength(before);
    expect(view.result.current.historyError?.code).toBe('HISTORY_BUDGET_EXCEEDED');
  });
});
