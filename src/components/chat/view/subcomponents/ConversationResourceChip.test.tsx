/**
 * ConversationResourceChip.test.tsx — ما يصل الشاشة، لا ما تحسبه الدالّة.
 *
 * الحدّ الحرج المختبَر هنا واحد: **الشرطة بدل الصفر**. محادثة بلا عملية حيّة
 * يجب أن تُطبع `—`؛ رقم `0MB` يُقرأ «لا تستهلك شيئاً» وهو ادّعاء لا نملكه —
 * وهو النمط نفسه الذي حرسته شارة الكلفة المجاورة. والحدّ الثاني: **لا رقم
 * جهاز هنا** — قرار المالك 2026-07-31 أن حالة الجهاز مكانها الشريط الجانبي،
 * فرقمٌ للجهاز داخل شارة المحادثة يُقرأ رقمَ المحادثة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const extras = ['mem', 'count']
        .filter(name => opts && opts[name] !== undefined)
        .map(name => `${name}=${String(opts?.[name])}`);
      return extras.length > 0 ? `${key}(${extras.join(',')})` : key;
    },
    i18n: { language: 'ar' },
  }),
}));

const useSessionResources = vi.fn();
vi.mock('../../hooks/useSessionResources', () => ({
  useSessionResources: (...args: unknown[]) => useSessionResources(...args),
}));

import ConversationResourceChip from './ConversationResourceChip';
import { formatMb } from './conversationResourceFormat';

const LIVE = {
  available: true,
  rootPid: 1234,
  pidSource: 'registry' as const,
  processCount: 6,
  memoryMb: 912,
  memorySource: 'pss' as const,
  cpuPercent: 14.2,
  breakdown: [
    { kind: 'browser' as const, processCount: 3, memoryMb: 520 },
    { kind: 'session' as const, processCount: 1, memoryMb: 300 },
    { kind: 'agent' as const, processCount: 2, memoryMb: 92 },
  ],
};

const mountWith = (resources: unknown, status = 'ready') => {
  useSessionResources.mockReturnValue({ resources, status, refresh: vi.fn() });
  return render(<ConversationResourceChip sessionId="sess-1" />);
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('formatMb', () => {
  it('يعرض الميغا دون 1024 والغيغا فوقها', () => {
    expect(formatMb(912)).toBe('912MB');
    expect(formatMb(3300)).toBe('3.2GB');
  });

  it('رقم غير صالح يصير شرطة لا صفراً', () => {
    expect(formatMb(Number.NaN)).toBe('—');
    expect(formatMb(-5)).toBe('—');
  });

  it('الصفر نفسه شرطة — «تستهلك 0MB» ادّعاء لا نملكه (مراجعة 2026-07-31)', () => {
    expect(formatMb(0)).toBe('—');
  });
});

describe('ConversationResourceChip', () => {
  it('trigger شفاف بلا حد أو ظل، وتظهر حالة الفتح كـghost', () => {
    mountWith(LIVE);
    const button = screen.getByRole('button');
    const tokens = button.className.split(/\s+/);
    expect(tokens).toContain('bg-transparent');
    expect(tokens).toContain('hover:bg-accent/80');
    expect(tokens).toContain('focus-visible:ring-2');
    expect(tokens).not.toContain('border');
    expect(tokens).not.toContain('shadow-sm');

    fireEvent.click(button);
    expect(button.className.split(/\s+/)).toContain('bg-accent/80');
  });

  it('يطبع شرطة — لا 0MB — حين لا عملية منسوبة', () => {
    mountWith({ ...LIVE, available: false, memoryMb: 0, processCount: 0 });
    const chip = screen.getByRole('button');
    expect(chip.textContent).toContain('—');
    expect(chip.textContent).not.toContain('0MB');
  });

  it('يطبع الذاكرة حين تتوفّر', () => {
    mountWith(LIVE);
    expect(screen.getByRole('button').textContent).toContain('912MB');
  });

  it('يفتح التفصيل ويعرض توزيع المحادثة', () => {
    mountWith(LIVE);
    fireEvent.click(screen.getByRole('button'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('mem=912MB');
    expect(dialog.textContent).toContain('resources.kind.browser');
    expect(dialog.textContent).toContain('520MB');
  });

  it('لا يعرض شيئاً عن الجهاز — مكانه الشريط الجانبي', () => {
    mountWith(LIVE);
    fireEvent.click(screen.getByRole('button'));
    const dialog = screen.getByRole('dialog');
    // رقم جهاز داخل شارة المحادثة يُقرأ رقمَ المحادثة.
    expect(dialog.textContent).not.toContain('/tmp');
    expect(dialog.textContent).not.toContain('swap');
    expect(dialog.textContent).not.toContain('resources.systemTitle');
  });

  it('شجرة فشلت كل قياساتها تُعرض شرطةً لا 0MB', () => {
    // الخدمة تُعيد available:false في هذه الحالة بعد الإصلاح؛ وهذا حارس ثانٍ
    // على مستوى العرض لو تسرّب صفرٌ من أي مصدر.
    mountWith({ ...LIVE, memoryMb: 0 });
    expect(screen.getByRole('button').textContent).not.toContain('0MB');
  });

  it('يُفصح عن مصدر القياس حين يهبط إلى RSS', () => {
    mountWith({ ...LIVE, memorySource: 'rss' });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('resources.rssNote');
  });

  it('يشرح سبب غياب النسبة بدل تركها فراغاً', () => {
    mountWith({ ...LIVE, available: false });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('resources.unattributed');
  });
});
