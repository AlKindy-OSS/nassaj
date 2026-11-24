/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — the composer's STOP and approval buttons
 * send turn-scoped, idempotent commands:
 *   - STOP names the turn the user saw (`targetTurnKey` from the run frames, or
 *     the pending send id before the first run frame) and carries one commandId
 *     per targeted turn, so a second press resends the same id;
 *   - an approval carries one commandId per requestId;
 *   - a final receipt (`stopped` / `not_running`) clears the spinner even when
 *     the broadcast `complete` was lost.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'khalid' } }),
}));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false, open: () => {} }),
}));
vi.mock('./useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false, filteredFiles: [], selectedFileIndex: 0, renderInputWithMentions: () => null,
    selectFile: () => {}, setCursorPosition: () => {}, handleFileMentionsKeyDown: () => false,
  }),
}));
vi.mock('./useSlashCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSlashCommands')>();
  return {
    ...actual,
    useSlashCommands: () => ({
      slashCommands: [], slashCommandsCount: 0, filteredCommands: [], frequentCommands: [], commandQuery: '',
      showCommandMenu: false, selectedCommandIndex: -1, resetCommandMenuState: () => {},
      handleCommandSelect: () => {}, handleToggleCommandMenu: () => {}, handleCommandInputChange: () => {},
      handleCommandMenuKeyDown: () => false,
    }),
  };
});
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
}));

import type { ControlFrameMap } from '../../../contexts/WebSocketContext';
import { recordTurnKeyFrame, rememberSentTurnKey, resetControlCommandState } from '../utils/controlCommandOutbox';

import { useChatComposerState } from './useChatComposerState';

function renderComposer(overrides: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const spies = { setIsLoading: vi.fn(), setCanAbortSession: vi.fn() };
  const props = {
    selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
    selectedSession: { id: 's1', __provider: 'claude' },
    currentSessionId: 's1',
    provider: 'claude', displayProvider: 'claude', engineProvider: null,
    permissionMode: 'default', cyclePermissionMode: () => {},
    cursorModel: 'cursor', claudeModel: 'claude', codexModel: 'gpt-5', antigravityModel: 'ag', opencodeModel: 'oc',
    hermesModel: 'hermes', kimiModel: 'kimi', deepseekModel: 'deepseek', glmModel: 'glm', qwenModel: 'qwen',
    isLoading: true, canAbortSession: true, tokenBudget: null,
    sendMessage: (message: Record<string, unknown>) => { sent.push(message); return { ok: true }; },
    pendingViewSessionRef: { current: null },
    scrollToBottom: () => {}, addMessage: () => {}, setClaudeStatus: () => {}, setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
    controlReceipts: new Map() as ControlFrameMap,
    ...spies,
    ...overrides,
  };
  const view = renderHook((current: typeof props) => useChatComposerState(current as any), { initialProps: props });
  return { ...view, sent, spies, props };
}

beforeEach(() => {
  resetControlCommandState();
  localStorage.clear();
});

describe('STOP', () => {
  it('names the turn from the run frames and carries a commandId', () => {
    recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'turn-1' });
    const view = renderComposer();
    act(() => view.result.current.handleAbortSession());
    expect(view.sent).toHaveLength(1);
    expect(view.sent[0]).toMatchObject({ type: 'abort-session', sessionId: 's1', provider: 'claude', targetTurnKey: 'turn-1' });
    expect(view.sent[0].commandId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
  });

  it('a second press on the same turn (after the safety timeout) resends the SAME commandId', () => {
    vi.useFakeTimers();
    try {
      recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'turn-1' });
      const view = renderComposer();
      act(() => view.result.current.handleAbortSession());
      act(() => { vi.advanceTimersByTime(10_000); });
      act(() => view.result.current.handleAbortSession());
      expect(view.sent).toHaveLength(2);
      expect(view.sent[1].commandId).toBe(view.sent[0].commandId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('condition 4: before any run frame the pending send id is the target', () => {
    rememberSentTurnKey(null, 'pending-send');
    const view = renderComposer({ currentSessionId: null, selectedSession: null });
    act(() => view.result.current.handleAbortSession());
    expect(view.sent[0]).toMatchObject({ type: 'abort-session', sessionId: '', targetTurnKey: 'pending-send' });
  });

  it('a final receipt clears the spinner of the session in view', () => {
    recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'turn-1' });
    const view = renderComposer();
    act(() => view.result.current.handleAbortSession());
    const commandId = view.sent[0].commandId as string;
    const receipts: ControlFrameMap = new Map([[commandId, { seq: 1, frame: {
      type: 'control-command-receipt', commandId, kind: 'abort', status: 'not_running', duplicate: true,
      result: { sessionId: 's1' },
    } }]]);
    view.rerender({ ...view.props, controlReceipts: receipts });
    expect(view.spies.setIsLoading).toHaveBeenCalledWith(false);
    expect(view.spies.setCanAbortSession).toHaveBeenCalledWith(false);
  });

  it('a stale_target receipt leaves the newer turn\'s spinner alone', () => {
    const view = renderComposer();
    const receipts: ControlFrameMap = new Map([['c', { seq: 1, frame: {
      type: 'control-command-receipt', commandId: 'c', kind: 'abort', status: 'stale_target', duplicate: false,
      result: { sessionId: 's1' },
    } }]]);
    view.rerender({ ...view.props, controlReceipts: receipts });
    expect(view.spies.setIsLoading).not.toHaveBeenCalledWith(false);
  });
});

describe('approval', () => {
  it('carries one commandId per requestId', () => {
    const view = renderComposer();
    act(() => view.result.current.handlePermissionDecision('req-1', { allow: true }));
    act(() => view.result.current.handlePermissionDecision('req-1', { allow: true }));
    act(() => view.result.current.handlePermissionDecision('req-2', { allow: false }));
    expect(view.sent.map((message) => message.type)).toEqual(Array(3).fill('claude-permission-response'));
    expect(view.sent[1].commandId).toBe(view.sent[0].commandId);
    expect(view.sent[2].commandId).not.toBe(view.sent[0].commandId);
    expect(view.sent[0]).toMatchObject({ requestId: 'req-1', allow: true });
  });
});
