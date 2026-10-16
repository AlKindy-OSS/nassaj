/**
 * T-2037 — composer shell mode: only the explicit toggle switches modes, a
 * leading `!` stays chat text, a shell run never reaches the transcript, the
 * toggle is never hidden, and risky commands go through the themed dialog.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/ChatComposer.shellMode.test.tsx
 */

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { getCurrentDialog, settleDialog } from '../../../../shared/dialogs';
import { resetDialogsForTests } from '../../../../shared/dialogs/dialogService';
import { requestComposerInsert, resetComposerInsertForTests } from '../../../../stores/composerInsertStore';
import {
  consumeOneShotRequest,
  resetOneShotRunsForTests,
} from '../../../shell/oneShot/oneShotRunsStore';

import ChatComposer from './ChatComposer';

const access = vi.hoisted(() => ({
  role: 'owner' as string | null,
  canUseRaw: true,
  loading: false,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalAuth: () => (access.role ? { user: { role: access.role } } : null),
}));
vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: (enabled: boolean) => ({
    canUseRaw: enabled && access.canUseRaw,
    loading: enabled && access.loading,
  }),
}));

const noop = () => {};

const props = (overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) =>
  ({
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    claudeStatus: null,
    isLoading: false,
    onAbortSession: noop,
    provider: 'claude',
    displayProvider: 'claude',
    permissionMode: 'default',
    onModeSwitch: noop,
    thinkingMode: 'none',
    setThinkingMode: noop,
    composerMode: 'chat',
    setComposerMode: noop,
    agentModeAvailable: false,
    coordinationLevel: 'direct',
    setCoordinationLevel: noop,
    coordinationLevelAvailable: false,
    tokenBudget: null,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: false,
    onClearInput: noop,
    onSubmit: noop,
    isDragActive: false,
    attachedImages: [],
    onRemoveImage: noop,
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    attachedFiles: [],
    onRemoveFile: noop,
    uploadingFiles: new Map(),
    fileErrors: new Map(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openImagePicker: noop,
    inputHighlightRef: createRef<HTMLDivElement>(),
    renderInputWithMentions: (text: string) => text,
    textareaRef: createRef<HTMLTextAreaElement>(),
    input: '',
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'Type your message',
    isTextareaExpanded: false,
    ...overrides,
  }) as unknown as ComponentProps<typeof ChatComposer>;


class NoSocket {
  constructor() {
    throw new Error('a shell socket was opened');
  }
}

beforeEach(() => {
  access.role = 'owner';
  access.canUseRaw = true;
  access.loading = false;
  vi.stubGlobal('WebSocket', NoSocket);
});

afterEach(() => {
  cleanup();
  resetDialogsForTests();
  resetOneShotRunsForTests();
  resetComposerInsertForTests();
  vi.unstubAllGlobals();
});

const toggle = () => screen.getByTestId('composer-shell-toggle');
const textarea = (container: HTMLElement) => container.querySelector('textarea') as HTMLTextAreaElement;
const flush = () => act(async () => { await Promise.resolve(); });

describe('ChatComposer shell mode (T-2037)', () => {
  it('"!ls" with the mode OFF is a normal chat submit, no shell run', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onTextareaKeyDown = vi.fn();
    const { container } = render(<ChatComposer {...props({ input: '!ls', onSubmit, onTextareaKeyDown })} />);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    expect(onTextareaKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(consumeOneShotRequest()).toBeNull();
    expect(textarea(container).getAttribute('dir')).not.toBe('ltr');
  });

  it('mode ON: Enter requests a one-shot run, clears the draft, never submits chat', async () => {
    const onSubmit = vi.fn();
    const onClearInput = vi.fn();
    const onTextareaKeyDown = vi.fn();
    const { container } = render(
      <ChatComposer {...props({ input: 'ls -la', onSubmit, onClearInput, onTextareaKeyDown })} />,
    );
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('composer-shell-badge')).toBeTruthy();
    expect(textarea(container).getAttribute('dir')).toBe('ltr');
    expect(textarea(container).className).toContain('font-mono');
    expect(container.querySelector('form')?.getAttribute('data-shell-mode')).toBe('on');

    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    await flush();
    expect(onTextareaKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClearInput).toHaveBeenCalledTimes(1);
    expect(consumeOneShotRequest()).toEqual(expect.objectContaining({ command: 'ls -la' }));
  });

  it('mode ON: the submit button runs too (form submit), still no chat submit', async () => {
    const onSubmit = vi.fn();
    const { container } = render(<ChatComposer {...props({ input: 'pwd', onSubmit })} />);
    fireEvent.click(toggle());
    fireEvent.submit(container.querySelector('form')!);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(consumeOneShotRequest()).toEqual(expect.objectContaining({ command: 'pwd' }));
  });

  it('Esc leaves shell mode', () => {
    const { container } = render(<ChatComposer {...props({ input: 'ls' })} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(textarea(container), { key: 'Escape' });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it.each([
    ['admin', true, false, null],
    ['member', true, false, 'shellMode.disabledReason.forbidden'],
    [null, true, false, 'shellMode.disabledReason.forbidden'],
    ['owner', false, false, 'shellMode.disabledReason.raw_exec_disabled'],
    ['owner', true, true, 'shellMode.disabledReason.loading'],
  ] as const)('role=%s raw=%s loading=%s → reason %s, toggle stays visible', (role, raw, loading, reason) => {
    access.role = role;
    access.canUseRaw = raw;
    access.loading = loading;
    render(<ChatComposer {...props({ input: 'ls' })} />);
    expect(toggle()).toBeTruthy();
    if (reason) {
      expect(toggle().getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByTestId('composer-shell-toggle-reason').textContent).toBe(reason);
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-pressed')).toBe('false');
    } else {
      expect(toggle().getAttribute('aria-disabled')).toBeNull();
    }
  });

  it.each(['systemctl restart nginx', 'kill -9 42', 'pm2 stop all', 'sudo reboot'])(
    '%s → danger dialog with the command verbatim; Cancel sends nothing',
    async (command) => {
      const onClearInput = vi.fn();
      const { container } = render(<ChatComposer {...props({ input: command, onClearInput })} />);
      fireEvent.click(toggle());
      fireEvent.keyDown(textarea(container), { key: 'Enter' });
      const dialog = getCurrentDialog();
      expect(dialog).toEqual(expect.objectContaining({ kind: 'confirm', tone: 'danger', code: command }));
      await act(async () => {
        settleDialog(dialog!.id, false);
        await Promise.resolve();
      });
      expect(consumeOneShotRequest()).toBeNull();
      expect(onClearInput).not.toHaveBeenCalled();
    },
  );

  it('confirming the danger dialog requests the run', async () => {
    const { container } = render(<ChatComposer {...props({ input: 'systemctl status nginx' })} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    await act(async () => {
      settleDialog(getCurrentDialog()!.id, true);
      await Promise.resolve();
    });
    expect(consumeOneShotRequest()).toEqual(expect.objectContaining({ command: 'systemctl status nginx' }));
  });

  it('pkill is shown as blocked (alert, no confirm) and never requested', async () => {
    const { container } = render(<ChatComposer {...props({ input: 'pkill vite' })} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    const dialog = getCurrentDialog();
    expect(dialog).toEqual(expect.objectContaining({ kind: 'alert', message: 'shellMode.blocked' }));
    await act(async () => {
      settleDialog(dialog!.id, true);
      await Promise.resolve();
    });
    expect(consumeOneShotRequest()).toBeNull();
  });

  it('tmpfs install → warning confirm mentioning the hooks gap', async () => {
    const { container } = render(<ChatComposer {...props({ input: 'cd /tmp && npm ci' })} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    const dialog = getCurrentDialog();
    expect(dialog?.message).toContain('shellMode.tmpfsWarning');
    expect(dialog?.tone).toBe('default');
    await act(async () => {
      settleDialog(dialog!.id, false);
      await Promise.resolve();
    });
    expect(consumeOneShotRequest()).toBeNull();
  });

  it('attached output switches shell mode off, so Enter cannot run it', () => {
    render(<ChatComposer {...props({ input: '' })} />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => {
      requestComposerInsert('exit code 0');
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});
