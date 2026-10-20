/**
 * T-2060 — the clear-input button is hidden on narrow screens only; from `sm`
 * up it must be visible (the old `sm:No-flex` class was not a utility, so the
 * button stayed `hidden` everywhere) and carry an accessible name.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/ChatComposer.clearInput.test.tsx
 */

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';


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


afterEach(() => {
  cleanup();
});

describe('ChatComposer clear-input button (T-2060)', () => {
  it('is absent without input', () => {
    render(<ChatComposer {...props({ hasInput: false })} />);
    expect(screen.queryByRole('button', { name: 'input.clearInput' })).toBeNull();
  });

  it('is labelled, hidden only below sm, and clears on click', () => {
    const onClearInput = vi.fn();
    render(<ChatComposer {...props({ hasInput: true, input: 'hello', onClearInput })} />);
    const button = screen.getByRole('button', { name: 'input.clearInput', hidden: true });
    const classes = button.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('sm:inline-flex');
    expect(classes.some((c) => /^sm:[A-Z]/.test(c))).toBe(false);
    fireEvent.click(button);
    expect(onClearInput).toHaveBeenCalledTimes(1);
  });
});
