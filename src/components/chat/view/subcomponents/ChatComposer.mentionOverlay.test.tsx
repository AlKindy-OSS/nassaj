/**
 * B-RTL-MENTION — طبقة مرآة الـ@mentions لا تطابق اتجاه الحقل الذي تحتها.
 *
 * الـoverlay طبقة نصّ شفّافة مرسومة فوق `<textarea>` لتلوين إشارات الملفات، فهي
 * تعتمد على تطابق كل حرف بموضعه مع الحقل. الحقل يحمل `dir="auto"` ⇒ يحسب اتجاهه
 * من أول حرف قوي في المسودّة، بينما الـoverlay كان يرث `rtl` من المستند دوماً.
 * كل مسودّة تبدأ بحرف لاتيني تجعل الطبقتين متعاكستين، فتسقط مستطيلات التمييز على
 * حروف أخرى. مقيس: 126 من 1916 مسودّة حقيقية (6.6%).
 *
 * العلاج سطر واحد: نفس السِمة حرفياً على الطبقتين. لا يجوز هنا استبدال `dir=auto`
 * بالمُحلِّل بالأغلبية — «أول حرف قوي» رتيبة تحت الإضافة (صفر انقلاب أثناء
 * الكتابة)، والأغلبية تستورد عطل اهتزاز البثّ إلى الحقل الذي يكتب فيه المستخدم.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/ChatComposer.mentionOverlay.test.tsx
 */

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import ChatComposer from './ChatComposer';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));

const noop = () => {};

const props = (input: string) =>
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
    thinkingMode: 'off',
    setThinkingMode: noop,
    composerMode: 'chat',
    setComposerMode: noop,
    agentModeAvailable: false,
    tokenBudget: null,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: input.length > 0,
    onClearInput: noop,
    isUserScrolledUp: false,
    hasMessages: false,
    onScrollToBottom: noop,
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
    input,
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

describe('ChatComposer — طبقة المرآة تطابق اتجاه الحقل حرفياً', () => {
  it('الـoverlay يحمل dir="auto" تماماً كالـtextarea تحته', () => {
    const { container } = render(<ChatComposer {...props('safe-restart.sh ثم راجع السجلّ')} />);

    const textarea = container.querySelector('textarea')!;
    const overlay = container.querySelector('[aria-hidden="true"].pointer-events-none')!;
    expect(textarea).not.toBeNull();
    expect(overlay).not.toBeNull();

    expect(textarea.getAttribute('dir')).toBe('auto');
    expect(overlay.getAttribute('dir')).toBe('auto');
    expect(overlay.getAttribute('dir')).toBe(textarea.getAttribute('dir'));
  });

  it('المُؤلِّف يبقى على `auto` ولا يُحقَن باتجاه محسوب بالأغلبية', () => {
    const { container } = render(<ChatComposer {...props('مسودّة عربية خالصة')} />);
    const textarea = container.querySelector('textarea')!;
    // نفي صريح: الاتجاه هنا يُترك للمتصفح، لا يُحسب في مسار ضغطة المفتاح.
    expect(textarea.getAttribute('dir')).toBe('auto');
  });
});
