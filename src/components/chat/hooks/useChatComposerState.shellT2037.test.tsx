/**
 * T-2037 — custom-command bash snippets use the themed dialog (never
 * window.confirm), only when the server lists non-empty `bashSnippets`; and the
 * Shell tab's attach path only inserts into the draft, never sends.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useChatComposerState.shellT2037.test.tsx
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    name: '/deploy',
    namespace: 'project',
    type: 'custom',
    path: '/p/.claude/commands/deploy.md',
    metadata: { type: 'custom' },
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


import { clearOutbox, setOutboxUser, setOutboxBlobStore } from '../utils/messageOutbox';
import { getCurrentDialog, settleDialog } from '../../../shared/dialogs';
import { resetDialogsForTests } from '../../../shared/dialogs/dialogService';
import { requestComposerInsert, resetComposerInsertForTests, setComposerShellModeActive } from '../../../stores/composerInsertStore';

import { readBashSnippets, useChatComposerState } from './useChatComposerState';

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


afterEach(() => {
  resetDialogsForTests();
  resetComposerInsertForTests();
});

async function runDeploy(view: ReturnType<typeof renderComposer>) {
  act(() => view.result.current.setInput('/deploy'));
  await act(async () => view.result.current.handleSubmit(fakeSubmitEvent));
  await waitFor(() => expect(apiCalls.some((call) => call.url === '/api/commands/execute')).toBe(true));
  await act(async () => { await Promise.resolve(); });
}

describe('custom command bash snippets (T-2037)', () => {
  it('lists the snippets verbatim in a themed confirm; cancel sends nothing', async () => {
    executeResponse = {
      ok: true,
      body: { type: 'custom', content: 'check !`ls -la` and !`git status`', hasBashCommands: true, bashSnippets: ['ls -la', 'git status'] },
    };
    const confirmSpy = vi.spyOn(window, 'confirm');
    const view = renderComposer('claude');
    await runDeploy(view);

    const dialog = getCurrentDialog();
    expect(dialog).toEqual(expect.objectContaining({
      kind: 'confirm',
      title: 'customCommand.bashSnippetsTitle',
      message: 'customCommand.confirmBashExecution',
      code: 'ls -la\ngit status',
    }));
    await act(async () => {
      settleDialog(dialog!.id, false);
      await Promise.resolve();
    });
    expect(view.sent).toHaveLength(0);
    expect(view.added).toEqual([expect.objectContaining({ content: 'Command execution cancelled' })]);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it.each([
    ['no bashSnippets field', { hasBashCommands: true }],
    ['an empty list', { hasBashCommands: true, bashSnippets: [] }],
    ['only blank snippets', { hasBashCommands: true, bashSnippets: ['  ', ''] }],
  ])('no dialog with %s (hasBashCommands alone is not enough)', async (_label, extra) => {
    executeResponse = { ok: true, body: { type: 'custom', content: 'Hello!', ...extra } };
    const view = renderComposer('claude');
    await runDeploy(view);
    expect(getCurrentDialog()).toBeNull();
    // Accepted without a prompt: the text goes on to the agent as a message.
    await waitFor(() => expect(JSON.stringify(view.sent)).toContain('Hello!'));
  });

  it('readBashSnippets keeps only non-empty strings', () => {
    expect(readBashSnippets({ type: 'custom', bashSnippets: ['a', ' ', 'b'] })).toEqual(['a', 'b']);
    expect(readBashSnippets({ type: 'custom' })).toEqual([]);
  });

  it('the source holds no window.confirm, no eslint-disable for it and no T-2037 TODO', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/hooks/useChatComposerState.ts'), 'utf8');
    expect(source).not.toMatch(/window\.confirm/);
    expect(source).not.toMatch(/no-restricted-properties/);
    expect(source).not.toMatch(/TODO\(T-2037\)/);
  });
});

describe('composer insert from the Shell tab (T-2037)', () => {
  it('appends the attached block to the draft and sends nothing', async () => {
    const view = renderComposer('claude');
    act(() => view.result.current.setInput('see this:'));
    act(() => { requestComposerInsert('exit code 0\n```text\n$ ls\na\n```'); });
    expect(view.result.current.input).toBe('see this:\n\nexit code 0\n```text\n$ ls\na\n```');
    expect(view.sent).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  it('delivers an insert offered before the composer mounted', () => {
    requestComposerInsert('queued');
    const view = renderComposer('claude');
    expect(view.result.current.input).toBe('queued');
    expect(view.sent).toHaveLength(0);
  });

  it('a shell-mode draft is not autosaved (never restored as chat text)', () => {
    const view = renderComposer('claude');
    setComposerShellModeActive(true);
    act(() => view.result.current.setInput('rm -rf build'));
    expect(localStorage.getItem('draft_input_p1')).toBeNull();
    setComposerShellModeActive(false);
    act(() => view.result.current.setInput('hello'));
    expect(localStorage.getItem('draft_input_p1')).toBe('hello');
  });
});
