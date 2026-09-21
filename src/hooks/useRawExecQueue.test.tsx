/**
 * useRawExecQueue.test.tsx — B-247: the client reads the queue, it does not
 * decide who may see it.
 *
 * The whole surface added in B-247 (a red section in the pending-actions panel,
 * a badge on the sidebar, a badge on the settings nav) is driven by this one
 * hook, and every one of those places is reachable by a non-owner. So the risk
 * is not "does the list render" — it is "could the client show rows the server
 * would not have released, or hand the reviewer a row it cannot verify".
 *
 * The answer to the first is structural: GET /api/system/command-board-raw
 * already applies mayReadQueue (raw tier + armed flag + no environment blockers)
 * and ships `commands: []` to everyone else. These tests pin the client to that
 * contract — it renders what it was given, and never re-derives visibility from
 * a role, a mode string or the armed flag.
 *
 * The answer to the second is parsing: a row without a digest cannot be reviewed
 * safely, because the digest is the only binding between the bytes a human reads
 * in the dialog and the bytes the server runs. Such a row is dropped, not shown.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

/** Fresh module registry per test — the hook caches at module scope on purpose. */
async function loadHook() {
  vi.resetModules();
  return await import('./useRawExecConfig');
}

function respondWith(body: unknown, ok = true) {
  authenticatedFetch.mockResolvedValue({ ok, json: async () => body });
}

const ARMED_RAW = {
  rawExecEnabled: true,
  rawExecBlockedReasons: [],
  mode: 'raw',
  maxCommands: 20,
};

const ROW = {
  id: 'raw-1',
  command: 'sudo usermod -aG docker jazari',
  digest: 'a'.repeat(64),
  requestedBy: 'jazari',
  requestedAt: '2026-07-26T09:15:00.000Z',
};

beforeEach(() => {
  authenticatedFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRawExecQueue — the server owns visibility', () => {
  it('returns the rows the server released', async () => {
    respondWith({ ...ARMED_RAW, commands: [ROW] });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toHaveLength(1);
    expect(result.current.commands[0].command).toBe(ROW.command);
    expect(result.current.commands[0].digest).toBe(ROW.digest);
  });

  it('returns nothing when the server withheld the queue', async () => {
    // What a caller who fails mayReadQueue actually receives: the capability
    // fields still describe them, but `commands` is empty.
    respondWith({ rawExecEnabled: true, rawExecBlockedReasons: [], mode: 'restricted', commands: [] });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toHaveLength(0);
    expect(result.current.canUseRaw).toBe(false);
  });

  it('does NOT re-gate the rows on the locally derived capability', async () => {
    // A server that released rows while reporting a tier the client would read
    // as "no raw button" must still have its rows shown: hiding them would put a
    // second, divergible copy of mayReadQueue in the client. The button and the
    // list answer different questions.
    respondWith({ ...ARMED_RAW, rawExecEnabled: false, commands: [ROW] });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canUseRaw).toBe(false);
    expect(result.current.commands).toHaveLength(1);
  });

  it('never calls the server for an anonymous caller', async () => {
    respondWith({ ...ARMED_RAW, commands: [ROW] });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(false));

    expect(result.current.loading).toBe(false);
    expect(result.current.commands).toHaveLength(0);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe('useRawExecQueue — fail-closed parsing', () => {
  it('drops a row with no digest: it could not be verified in the reviewer', async () => {
    respondWith({
      ...ARMED_RAW,
      commands: [ROW, { id: 'raw-2', command: 'echo hi', requestedBy: null, requestedAt: null }],
    });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands.map((c) => c.id)).toEqual(['raw-1']);
  });

  it('drops rows with a missing id or empty command text', async () => {
    respondWith({
      ...ARMED_RAW,
      commands: [
        { command: 'echo a', digest: 'c'.repeat(64) },        // no id
        { id: 'raw-3', command: '', digest: 'd'.repeat(64) }, // empty command
        null,
        'not-an-object',
        ROW,
      ],
    });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands.map((c) => c.id)).toEqual(['raw-1']);
  });

  it('yields nothing when the payload is not a list at all', async () => {
    respondWith({ ...ARMED_RAW, commands: { id: 'raw-1' } });
    const { useRawExecQueue } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commands).toHaveLength(0);
  });

  it('yields nothing on a refused read or a network failure', async () => {
    respondWith({ code: 'unauthenticated' }, false);
    const refused = await loadHook();
    const { result: refusedResult } = renderHook(() => refused.useRawExecQueue(true));
    await waitFor(() => expect(refusedResult.current.loading).toBe(false));
    expect(refusedResult.current.commands).toHaveLength(0);

    authenticatedFetch.mockRejectedValue(new Error('offline'));
    const offline = await loadHook();
    const { result: offlineResult } = renderHook(() => offline.useRawExecQueue(true));
    await waitFor(() => expect(offlineResult.current.loading).toBe(false));
    expect(offlineResult.current.commands).toHaveLength(0);
    expect(offlineResult.current.canUseRaw).toBe(false);
  });
});

describe('useRawExecQueue — liveness', () => {
  it('re-reads on refreshRawExecConfig and pushes the new list to mounted consumers', async () => {
    respondWith({ ...ARMED_RAW, commands: [ROW] });
    const { useRawExecQueue, refreshRawExecConfig } = await loadHook();

    const { result } = renderHook(() => useRawExecQueue(true));
    await waitFor(() => expect(result.current.commands).toHaveLength(1));

    // The row was executed or dismissed elsewhere; the WS bridge fires.
    respondWith({ ...ARMED_RAW, commands: [] });
    refreshRawExecConfig();

    // Badges must fall to zero without anything re-mounting.
    await waitFor(() => expect(result.current.commands).toHaveLength(0));
  });

  it('shares one request across concurrent consumers', async () => {
    respondWith({ ...ARMED_RAW, commands: [ROW] });
    const { useRawExecQueue } = await loadHook();

    const a = renderHook(() => useRawExecQueue(true));
    const b = renderHook(() => useRawExecQueue(true));

    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));

    // The sidebar badge, the settings badge and every chat code block ask the
    // same question; one answer serves them all.
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(b.result.current.commands).toHaveLength(1);
  });
});
