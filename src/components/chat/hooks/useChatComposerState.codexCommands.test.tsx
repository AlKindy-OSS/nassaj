/** B-614 — Codex built-ins announced by the server never become chat prompts. */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let executeResponse: { ok: boolean; status?: number; body: unknown };
let language = 'en';
const apiCalls: Array<{ url: string; init?: RequestInit }> = [];
type ExecuteHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
let executeFetch: () => Promise<ExecuteHttpResponse>;

function responseFrom(value: typeof executeResponse): ExecuteHttpResponse {
  return {
    ok: value.ok,
    status: value.status ?? (value.ok ? 200 : 500),
    json: async () => value.body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue || key);
      return template.replace('{{message}}', String(options?.message || ''));
    },
    i18n: { get language() { return language; } },
  }),
}));
vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
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
vi.mock('./useSlashCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSlashCommands')>();
  const review = {
    name: '/review',
    namespace: 'builtin',
    type: 'built-in',
    metadata: { type: 'builtin', hasHandler: false },
  };
  return {
    ...actual,
    useSlashCommands: () => ({
      slashCommands: [review],
      slashCommandsCount: 1,
      filteredCommands: [review],
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
    return executeFetch();
  },
}));

/* jsdom has neither IndexedDB nor the origin-wide Web Lock required by the
 * production admission boundary.  This adapter keeps composer orchestration
 * honest: it uses the real legacy entry/image writer supplied by each test,
 * waits for its image readback, and rolls the entry back on failure.  Real
 * IndexedDB/lock atomicity is covered separately in the browser harness. */
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
      return actual.getOutboxSnapshot().find(entry => entry.id === id) ?? null;
    }),
  };
});


import { clearOutbox, setOutboxUser, recordOutboxEntry, getOutboxSnapshot, markOutboxFailed, setOutboxBlobStore, MAX_OUTBOX_ENTRIES, type OutboxBlobStore } from '../utils/messageOutbox';

import { useChatComposerState } from './useChatComposerState';

const fakeSubmitEvent = { preventDefault: () => {} } as any;

function renderComposer(provider = 'codex', overrides: Record<string, unknown> = {}) {
  const added: any[] = [];
  const sent: any[] = [];
  const onBtwQuery = vi.fn();
  const props = {
    selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
    selectedSession: { id: 's1', __provider: provider },
    currentSessionId: 's1',
    provider,
    displayProvider: provider,
    engineProvider: null,
    permissionMode: 'default',
    cyclePermissionMode: () => {},
    cursorModel: 'cursor', claudeModel: 'claude', codexModel: 'gpt-5',
    antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hermes', kimiModel: 'kimi',
    deepseekModel: 'deepseek', glmModel: 'glm',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message); return { ok: true }; },
    pendingViewSessionRef: { current: null },
    scrollToBottom: () => {},
    addMessage: (message: unknown) => added.push(message),
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
    onBtwQuery,
    ...overrides,
  };
  return { ...renderHook(() => useChatComposerState(props as any)), props, added, sent, onBtwQuery };
}

beforeEach(() => {
  clearOutbox();
  const images = new Map<string, File>();
  setOutboxBlobStore({
    put: async (key, file) => { images.set(key, file); },
    getMany: async keys => keys.flatMap(key => { const file = images.get(key); return file ? [file] : []; }),
    deleteMany: async keys => { keys.forEach(key => images.delete(key)); },
    clearAll: async () => { images.clear(); },
  });
  localStorage.clear();
  setOutboxUser(1);
  apiCalls.length = 0;
  executeResponse = { ok: true, body: {} };
  language = 'en';
  executeFetch = async () => responseFrom(executeResponse);
});

describe('Codex command execution', () => {
  it('يطبع /ضغط العربي إلى الاسم القياسي فقط قبل تنفيذ Codex', async () => {
    language = 'ar';
    // Mirror the server's builtin compact result; an empty body is an invalid result.
    executeResponse = {
      ok: true,
      body: { type: 'builtin', action: 'compact', data: { message: 'Codex context compaction completed.' } },
    };
    const view = renderComposer();

    act(() => view.result.current.setInput('/ضغط'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    const executeCall = apiCalls.find((call) => call.url === '/api/commands/execute');
    expect(JSON.parse(String(executeCall?.init?.body))).toMatchObject({ commandName: '/compact' });
    expect(view.sent).toHaveLength(0);
    expect(view.added).toEqual([
      expect.objectContaining({ type: 'assistant', content: 'Codex context compaction completed.' }),
    ]);
  });

  it('يرسل /بالمناسبة العربي إلى القناة الجانبية باسم canonical فقط', async () => {
    language = 'ar';
    const view = renderComposer();

    act(() => view.result.current.setInput('/بالمناسبة افحص الجولة الحالية'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onBtwQuery).toHaveBeenCalledWith('افحص الجولة الحالية');
    expect(view.sent).toHaveLength(0);
    expect(view.added).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it.each([
    ['/جانبي سؤال', 'سؤال'],
    ['/side سؤال', 'سؤال'],
  ])('يوجه %s عبر currentSessionId حتى إن غابت selectedSession', async (input, question) => {
    language = 'ar';
    const view = renderComposer('codex', { selectedSession: null, currentSessionId: 's1' });

    act(() => view.result.current.setInput(input));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onBtwQuery).toHaveBeenCalledWith(question);
    expect(view.sent).toHaveLength(0);
    expect(view.added).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it('يعرض feedback للمرادف الجانبي بلا جلسة ولا يمرره', async () => {
    language = 'ar';
    const view = renderComposer('codex', { selectedSession: null, currentSessionId: null });

    act(() => view.result.current.setInput('/جانبي سؤال'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.result.current.sendError).toBe('btw.errors.session_not_found');
    expect(view.onBtwQuery).not.toHaveBeenCalled();
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it.each([
    ['/side سؤال', 'btw.errors.session_not_found'],
    ['/side', 'btw.errors.question_required'],
  ])('يحجز %s ولا يمرره إلى النقل العام عند فشل الحارس', async (input, expectedError) => {
    const hasSession = input === '/side';
    const view = renderComposer('codex', hasSession ? {} : { selectedSession: null, currentSessionId: null });

    act(() => view.result.current.setInput(input));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.result.current.sendError).toBe(expectedError);
    expect(view.onBtwQuery).not.toHaveBeenCalled();
    expect(view.sent).toHaveLength(0);
    expect(view.added).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it('يحجز /btw بلا جلسة في مزوّد يدعم القناة الجانبية', async () => {
    const view = renderComposer('claude', { selectedSession: null, currentSessionId: null });

    act(() => view.result.current.setInput('/btw سؤال'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.result.current.sendError).toBe('btw.errors.session_not_found');
    expect(view.onBtwQuery).not.toHaveBeenCalled();
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it('يعرض feedback عند غياب callback للقناة الجانبية ولا يرسل الأمر', async () => {
    const view = renderComposer('codex', { onBtwQuery: undefined });

    act(() => view.result.current.setInput('/side سؤال'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.result.current.sendError).toBe('btw.errors.sdk_error');
    expect(view.sent).toHaveLength(0);
    expect(view.added).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it('يعرض feedback للمرادف الجانبي بلا سؤال ولا يمرره', async () => {
    language = 'ar';
    const view = renderComposer();

    act(() => view.result.current.setInput('/بالمناسبة'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.result.current.sendError).toBe('btw.errors.question_required');
    expect(view.onBtwQuery).not.toHaveBeenCalled();
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);

    act(() => view.result.current.setInput('/بالمناسبة سؤال صالح'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.result.current.sendError).toBeNull();
    expect(view.onBtwQuery).toHaveBeenCalledWith('سؤال صالح');
  });

  it('يلغي مؤقت تنبيه alias الجانبي عند إلغاء تحميل المؤلف', async () => {
    language = 'ar';
    const clearTimer = vi.spyOn(global, 'clearTimeout');
    const view = renderComposer();

    act(() => view.result.current.setInput('/جانبي'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    view.unmount();

    expect(clearTimer).toHaveBeenCalled();
    clearTimer.mockRestore();
  });

  it('يوجّه /side إلى قناة Codex الجانبية ولا يرسله كرسالة أو أمر HTTP', async () => {
    const view = renderComposer();

    act(() => view.result.current.setInput('/side inspect the active turn'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onBtwQuery).toHaveBeenCalledOnce();
    expect(view.onBtwQuery).toHaveBeenCalledWith('inspect the active turn');
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
    expect(view.result.current.input).toBe('');
  });

  it('لا يعترض /side المكتوب يدوياً في جلسة Claude', async () => {
    const view = renderComposer('claude');

    act(() => view.result.current.setInput('/side inspect the active turn'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.onBtwQuery).not.toHaveBeenCalled();
    expect(apiCalls).toHaveLength(0);
    expect(view.sent).toHaveLength(1);
    expect(view.sent[0]).toMatchObject({
      type: 'claude-command',
      command: '/side inspect the active turn',
    });
  });

  it('يعرض markdown من الأمر المعلن ولا يرسله إلى WebSocket كنص عادي', async () => {
    executeResponse = {
      ok: true,
      body: { type: 'builtin', action: 'review', content: '## Review complete' },
    };
    const view = renderComposer();

    act(() => view.result.current.setInput('/review security'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    const executeCall = apiCalls.find((call) => call.url === '/api/commands/execute');
    expect(JSON.parse(String(executeCall?.init?.body))).toMatchObject({
      commandName: '/review',
      args: ['security'],
      context: { provider: 'codex', sessionId: 's1' },
    });
    expect(view.sent).toHaveLength(0);
    expect(view.added).toContainEqual(expect.objectContaining({
      type: 'assistant',
      content: '## Review complete',
    }));
  });

  it('يعرض فشل تنفيذ الأمر ولا يمرره إلى المحادثة', async () => {
    executeResponse = {
      ok: false,
      status: 409,
      body: { error: 'Review is already running' },
    };
    const view = renderComposer();

    act(() => view.result.current.setInput('/review'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    await waitFor(() => expect(view.added).toContainEqual(expect.objectContaining({
      type: 'assistant',
      content: 'Error executing command: Review is already running',
    })));
    expect(view.sent).toHaveLength(0);
  });

  it('يعرض البيانات المنظمة ولا يدّعي نجاحاً بلا نتيجة', async () => {
    executeResponse = {
      ok: true,
      body: {
        type: 'builtin',
        action: 'mcp',
        data: { servers: [{ name: 'docs', status: 'connected' }] },
      },
    };
    const view = renderComposer();

    act(() => view.result.current.setInput('/review'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    expect(view.added).toContainEqual(expect.objectContaining({
      type: 'assistant',
      content: expect.stringContaining('"status": "connected"'),
    }));
    expect(view.sent).toHaveLength(0);
  });

  it('يقفل طلبي /compact المتزامنين ويعرض التنفيذ حتى النجاح ثم يتيح طلباً لاحقاً', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer();

    act(() => view.result.current.setInput('/compact'));
    await act(async () => {
      void view.result.current.handleSubmit(fakeSubmitEvent);
      void view.result.current.handleSubmit(fakeSubmitEvent);
    });

    expect(apiCalls.filter((call) => call.url === '/api/commands/execute')).toHaveLength(1);
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 's1' });

    await act(async () => {
      pending.resolve(responseFrom({
        ok: true,
        body: { type: 'builtin', action: 'compact', data: { message: 'Compaction started' } },
      }));
      await pending.promise;
    });
    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());

    executeResponse = {
      ok: true,
      body: { type: 'builtin', action: 'compact', data: { message: 'Compaction restarted' } },
    };
    executeFetch = async () => responseFrom(executeResponse);
    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    await waitFor(() => expect(apiCalls.filter((call) => call.url === '/api/commands/execute')).toHaveLength(2));
    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());
  });

  it('يرسل /compact إلى الجلسة المحددة عند غياب currentSessionId', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer('codex', { currentSessionId: null, selectedSession: { id: 'selected-s1', __provider: 'codex' } });

    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    const request = apiCalls.find((call) => call.url === '/api/commands/execute');
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      context: { sessionId: 'selected-s1', provider: 'codex' },
    });
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 'selected-s1' });

    await act(async () => {
      pending.resolve(responseFrom({ ok: true, body: { type: 'builtin', action: 'compact', data: {} } }));
      await pending.promise;
    });
  });

  it('يبقي قفل الجلسة الثانية بعد تسوية compact في الأولى', async () => {
    const first = deferred<ExecuteHttpResponse>();
    const second = deferred<ExecuteHttpResponse>();
    const pending = [first, second];
    executeFetch = () => pending.shift()!.promise;
    const view = renderComposer();

    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));

    view.props.currentSessionId = 's2';
    view.props.selectedSession = { id: 's2', __provider: 'codex' };
    act(() => view.rerender());
    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 's2' });

    await act(async () => {
      first.resolve(responseFrom({ ok: true, body: { type: 'builtin', action: 'compact', data: {} } }));
      await first.promise;
    });
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 's2' });

    await act(async () => {
      second.resolve(responseFrom({ ok: true, body: { type: 'builtin', action: 'compact', data: {} } }));
      await second.promise;
    });
    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());
  });

  it('يحصر تنفيذ /compact في جلسته ولا يعطّل جلسة أخرى', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer();

    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 's1' });

    view.props.currentSessionId = 's2';
    view.props.selectedSession = { id: 's2', __provider: 'codex' };
    act(() => view.rerender());
    expect(view.result.current.executingCommand).toBeNull();

    act(() => view.result.current.setInput('رسالة للجلسة الثانية'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.sent).toContainEqual(expect.objectContaining({
      type: 'codex-command',
      sessionId: 's2',
      command: 'رسالة للجلسة الثانية',
    }));

    view.props.currentSessionId = 's1';
    view.props.selectedSession = { id: 's1', __provider: 'codex' };
    act(() => view.rerender());
    expect(view.result.current.executingCommand).toEqual({ name: '/compact', sessionId: 's1' });

    await act(async () => {
      pending.resolve(responseFrom({
        ok: true,
        body: { type: 'builtin', action: 'compact', data: { message: 'Done' } },
      }));
      await pending.promise;
    });
    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());
  });

  it('يحرر قفل الأمر بعد الفشل ويسمح بإعادة المحاولة', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer();

    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.result.current.executingCommand?.name).toBe('/compact');

    await act(async () => {
      pending.resolve(responseFrom({
        ok: false,
        status: 503,
        body: { error: 'Compaction unavailable' },
      }));
      await pending.promise;
    });
    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());
    expect(view.added).toContainEqual(expect.objectContaining({
      content: 'Error executing command: Compaction unavailable',
    }));

    executeResponse = {
      ok: true,
      body: { type: 'builtin', action: 'compact', data: { message: 'Retry accepted' } },
    };
    executeFetch = async () => responseFrom(executeResponse);
    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    await waitFor(() => expect(apiCalls.filter((call) => call.url === '/api/commands/execute')).toHaveLength(2));
  });

  it('لا يمحو مسودة جديدة كُتبت أثناء انتظار نتيجة builtin', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer();

    act(() => view.result.current.setInput('/compact'));
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.result.current.executingCommand?.name).toBe('/compact');
    expect(view.result.current.input).toBe('');

    act(() => view.result.current.setInput('مسودة كُتبت أثناء التنفيذ'));
    await act(async () => {
      pending.resolve(responseFrom({
        ok: true,
        body: { type: 'builtin', action: 'compact', data: { message: 'Done' } },
      }));
      await pending.promise;
    });

    await waitFor(() => expect(view.result.current.executingCommand).toBeNull());
    expect(view.result.current.input).toBe('مسودة كُتبت أثناء التنفيذ');
  });
});


it('B-894 refuses a full outbox before dispatch and preserves the composer', async () => {
  for (let n = 0; n < MAX_OUTBOX_ENTRIES; n++) {
    recordOutboxEntry({ id: `held-${n}`, projectId: 'p1', sessionId: 's1', text: 'held', status: 'unconfirmed' });
  }
  const view = renderComposer('claude');
  act(() => view.result.current.setInput('Keep this unsent draft'));
  await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
  expect(view.sent).toHaveLength(0);
  expect(view.result.current.input).toBe('Keep this unsent draft');
});


describe('B-894 original payload eligibility', () => {
  it.each(['qwen', 'hermes', 'kimi', 'deepseek', 'glm', 'claude', 'codex', 'cursor', 'opencode', 'antigravity'])(
    '%s sends a completeness manifest only on eligible text receipt paths', async (provider) => {
      const view = renderComposer(provider);
      act(() => view.result.current.setInput('Same text'));
      await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
      expect(getOutboxSnapshot()[0].historyEligibility).toBe('text_only');
      const expected = ['claude', 'qwen', 'hermes', 'kimi', 'deepseek', 'glm'].includes(provider);
      expect(view.sent[0].options.receiptPayload).toEqual(expected
        ? { version: 1, kind: 'text', imageCount: 0, fileCount: 0 } : undefined);
      view.unmount();
    });

  it.each([['qwen', 'image'], ['qwen', 'file'], ['claude', 'image'], ['claude', 'file']])('keeps %s original %s ineligible when upload returns no attachments', async (provider, kind) => {
    executeResponse = { ok: true, body: { images: [], files: [] } };
    const view = renderComposer(provider);
    act(() => {
      view.result.current.setInput('Same text');
      const file = new File(['payload'], kind === 'image' ? 'a.png' : 'a.txt', { type: kind === 'image' ? 'image/png' : 'text/plain' });
      if (kind === 'image') view.result.current.setAttachedImages([file]);
      else view.result.current.setAttachedFiles([file]);
    });
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(getOutboxSnapshot()[0].historyEligibility).toBe('ineligible');
    expect(view.sent[0].options.receiptPayload).toBeUndefined();
    view.unmount();
  });

  it('B-1078: a claude image message mints a receipt with the real image count', async () => {
    executeResponse = { ok: true, body: { images: [{ data: 'AA==' }], files: [] } };
    const view = renderComposer('claude');
    act(() => {
      view.result.current.setInput('قلل الهدر هنا برضو');
      view.result.current.setAttachedImages([new File(['x'], 'shot.png', { type: 'image/png' })]);
    });
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    // Image messages stay outbox-ineligible (attachments are not durably replayable),
    // yet still declare a text receipt so the folded transcript row can be paired.
    expect(getOutboxSnapshot()[0].historyEligibility).toBe('ineligible');
    expect(view.sent[0].options.receiptPayload).toEqual({ version: 1, kind: 'text', imageCount: 1, fileCount: 0 });
    expect((view.sent[0].options.images as unknown[]).length).toBe(1);
    view.unmount();
  });

  it('B-1078: a claude file message mints a receipt with the real file count', async () => {
    executeResponse = { ok: true, body: { images: [], files: [{ path: '/tmp/a.txt', name: 'a.txt' }] } };
    const view = renderComposer('claude');
    act(() => {
      view.result.current.setInput('راجع الملف');
      view.result.current.setAttachedFiles([new File(['x'], 'a.txt', { type: 'text/plain' })]);
    });
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.sent[0].options.receiptPayload).toEqual({ version: 1, kind: 'text', imageCount: 0, fileCount: 1 });
    expect((view.sent[0].options.files as unknown[]).length).toBe(1);
    view.unmount();
  });

  it.each([true, false].flatMap(sameId => ['qwen', 'claude'].map(provider => [sameId, provider] as const)))('retry refuses unknown original files (same ID: %s, %s)', async (sameId, provider) => {
    recordOutboxEntry({ id: 'original-file', projectId: 'p1', sessionId: 's1', text: 'Same text',
      historyEligibility: 'ineligible', intent: { provider } });
    markOutboxFailed('original-file', { code: 'transport', sameClientMsgIdRetryable: sameId });
    const view = renderComposer(provider);
    await act(async () => view.result.current.retryOutboxEntry('original-file'));
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
    expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'original-file', historyEligibility: 'ineligible', retryBlockCode: 'attachment_payload_unknown' });
    view.unmount();
  });

  it.each(['qwen', 'claude'])('%s legacy retries cannot acquire a text-only declaration', async (provider) => {
    recordOutboxEntry({ id: 'legacy', projectId: 'p1', sessionId: 's1', text: 'Same text',
      status: 'failed', intent: { provider } });
    const view = renderComposer(provider);
    await act(async () => view.result.current.retryOutboxEntry('legacy'));
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
    expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'legacy', retryBlockCode: 'attachment_payload_unknown' });
    view.unmount();
  });

  it.each(['hermes', 'claude'])('%s manual verification preserves an ineligible copy on a positive text receipt', async (provider) => {
    recordOutboxEntry({ id: 'file-check', projectId: 'p1', sessionId: 's1', text: 'Same text',
      historyEligibility: 'ineligible', intent: { provider } });
    const view = renderComposer(provider, { verifyMessageDelivered: async () => true });
    await act(async () => view.result.current.verifyOutboxEntry('file-check'));
    expect(getOutboxSnapshot().find(entry => entry.id === 'file-check')?.status).toBe('delivered');
    view.unmount();
  });
});


it.each(['kimi', 'glm'])('B-894 excludes the %s native agent path', async (provider) => {
  vi.stubEnv('VITE_NASSAJ_OPENCODE_CARRIER', 'true');
  const view = renderComposer(provider);
  try {
    act(() => { view.result.current.setComposerMode('agent'); view.result.current.setInput('hello'); });
    await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
    expect(view.sent[0].options.mode).toBe('agent');
    expect(view.sent[0].options.receiptPayload).toBeUndefined();
  } finally { view.unmount(); vi.unstubAllEnvs(); }
});

it.each([true, false])('B-894 preserves eligible text on retry (same ID: %s)', async (sameId) => {
  recordOutboxEntry({ id: 'original-text', projectId: 'p1', sessionId: 's1', text: 'hello',
    historyEligibility: 'text_only', intent: { provider: 'qwen' } });
  markOutboxFailed('original-text', { code: 'transport', sameClientMsgIdRetryable: sameId });
  const view = renderComposer('qwen');
  await act(async () => view.result.current.retryOutboxEntry('original-text'));
  expect(view.sent[0].options.receiptPayload).toEqual({ version: 1, kind: 'text', imageCount: 0, fileCount: 0 });
  expect(getOutboxSnapshot()[0].historyEligibility).toBe('text_only');
  view.unmount();
});


describe('B-894 complete attachment retry guard', () => {
  const images = () => ['first.png', 'second.png'].map(name => new File([name], name, { type: 'image/png' }));
  function storeWith(read: () => Promise<File[]>) {
    const deleteMany = vi.fn<OutboxBlobStore['deleteMany']>(async () => {});
    setOutboxBlobStore({ put: async () => {}, getMany: read, deleteMany, clearAll: async () => {} });
    return deleteMany;
  }

  it.each([true, false].flatMap(sameId => ['missing', 'partial', 'throw', 'files', 'legacy'].map(kind => [sameId, kind] as const)))(
    'blocks incomplete payload before all effects (same ID %s, %s)', async (sameId, kind) => {
      const originalImages = images();
      const read = vi.fn(async () => {
        if (kind === 'throw') throw new Error('IDB unavailable');
        return kind === 'partial' ? originalImages.slice(1) : [];
      });
      const deleteMany = storeWith(read);
      const fileNames = kind === 'legacy' ? undefined : kind === 'files' ? ['source.pdf'] : [];
      recordOutboxEntry({ id: 'held', projectId: 'p1', sessionId: 's1', text: 'Do not lose attachments',
        images: ['files', 'legacy'].includes(kind) ? [] : originalImages, fileNames,
        historyEligibility: 'ineligible', intent: { provider: 'qwen' } });
      markOutboxFailed('held', { code: 'conversation_not_found', sameClientMsgIdRetryable: sameId });
      const original = getOutboxSnapshot()[0];
      const randomUUID = vi.spyOn(crypto, 'randomUUID');
      const view = renderComposer('qwen');
      try {
        await act(async () => view.result.current.retryOutboxEntry('held'));
        expect(view.sent).toHaveLength(0);
        expect(apiCalls).toHaveLength(0);
        expect(randomUUID).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
        expect(getOutboxSnapshot()).toHaveLength(1);
        expect(getOutboxSnapshot()[0]).toMatchObject(original);
        expect(getOutboxSnapshot()[0].retryBlockCode).toBe({ missing: 'attachment_images_missing', partial: 'attachment_images_incomplete',
          throw: 'attachment_images_unreadable', files: 'attachment_files_unavailable', legacy: 'attachment_payload_unknown' }[kind]);
        if (kind === 'files' || kind === 'legacy') expect(read).not.toHaveBeenCalled();
      } finally { randomUUID.mockRestore(); view.unmount(); }
    });

  it.each([true, false].flatMap(sameId => ['http', 'throw', 'empty', 'partial'].map(kind => [sameId, kind] as const)))(
    'retains original after unsuccessful upload (same ID %s, %s)', async (sameId, kind) => {
      const originalImages = images();
      const deleteMany = storeWith(async () => originalImages);
      recordOutboxEntry({ id: 'held-upload', projectId: 'p1', sessionId: 's1', text: 'with images', images: originalImages,
        fileNames: [], historyEligibility: 'ineligible', intent: { provider: 'codex' } });
      markOutboxFailed('held-upload', { code: 'transport', sameClientMsgIdRetryable: sameId });
      const original = getOutboxSnapshot()[0];
      executeFetch = async () => {
        if (kind === 'throw') throw new Error('network');
        return responseFrom({ ok: kind !== 'http', body: { images: kind === 'partial' ? [{ path: 'only-one' }] : [] } });
      };
      const randomUUID = vi.spyOn(crypto, 'randomUUID');
      const view = renderComposer();
      try {
        await act(async () => view.result.current.retryOutboxEntry('held-upload'));
        expect(view.sent).toHaveLength(0);
        expect(apiCalls).toHaveLength(1);
        // B-969 prepares a durable replacement before HTTP; only that unsent copy may be removed.
        if (sameId) {
          expect(randomUUID).not.toHaveBeenCalled();
          expect(deleteMany).not.toHaveBeenCalled();
        } else {
          expect(randomUUID).toHaveBeenCalledTimes(1);
          expect(deleteMany).toHaveBeenCalled();
          expect(deleteMany.mock.calls.every(([keys]) => keys.every(key => !key.startsWith('held-upload#')))).toBe(true);
        }
        expect(getOutboxSnapshot()).toHaveLength(1);
        expect(getOutboxSnapshot()[0]).toMatchObject({ ...original, retryBlockCode: 'attachment_upload_failed' });
      } finally { randomUUID.mockRestore(); view.unmount(); }
    });

  it.each([true, false].flatMap(sameId => ['codex', 'claude', 'opencode'].map(provider => [sameId, provider] as const)))('retries all restored images and keeps eligibility (same ID %s, %s)', async (sameId, provider) => {
    const originalImages = images();
    storeWith(async () => originalImages);
    recordOutboxEntry({ id: 'complete-images', projectId: 'p1', sessionId: 's1', text: 'full image payload', images: originalImages,
      fileNames: [], historyEligibility: 'ineligible', intent: { provider } });
    markOutboxFailed('complete-images', { code: 'transport', sameClientMsgIdRetryable: sameId });
    const uploaded = [{ path: 'first.png' }, { path: 'second.png' }];
    executeResponse = { ok: true, body: { images: uploaded } };
    const view = renderComposer(provider);
    await act(async () => view.result.current.retryOutboxEntry('complete-images'));
    expect(apiCalls).toHaveLength(1);
    expect((apiCalls[0].init?.body as FormData).getAll('images')).toEqual(originalImages);
    expect(view.sent).toHaveLength(1);
    expect(view.sent[0].options.images).toEqual(uploaded);
    // B-1078: a successful image retry on a receipt-provider now declares the folded
    // text receipt with the re-uploaded count, so the transcript row still pairs;
    // codex/opencode remain outside the receipt allowlist.
    expect(view.sent[0].options.receiptPayload).toEqual(
      provider === 'claude' ? { version: 1, kind: 'text', imageCount: 2, fileCount: 0 } : undefined);
    expect(getOutboxSnapshot()).toHaveLength(1);
    expect(getOutboxSnapshot()[0]).toMatchObject({ imageNames: ['first.png', 'second.png'], fileNames: [], fileCount: 0, historyEligibility: 'ineligible' });
    expect(getOutboxSnapshot()[0].id === 'complete-images').toBe(sameId);
    view.unmount();
  });

  it('keeps the original when dispatch rejects the replacement', async () => {
    recordOutboxEntry({ id: 'transport-original', projectId: 'p1', sessionId: 's1', text: 'safe text', historyEligibility: 'text_only' });
    markOutboxFailed('transport-original', { code: 'transport', sameClientMsgIdRetryable: false });
    const original = getOutboxSnapshot()[0];
    const view = renderComposer('codex', { sendMessage: () => ({ ok: false, reason: 'socket_not_open' }) });
    await act(async () => view.result.current.retryOutboxEntry(original.id));
    expect(getOutboxSnapshot()).toContainEqual(original);
    view.unmount();
  });

  it('snapshots the file inventory before upload completes', async () => {
    const pending = deferred<ExecuteHttpResponse>();
    executeFetch = () => pending.promise;
    const view = renderComposer('qwen');
    act(() => { view.result.current.setInput('original file'); view.result.current.setAttachedFiles([new File(['a'], 'original.pdf')]); });
    let sending!: Promise<void>;
    act(() => { sending = view.result.current.handleSubmit(fakeSubmitEvent); });
    act(() => view.result.current.setAttachedFiles([new File(['b'], 'replacement.pdf')]));
    await act(async () => { pending.resolve(responseFrom({ ok: true, body: { files: [] } })); await sending; });
    expect(getOutboxSnapshot()[0]).toMatchObject({ fileNames: ['original.pdf'], fileCount: 1, historyEligibility: 'ineligible' });
    view.unmount();
  });
});


it.each(['qwen', 'hermes', 'kimi', 'deepseek', 'glm', 'cursor', 'antigravity'])(
  'B-894 refuses restored images when the %s wire path cannot carry them', async (provider) => {
    const file = new File(['image'], 'image.png', { type: 'image/png' });
    const deleteMany = vi.fn(async () => {});
    setOutboxBlobStore({ put: async () => {}, getMany: async () => [file], deleteMany, clearAll: async () => {} });
    recordOutboxEntry({ id: 'unsupported', projectId: 'p1', sessionId: 's1', text: 'image payload', images: [file],
      fileNames: [], historyEligibility: 'ineligible', status: 'failed', intent: { provider } });
    const view = renderComposer(provider);
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    try {
      await act(async () => view.result.current.retryOutboxEntry('unsupported'));
      expect(view.sent).toHaveLength(0);
      expect(apiCalls).toHaveLength(0);
      expect(randomUUID).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
      expect(getOutboxSnapshot()).toHaveLength(1);
      expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'unsupported', retryBlockCode: 'attachment_provider_unsupported', imageNames: ['image.png'] });
    } finally { randomUUID.mockRestore(); view.unmount(); }
  });


describe('B-894 replacement durability', () => {
  it.each(['throw', 'silent', 'partial', 'pending', 'storage'])(
    'keeps original image blobs until replacement is durable (%s)', async (failure) => {
      const map = new Map<string, File>();
      const gate = deferred<void>();
      const originalImages = ['first.png', 'second.png'].map(name => new File([name], name, { type: 'image/png' }));
      const deleteMany = vi.fn(async (keys: string[]) => { keys.forEach(key => map.delete(key)); });
      setOutboxBlobStore({
        put: async (key, file) => {
          if (key.startsWith('source-copy#')) { map.set(key, file); return; }
          if (failure === 'throw') throw new Error('IDB write failed');
          if (failure === 'silent' || (failure === 'partial' && key.endsWith('#1'))) return;
          if (failure === 'pending') await gate.promise;
          map.set(key, file);
        },
        getMany: async keys => keys.map(key => map.get(key)).filter((file): file is File => Boolean(file)),
        deleteMany, clearAll: async () => { map.clear(); },
      });
      recordOutboxEntry({ id: 'source-copy', projectId: 'p1', sessionId: 's1', text: 'keep originals', images: originalImages,
        fileNames: [], historyEligibility: 'ineligible', intent: { provider: 'codex' } });
      markOutboxFailed('source-copy', { code: 'transport', sameClientMsgIdRetryable: false });
      const original = getOutboxSnapshot()[0];
      executeResponse = { ok: true, body: { images: [{ path: 'one' }, { path: 'two' }] } };
      const view = renderComposer();
      const originalSetItem = Storage.prototype.setItem;
      const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (failure === 'storage' && key.startsWith('nassaj_outbox_') && value.includes('cmid_')) throw new Error('quota');
        return originalSetItem.call(this, key, value);
      });
      try {
        let retry!: Promise<void>;
        if (failure === 'pending') {
          act(() => { retry = view.result.current.retryOutboxEntry('source-copy'); });
          await waitFor(() => expect(getOutboxSnapshot()).toHaveLength(2));
          expect(view.sent).toHaveLength(0);
          expect(map.get('source-copy#0')).toBe(originalImages[0]);
          expect(map.get('source-copy#1')).toBe(originalImages[1]);
          expect(deleteMany).not.toHaveBeenCalled();
          await act(async () => { gate.resolve(); await retry; });
          expect(view.sent).toHaveLength(1);
          expect(getOutboxSnapshot()).toHaveLength(1);
          expect(getOutboxSnapshot()[0].id).not.toBe(original.id);
          expect(map.has('source-copy#0')).toBe(false);
          expect(map.get(getOutboxSnapshot()[0].id + '#0')).toBe(originalImages[0]);
        } else {
          await act(async () => view.result.current.retryOutboxEntry('source-copy'));
          expect(view.sent).toHaveLength(0);
          expect(getOutboxSnapshot()).toHaveLength(1);
          expect(getOutboxSnapshot()[0]).toMatchObject(original);
          expect(map.get('source-copy#0')).toBe(originalImages[0]);
          expect(map.get('source-copy#1')).toBe(originalImages[1]);
          expect(deleteMany.mock.calls.every(([keys]) => keys.every(key => !key.startsWith('source-copy#')))).toBe(true);
          // Admission now fails before preparing a replacement; the original
          // stays unchanged and the composer reports the durable-write failure.
          expect(view.result.current.sendError).toBe('outbox.storageFull');
          expect(apiCalls).toHaveLength(0);
        }
      } finally { storage.mockRestore(); gate.resolve(); view.unmount(); }
    });
});
