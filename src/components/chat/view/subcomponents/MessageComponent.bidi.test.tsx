/**
 * B-RTL-MSG — ثلاثة مواضع في `MessageComponent` يُحسم فيها الاتجاه على العنصر الخطأ.
 *
 * ٣. بطاقة إشعار المهمة: `dir="auto"` كان على صفّ الـflex نفسه، فيقلب **التخطيط**
 *    (نقطة الحالة وشريط `border-s-2`) لا النصّ. عينة اصطناعية تبدأ بلاتيني ثم
 *    تستدير عربياً تثبت أن `auto` لا يصلح على حاوية التخطيط.
 * ٤. رسالة النظام: التسمية المترجَمة `[System message]` تسبق المحتوى داخل نفس
 *    الـ`span dir="auto"`، فأول حرف قوي هو حرف التسمية دائماً — المحتوى لا رأي له
 *    في اتجاه نفسه.
 * ٥. النافذة التفاعلية: سطر السؤال ونصوص الخيارات بلا أي حسم اتجاه.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.bidi.test.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { SESSION_BUCKET_PROVIDERS } from '../../../../../shared/sessionBuckets';
import { resolveTextDirection } from '../../../../utils/textDirection';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import type { LLMProvider } from '../../../../types/app';
import { TurnCostContext } from '../../context/TurnCostContext';

import MessageComponent from './MessageComponent';

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({
    catalog: [],
    runAction: async () => ({ status: 'error', code: 'not_initialized' }),
    liveStatusOf: () => null,
  }),
}));

type MessageComponentProps = ComponentProps<typeof MessageComponent>;

const renderMessage = (message: Record<string, unknown>, provider: LLMProvider = 'claude', extra: Partial<MessageComponentProps> = {}) => {
  const props = {
    prevMessage: null,
    createDiff: () => [],
    provider,
    message: { id: 'm1', timestamp: '2026-07-26T10:00:00.000Z', ...message },
    ...extra,
  } as unknown as MessageComponentProps;
  return render(<MessageComponent {...props} />);
};

afterEach(cleanup);

describe('MessageComponent — the same attested metadata for every harness', () => {
  it.each(SESSION_BUCKET_PROVIDERS)('%s exposes an honest unknown model and a capability-gated continuation', (provider) => {
    const onForkFromMessage = vi.fn();
    const view = renderMessage({ type: 'assistant', content: 'رد محفوظ', transcriptMessageId: 'saved-id' }, provider, { onForkFromMessage });
    expect(view.getByText('messageMetadata.modelUnknown')).toBeTruthy();
    const button = view.getByRole('button', { name: 'Continue in a new conversation' }) as HTMLButtonElement;
    const supported = provider === 'claude' || provider === 'codex';
    expect(button.disabled).toBe(!supported);
    fireEvent.click(button);
    expect(onForkFromMessage.mock.calls).toEqual(supported ? [['saved-id']] : []);
    if (!supported) expect(button.getAttribute('aria-description')).toBe('messageFork.errors.unsupported_provider');
  });

  it.each([
    { isFinalAnswer: true },
    { transcriptMessageId: ' ', isFinalAnswer: true },
    { transcriptMessageId: 'saved-id', isStreaming: true },
  ])('does not enable a Codex fork without a completed attested cutoff: %j', (metadata) => {
    const onForkFromMessage = vi.fn();
    const view = renderMessage({ type: 'assistant', content: 'نص', ...metadata }, 'codex', { onForkFromMessage });
    const button = view.getByRole('button', { name: 'Continue in a new conversation' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-description')).toBe(metadata.isStreaming
      ? 'messageFork.awaitingCompletion' : 'messageFork.errors.unsupported_cutoff');
    fireEvent.click(button);
    expect(onForkFromMessage).not.toHaveBeenCalled();
  });

  it('explains an unavailable continuation on a phone tap without sending a fork', () => {
    const onForkFromMessage = vi.fn();
    const view = renderMessage({ type: 'assistant', content: 'رد' }, 'codex', { onForkFromMessage });
    const button = view.getByRole('button', { name: 'Continue in a new conversation' });
    const trigger = button.parentElement!;
    expect(view.queryByRole('tooltip')).toBeNull();
    fireEvent.touchStart(trigger, { touches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(trigger, { changedTouches: [{ clientX: 20, clientY: 20 }] });
    expect(view.getByRole('tooltip').textContent).toBe('messageFork.errors.unsupported_cutoff');
    expect(trigger.getAttribute('aria-describedby')).toBe(view.getByRole('tooltip').id);
    fireEvent.click(button);
    expect(onForkFromMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it.each(SESSION_BUCKET_PROVIDERS)(
    '%s renders the response model and only the final response duration on history', (provider) => {
      const base: NormalizedMessage = {
        id: 'progress', sessionId: 'session', provider, kind: 'text', role: 'assistant',
        content: 'جارٍ العمل', timestamp: '2026-09-05T10:00:00.000Z', model: 'actual-response-model',
      };
      const rows = normalizedToChatMessages([base, {
        ...base, id: 'final', content: 'تم', responseTurnMetric: {
          durationMs: 1_500, startedAt: '2026-09-05T09:00:00.000Z', completedAt: '2026-09-05T10:00:00.000Z',
        },
      }]);
      const progress = renderMessage(rows[0], provider);
      expect(progress.getByLabelText('actual-response-model')).toBeTruthy();
      expect(progress.queryByText(/^استغرق/)).toBeNull();
      expect(progress.container.querySelector('[data-assistant-message-actions] time')).toBeTruthy();
      progress.unmount();
      const final = renderMessage(rows[1], provider);
      expect(final.getByLabelText('actual-response-model')).toBeTruthy();
      expect(final.getByText(/^استغرق/).textContent).toContain('1.5');
      expect(final.container.querySelector('button[aria-label="Copy as markdown"]')).toBeTruthy();
    },
  );
});

describe('MessageComponent — إشعار المهمة: الاتجاه على النصّ لا على صفّ التخطيط', () => {
  // ملخّص اصطناعي ممثل: يفتح بلاتيني ثم يستدير عربياً — أغلبيته عربية.
  const content = 'Sub-agent finished — تمّ إنجاز مراجعة التوثيق كاملةً';

  it('صفّ الـflex بلا dir فلا ينقلب موضع نقطة الحالة ولا الشريط الجانبي', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content,
      isTaskNotification: true,
      taskStatus: 'completed',
    });
    expect(container.querySelectorAll('[dir="auto"]')).toHaveLength(0);

    const row = container.querySelector('div.flex.items-center')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('dir')).toBeNull();
  });

  it('span النصّ يحمل الاتجاه المحسوب بالأغلبية (rtl هنا، وauto كانت تعطي ltr)', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content,
      isTaskNotification: true,
      taskStatus: 'completed',
    });
    const textSpan = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === content
    )!;
    expect(textSpan).toBeTruthy();
    expect(resolveTextDirection(content)).toBe('rtl');
    expect(textSpan.getAttribute('dir')).toBe('rtl');
  });
});

describe('MessageComponent — مدة عمل الدور المكتمل', () => {
  it('يعرض مدة الدور الموثقة بجانب الرد النهائي، بما في ذلك 0ms', () => {
    const first = renderMessage({
      type: 'assistant', content: 'تم', turnDurationMs: 114_400,
    });
    const label = first.getByText('استغرق 1د 54.4ث');
    expect(label.tagName).toBe('BDI');
    expect(label.parentElement?.getAttribute('dir')).toBe('rtl');
    first.unmount();

    const instant = renderMessage({
      type: 'assistant', content: 'فوري', turnDurationMs: 0,
    });
    expect(instant.getByText('استغرق 0ملث')).toBeTruthy();
  });

  it('لا يعرض مدةً مفقودة أو سالبة، ولا ينسبها إلى رسالة مستخدم', () => {
    const invalid = renderMessage({
      type: 'assistant', content: 'تم', turnDurationMs: -1,
    });
    expect(invalid.queryByText(/^استغرق/)).toBeNull();
    invalid.unmount();

    const user = renderMessage({
      type: 'user', content: 'نفّذ', turnDurationMs: 4_200,
    });
    expect(user.queryByText(/^استغرق/)).toBeNull();
  });

  it('يعرض مدة Codex وتوكنزه وكلفته في ذيل الرد المحفوظ', () => {
    const turn = {
      assistantMessageId: 'codex-reply',
      startedAt: null,
      completedAt: null,
      requests: 1,
      models: ['gpt-5.6-sol'],
      tokens: { input: 36_000, output: 3_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      costUsd: 0.01,
    };
    const props = {
      prevMessage: null,
      createDiff: () => [],
      provider: 'codex',
      message: {
        id: 'codex-reply_0',
        transcriptMessageId: 'codex-reply',
        timestamp: '2026-09-14T10:00:00.000Z',
        type: 'assistant',
        content: 'تم',
        turnDurationMs: 222_300,
      },
    } as unknown as MessageComponentProps;

    const view = render(
      <TurnCostContext.Provider value={new Map([['codex-reply', turn]])}>
        <MessageComponent {...props} />
      </TurnCostContext.Provider>,
    );

    expect(view.getByText('استغرق 3د 42.3ث · 39K tokens · $0.01')).toBeTruthy();
  });
});

describe('MessageComponent — أفعال المساعد أسفل الهوية والمحتوى', () => {
  it('يجعل التذييل صفاً مستقلاً بعرض شبكة الرسالة ويلف الأفعال بلا تمدد زر النسخ', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content: 'رد تجريبي',
      turnDurationMs: 1_500,
    });

    const layout = container.querySelector<HTMLElement>('[data-assistant-message-layout]')!;
    const identity = container.querySelector<HTMLElement>('[data-assistant-identity]')!;
    const content = container.querySelector<HTMLElement>('[data-assistant-message-content]')!;
    const actions = container.querySelector<HTMLElement>('[data-assistant-message-actions]')!;

    expect(layout.classList.contains('grid')).toBe(true);
    expect(identity.parentElement).toBe(layout);
    expect(content.parentElement).toBe(layout);
    expect(actions.parentElement).toBe(layout);
    expect(actions.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(actions.classList.contains('col-span-2')).toBe(true);
    // 3716d321e folds actions into the compact metadata row.
    expect(actions.classList.contains('mt-1')).toBe(true);
    expect(actions.classList.contains('flex-wrap')).toBe(true);
    expect(actions.classList.contains('w-full')).toBe(true);

    const copyButton = actions.querySelector<HTMLButtonElement>('button[aria-label="Copy as markdown"]');
    expect(copyButton).not.toBeNull();
    const copyRoot = copyButton!.parentElement!;
    expect(copyRoot.classList.contains('flex-none')).toBe(true);
    expect(copyRoot.classList.contains('flex-1')).toBe(false);
    expect(copyRoot.querySelector('button')?.classList.contains('min-h-8')).toBe(true);
  });
});

describe('MessageComponent — رسالة النظام: التسمية لا تحسم اتجاه المحتوى', () => {
  const content = 'تم استلام الطلب من العقدة المجاورة وتنفيذه بنجاح';

  it('المحتوى في شقيق مستقل يحمل اتجاهه، والتسمية لا تسبقه داخل نفس النطاق', () => {
    const { container } = renderMessage({ type: 'user', originKind: 'peer', content });

    // لا `auto` في الشجرة: أول حرف قوي كان دائماً حرف التسمية `[System message]`.
    expect(container.querySelectorAll('[dir="auto"]')).toHaveLength(0);

    const contentSpan = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === content
    )!;
    expect(contentSpan).toBeTruthy();
    expect(contentSpan.getAttribute('dir')).toBe('rtl');

    // التسمية شقيقة للمحتوى لا حاضنة له — وهذا بيت القصيد: ما دامت تحويه
    // فأول حرف قوي في النطاق هو حرفها، ويبقى المحتوى بلا رأي في اتجاهه.
    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === '[System message]'
    )!;
    expect(label).toBeTruthy();
    expect(label.contains(contentSpan)).toBe(false);
    expect(label.parentElement).toBe(contentSpan.parentElement);
  });
});

describe('MessageComponent — النافذة التفاعلية: سؤال وخيارات بلا حسم اتجاه', () => {
  const question = 'هل نرفع العلم الآن على العقدة المحلية';
  const content = [question, '❯ 1. نعم، ارفعه الآن', '  2. لا، أجّله للسبرنت التالي'].join('\n');

  it('سطر السؤال يحمل dir محسوباً', () => {
    const { container } = renderMessage({ type: 'assistant', content, isInteractivePrompt: true });
    const p = Array.from(container.querySelectorAll('p')).find(
      (el) => el.textContent === question
    )!;
    expect(p).toBeTruthy();
    expect(p.getAttribute('dir')).toBe('rtl');
  });

  it('نصّ كل خيار يحمل dir محسوباً بمعزل عن رقمه اللاتيني', () => {
    const { container } = renderMessage({ type: 'assistant', content, isInteractivePrompt: true });
    const texts = ['نعم، ارفعه الآن', 'لا، أجّله للسبرنت التالي'];
    for (const text of texts) {
      const span = Array.from(container.querySelectorAll('span')).find(
        (el) => el.textContent === text
      )!;
      expect(span, text).toBeTruthy();
      expect(span.getAttribute('dir')).toBe('rtl');
    }
  });
});

describe('B-928 conversation error rows', () => {
  it.each([
    { code: 'usage_limit' },
    { error: { code: 'usage_limit', detail: 'private-token' } },
  ])('keeps the original code through history normalization: %j', (wire) => {
    const [message] = normalizedToChatMessages([{
      id: 'error-row', sessionId: 'saved-session', kind: 'error', provider: 'codex',
      timestamp: '2026-09-05T00:00:00Z', content: '/private/secret token', ...wire,
    } as NormalizedMessage]);
    expect(message.errorCode).toBe('usage_limit');
    const view = renderMessage(message, 'codex');
    expect(view.container.textContent).toContain('usage_limit');
    expect(view.container.textContent).not.toMatch(/private|secret|Unknown error/);
  });

  it('renders an unclassified row safely even without normalization', () => {
    const view = renderMessage({ type: 'error', content: '/private/token' }, 'codex');
    expect(view.container.textContent).toContain('SERVER_ERROR_UNCLASSIFIED');
    expect(view.container.textContent).not.toContain('/private/token');
  });

  it('keeps the stale-session action behind its exact code and explicit click', () => {
    const onStartNewSession = vi.fn();
    const [message] = normalizedToChatMessages([{
      id: 'stale', kind: 'error', provider: 'codex', timestamp: '2026-09-05T00:00:00Z',
      error: { code: 'conversation_not_found' }, staleSessionId: 'old', command: 'original command',
    } as NormalizedMessage]);
    const view = renderMessage(message, 'codex', { onStartNewSession });
    expect(view.container.textContent).toContain('conversation_not_found');
    expect(onStartNewSession).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'sessionNotResumable.startNew' }));
    expect(onStartNewSession).toHaveBeenCalledWith('original command');
  });

  it('does not offer stale-session recovery based on error text alone', () => {
    const view = renderMessage({ type: 'error', content: 'conversation_not_found', failedCommand: 'command' }, 'codex');
    expect(view.queryByRole('button', { name: 'sessionNotResumable.startNew' })).toBeNull();
  });
});
