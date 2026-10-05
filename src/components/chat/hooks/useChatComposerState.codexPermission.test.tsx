/** B-472 — Codex Settings mode seeds the composer; dispatch sends exactly the composer's mode. */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const language = 'en';
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
  authenticatedFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
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
      return actual.getOutboxSnapshot().find(entry => entry.id === id) ?? null;
    }),
  };
});

import { applyPendingCodexPermissionStamp } from '../utils/codexPermissionMode';
import { clearOutbox, setOutboxUser, setOutboxBlobStore } from '../utils/messageOutbox';
import { useChatComposerState } from './useChatComposerState';
import { useChatProviderState } from './useChatProviderState';

const fakeSubmitEvent = { preventDefault: () => {} } as any;

/** Real provider-state (seeds the mode) feeding the real composer (sends it). */
function renderPair(initial: { id: string; __provider: string } | null, sendOk = true) {
  const sent: any[] = [];
  const holder = { session: initial };
  const hook = renderHook(() => {
    const session = holder.session;
    const ps = useChatProviderState({ selectedSession: session as any, selectedProject: null });
    const composer = useChatComposerState({
      selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
      selectedSession: session,
      currentSessionId: session?.id ?? null,
      provider: 'codex',
      displayProvider: 'codex',
      engineProvider: null,
      permissionMode: ps.permissionMode,
      cyclePermissionMode: ps.cyclePermissionMode,
      cursorModel: 'cursor', claudeModel: 'claude', codexModel: 'gpt-5',
      antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hermes', kimiModel: 'kimi',
      deepseekModel: 'deepseek', glmModel: 'glm',
      isLoading: false, canAbortSession: false, tokenBudget: null,
      sendMessage: (m: unknown) => { sent.push(m); return { ok: sendOk }; },
      pendingViewSessionRef: { current: null },
      scrollToBottom: () => {}, addMessage: () => {}, setIsLoading: () => {},
      setCanAbortSession: () => {}, setClaudeStatus: () => {}, setIsUserScrolledUp: () => {},
      setPendingPermissionRequests: () => {}, onBtwQuery: () => {},
    } as any);
    return { ps, composer };
  });
  const setSession = (next: { id: string; __provider: string } | null) => {
    holder.session = next;
    hook.rerender();
  };
  return { hook, sent, setSession };
}

async function submit(view: ReturnType<typeof renderPair>, text: string) {
  act(() => view.hook.result.current.composer.setInput(text));
  await act(async () => view.hook.result.current.composer.handleSubmit(fakeSubmitEvent));
}

const SESSION = { id: 's1', __provider: 'codex' };
const codexSettings = (permissionMode: string) =>
  localStorage.setItem('codex-settings', JSON.stringify({ permissionMode }));

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
  localStorage.setItem('selected-provider', 'codex');
  setOutboxUser(1);
});

describe('Codex permission mode (B-472)', () => {
  it('Settings=acceptEdits seeds a brand-new chat (no session) composer', () => {
    codexSettings('acceptEdits');
    const view = renderPair(null);
    expect(view.hook.result.current.ps.permissionMode).toBe('acceptEdits');
  });

  it('Settings=acceptEdits on a new codex session: composer and payload both acceptEdits', async () => {
    codexSettings('acceptEdits');
    const view = renderPair(SESSION);
    expect(view.hook.result.current.ps.permissionMode).toBe('acceptEdits');
    await submit(view, 'hello');
    expect(view.sent[0]).toMatchObject({ type: 'codex-command', options: { permissionMode: 'acceptEdits' } });
  });

  it('seeds an existing codex session without a saved mode from Settings', () => {
    codexSettings('bypassPermissions');
    const view = renderPair({ id: 's1', __provider: 'codex' });
    expect(view.hook.result.current.ps.permissionMode).toBe('bypassPermissions');
  });

  it('a session-saved mode beats Settings', () => {
    codexSettings('bypassPermissions');
    localStorage.setItem('permissionMode-s1', 'default');
    const view = renderPair({ id: 's1', __provider: 'codex' });
    expect(view.hook.result.current.ps.permissionMode).toBe('default');
  });

  it('composer Plan with Settings=bypass sends default, never the Settings value', async () => {
    codexSettings('bypassPermissions');
    const view = renderPair(SESSION);
    act(() => view.hook.result.current.ps.setPermissionMode('plan' as any));
    await submit(view, 'hello');
    expect(view.sent[0].options.permissionMode).toBe('default');
  });

  it('a user change in the composer is respected over Settings', async () => {
    codexSettings('acceptEdits');
    const view = renderPair(SESSION);
    act(() => view.hook.result.current.ps.cyclePermissionMode());
    expect(view.hook.result.current.ps.permissionMode).toBe('bypassPermissions');
    await submit(view, 'hello');
    expect(view.sent[0].options.permissionMode).toBe('bypassPermissions');
  });

  it('missing Settings seeds default', async () => {
    const view = renderPair(SESSION);
    await submit(view, 'hello');
    expect(view.sent[0].options.permissionMode).toBe('default');
  });

  it('new chat: Settings=bypass, user lowers to default, two sends stay default', async () => {
    codexSettings('bypassPermissions');
    const view = renderPair(null);
    expect(view.hook.result.current.ps.permissionMode).toBe('bypassPermissions');
    act(() => view.hook.result.current.ps.setPermissionMode('default'));
    await submit(view, 'first');
    expect(view.sent[0].options.permissionMode).toBe('default');
    // session_created echoes the send's clientMsgId; the handler applies the stamp
    applyPendingCodexPermissionStamp('new-1', view.sent[0].options.clientMsgId);
    act(() => view.setSession({ id: 'new-1', __provider: 'codex' }));
    expect(view.hook.result.current.ps.permissionMode).toBe('default');
    await submit(view, 'second');
    expect(view.sent[1].options.permissionMode).toBe('default');
    expect(localStorage.getItem('permissionMode-new-1')).toBe('default');
  });

  it('opening an unrelated existing session does not inherit a stale stamp', () => {
    codexSettings('acceptEdits');
    const view = renderPair({ id: 'old-1', __provider: 'codex' });
    expect(view.hook.result.current.ps.permissionMode).toBe('acceptEdits');
  });

  it('a pending stamp is never taken by selecting another old session (Settings wins)', async () => {
    codexSettings('acceptEdits');
    const view = renderPair(null);
    act(() => view.hook.result.current.ps.setPermissionMode('default'));
    await submit(view, 'first'); // stamp(default) pending, session_created not yet received
    act(() => view.setSession({ id: 'old-2', __provider: 'codex' }));
    expect(view.hook.result.current.ps.permissionMode).toBe('acceptEdits');
    expect(localStorage.getItem('permissionMode-old-2')).toBeNull();
  });

  it('a session_created with a mismatched clientMsgId does not apply the stamp', async () => {
    codexSettings('acceptEdits');
    const view = renderPair(null);
    act(() => view.hook.result.current.ps.setPermissionMode('default'));
    await submit(view, 'first');
    expect(applyPendingCodexPermissionStamp('other-1', 'someone-elses-msg')).toBeNull();
    expect(applyPendingCodexPermissionStamp('other-1', null)).toBeNull();
    expect(localStorage.getItem('permissionMode-other-1')).toBeNull();
    // the real send's own session_created still applies it afterwards
    expect(applyPendingCodexPermissionStamp('new-1', view.sent[0].options.clientMsgId)).toBe('default');
  });

  it('a failed send leaves no stamp', async () => {
    codexSettings('acceptEdits');
    const view = renderPair(null, false);
    act(() => view.hook.result.current.ps.setPermissionMode('default'));
    await submit(view, 'first');
    expect(applyPendingCodexPermissionStamp('new-1', view.sent[0].options.clientMsgId)).toBeNull();
  });
});
