import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

import ChatComposer from './ChatComposer';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'ar' },
  }),
}));

// Provider logos read the theme; the composer contract under test does not.
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));

const noop = () => {};

const props = (coordinationLevelAvailable: boolean) =>
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
    coordinationLevelAvailable,
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
    placeholder: 'اكتب رسالتك',
    isTextareaExpanded: false,
  }) as unknown as ComponentProps<typeof ChatComposer>;

afterEach(cleanup);

describe('Codex attachment feedback', () => {
  it.each([arChat.codexImageInput, enChat.codexImageInput])('announces localized rejection without hiding the draft', messages => {
    render(<ChatComposer {...props(false)} input="مسودة" sendError={messages.tooLarge} />);
    expect(screen.getByRole('alert').textContent).toBe(messages.tooLarge);
    expect((screen.getByPlaceholderText('اكتب رسالتك') as HTMLTextAreaElement).value).toBe('مسودة');
  });

  it('يعرض تنبيه alias الجانبي في منطقة alert المتاحة', () => {
    render(<ChatComposer {...props(false)} sendError={arChat.btw.errors.question_required} />);
    expect(screen.getByRole('alert').textContent).toBe(arChat.btw.errors.question_required);
  });
});

describe('ChatComposer image-only submission', () => {
  it('submits a pointer click with only an image through the actual form', () => {
    const onSubmit = vi.fn(event => event.preventDefault());
    const { container } = render(<ChatComposer {...props(false)}
      attachedImages={[new File(['x'], 'mobile-photo.jpg', { type: 'image/jpeg' })]}
      onSubmit={onSubmit} />);
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('يتيح إرسال الصورة دون نص ويبقي الرسالة الفارغة محظورة', () => {
    const initial = props(false);
    const { container, rerender } = render(<ChatComposer {...initial} />);
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit()?.disabled).toBe(true);
    rerender(<ChatComposer {...initial} attachedImages={[new File(['x'], 'shot.png', { type: 'image/png' })]} />);
    expect(submit()?.disabled).toBe(false);
    rerender(<ChatComposer {...initial} isWsConnected={false} attachedImages={[new File(['x'], 'shot.png', { type: 'image/png' })]} />);
    expect(submit()?.disabled).toBe(true);
    rerender(<ChatComposer {...initial} input="   " />);
    expect(submit()?.disabled).toBe(true);
  });
});

describe('ChatComposer Arabic side-command readiness', () => {
  it('يبقي الإرسال متاحاً أثناء البث للسؤال الجانبي العربي مع جلسة Codex فقط', () => {
    const initial = props(false);
    const { container, rerender } = render(
      <ChatComposer
        {...initial}
        provider="codex"
        displayProvider="codex"
        input="/بالمناسبة افحص الجولة"
        isLoading
        sessionId="session-1"
      />,
    );
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit()?.disabled).toBe(false);

    rerender(
      <ChatComposer
        {...initial}
        provider="codex"
        displayProvider="codex"
        input="/بالمناسبة افحص الجولة"
        isLoading
        sessionId={null}
      />,
    );
    // Without a session the side command is ordinary streaming input: no submit control.
    expect(submit()).toBeNull();
    expect(container.querySelector('button[type="button"][disabled]')).not.toBeNull();
  });
});

describe('ChatComposer coordination level control', () => {
  it('shows the control when the current provider supports coordination levels', () => {
    render(<ChatComposer {...props(true)} />);
    expect(screen.getByRole('button', { name: 'coordinationLevel.ariaLabel' })).toBeTruthy();
  });

  it('hides the control when the current provider does not support coordination levels', () => {
    render(<ChatComposer {...props(false)} />);
    expect(screen.queryByRole('button', { name: 'coordinationLevel.ariaLabel' })).toBeNull();
  });

  it('يقفل المحدد ويغلق لوحته فور بدء الجولة', () => {
    const initial = props(true);
    const { rerender } = render(<ChatComposer {...initial} />);
    const trigger = screen.getByRole('button', { name: 'coordinationLevel.ariaLabel' });

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { hidden: true })).toBeTruthy();

    rerender(<ChatComposer {...initial} isLoading />);
    expect(trigger.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('يختار المستوى بلوحة المفاتيح ويعيد التركيز إلى الزر', () => {
    const setCoordinationLevel = vi.fn();
    render(<ChatComposer {...props(true)} setCoordinationLevel={setCoordinationLevel} />);
    const trigger = screen.getByRole('button', { name: 'coordinationLevel.ariaLabel' });

    fireEvent.click(trigger);
    const options = screen.getAllByRole('option', { hidden: true });
    fireEvent.keyDown(screen.getByRole('listbox', { hidden: true }), { key: 'End' });
    fireEvent.click(options[2]);

    expect(setCoordinationLevel).toHaveBeenCalledWith('delegate_review');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('يعرض حالة الأمر المنفذ باسم معزول اتجاهياً ويعطل الإرسال', () => {
    const { container } = render(
      <ChatComposer
        {...props(false)}
        input="مسودة جديدة"
        hasInput
        executingCommand={{ name: '/compact', sessionId: 'session-1' }}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('commandExecution.running');
    const commandName = status.querySelector('bdi');
    expect(commandName?.textContent).toBe('/compact');
    expect(commandName?.getAttribute('dir')).toBe('ltr');
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('يبقي زر /btw زر إرسال فعلياً أثناء البث على الجوال', () => {
    type SubmitEvent = Parameters<NonNullable<ComponentProps<typeof ChatComposer>['onSubmit']>>[0];
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const { container } = render(
      <ChatComposer
        {...props(false)}
        input="/btw هل انتهيت؟"
        hasInput
        isLoading
        sessionId="session-1"
        onSubmit={onSubmit}
      />,
    );

    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit?.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('يبقي الرسائل العادية معطلة أثناء البث', () => {
    const { container } = render(
      <ChatComposer
        {...props(false)}
        input="رسالة عادية"
        hasInput
        isLoading
      />,
    );

    const activeButton = container.querySelector<HTMLButtonElement>('button[type="button"][disabled]');
    expect(activeButton).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it('يغلق نافذة الجدولة عند تبديل الجلسة كي لا يعدّل رسالة الجلسة السابقة', () => {
    const initial = props(false);
    const { rerender } = render(
      <ChatComposer {...initial} sessionId="session-1" input="رسالة لاحقة" hasInput />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'scheduled.open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    rerender(<ChatComposer {...initial} sessionId="session-2" input="رسالة لاحقة" hasInput />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
