/**
 * B-1450 — «/steer <text>» أثناء بثّ جولة البادئ نفسه (isLoading) كان يُعطِّل
 * زرّ الإرسال الأساسي (نفس بوابة isBtwReady القديمة) فيتحوّل إلى الشكل المربّع
 * «مشغول» بلا مسار لمسٍ للإرسال: لوحة المفاتيح تعترضه في useChatComposerState
 * (isReservedSteerCommand) بصرف النظر عن isLoading، لكنّ الزرّ نفسه — المسار
 * الوحيد على اللمس حين لا يُرسل Enter (`resolveEnterSends` = false) — كان
 * معطّلاً أو يعرض شارة الإيقاف بدل الإرسال.
 *
 * العلاج: `isSteerReady` (isReservedSteerCommand على نفس تطبيع normalizeArabicSlashCommand
 * المستخدم في مسار الإرسال الفعلي) يُرخي نفس بوابة isBtwReady على الزرّ —
 * enabled + type=submit + أيقونة الإرسال، لا الشارة المربّعة — بلا أي فحص
 * canSteer/sessionId على العميل (T-1904: طبقة التحليل تتجاوزه عمداً).
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/components/chat/view/subcomponents/ChatComposer.steerSubmit.test.tsx
 */

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import ChatComposer from './ChatComposer';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

// Provider logos read the theme; the composer contract under test does not.
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));

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

afterEach(cleanup);

describe('ChatComposer /steer submit readiness while streaming', () => {
  it('enables the submit button, as type=submit, for a reserved steer draft mid-run', () => {
    const { container } = render(
      <ChatComposer {...props({ isLoading: true, input: '/steer focus here' })} />,
    );
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);
    // Send-arrow glyph, never the busy square: same DOM contract as /btw.
    expect(submit?.querySelector('svg.lucide-square')).toBeNull();
  });

  it('a tap (click, no Enter/keyboard involvement) submits the steer draft mid-run', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const { container } = render(
      <ChatComposer {...props({ isLoading: true, input: '/steer focus here', onSubmit })} />,
    );
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    fireEvent.pointerDown(submit, { pointerType: 'touch' });
    fireEvent.pointerUp(submit, { pointerType: 'touch' });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('bare "/steer" (no trailing text) is still an enabled submit, not disabled', () => {
    const { container } = render(
      <ChatComposer {...props({ isLoading: true, input: '/steer' })} />,
    );
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);
  });

  it('a normal (non-command) draft mid-run stays a disabled busy button (no regression)', () => {
    const { container } = render(
      <ChatComposer {...props({ isLoading: true, input: 'plain message, not a command' })} />,
    );
    const submitType = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    const busyButton = container.querySelector<HTMLButtonElement>('button[type="button"][disabled]');
    expect(submitType).toBeNull();
    expect(busyButton).not.toBeNull();
  });

  it('/btw readiness is unchanged: still requires sideChannel support + sessionId, unlike /steer', () => {
    // codex + sessionId ⇒ /btw ready mid-run (existing contract).
    const { container: withSession } = render(
      <ChatComposer
        {...props({
          provider: 'codex',
          displayProvider: 'codex',
          isLoading: true,
          input: '/btw check the run',
          sessionId: 'session-1',
        })}
      />,
    );
    expect(
      withSession.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);

    // codex without a session ⇒ /btw is ordinary streaming input again (busy button),
    // proving /steer's session-independent readiness did not loosen this gate.
    const { container: withoutSession } = render(
      <ChatComposer
        {...props({
          provider: 'codex',
          displayProvider: 'codex',
          isLoading: true,
          input: '/btw check the run',
          sessionId: null,
        })}
      />,
    );
    expect(withoutSession.querySelector<HTMLButtonElement>('button[type="submit"]')).toBeNull();
  });
});
