/**
 * qa M5 — the agy session handover announcement (`session_created` for the
 * brain UUID with `parentSessionId` = the spawn key) migrates ONLY the view
 * that is on that spawn key; a user who switched chats before the run closed
 * keeps the chat they are looking at.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CONTROL_EVENT_KINDS, type ControlEventLog } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers, type StreamBuffer } from './useChatRealtimeHandlers';

/** The chat on screen is still addressed by its agy spawn key. */
const SPAWN_KEY = 'agy_1790531982349_26187fb5';
const BRAIN = 'e70cd70d-8a4f-4694-9304-37f6e440249e';

const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

function harness(viewed: string = SPAWN_KEY) {
  const appended: { sessionId: string; content?: string }[] = [];
  const replaced: { from: string; to: string }[] = [];
  const branched: { from: string; to: string }[] = [];
  const navigated: string[] = [];

  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: (sessionId: string, msg: any) =>
      appended.push({ sessionId, content: msg?.content }),
    appendRealtimeBatch: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: (from: string, to: string) => replaced.push({ from, to }),
    branchSessionId: (from: string, to: string) => branched.push({ from, to }),
  } as any;

  const props = {
    controlFrames: new Map() as any,
    provider: 'antigravity' as const,
    selectedSession: { id: viewed } as any,
    currentSessionId: viewed,
    setCurrentSessionId: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map<string, StreamBuffer>() } as any,
    onNavigateToSession: (id: string) => navigated.push(id),
    sessionStore,
  };

  const { rerender } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered }),
    { initialProps: { latestMessage: null, controlEvents: EMPTY_LOG } as any },
  );

  // مرآة الإنتاج (‏T-1293): أحداث التحكّم تُلحَق بالسجلّ **وتمرّ** إلى
  // `latestMessage` معاً — تفرّع لا تحويل. وما عداها يمرّ بالفتحة وحدها.
  let seq = 0;
  let events: { seq: number; frame: any }[] = [];
  const send = (m: any) => {
    if (m && CONTROL_EVENT_KINDS.has(m.kind)) {
      seq += 1;
      events = [...events, { seq, frame: m }];
    }
    rerender({ latestMessage: m, controlEvents: { events, droppedBeforeSeq: 0 } });
  };

  return { appended, replaced, branched, navigated, send };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

const announce = {
  kind: 'session_created',
  newSessionId: BRAIN,
  sessionId: BRAIN,
  parentSessionId: SPAWN_KEY,
  provider: 'antigravity',
};

describe('agy handover announcement', () => {
  it('moves the spawn-key view onto the brain UUID', () => {
    const h = harness();
    h.send(announce);
    assert.deepEqual(h.replaced, [{ from: SPAWN_KEY, to: BRAIN }]);
    assert.deepEqual(h.navigated, [BRAIN]);
  });

  it('leaves another chat alone when the user switched before close', () => {
    const h = harness('sess-other-chat');
    h.send(announce);
    assert.deepEqual(h.replaced, []);
    assert.deepEqual(h.navigated, []);
  });

  it('a replayed announcement after the view already moved migrates nothing', () => {
    const h = harness(BRAIN);
    h.send(announce);
    assert.deepEqual(h.replaced, []);
    assert.deepEqual(h.navigated.filter((id) => id !== BRAIN), []);
  });
});
