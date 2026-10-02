/**
 * T-1904 e2e (bug 3) — «/steer <text>» يُعترَض دائماً بصرف النظر عن
 * `steerAvailable` (موافقة معطَّلة/سياسة معطَّلة/الدور لم يعد جارياً)، ولا
 * يسقط أبداً إلى مسار الرسالة العادية أو /api/commands/execute.
 *
 * الحادثة الميدانية المُصلَحة: كان الاعتراض يعتمد على إيجاد مدخلة "/steer"
 * داخل قائمة الأوامر الديناميكية (لا تُحقَن إلا حين canSteer صحيح)، فحين لم
 * تكن متاحة سقط النصّ إلى الإرسال العادي ورفضه الخادم بـ«session_busy» —
 * رسالة مضلِّلة بدل سبب التوجيه الحقيقي.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiCalls: Array<{ url: string; init?: RequestInit }> = [];

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
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: () => {},
  }),
}));
vi.mock('./useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: () => {},
    setCursorPosition: () => {},
    handleFileMentionsKeyDown: () => false,
  }),
}));
// No custom slash entries at all — proves the steer intercept does not
// depend on `/steer` being present in the (empty, here) command list.
vi.mock('./useSlashCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSlashCommands')>();
  return {
    ...actual,
    useSlashCommands: () => ({
      slashCommands: [],
      slashCommandsCount: 0,
      filteredCommands: [],
      frequentCommands: [],
      commandQuery: '',
      showCommandMenu: false,
      selectedCommandIndex: -1,
      resetCommandMenuState: () => {},
      handleCommandSelect: () => {},
      handleToggleCommandMenu: () => {},
      handleCommandInputChange: () => {},
      handleCommandMenuKeyDown: () => false,
    }),
  };
});
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async (url: string, init?: RequestInit) => {
    apiCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  },
}));
vi.mock('../utils/messageOutbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageOutbox')>();
  return {
    ...actual,
    recordOutboxEntryDurably: vi.fn(async (input: Parameters<typeof actual.recordOutboxEntry>[0]) => {
      const entry = actual.recordOutboxEntry(input);
      if (!entry) return null;
      if (await actual.verifyOutboxImagePersistence(entry, input.images ?? [])) return entry;
      await actual.removeOutboxEntryExplicit(entry.id);
      return null;
    }),
    markOutboxPendingDurably: vi.fn(async (id: string) => {
      if (!actual.markOutboxPending(id)) return null;
      return actual.getOutboxSnapshot().find((entry) => entry.id === id) ?? null;
    }),
  };
});

import { clearOutbox, setOutboxUser, setOutboxBlobStore } from '../utils/messageOutbox';

import { useChatComposerState } from './useChatComposerState';

const fakeSubmitEvent = { preventDefault: () => {} } as any;

function renderComposer(overrides: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const onSteerSend = vi.fn();
  const props = {
    selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
    selectedSession: { id: 's1', __provider: 'claude' },
    currentSessionId: 's1',
    provider: 'claude',
    displayProvider: 'claude',
    engineProvider: null,
    permissionMode: 'default',
    cyclePermissionMode: () => {},
    cursorModel: 'cursor', claudeModel: 'claude', codexModel: 'gpt-5',
    antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hermes', kimiModel: 'kimi',
    deepseekModel: 'deepseek', glmModel: 'glm', qwenModel: 'qwen',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message); return { ok: true }; },
    pendingViewSessionRef: { current: null },
    scrollToBottom: () => {},
    addMessage: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
    onSteerSend,
    steerAvailable: false, // consent/policy off or turn not active — the exact bug condition
    ...overrides,
  };
  return { ...renderHook(() => useChatComposerState(props as any)), sent, onSteerSend };
}

beforeEach(() => {
  clearOutbox();
  const images = new Map<string, File>();
  setOutboxBlobStore({
    put: async (key, file) => { images.set(key, file); },
    getMany: async (keys) => keys.flatMap((key) => { const file = images.get(key); return file ? [file] : []; }),
    deleteMany: async (keys) => { keys.forEach((key) => images.delete(key)); },
    clearAll: async () => { images.clear(); },
  });
  localStorage.clear();
  setOutboxUser(1);
  apiCalls.length = 0;
});

describe('/steer interception (steerAvailable=false)', () => {
  it('calls onSteerSend, never sends a normal chat message, never hits /api/commands/execute', async () => {
    const view = renderComposer();

    act(() => view.result.current.setInput('/steer focus on the bug'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onSteerSend).toHaveBeenCalledWith('focus on the bug');
    expect(view.sent).toHaveLength(0);
    expect(apiCalls.find((c) => c.url === '/api/commands/execute')).toBeUndefined();
    expect(view.result.current.input).toBe('');
  });

  it('works even while isLoading is true (a viewer must be able to steer mid-run)', async () => {
    const view = renderComposer({ isLoading: true });

    act(() => view.result.current.setInput('/steer stop doing that'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onSteerSend).toHaveBeenCalledWith('stop doing that');
    expect(view.sent).toHaveLength(0);
  });

  it('bare "/steer" with no text is ignored silently (no send, no error)', async () => {
    const view = renderComposer();

    act(() => view.result.current.setInput('/steer'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onSteerSend).not.toHaveBeenCalled();
    expect(view.sent).toHaveLength(0);
  });
});

/**
 * B-1469 — Enter while a reply is running (isLoading) must not silently
 * drop the keystroke. The composer keeps the text and shows an inline hint
 * instead (the user can only interrupt by stopping the run — no send queue).
 * `/steer` and `/btw` still bypass this guard and reach the agent mid-run.
 */
describe('submit guard while isLoading (B-1469)', () => {
  it('keeps the text and sets a hint instead of sending or dropping it', async () => {
    const view = renderComposer({ isLoading: true });

    act(() => view.result.current.setInput('one more question'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.sent).toHaveLength(0);
    expect(view.result.current.input).toBe('one more question');
    expect(view.result.current.sendError).toBe('composer.replyInProgress');
  });

  it('does not show the hint for an empty composer while isLoading', async () => {
    const view = renderComposer({ isLoading: true });

    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.sent).toHaveLength(0);
    expect(view.result.current.sendError).toBeNull();
  });

  it('/steer still reaches the agent while isLoading, no hint shown', async () => {
    const view = renderComposer({ isLoading: true });

    act(() => view.result.current.setInput('/steer stop doing that'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onSteerSend).toHaveBeenCalledWith('stop doing that');
    expect(view.sent).toHaveLength(0);
    expect(view.result.current.sendError).toBeNull();
  });

  it('/btw still reaches its own side-channel query while isLoading, no hint shown', async () => {
    const onBtwQuery = vi.fn();
    const view = renderComposer({ isLoading: true, onBtwQuery });

    act(() => view.result.current.setInput('/btw what changed so far?'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(onBtwQuery).toHaveBeenCalledWith('what changed so far?');
    expect(view.sent).toHaveLength(0);
    expect(view.result.current.sendError).toBeNull();
  });
});
