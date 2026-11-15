/**
 * The composer's per-file attachment cap follows the owner's storage policy
 * (`attachmentMaxMb`), not a hardcoded number: both the size check and the
 * dropzone's `maxSize` use it, and the error names the real limit.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useChatComposerState.attachmentLimit.test.tsx
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MB = 1024 * 1024;
let policyMaxMb = 50;
const dropzoneOptions: Array<{ maxSize?: number }> = [];

const translation = {
  t: (key: string, options?: Record<string, unknown>) =>
    options?.maxMb !== undefined ? `${key}:${String(options.maxMb)}` : key,
  i18n: { language: 'en' },
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));
vi.mock('react-dropzone', () => ({
  useDropzone: (options: { maxSize?: number }) => {
    dropzoneOptions.push(options);
    return { getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false, open: () => {} };
  },
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
vi.mock('./useSlashCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useSlashCommands')>()),
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
}));
vi.mock('../../../hooks/useAttachmentMaxMb', () => ({
  useAttachmentMaxMb: () => policyMaxMb,
}));
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
}));

import { useChatComposerState } from './useChatComposerState';

function renderComposer() {
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
    deepseekModel: 'deepseek', glmModel: 'glm',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => ({ ok: true }),
    pendingViewSessionRef: { current: null },
    scrollToBottom: () => {},
    addMessage: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
    onBtwQuery: () => {},
  };
  return renderHook(() => useChatComposerState(props as any));
}

function pdfOfSize(name: string, bytes: number): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

beforeEach(() => {
  policyMaxMb = 50;
  dropzoneOptions.length = 0;
  localStorage.clear();
});

describe('composer attachment size limit follows the storage policy', () => {
  it('by default (50 MB) refuses a 60 MB file early, naming the limit', () => {
    const view = renderComposer();
    act(() => view.result.current.handleNonImageFiles([pdfOfSize('mid.pdf', 60 * MB)]));
    expect(view.result.current.attachedFiles).toHaveLength(0);
    expect(view.result.current.fileErrors.get('mid.pdf')).toBe('fileAttachment.errorSize:50');
  });

  it('owner set 120: a 100 MB file is accepted', () => {
    policyMaxMb = 120;
    const view = renderComposer();
    act(() => view.result.current.handleNonImageFiles([pdfOfSize('big.pdf', 100 * MB)]));
    expect(view.result.current.attachedFiles.map((f: File) => f.name)).toEqual(['big.pdf']);
    expect(view.result.current.fileErrors.size).toBe(0);
  });

  it('owner set 120: a 130 MB file is refused, naming 120', () => {
    policyMaxMb = 120;
    const view = renderComposer();
    act(() => view.result.current.handleNonImageFiles([pdfOfSize('huge.pdf', 130 * MB)]));
    expect(view.result.current.attachedFiles).toHaveLength(0);
    expect(view.result.current.fileErrors.get('huge.pdf')).toBe('fileAttachment.errorSize:120');
  });

  it('the dropzone maxSize uses the policy value', () => {
    policyMaxMb = 120;
    renderComposer();
    expect(dropzoneOptions.at(-1)?.maxSize).toBe(120 * MB);
  });
});
