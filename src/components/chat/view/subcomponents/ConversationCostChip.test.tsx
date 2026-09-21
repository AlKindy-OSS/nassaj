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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    // نُعيد المفتاح نفسه (مع المتغيّرات) كي يُختبَر المفتاح المستعمَل لا نصّ
    // ترجمة قد يتغيّر.
    t: (key: string, opts?: Record<string, unknown>) => {
      const extras = ['date', 'count', 'tokens']
        .filter((name) => opts && opts[name] !== undefined)
        .map((name) => `${name}=${String(opts?.[name])}`);
      return extras.length > 0 ? `${key}(${extras.join(',')})` : key;
    },
    i18n: { language: 'ar' },
  }),
}));

import { ConversationCostContext } from '../../context/ConversationCostContext';
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
  workDurationMs: 3_780_000,
  perModel: [
    {
      model: 'claude-opus-5',
      costUsd: 12.34,
      requests: 8,
      tokens: { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 24_000 },
    },
  ],
};

const mountWith = (cost: unknown, status = 'success', workDurationMs?: number | null) => {
  const ctxValue = { cost: cost as never, status: status as never, refresh: vi.fn() };
  return render(
    <ConversationCostContext.Provider value={ctxValue}>
      <ConversationCostChip workDurationMs={workDurationMs} />
    </ConversationCostContext.Provider>,
  );
};

const chip = () => screen.getByRole('button', { name: /conversationCost\.tooltipTitle/ });
const durationIcon = () => screen.getByTestId('conversation-work-duration-icon');

const expectChipOrder = (duration: string) => {
  const content = chip().textContent ?? '';
  expect(content.indexOf('$12.34')).toBeLessThan(content.indexOf(duration));
  expect(content.indexOf(duration)).toBeLessThan(content.indexOf('26K'));
};

beforeEach(() => {
  // الحالة مُعاد ضبطها عبر cleanup() بعد كل اختبار — لا حاجة لإعادة ضبط mock.
});

afterEach(() => {
  // `globals: false` يعني ألّا تنظيف تلقائياً من testing-library — بدونه تتراكم
  // نُسخ الشارة في نفس الـDOM فتفشل الاستعلامات بتعدّد المطابقات.
  cleanup();
  vi.restoreAllMocks();
});

describe('الرقم المعروض', () => {
  it('trigger شفاف بلا حد أو ظل، وتظهر حالة الفتح كـghost', () => {
    mountWith(COST, 'success', 1_000);
    const button = chip();
    const tokens = button.className.split(/\s+/);
    expect(tokens).toContain('bg-transparent');
    expect(tokens).toContain('hover:bg-accent/80');
    expect(tokens).toContain('focus-visible:ring-2');
    expect(tokens).not.toContain('border');
    expect(tokens).not.toContain('shadow-sm');

    fireEvent.click(button);
    expect(button.className.split(/\s+/)).toContain('bg-accent/80');
  });

  it('يعرض المبلغ الكامل وإجمالي العمل في الشريط حين يصل قياس موثوق', () => {
    mountWith(COST, 'success', 3_780_000);
    expect(screen.getByText('$12.34')).toBeTruthy();
    expect(chip().textContent).toContain('26K');
    expect(chip().textContent).toContain('1h 3m');
    expect(durationIcon()).toBeTruthy();
    expectChipOrder('1h 3m 0.0s');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.workDuration');
    expect(chip().getAttribute('aria-label')).toContain('25,500 conversationCost.totalTokens');
    expect(chip().getAttribute('title')).toContain('25,500 conversationCost.totalTokens');
  });

  it('يعرض إحصاءات Codex الثلاث في الشريط ونافذة التفصيل', () => {
    const codexCost = {
      ...COST,
      provider: 'codex',
      perModel: [{ ...COST.perModel[0], model: 'gpt-5.6-sol' }],
    };
    mountWith(codexCost, 'success', 42_300);

    expect(chip().textContent).toContain('$12.34');
    expect(chip().textContent).toContain('42.3s');
    expect(chip().textContent).toContain('26K');

    fireEvent.click(chip());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('conversationCost.workDuration42.3s');
    expect(dialog.textContent).toContain('gpt-5.6-sol');
    expect(dialog.textContent).toContain('conversationCost.codexModelUsage');
  });

  it('لا يستعمل cost.workDurationMs مطلقاً كمصدر لمدة الرد', () => {
    mountWith(COST);

    expect(chip().textContent).not.toContain('1h 3m');
    expect(chip().textContent).toContain('—');
    expect(durationIcon()).toBeTruthy();
    expectChipOrder('—');
    expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.workDuration');
  });

  it('يعامل null كغياب صريح ولو حملت لقطة الكلفة رقماً', () => {
    mountWith(COST, 'success', null);

    expect(chip().textContent).not.toContain('1h 3m');
    expect(chip().textContent).toContain('—');
    expect(durationIcon()).toBeTruthy();
    expectChipOrder('—');
    expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.workDuration');
  });

  it('لا يعرض رقماً مخمناً حين يغيب القياس عن المصدرين', () => {
    mountWith({ ...COST, workDurationMs: undefined }, 'success', null);

    expect(chip().textContent).toContain('—');
    expect(durationIcon()).toBeTruthy();
    expectChipOrder('—');
    expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.workDuration');
  });

  it('يعرض مدة الصفر الموثقة ولا يعاملها كقيمة غائبة', () => {
    mountWith({ ...COST, workDurationMs: undefined }, 'success', 0);

    expect(chip().textContent).toContain('0ms');
    expectChipOrder('0ms');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.workDuration: 0ms');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'لا يعرض قياساً غير صالح (%s)',
    (duration) => {
      mountWith({ ...COST, workDurationMs: undefined }, 'success', duration);
      expect(chip().textContent).toContain('—');
      expect(durationIcon()).toBeTruthy();
      expectChipOrder('—');
      expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.workDuration');
    },
  );

  it('يتجاهل اختلاف رقم الكلفة ويعرض إجمالي response_turn_metrics وحده', () => {
    mountWith({ ...COST, workDurationMs: 60_000 }, 'loading', 114_400);

    expect(chip().textContent).toContain('1m 54.4s');
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
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.tokensUnavailable');
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
  it('تسمّي سلاسل Codex وطلبات بقية الهارنس بوضوح بالعربية والإنجليزية', () => {
    expect(enChat.conversationCost.codexModelUsage).toBe(
      '{{count}} threads · {{tokens}} processing units',
    );
    expect(enChat.conversationCost.requestModelUsage).toBe(
      '{{count}} requests · {{tokens}} processing units',
    );
    expect(arChat.conversationCost.codexModelUsage).toBe(
      '{{count}} سلسلة تنفيذ · {{tokens}} وحدة معالجة',
    );
    expect(arChat.conversationCost.requestModelUsage).toBe(
      '{{count}} طلباً · {{tokens}} وحدة معالجة',
    );
  });

  it('تفتح بالنقر وتحمل النماذج والوكلاء الفرعيين وتاريخ الأسعار', () => {
    mountWith({ ...COST, subagentRequests: 7 }, 'success', 3_780_000);

    fireEvent.click(chip());

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('conversationCost.workDuration1h 3m');
    expect(dialog.textContent).toContain('conversationCost.apiEquivalent');
    expect(dialog.textContent).toContain('conversationCost.subagents(count=7)');
    expect(dialog.textContent).toContain('conversationCost.pricesAsOf(date=2026-07-28)');
    expect(dialog.textContent).toContain('claude-opus-5');
  });

  it('يبقى إجمالي العمل ظاهراً حتى عندما لا تتوافر كلفة الجلسة', () => {
    mountWith(null, 'error', 114_400);

    fireEvent.click(chip());

    expect(screen.getByRole('dialog').textContent).toContain('conversationCost.workDuration1m 54.4s');
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

  it('Codex يفصل عدد سلاسل التنفيذ عن إجمالي التوكنز بلا علامة ضرب', () => {
    mountWith({
      ...COST,
      provider: 'codex',
      totalUsd: 4620.69,
      perModel: [
        {
          model: 'gpt-5.6-sol',
          costUsd: 4620.69,
          requests: 59,
          tokens: {
            input: 153_335_436,
            output: 12_719_213,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 6_944_869_120,
          },
        },
      ],
    });

    fireEvent.click(chip());

    const dialogText = screen.getByRole('dialog').textContent ?? '';
    const usage = screen.getByText('conversationCost.codexModelUsage(count=59,tokens=7.11B)');
    expect(usage.getAttribute('dir')).toBe('rtl');
    expect(dialogText).toContain('conversationCost.codexModelUsage(count=59,tokens=7.11B)');
    expect(dialogText).not.toContain('×');
  });

  it('يعرض اسم النموذج والسعر ثم تفاصيل الاستخدام في سطر مستقل بلا اقتطاع', () => {
    const longModelName = 'claude-very-long-model-name-that-must-remain-readable';
    mountWith({
      ...COST,
      perModel: [{ ...COST.perModel[0], model: longModelName }],
    });

    fireEvent.click(chip());

    const model = screen.getByText(longModelName);
    const row = model.closest('li');

    expect(row).toBeTruthy();
    const usage = within(row as HTMLElement).getByText(
      'conversationCost.requestModelUsage(count=8,tokens=26K)',
    );
    const price = within(row as HTMLElement).getByText('$12.34', { selector: 'bdi' });

    expect(row?.className).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(model.classList.contains('truncate')).toBe(false);
    expect(model.className).toContain('break-words');
    expect(price.parentElement).toBe(row);
    expect(usage.parentElement).toBe(row);
    expect(usage.className).toContain('col-span-2');
    expect(usage.className).toContain('text-muted-foreground');
    expect(usage.className).not.toMatch(/text-muted-foreground\//);
  });

  it('يربط اسم النافذة بعنوانها المرئي', () => {
    mountWith(COST);

    fireEvent.click(chip());

    const dialog = screen.getByRole('dialog');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId ?? '')?.textContent).toBe(
      'conversationCost.tooltipTitle',
    );
    expect(dialog.hasAttribute('aria-label')).toBe(false);
  });

  it.each([
    'claude',
    'cursor',
    'gemini',
    'antigravity',
    'opencode',
    'kimi',
    'deepseek',
    'glm',
    'hermes',
    'sakana',
  ])('%s يفصل عدد الطلبات عن إجمالي التوكنز بلا علامة ضرب', (provider) => {
    mountWith({ ...COST, provider });

    fireEvent.click(chip());

    const dialogText = screen.getByRole('dialog').textContent ?? '';
    const usage = screen.getByText('conversationCost.requestModelUsage(count=8,tokens=26K)');
    expect(usage.getAttribute('dir')).toBe('rtl');
    expect(dialogText).not.toContain('×');
    expect(dialogText).not.toContain('conversationCost.codexModelUsage');
  });

  it('تُغلق بمفتاح Escape', () => {
    mountWith(COST);

    fireEvent.click(chip());
    expect(screen.queryByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('تعيد التركيز إلى الشارة عند الإغلاق بالزر', () => {
    mountWith(COST);

    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'contextRot.close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('تعيد التركيز إلى الشارة عند النقر خارج النافذة', () => {
    mountWith(COST);

    fireEvent.click(chip());
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.parentElement;
    expect(overlay).toBeTruthy();
    fireEvent.pointerDown(overlay as HTMLElement);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });
});

describe('حالة التحميل', () => {
  it('أول جلب بلا رقم سابق لا يطبع صفراً', () => {
    mountWith(null, 'loading');

    expect(screen.queryByText('$0.00')).toBeNull();
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.loading');
  });

  it('يبقي اللقطة السابقة مرئية أثناء تحديثها ولا يعيد Calculating', () => {
    mountWith({ ...COST, snapshotStatus: 'fresh' }, 'loading');

    expect(screen.getByText('$12.34')).toBeTruthy();
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.refreshing');
    expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.loading');
  });

  it.each([
    ['stale', 'conversationCost.stale'],
    ['incomplete', 'conversationCost.incompleteSnapshot'],
  ])('يميّز حالة اللقطة %s عن اكتمال تسعير النماذج', (snapshotStatus, expectedKey) => {
    mountWith({ ...COST, complete: true, snapshotStatus });

    expect(screen.getByText('$12.34')).toBeTruthy();
    expect(screen.getByTestId('conversation-snapshot-warning')).toBeTruthy();
    expect(chip().getAttribute('aria-label')).toContain(expectedKey);
    expect(chip().getAttribute('aria-label')).not.toContain('conversationCost.partial');
  });
});


describe('published pricing availability', () => {
  it('shows a dash for wholly unpriced usage while retaining tokens, duration and model details', () => {
    mountWith({ ...COST, totalUsd: 0, complete: false, unpricedModels: ['gpt-6-astra'], perModel: [{ ...COST.perModel[0], model: 'gpt-6-astra', costUsd: null }] }, 'success', 60_000);
    expect(chip().textContent).not.toContain('$0.00');
    expect(chip().textContent).toContain('—');
    expect(chip().textContent).toContain('26K');
    expect(chip().textContent).toContain('1m');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.pricingUnavailable');
    fireEvent.click(chip());
    expect(screen.getByText('gpt-6-astra')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('conversationCost.pricingUnavailable');
  });

  it('labels mixed paid and unpriced usage as partial in the accessible amount', () => {
    mountWith({ ...COST, complete: false, unpricedModels: ['unknown'], perModel: [...COST.perModel, { ...COST.perModel[0], model: 'unknown', costUsd: null }] });
    expect(chip().textContent).toContain('~$12.34');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.partialAmount');
  });

  it('does not call an incomplete estimate zero even when a known model is free', () => {
    mountWith({ ...COST, totalUsd: 0, complete: false, unpricedModels: ['unknown'], perModel: [{ ...COST.perModel[0], costUsd: 0 }, { ...COST.perModel[0], model: 'unknown', costUsd: null }] });
    expect(chip().textContent).not.toContain('$0.00');
    expect(chip().getAttribute('aria-label')).toContain('conversationCost.pricingUnavailable');
  });
});
