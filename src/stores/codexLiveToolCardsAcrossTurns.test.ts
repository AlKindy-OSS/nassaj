/**
 * codexLiveToolCardsAcrossTurns.test.ts — B-1489: Codex live tool cards across
 * turns, through the production store (only the network is mocked).
 *
 * The SDK numbers items per turn (`item_1`, `item_3`, ...), so forwarding the
 * raw id made turn 2's `item_1` replace turn 1's card in appendRealtime (it
 * dedupes by row id). The server now sends `codex-<turnNonce>-<item.id>`.
 * After a refetch, live tool rows are retired (retainUnconfirmedRealtime) and
 * the history copies, now recovered from `tools.exec_command`, take over —
 * without any duplicate.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useSessionStore } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

const SID = 'b1489-codex-thread';
const TURN_NONCES = ['5f0c1d2e-0000-4000-8000-000000000001', '5f0c1d2e-0000-4000-8000-000000000002',
  '5f0c1d2e-0000-4000-8000-000000000003'];
const SDK_IDS = ['item_1', 'item_3', 'item_5'];

function toolCard(id: string, command: string, second: number): NormalizedMessage {
  return {
    id, sessionId: SID, provider: 'codex', kind: 'tool_use', toolName: 'Bash', toolId: id,
    toolInput: { command }, toolResult: { content: '', isError: false },
    timestamp: new Date(Date.UTC(2026, 9, 1, 20, 0, second)).toISOString(),
  } as NormalizedMessage;
}

/** The 9 live cards exactly as openai-codex.js now ids them. */
function liveCards(): NormalizedMessage[] {
  return TURN_NONCES.flatMap((nonce, turn) => SDK_IDS.map((sdkId, index) =>
    toolCard(`codex-${nonce}-${sdkId}`, `cmd-${turn}-${sdkId}`, turn * 10 + index)));
}

/** The same commands as fetchHistory returns them (line-hash history ids). */
function historyCards(): NormalizedMessage[] {
  return TURN_NONCES.flatMap((_nonce, turn) => SDK_IDS.map((sdkId, index) =>
    toolCard(`codex-history-${turn}${index}-0-tool-use`, `cmd-${turn}-${sdkId}`, turn * 10 + index)));
}

beforeEach(() => authenticatedFetch.mockReset());

describe('B-1489 — Codex live tool cards survive later turns', () => {
  it('keeps all nine cards of three turns that reuse item_1/item_3/item_5', async () => {
    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      for (const card of liveCards()) result.current.appendRealtime(SID, card);
    });
    const shown = result.current.getMessages(SID).filter((row) => row.kind === 'tool_use');
    expect(shown).toHaveLength(9);
    expect(new Set(shown.map((row) => row.id)).size).toBe(9);
  });

  it('a refetch hands the cards to history with no duplicate and no loss', async () => {
    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      for (const card of liveCards()) result.current.appendRealtime(SID, card);
    });
    const server = historyCards();
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: server, total: server.length, hasMore: false }),
    });
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });
    const shown = result.current.getMessages(SID).filter((row) => row.kind === 'tool_use');
    expect(shown.map((row) => row.id)).toEqual(server.map((row) => row.id));
    const commands = shown.map((row) => (row.toolInput as { command: string }).command);
    expect(new Set(commands).size).toBe(9);
  });
});

/** Seconds after the epoch of the fixture conversation. */
const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 1, 20, 0, 0) + second * 1000).toISOString();

function textRow(id: string, role: 'user' | 'assistant', content: string, second: number,
  extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id, sessionId: SID, provider: 'codex', kind: 'text', role, content,
    timestamp: at(second), ...extra,
  } as NormalizedMessage;
}

/**
 * Turn t (t = 0..2) as the live stream delivers it: commentary → tool → final.
 * The commentary text is identical in every turn, so only per-turn one-to-one
 * matching can tell the copies apart.
 */
function liveTurn(t: number): NormalizedMessage[] {
  const nonce = TURN_NONCES[t];
  const base = 100 * t;
  const reply = { responseToMessageId: `cmid_turn_${t}` };
  return [
    // item.completed reaches the client after the rollout already recorded the
    // tool call (history 3.0), so the history tool sorts between the two copies.
    textRow(`codex-${nonce}-item_0`, 'assistant', 'Running the tests now.', base + 3.2, reply),
    toolCard(`codex-${nonce}-item_1`, `npm test -- ${t}`, base + 3.6),
    textRow(`codex-${nonce}-item_2`, 'assistant', `Turn ${t}: all green.`, base + 5.1, reply),
  ];
}

/** The same turn as fetchHistory returns it; rollout stamps land between the live copies. */
function historyTurn(t: number, proven: boolean): NormalizedMessage[] {
  const base = 100 * t;
  return [
    textRow(`msg_user_${t}`, 'user', `run the tests ${t}`, base + 1,
      proven ? { clientMsgId: `cmid_turn_${t}` } : {}),
    textRow(`msg_a_${t}`, 'assistant', 'Running the tests now.', base + 2.0),
    toolCard(`codex-history-${t}-0-tool-use`, `npm test -- ${t}`, base + 3.0),
    textRow(`msg_b_${t}`, 'assistant', `Turn ${t}: all green.`, base + 5.0),
  ];
}

async function refetchAfterLiveTurns(server: NormalizedMessage[]) {
  const { result } = renderHook(() => useSessionStore());
  await act(async () => {
    for (const row of [0, 1, 2].flatMap(liveTurn)) result.current.appendRealtime(SID, row);
  });
  authenticatedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ messages: server, total: server.length, hasMore: false }),
  });
  await act(async () => {
    await result.current.refreshFromServer(SID);
  });
  return result.current.getMessages(SID);
}

describe('B-1489 — live Codex replies retire against their history copies', () => {
  for (const proven of [true, false]) {
    it(`commentary → tool → final × 3 turns refetches without duplicates (proven turn: ${proven})`,
      async () => {
        const server = [0, 1, 2].flatMap((t) => historyTurn(t, proven));
        const shown = await refetchAfterLiveTurns(server);
        expect(shown.map((row) => row.id)).toEqual(server.map((row) => row.id));
      });
  }

  it('keeps a live reply whose history copy is not written yet, and only that one', async () => {
    const server = [0, 1, 2].flatMap((t) => historyTurn(t, true)).slice(0, -1);
    const shown = await refetchAfterLiveTurns(server);
    const live = shown.filter((row) =>
      row.id.startsWith('codex-') && !row.id.startsWith('codex-history-'));
    expect(live.map((row) => row.content)).toEqual(['Turn 2: all green.']);
    expect(shown).toHaveLength(server.length + 1);
  });

  it('a final answer retires by its attested transcript id even if the text differs', async () => {
    const server = [0, 1, 2].flatMap((t) => historyTurn(t, true));
    const last = server.length - 1;
    server[last] = { ...server[last], content: 'Turn 2: all green (edited).' };
    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      for (const row of [0, 1, 2].flatMap(liveTurn)) {
        const attested = row.id.endsWith('-item_2') && row.content?.startsWith('Turn 2');
        const delivered = attested ? { ...row, transcriptMessageId: 'msg_b_2' } : row;
        result.current.appendRealtime(SID, delivered);
      }
    });
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: server, total: server.length, hasMore: false }),
    });
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });
    const shown = result.current.getMessages(SID);
    expect(shown.map((row) => row.id)).toEqual(server.map((row) => row.id));
  });

  it('never hides a new reply whose send the snapshot has not acknowledged yet', async () => {
    const { result } = renderHook(() => useSessionStore());
    const pendingUser = textRow('cmid_c2', 'user', 'q2', 10);
    const newReply = textRow(`codex-${TURN_NONCES[1]}-item_0`, 'assistant', 'Done.', 12,
      { responseToMessageId: 'cmid_c2' });
    await act(async () => {
      result.current.appendRealtime(SID, pendingUser);
      result.current.appendRealtime(SID, newReply);
    });
    const server = [
      textRow('msg_q1', 'user', 'q1', 1, { clientMsgId: 'cmid_c1' }),
      textRow('msg_b', 'assistant', 'Done.', 2),
    ];
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: server, total: server.length, hasMore: false }),
    });
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });
    expect(result.current.getMessages(SID).map((row) => row.id))
      .toEqual(['msg_q1', 'msg_b', 'cmid_c2', newReply.id]);
  });

  it('pairs exact text before a prefix so "OK" and "OK, done" both retire', async () => {
    const { result } = renderHook(() => useSessionStore());
    const reply = { responseToMessageId: 'cmid_ok' };
    await act(async () => {
      const nonce = TURN_NONCES[0];
      result.current.appendRealtime(SID,
        textRow(`codex-${nonce}-item_0`, 'assistant', 'OK', 2, reply));
      result.current.appendRealtime(SID,
        textRow(`codex-${nonce}-item_2`, 'assistant', 'OK, done', 4, reply));
    });
    const server = [
      textRow('msg_user_ok', 'user', 'go', 1, { clientMsgId: 'cmid_ok' }),
      textRow('msg_ok_done', 'assistant', 'OK, done', 2),
      textRow('msg_ok', 'assistant', 'OK', 3),
    ];
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: server, total: server.length, hasMore: false }),
    });
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });
    const shown = result.current.getMessages(SID);
    expect(shown.map((row) => row.id)).toEqual(server.map((row) => row.id));
  });
});
