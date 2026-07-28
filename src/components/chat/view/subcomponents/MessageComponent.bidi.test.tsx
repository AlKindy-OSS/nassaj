/**
 * B-RTL-MSG — ثلاثة مواضع في `MessageComponent` يُحسم فيها الاتجاه على العنصر الخطأ.
 *
 * ٣. بطاقة إشعار المهمة: `dir="auto"` كان على صفّ الـflex نفسه، فيقلب **التخطيط**
 *    (نقطة الحالة وشريط `border-s-2`) لا النصّ. ومقيس على البيانات الحقيقية:
 *    1742 من 1744 ملخّص إشعار يبدأ بحرف لاتيني ⇒ `auto` = ltr دوماً، فالبطاقة
 *    العربية تُبنى بتخطيط لاتيني مهما كان محتواها.
 * ٤. رسالة النظام: التسمية المترجَمة `[System message]` تسبق المحتوى داخل نفس
 *    الـ`span dir="auto"`، فأول حرف قوي هو حرف التسمية دائماً — المحتوى لا رأي له
 *    في اتجاه نفسه.
 * ٥. النافذة التفاعلية: سطر السؤال ونصوص الخيارات بلا أي حسم اتجاه.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.bidi.test.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import MessageComponent from './MessageComponent';
import { resolveTextDirection } from '../../../../utils/textDirection';

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

const renderMessage = (message: Record<string, unknown>) => {
  const props = {
    prevMessage: null,
    createDiff: () => [],
    provider: 'claude',
    message: { id: 'm1', timestamp: '2026-07-26T10:00:00.000Z', ...message },
  } as unknown as MessageComponentProps;
  return render(<MessageComponent {...props} />);
};

afterEach(cleanup);

describe('MessageComponent — إشعار المهمة: الاتجاه على النصّ لا على صفّ التخطيط', () => {
  // ملخّص إشعار واقعي: يفتح بلاتيني ثم يستدير عربياً — أغلبيته عربية.
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
