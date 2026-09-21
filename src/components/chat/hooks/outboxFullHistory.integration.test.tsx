import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 2 } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-dropzone', () => ({ useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false, open: () => {} }) }));
vi.mock('./useSlashCommands', async (original) => ({ ...await original<typeof import('./useSlashCommands')>(), useSlashCommands: () => ({ slashCommands: [], filteredCommands: [], frequentCommands: [], commandQuery: '', showCommandMenu: false, selectedCommandIndex: 0, resetCommandMenuState: () => {}, handleCommandSelect: () => {}, handleToggleCommandMenu: () => {}, handleCommandInputChange: () => {}, handleCommandMenuKeyDown: () => false }) }));
vi.mock('./useFileMentions', () => ({ useFileMentions: () => ({ showFileDropdown: false, filteredFiles: [], selectedFileIndex: 0, renderInputWithMentions: () => null, selectFile: () => {}, setCursorPosition: () => {}, handleFileMentionsKeyDown: () => false }) }));
import { useSessionStore } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';
import { clearOutbox, confirmOutboxEntry, getOutboxSnapshot, recordOutboxEntry, setOutboxBlobStore, setOutboxUser } from '../utils/messageOutbox';

import { useChatSessionState } from './useChatSessionState';
import { useChatComposerState } from './useChatComposerState';

const project = { projectId: 'project', path: '/synthetic', fullPath: '/synthetic' } as any;
const session = { id: 'session', __provider: 'codex' } as any;
const noop = () => {};
const send = () => ({ ok: true });
const deleteMany = vi.fn(async (_keys: string[]) => undefined);
const nativeRow = { id: 'codex-history-stable', sessionId: 'session', provider: 'codex', role: 'user', kind: 'text', content: 'pictured message', timestamp: '2026-09-08T00:00:00Z' };
let finishFull: (value: any) => void;
function mount() {
  return renderHook(() => {
    const store = useSessionStore();
    const pending = useRef(null);
    const history = useChatSessionState({ selectedSession: session, selectedProject: project,
      ws: null, sendMessage: noop, resetStreamingState: noop, pendingViewSessionRef: pending, sessionStore: store } as any);
    const composer = useChatComposerState({ selectedProject: project, selectedSession: session,
      currentSessionId: 'session', provider: 'codex', displayProvider: 'codex', engineProvider: null,
      permissionMode: 'default', cyclePermissionMode: noop, isLoading: false, canAbortSession: false,
      tokenBudget: null, sendMessage: send, pendingViewSessionRef: pending,
      scrollToBottom: noop, addMessage: noop, setIsLoading: noop, setCanAbortSession: noop,
      setClaudeStatus: noop, setIsUserScrolledUp: noop, setPendingPermissionRequests: noop,
      outboxHistory: store.getSessionSlot('session')?.serverMessages,
    } as any);
    return { store, history, composer };
  });
}
beforeEach(() => {
  localStorage.clear(); clearOutbox(); setOutboxUser(2);
  setOutboxBlobStore({ put: async () => undefined, getMany: async () => [], deleteMany, clearAll: async () => undefined });
  deleteMany.mockClear();
  recordOutboxEntry({ id: 'client-picture', sessionId: 'session', projectId: 'project', text: 'pictured message',
    images: [new File(['picture'], 'picture.png')], intent: { provider: 'codex' } as any });
  confirmOutboxEntry('client-picture');
  publishServerCapabilities({ capabilities: { lightHistory: { supported: true, enabled: true, schema: 1 } } });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0));
  authenticatedFetch.mockReset().mockImplementation((url: string) => {
    if (!url.includes('/messages')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    if (url.includes('payload=full')) return new Promise(resolve => { finishFull = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ messages: [{ ...nativeRow, deferredPayload: true, imagesOmitted: 1 }],
      total: 1000, hasMore: true, historySchema: 1, payloadMode: 'light', revision: 'revision-one' }) });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearOutbox(); });
it('bounded full enrichment retains an unmigrated v1 pictured copy until generation-scoped v2 proof exists', async () => {
  const { result } = mount();
  await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => url.includes('payload=full'))).toBe(true));
  expect(getOutboxSnapshot()).toHaveLength(1);
  expect(deleteMany).not.toHaveBeenCalled();
  await act(async () => finishFull({ ok: true, json: async () => ({ messages: [{ ...nativeRow,
    clientMsgId: 'client-picture', images: ['data:image/png;base64,cGljdHVyZQ=='] }],
    total: 1000, hasMore: true, historySchema: 1, payloadMode: 'full', revision: 'revision-one' }) }));
  // Wait for actual enrichment, not the initial retained snapshot. Identity
  // alone cannot delete a v1 entry without an imported v2 generation.
  await waitFor(() => expect(result.current.store.getSlot('session').serverMessages[0]).toMatchObject({
    clientMsgId: 'client-picture', images: ['data:image/png;base64,cGljdHVyZQ=='],
  }));
  expect(getOutboxSnapshot()).toHaveLength(1);
  expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'client-picture', status: 'delivered', text: 'pictured message', imageNames: ['picture.png'] });
  expect(deleteMany).not.toHaveBeenCalled();
  expect(result.current.composer.outboxEntries).toHaveLength(0);
  const requests = authenticatedFetch.mock.calls.filter(([url]) => url.includes('/messages')).map(([url]) => url);
  expect(requests).toHaveLength(2);
  expect(requests.every(url => url.includes('limit=20'))).toBe(true);
  expect(requests[1]).toContain('revision=revision-one');
});
it('full enrichment failure preserves the received local text and attachment without expanding history', async () => {
  mount();
  await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => url.includes('payload=full'))).toBe(true));
  await act(async () => finishFull({ ok: false, status: 413, json: async () => ({ error: { code: 'HISTORY_BUDGET_EXCEEDED' } }) }));
  expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'client-picture', status: 'delivered', imageNames: ['picture.png'] });
  expect(deleteMany).not.toHaveBeenCalled();
  expect(authenticatedFetch.mock.calls.filter(([url]) => url.includes('/messages'))).toHaveLength(2);
});
