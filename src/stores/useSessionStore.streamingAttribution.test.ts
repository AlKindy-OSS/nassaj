/**
 * B-43 — coordinator attribution on the *streaming* assistant row.
 *
 * The bug: `updateStreaming` rebuilt the streaming row from scratch on every
 * delta, so `coordinatorId` / `originKind` (stamped by the server on every
 * assistant payload, including `stream_delta`) were dropped. The bubble was
 * therefore attributed to the session owner while streaming and only snapped to
 * the real coordinator once the finalized history came back from the server —
 * a visible mis-attribution flash in multi-participant sessions.
 *
 * The fix (commit 9a9f06f5) stamps the attribution on the streaming row and
 * keeps a previously-stamped value when a later delta omits it. It shipped
 * without a regression test; this file is that guard.
 *
 * Invariants locked here (removing any of them re-opens B-43):
 *   1. attribution passed to `updateStreaming` lands on the streaming row;
 *   2. a later attribution-less delta does NOT wipe it (sticky);
 *   3. `finalizeStreaming` carries it onto the finalized text row;
 *   4. the streaming row stays a single row with the well-known id, replaced
 *      in place (mirrors / no-swap: array identity changes, row count does not).
 *
 * Run: NODE_ENV=test npx vitest run src/stores/useSessionStore.streamingAttribution.test.ts
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { SESSION_BUCKET_PROVIDERS } from '../../shared/sessionBuckets';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { applyStreamFrame } from '../contexts/streamFrameLog';

import { useSessionStore } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

const SESSION = 'sess-b43';
const STREAM_ID = `__streaming_${SESSION}`;

describe('response model survives stream batching and normalization across harnesses', () => {
  it.each(SESSION_BUCKET_PROVIDERS)(
    '%s preserves only the named response model through sparse deltas and completion', (provider) => {
      const { result } = renderHook(() => useSessionStore());
      let frames = applyStreamFrame(new Map(), {
        kind: 'stream_delta', sessionId: SESSION, provider, content: 'أ',
        responseToMessageId: 'run-one', model: 'actual-model-one',
      }, 1);
      frames = applyStreamFrame(frames, {
        kind: 'stream_delta', sessionId: SESSION, content: 'ب', responseToMessageId: 'run-one',
      }, 2);
      frames = applyStreamFrame(frames, { kind: 'stream_end', sessionId: SESSION }, 3);
      const snapshot = frames.get(SESSION)!;
      act(() => {
        result.current.setActiveSession(SESSION);
        result.current.updateStreaming(SESSION, snapshot.text, provider, snapshot.frame, 'run-one');
        result.current.updateStreaming(SESSION, snapshot.text, provider, { model: ' ' }, 'run-one');
        result.current.finalizeStreaming(SESSION, 'final-one');
      });
      const [reply] = normalizedToChatMessages(result.current.getMessages(SESSION));
      expect(reply.model).toBe('actual-model-one');
      expect(reply.turnDurationMs).toBeUndefined();
      act(() => result.current.updateStreaming(SESSION, 'التالي', provider, undefined, 'run-two'));
      const rows = normalizedToChatMessages(result.current.getMessages(SESSION));
      expect(rows.at(-1)?.model).toBeUndefined();
      expect(rows[0].model).toBe('actual-model-one');
    },
  );

  it('does not carry a model through an explicit run boundary before stream_end', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'first', 'codex', { model: 'first-model' }, 'one');
      result.current.updateStreaming(SESSION, 'second', 'codex', undefined, 'two');
    });
    expect(result.current.getMessages(SESSION).map(row => row.model)).toEqual(['first-model', undefined]);
    let frames = applyStreamFrame(new Map(), {
      kind: 'stream_delta', sessionId: SESSION, content: 'first', responseToMessageId: 'one', model: 'first-model',
    }, 1);
    frames = applyStreamFrame(frames, {
      kind: 'stream_delta', sessionId: SESSION, content: 'second', responseToMessageId: 'two',
    }, 2);
    expect(frames.get(SESSION)?.frame.model).toBeUndefined();
    expect(frames.get(SESSION)?.completed?.[0].frame.model).toBe('first-model');
  });
});

function streamRow(messages: NormalizedMessage[]): NormalizedMessage | undefined {
  return messages.find((m) => m.id === STREAM_ID);
}

describe('updateStreaming — coordinator attribution while streaming (B-43)', () => {
  it('stamps coordinatorId/originKind supplied with the first delta', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'مرح', 'claude', {
        coordinatorId: 7,
        originKind: 'coordinator',
      });
    });

    const row = streamRow(result.current.getMessages(SESSION));
    expect(row, 'streaming row missing').toBeDefined();
    expect(row?.kind).toBe('stream_delta');
    expect(row?.content).toBe('مرح');
    // Without the fix these are `undefined` and the bubble falls back to the
    // session owner for the whole duration of the stream.
    expect(row?.coordinatorId).toBe(7);
    expect(row?.originKind).toBe('coordinator');
  });

  it('keeps the stamped coordinatorId when a later delta omits attribution', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'مر', 'claude', { coordinatorId: 7 });
      // later chunks may arrive without the attribution fields
      result.current.updateStreaming(SESSION, 'مرحبا', 'claude');
    });

    const row = streamRow(result.current.getMessages(SESSION));
    expect(row?.content).toBe('مرحبا');
    expect(row?.coordinatorId, 'attribution lost by an attribution-less delta').toBe(7);
  });

  it('keeps the stamped coordinatorId when a later delta carries an explicit null', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'a', 'claude', {
        coordinatorId: 7,
        originKind: 'coordinator',
      });
      result.current.updateStreaming(SESSION, 'ab', 'claude', { coordinatorId: null });
    });

    const row = streamRow(result.current.getMessages(SESSION));
    expect(row?.coordinatorId).toBe(7);
    expect(row?.originKind).toBe('coordinator');
  });

  it('does not invent an attribution when none was ever supplied', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'plain', 'claude');
    });

    const row = streamRow(result.current.getMessages(SESSION));
    expect(row).toBeDefined();
    // Absent (not null): MessageComponent's documented "unknown ⇒ session owner"
    // fallback must stay reachable for legacy/unattributed runs.
    expect('coordinatorId' in (row as object)).toBe(false);
  });

  it('carries the attribution onto the finalized text row', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'done', 'claude', {
        coordinatorId: 12,
        originKind: 'coordinator',
      });
      result.current.finalizeStreaming(SESSION);
    });

    const messages = result.current.getMessages(SESSION);
    expect(streamRow(messages), 'streaming row should be renamed on finalize').toBeUndefined();
    const finalRow = messages.find((m) => m.kind === 'text' && m.role === 'assistant');
    expect(finalRow, 'finalized assistant row missing').toBeDefined();
    expect(finalRow?.coordinatorId).toBe(12);
    expect(finalRow?.originKind).toBe('coordinator');
  });

  it('carries a persisted response metric and full total onto the exact finalized reply', () => {
    const { result } = renderHook(() => useSessionStore());
    const responseToMessageId = 'user-run-model';

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(
        SESSION,
        'done',
        'claude',
        undefined,
        responseToMessageId,
      );
      result.current.finalizeStreaming(SESSION);
      result.current.applyResponseTurnCompletion(SESSION, {
        responseToMessageId,
        responseTurnMetric: {
          durationMs: 1_000,
          startedAt: '2026-08-19T00:00:00.000Z',
          completedAt: '2026-08-19T00:00:01.000Z',
        },
        responseTurnDurationTotalMs: 8_000,
        transcriptMessageId: 'msg-durable-model',
        // This is provider-attested transport data, not a UI/provider guess.
        model: 'claude-opus-5',
      });
    });

    const finalRow = result.current.getMessages(SESSION).find(
      (m) => m.kind === 'text' && m.role === 'assistant',
    );
    expect(finalRow?.model).toBe('claude-opus-5');
    expect(finalRow?.transcriptMessageId).toBe('msg-durable-model');
    expect(finalRow?.responseTurnMetric?.durationMs).toBe(1_000);
    expect(result.current.getSlot(SESSION).responseTurnDurationTotalMs).toBe(8_000);
  });

  it('links a live Codex item row to its durable msg id on completion', () => {
    const { result } = renderHook(() => useSessionStore());
    const responseToMessageId = 'codex-user-run';

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(
        SESSION,
        'codex answer',
        'codex',
        undefined,
        responseToMessageId,
      );
      result.current.finalizeStreaming(SESSION, 'item_live_answer');
      result.current.applyResponseTurnCompletion(SESSION, {
        responseToMessageId,
        responseTurnMetric: {
          durationMs: 2_300,
          startedAt: '2026-09-14T10:00:00.000Z',
          completedAt: '2026-09-14T10:00:02.300Z',
        },
        responseTurnDurationTotalMs: 2_300,
        transcriptMessageId: 'msg_answer',
        model: 'gpt-5.6-sol',
      });
    });

    const finalRow = result.current.getMessages(SESSION).find(
      (message) => message.id === 'item_live_answer',
    );
    expect(finalRow?.id).toBe('item_live_answer');
    expect(finalRow?.transcriptMessageId).toBe('msg_answer');
    expect(finalRow?.responseTurnMetric?.durationMs).toBe(2_300);
    expect(finalRow?.model).toBe('gpt-5.6-sol');
  });

  it('does not attach a metric across session boundaries', () => {
    const { result } = renderHook(() => useSessionStore());
    const responseToMessageId = 'user-run-safe';

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(
        SESSION,
        'done',
        'claude',
        undefined,
        responseToMessageId,
      );
      result.current.finalizeStreaming(SESSION);
      result.current.applyResponseTurnCompletion('another-session', {
        responseToMessageId,
        responseTurnMetric: {
          durationMs: 1_000,
          startedAt: '2026-08-19T00:00:00.000Z',
          completedAt: '2026-08-19T00:00:01.000Z',
        },
        responseTurnDurationTotalMs: 1_000,
      });
    });

    const finalRow = result.current.getMessages(SESSION).find(
      (m) => m.kind === 'text' && m.role === 'assistant',
    );
    expect(finalRow?.responseTurnMetric).toBeUndefined();
    expect(result.current.getSlot(SESSION).responseTurnDurationTotalMs).toBeNull();
  });

  it('starts a fresh turn without inheriting the previous coordinator', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'turn one', 'claude', { coordinatorId: 7 });
      result.current.finalizeStreaming(SESSION);
      // next run launched by a different participant
      result.current.updateStreaming(SESSION, 'turn two', 'claude', { coordinatorId: 9 });
    });

    const row = streamRow(result.current.getMessages(SESSION));
    expect(row?.coordinatorId).toBe(9);
  });

  it('replaces the streaming row in place — one row, new array identity (no-swap safe)', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.setActiveSession(SESSION);
      result.current.updateStreaming(SESSION, 'a', 'claude', { coordinatorId: 7 });
    });
    const firstArray = result.current.getSessionSlot(SESSION)?.realtimeMessages;

    act(() => {
      result.current.updateStreaming(SESSION, 'ab', 'claude', { coordinatorId: 7 });
    });
    const secondArray = result.current.getSessionSlot(SESSION)?.realtimeMessages;

    expect(secondArray?.length, 'streaming deltas must not accumulate rows').toBe(1);
    // A new array reference is what drives the merged recompute + subscriber
    // notification the live mirrors rely on.
    expect(secondArray).not.toBe(firstArray);
    expect(secondArray?.[0].coordinatorId).toBe(7);
  });
});
