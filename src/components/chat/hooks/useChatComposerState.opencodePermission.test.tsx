/** B-1707 — an OpenCode send carries permissionMode/toolsSettings exactly like a Claude send. */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue || key);
      return template.replace('{{message}}', String(options?.message || ''));
    },
    i18n: { language: 'en' },
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

import { getProviderCapabilities } from '../constants/providerCapabilities';
import { clearOutbox, setOutboxUser, setOutboxBlobStore } from '../utils/messageOutbox';
import { useChatComposerState } from './useChatComposerState';
import { useChatProviderState } from './useChatProviderState';

type Body = 'claude' | 'opencode';
type Session = { id: string; __provider: string } | null;
const fakeSubmitEvent = { preventDefault: () => {} } as any;

/** Real provider-state (seeds and cycles the mode) feeding the real composer (sends it). */
function renderPair(provider: Body, session: Session) {
  const sent: any[] = [];
  const hook = renderHook(() => {
    const ps = useChatProviderState({ selectedSession: session as any, selectedProject: null });
    const composer = useChatComposerState({
      selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
      selectedSession: session,
      currentSessionId: session?.id ?? null,
      provider,
      displayProvider: provider,
      engineProvider: null,
      permissionMode: ps.permissionMode,
      cyclePermissionMode: ps.cyclePermissionMode,
      cursorModel: 'cursor', claudeModel: 'claude', codexModel: 'gpt-5',
      antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hermes', kimiModel: 'kimi',
      deepseekModel: 'deepseek', glmModel: 'glm',
      isLoading: false, canAbortSession: false, tokenBudget: null,
      sendMessage: (m: unknown) => { sent.push(m); return { ok: true }; },
      pendingViewSessionRef: { current: null },
      scrollToBottom: () => {}, addMessage: () => {}, setIsLoading: () => {},
      setCanAbortSession: () => {}, setClaudeStatus: () => {}, setIsUserScrolledUp: () => {},
      setPendingPermissionRequests: () => {}, onBtwQuery: () => {},
    } as any);
    return { ps, composer };
  });
  return { hook, sent };
}

async function submit(view: ReturnType<typeof renderPair>, text: string) {
  act(() => view.hook.result.current.composer.setInput(text));
  await act(async () => view.hook.result.current.composer.handleSubmit(fakeSubmitEvent));
}

/** Cycles the composer mode `steps` times, sends once, returns the sent payload. */
async function sendAfterCycles(provider: Body, session: Session, steps: number) {
  localStorage.setItem('selected-provider', provider);
  const view = renderPair(provider, session);
  for (let i = 0; i < steps; i += 1) {
    act(() => view.hook.result.current.ps.cyclePermissionMode());
  }
  await submit(view, 'hello');
  expect(view.sent).toHaveLength(1);
  view.hook.unmount();
  return view.sent[0];
}

const permissionPart = (payload: any) => ({
  permissionMode: payload.options.permissionMode,
  toolsSettings: payload.options.toolsSettings,
});

const OC_SESSION = { id: 'o1', __provider: 'opencode' };
const CL_SESSION = { id: 'c1', __provider: 'claude' };

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
});

describe('OpenCode permission mode parity with Claude (B-1707)', () => {
  it("capabilities: OpenCode offers exactly Claude's modes, in Claude's order", () => {
    const claudeModes = getProviderCapabilities('claude').permissions.modes;
    expect(getProviderCapabilities('opencode').permissions.modes).toEqual(claudeModes);
    expect(claudeModes).toEqual(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']);
  });

  it('default: an untouched OpenCode send carries permissionMode=default and toolsSettings', async () => {
    const oc = await sendAfterCycles('opencode', OC_SESSION, 0);
    const cl = await sendAfterCycles('claude', CL_SESSION, 0);
    expect(oc.type).toBe('opencode-command');
    expect(cl.type).toBe('claude-command');
    expect(permissionPart(oc)).toEqual({
      permissionMode: 'default',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    });
    expect(permissionPart(oc)).toEqual(permissionPart(cl));
  });

  it('default on a brand-new chat (no session) matches Claude', async () => {
    const oc = await sendAfterCycles('opencode', null, 0);
    const cl = await sendAfterCycles('claude', null, 0);
    expect(oc.type).toBe('opencode-command');
    expect(oc.options.permissionMode).toBe('default');
    expect(permissionPart(oc)).toEqual(permissionPart(cl));
  });

  it.each([
    [1, 'auto'], [2, 'acceptEdits'], [3, 'bypassPermissions'], [4, 'plan'], [5, 'default'],
  ])('after %i cycle(s) both bodies send %s', async (steps, mode) => {
    const oc = await sendAfterCycles('opencode', OC_SESSION, steps);
    const cl = await sendAfterCycles('claude', CL_SESSION, steps);
    expect(oc.options.permissionMode).toBe(mode);
    expect(permissionPart(oc)).toEqual(permissionPart(cl));
  });

  it("the shared Claude tool settings (incl. skipPermissions) reach OpenCode unchanged", async () => {
    const saved = { allowedTools: ['Read'], disallowedTools: [], skipPermissions: true };
    localStorage.setItem('claude-settings', JSON.stringify(saved));
    const oc = await sendAfterCycles('opencode', OC_SESSION, 0);
    const cl = await sendAfterCycles('claude', CL_SESSION, 0);
    expect(oc.options.toolsSettings).toEqual(saved);
    expect(permissionPart(oc)).toEqual(permissionPart(cl));
  });

  it('persists per session like Claude: a cycled mode is saved and re-seeded on reopen', async () => {
    const session = { id: 'o9', __provider: 'opencode' };
    await sendAfterCycles('opencode', session, 3);
    expect(localStorage.getItem('permissionMode-o9')).toBe('bypassPermissions');
    const reopened = renderPair('opencode', session);
    expect(reopened.hook.result.current.ps.permissionMode).toBe('bypassPermissions');
    await submit(reopened, 'again');
    expect(reopened.sent[0].options.permissionMode).toBe('bypassPermissions');
  });
});
