/**
 * ADR-199 T-1987 — progress status rows end to end on the LIVE path:
 * WebSocket frame → useChatRealtimeHandlers → real useSessionStore →
 * normalizedToChatMessages → useRunProgress, with `isLoading` driven by the
 * handler itself (the `complete` control event), not set by the test.
 *
 * Earlier tests fed the store's rows straight to the normalizer and so missed
 * that the handler never persisted `status` rows: the turn-end plan and the
 * background-agent settlements were dropped before reaching the store.
 *
 * Fixtures are the scrubbed real captures already in the repo:
 *  - agy-progress-history.real.json — rows the agy adapter emits for a turn
 *    (the live path sends the same status rows just before `complete`);
 *  - claude-task-plan-live.real.json — the Claude live-path rows, including
 *    the two background-agent settlement status rows.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { CONTROL_EVENT_KINDS, type ControlEventLog } from '../../../contexts/WebSocketContext';
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { getProviderCapabilities } from '../constants/providerCapabilities';

import agyCapture from './__fixtures__/agy-progress-history.real.json';
import claudeCapture from './__fixtures__/claude-task-plan-live.real.json';
import { resolveOverallPercent } from './declaredProgress';
import { resetSessionActivityEpochs } from './sessionActivity';
import { normalizedToChatMessages } from './useChatMessages';
import { useChatRealtimeHandlers, type StreamBuffer } from './useChatRealtimeHandlers';
import { useRunProgress } from './useRunProgress';

const AGY_ROWS = agyCapture.rows as unknown as NormalizedMessage[];
const CLAUDE_ROWS = claudeCapture.rows as unknown as NormalizedMessage[];
const isHumanPrompt = (m: NormalizedMessage) => m.kind === 'text' && m.role === 'user' && 'userId' in m;

interface Delivered { latestMessage: unknown; controlEvents: ControlEventLog }

/** Real store + real handler + real progress chain, as ChatInterface wires them. */
function mountLive(provider: string, sessionId: string) {
  const capability = getProviderCapabilities(provider).progress;
  const options = { keepPlanAfterStop: capability.plan === 'turn', statusSubagents: capability.subagents === 'turn' };
  const view = renderHook(
    ({ latestMessage, controlEvents }: Delivered) => {
      const store = useSessionStore();
      store.setActiveSession(sessionId); // ChatInterface does this for the viewed chat
      const [loading, setIsLoading] = useState(true); // the composer sets this on submit
      useChatRealtimeHandlers({
        latestMessage, controlEvents, controlFrames: new Map(), provider,
        selectedSession: { id: sessionId } as any, currentSessionId: sessionId,
        setCurrentSessionId: () => {}, setIsLoading, setCanAbortSession: () => {},
        setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
        pendingViewSessionRef: { current: null }, streamTimerRef: { current: null },
        accumulatedStreamRef: { current: new Map<string, StreamBuffer>() }, sessionStore: store,
      } as any);
      const chat = normalizedToChatMessages(store.getMessages(sessionId));
      return { store, loading, progress: useRunProgress(chat, loading, options) };
    },
    { initialProps: { latestMessage: null, controlEvents: { events: [], droppedBeforeSeq: 0 } } as Delivered },
  );
  let seq = 0;
  let events: ControlEventLog['events'] = [];
  const send = (frame: Record<string, unknown>) => act(() => {
    if (CONTROL_EVENT_KINDS.has(frame.kind as string)) events = [...events, { seq: ++seq, frame }];
    view.rerender({ latestMessage: frame, controlEvents: { events, droppedBeforeSeq: 0 } });
  });
  /** A prompt the user just wrote: the composer adds it to the store locally. */
  const prompt = (row: NormalizedMessage) => act(() => {
    view.result.current.store.appendRealtime(sessionId, row);
    view.rerender({ latestMessage: null, controlEvents: { events, droppedBeforeSeq: 0 } });
  });
  const rows = () => view.result.current.store.getMessages(sessionId);
  return { send, prompt, rows, isLoading: () => view.result.current.loading, progress: () => view.result.current.progress };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

describe('agy turn-end plan through the live handler', () => {
  const sid = AGY_ROWS[0].sessionId;
  const promptRow = AGY_ROWS.find(isHumanPrompt)!;
  const replyRows = AGY_ROWS.filter((m) => m !== promptRow && m.kind !== 'status');
  const statusRows = AGY_ROWS.filter((m) => m.kind === 'status');

  function runTurn(order: 'reply-first' | 'status-first') {
    const live = mountLive('antigravity', sid);
    live.prompt(promptRow);
    const later = (m: NormalizedMessage) => ({ ...m, timestamp: '2026-09-27T21:16:00Z' });
    const reply = order === 'reply-first' ? replyRows : replyRows.map(later);
    if (order === 'reply-first') reply.forEach((m) => live.send({ ...m }));
    statusRows.forEach((m) => live.send({ ...m }));
    if (order === 'status-first') reply.forEach((m) => live.send({ ...m }));
    return live;
  }

  it('the plan is visible during the run, 2/5 with one in progress → 50%', () => {
    const live = runTurn('reply-first');
    const p = live.progress();
    assert.deepEqual([p.done, p.inProgress, p.total], [2, 1, 5]);
    assert.deepEqual(resolveOverallPercent(p), { percent: 50, source: 'tasks' });
  });

  it('stays visible, settled, after `complete` stops the run', () => {
    const live = runTurn('reply-first');
    live.send({ kind: 'complete', sessionId: sid, exitCode: 0 });
    assert.equal(live.isLoading(), false, 'complete must stop the run');
    const p = live.progress();
    assert.equal(p.settled, true);
    assert.deepEqual([p.done, p.total], [2, 5]);
    assert.deepEqual([p.agents.length, p.activeSubagent], [0, null], 'settled keeps the plan only');
    assert.deepEqual([p.agentsDone, p.agentsTotal], [1, 1]);
  });

  it('is cleared by the next human prompt', () => {
    const live = runTurn('reply-first');
    live.send({ kind: 'complete', sessionId: sid, exitCode: 0 });
    live.prompt({ ...promptRow, id: 'next-prompt', timestamp: '2026-09-27T23:00:00Z' });
    assert.equal(live.progress().total, 0);
    assert.equal(live.progress().settled, undefined);
  });

  it('the status-only subagent is counted while the run is live', () => {
    const p = runTurn('reply-first').progress();
    assert.equal(p.agentsTotal, 1);
    assert.deepEqual(p.agents.map((a) => [a.description, a.status]), [['scribe', 'done']]);
  });

  it('a plan sorted ahead of a later-stamped reply still reaches that reply', () => {
    const p = runTurn('status-first').progress();
    assert.deepEqual([p.done, p.total, p.agentsTotal], [2, 5, 1]);
  });
});

describe('Claude background agents close live from status rows', () => {
  const sid = CLAUDE_ROWS[0].sessionId;
  const promptRow = CLAUDE_ROWS.find(isHumanPrompt)!;
  const firstStatus = CLAUDE_ROWS.findIndex((m) => m.kind === 'status');

  function feed(rows: NormalizedMessage[]) {
    const live = mountLive('claude', sid);
    live.prompt(promptRow);
    rows.filter((m) => m !== promptRow).forEach((m) => live.send({ ...m }));
    return live;
  }

  it('before the notifications both agents run', () => {
    const p = feed(CLAUDE_ROWS.slice(0, firstStatus)).progress();
    assert.deepEqual(p.agents.map((a) => a.status), ['running', 'running']);
    assert.ok(p.activeSubagent);
  });

  it('the settlement status rows close both agents without counting them twice', () => {
    const p = feed(CLAUDE_ROWS).progress();
    assert.deepEqual(p.agents.map((a) => a.status), ['done', 'done']);
    assert.deepEqual([p.agentsDone, p.agentsTotal], [2, 2]);
    assert.equal(p.activeSubagent, null);
  });

  it('nothing stays after the run stops (capability is not `turn`)', () => {
    const live = feed(CLAUDE_ROWS);
    live.send({ kind: 'complete', sessionId: sid, exitCode: 0 });
    assert.equal(live.isLoading(), false);
    assert.equal(live.progress().total, 0);
    assert.equal(live.progress().settled, undefined);
  });
});

describe('text-only status rows are still not persisted', () => {
  it('a spinner status leaves the store unchanged', () => {
    const sid = AGY_ROWS[0].sessionId;
    const live = mountLive('antigravity', sid);
    live.prompt(AGY_ROWS.find(isHumanPrompt)!);
    live.send({ kind: 'status', sessionId: sid, text: 'Thinking', id: 'spin-1' });
    assert.equal(live.rows().some((m) => m.id === 'spin-1'), false);
  });
});
