/**
 * ConversationCostChip.test.tsx — ما يصل الشاشة فعلاً، لا ما تقرّره الدالّة الصرفة.
 *
 * `conversationCostFormat.test.ts` يثبّت القرار؛ هذا الملف يثبّت **وصوله**:
 * أن الشرطة تُطبَع بدل صفر ملفَّق، وأن جملة «قيمة مكافئة لا مبلغ محاسَب» تظهر
 * فعلاً مع كل رقم على اشتراك. الأخيرة ليست تحسيناً: رقم اشتراك بلا هذه الجملة
 * يُقرأ فاتورةً، وهو ادّعاء مالي كاذب.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    // نُعيد المفتاح نفسه (مع المتغيّرات) كي يُختبَر المفتاح المستعمَل لا نصّ
    // ترجمة قد يتغيّر.
    t: (key: string, opts?: Record<string, unknown>) => {
      const extras = ['date', 'count']
        .filter((name) => opts && opts[name] !== undefined)
        .map((name) => `${name}=${String(opts?.[name])}`);
      return extras.length > 0 ? `${key}(${extras.join(',')})` : key;
    },
    i18n: { language: 'ar' },
  }),
}));

const useConversationCost = vi.fn();
vi.mock('../../hooks/useConversationCost', () => ({
  useConversationCost: (...args: unknown[]) => useConversationCost(...args),
}));

import ConversationCostChip from './ConversationCostChip';

const COST = {
  sessionId: 'sess-1',
  provider: 'claude',
  available: true,
  metered: false,
  totalUsd: 12.34,
  complete: true,
  unpricedModels: [] as string[],
  subagentRequests: 0,
  pricesAsOf: '2026-07-28',
  perModel: [
    {
      model: 'claude-opus-5',
      costUsd: 12.34,
      requests: 8,
      tokens: { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 24_000 },
    },
  ],
};

const mountWith = (cost: unknown, status = 'success') => {
  useConversationCost.mockReturnValue({ cost, status, refresh: vi.fn() });
  return render(<ConversationCostChip sessionId="sess-1" />);
};

const chip = () => screen.getByRole('button', { name: /conversationCost\.tooltipTitle/ });

beforeEach(() => {
  useConversationCost.mockReset();
});

afterEach(() => {
  // `globals: false` يعني ألّا تنظيف تلقائياً من testing-library — بدونه تتراكم
  // نُسخ الشارة في نفس الـDOM فتفشل الاستعلامات بتعدّد المطابقات.
  cleanup();
  vi.restoreAllMocks();
});

describe('الرقم المعروض', () => {
  it('يعرض المبلغ الكامل', () => {
    mountWith(COST);
    expect(screen.getByText('$12.34')).toBeTruthy();
  });

  it('كلفة دون السنت تُقال «أقل من سنت» لا $0.00', () => {
    mountWith({ ...COST, totalUsd: 0.004 });
    expect(screen.getByText('<$0.01')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('غير المتاحة شرطةٌ لا صفر، والسبب في التلميح', () => {
    mountWith({
      ...COST,
      available: false,
      reason: 'provider does not persist token usage',
      totalUsd: 0,
    });

    expect(screen.queryByText('$0.00')).toBeNull();
    expect(chip().getAttribute('title')).toContain('provider does not persist token usage');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.unavailable');
  });

  it('التغطية الجزئية توسَم على الرقم نفسه', () => {
    mountWith({ ...COST, complete: false, unpricedModels: ['glm-5.2'] });
    expect(chip().textContent).toContain('~$12.34');
  });
});

describe('الصدق المالي في الشرح', () => {
  it('اشتراك: الرقم قيمة مكافئة لا مبلغاً محاسَباً — الجملة إلزامية', () => {
    mountWith({ ...COST, metered: false });

    const title = chip().getAttribute('title') ?? '';
    expect(title).toContain('conversationCost.apiEquivalent');
    expect(title).not.toContain('conversationCost.billed');
  });

  it('استهلاك مُقاس بمفتاح API يُقال «محاسَب»', () => {
    mountWith({ ...COST, metered: true });

    const title = chip().getAttribute('title') ?? '';
    expect(title).toContain('conversationCost.billed');
    expect(title).not.toContain('conversationCost.apiEquivalent');
  });
});

describe('نافذة التفصيل', () => {
  it('تفتح بالنقر وتحمل النماذج والوكلاء الفرعيين وتاريخ الأسعار', () => {
    mountWith({ ...COST, subagentRequests: 7 });

    fireEvent.click(chip());

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('conversationCost.apiEquivalent');
    expect(dialog.textContent).toContain('conversationCost.subagents(count=7)');
    expect(dialog.textContent).toContain('conversationCost.pricesAsOf(date=2026-07-28)');
    expect(dialog.textContent).toContain('claude-opus-5');
  });

  it('تسمّي النماذج بلا سعر رسمي حين تكون التغطية جزئية', () => {
    mountWith({ ...COST, complete: false, unpricedModels: ['glm-5.2', 'kimi-k2.6'] });

    fireEvent.click(chip());

    expect(screen.getByRole('dialog').textContent).toContain(
      'conversationCost.partial: glm-5.2, kimi-k2.6',
    );
  });

  it('نموذج بلا سعر يُعرَض شرطةً في التفصيل لا $0.00', () => {
    mountWith({
      ...COST,
      complete: false,
      unpricedModels: ['glm-5.2'],
      perModel: [
        {
          model: 'glm-5.2',
          costUsd: null,
          requests: 3,
          tokens: { input: 10, output: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
        },
      ],
    });

    fireEvent.click(chip());

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('—');
    expect(dialog.textContent).not.toContain('$0.00');
  });

  it('تُغلق بمفتاح Escape', () => {
    mountWith(COST);

    fireEvent.click(chip());
    expect(screen.queryByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('حالة التحميل', () => {
  it('أول جلب بلا رقم سابق لا يطبع صفراً', () => {
    mountWith(null, 'loading');

    expect(screen.queryByText('$0.00')).toBeNull();
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.loading');
  });
});
