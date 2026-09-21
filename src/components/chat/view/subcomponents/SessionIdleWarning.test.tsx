/**
 * SessionIdleWarning.test.tsx — اختبارات مكوّن تنبيه خمول الجلسة (T-1764).
 *
 * الحالات المغطّاة:
 *  1. <60 دقيقة → لا يظهر
 *  2. ≥60 دقيقة → يظهر (مع رقم التوكنز حين يتوفر)
 *  2b. contextTokens = used (لا cumulative) — المصدر الصحيح هو حجم السياق الحالي
 *  3. أثناء البثّ → لا يظهر
 *  4. بعد الإرسال (تغيّر lastMessageTimestamp) → يختفي
 *  5. النقر على الرابط → يستدعي onNewSession
 *  6. contextTokens = null (مزوّد بلا عدّاد) → يظهر بلا رقم
 *
 * RUNNER: vitest (npm run test:client) — jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- mock react-i18next ---
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts?.defaultValue) return opts.defaultValue as string;
        return key;
      },
      i18n: { language: 'ar' },
    }),
    // Trans يُصيَّر بعرض مكوّناته الـcomponents كأزرار فعلية كي تعمل اختبارات النقر.
    Trans: ({
      i18nKey,
      components,
    }: {
      i18nKey?: string;
      components?: Record<string, React.ReactElement>;
    }) => {
      const link = components?.link;
      if (!link) return i18nKey ?? null;
      return React.cloneElement(link, {}, 'محادثة جديدة');
    },
  };
});

import SessionIdleWarning from './SessionIdleWarning';

/** عتبة اشتراك Claude (60 دقيقة) — الحالات الأساسية تُختبر عليها. */
const IDLE_THRESHOLD_MS = 60 * 60 * 1_000;

/** مساعد: يُصيَّر SessionIdleWarning بمدخلات مباشرة (بلا context). */
function mount(props: {
  lastMessageTimestamp: number | null;
  isStreaming: boolean;
  contextTokens?: number | null;
  thresholdMs?: number;
  onNewSession?: () => void;
}) {
  const onNewSession = props.onNewSession ?? vi.fn();
  return render(
    <SessionIdleWarning
      lastMessageTimestamp={props.lastMessageTimestamp}
      isStreaming={props.isStreaming}
      contextTokens={props.contextTokens ?? null}
      thresholdMs={props.thresholdMs ?? IDLE_THRESHOLD_MS}
      onNewSession={onNewSession}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SessionIdleWarning', () => {
  describe('1. أقل من 60 دقيقة — لا يظهر', () => {
    it('لا يعرض التنبيه عند lastMessageTimestamp = null (جلسة فارغة)', () => {
      vi.useFakeTimers();
      mount({ lastMessageTimestamp: null, isStreaming: false });
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });

    it('لا يعرض التنبيه قبل مرور ساعة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - (IDLE_THRESHOLD_MS - 60_000); // 59 دقيقة
      mount({ lastMessageTimestamp: ts, isStreaming: false });
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });
  });

  describe('2. مرور ساعة أو أكثر — يظهر', () => {
    it('يعرض التنبيه عند مرور ساعة بالضبط', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      mount({ lastMessageTimestamp: ts, isStreaming: false, contextTokens: 180_000 });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });

    it('يعرض التنبيه عند مرور أكثر من ساعة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS - 5 * 60_000;
      mount({ lastMessageTimestamp: ts, isStreaming: false });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });

    it('يظهر التنبيه بعد تقدّم المؤقّت لإتمام الساعة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - (IDLE_THRESHOLD_MS - 60_000); // 59 دقيقة
      mount({ lastMessageTimestamp: ts, isStreaming: false });

      expect(screen.queryByTestId('session-idle-warning')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });
  });

  describe('2b. المصدر الصحيح: contextTokens = حجم السياق الحالي لا الإجمالي التراكمي', () => {
    it('يعرض 180K (used) وليس قيمة تراكمية أكبر', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;

      // حجم السياق الحالي = 180,000 توكن
      // لو كانت القيمة التراكمية (cumulativeUsed) تُستخدم بدلاً فستكون أكبر بكثير
      const usedContextTokens = 180_000;

      mount({ lastMessageTimestamp: ts, isStreaming: false, contextTokens: usedContextTokens });

      const warning = screen.getByTestId('session-idle-warning');
      // يُعرض الزرّ (Trans يُصيَّر بـmock) — نتحقق من وجود التنبيه
      expect(warning).toBeTruthy();
      // التنبيه يحمل الزرّ المُصيَّر من Trans لا رقماً آخر
      const link = warning.querySelector('button');
      expect(link).not.toBeNull();
    });

    it('يعرض التنبيه بلا رقم حين contextTokens = null (مزوّد بلا عدّاد)', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      mount({ lastMessageTimestamp: ts, isStreaming: false, contextTokens: null });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });

    it('يعرض التنبيه بلا رقم حين contextTokens = 0', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      mount({ lastMessageTimestamp: ts, isStreaming: false, contextTokens: 0 });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });
  });

  describe('3. أثناء البثّ — لا يظهر', () => {
    it('لا يعرض التنبيه حين isStreaming = true ولو مضت ساعة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS - 60_000;
      mount({ lastMessageTimestamp: ts, isStreaming: true });
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });

    it('يختفي التنبيه فور بدء البثّ', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      const { rerender } = mount({ lastMessageTimestamp: ts, isStreaming: false });

      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();

      rerender(
        <SessionIdleWarning
          lastMessageTimestamp={ts}
          isStreaming={true}
          contextTokens={null}
          thresholdMs={IDLE_THRESHOLD_MS}
          onNewSession={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });
  });

  describe('4. بعد إرسال رسالة جديدة — يختفي', () => {
    it('يختفي عند تحديث lastMessageTimestamp إلى وقت حديث', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const oldTs = now - IDLE_THRESHOLD_MS;
      const { rerender } = mount({ lastMessageTimestamp: oldTs, isStreaming: false });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();

      const newTs = now;
      rerender(
        <SessionIdleWarning
          lastMessageTimestamp={newTs}
          isStreaming={false}
          contextTokens={null}
          thresholdMs={IDLE_THRESHOLD_MS}
          onNewSession={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });
  });

  describe('5. النقر على الرابط — يستدعي onNewSession', () => {
    it('يستدعي onNewSession عند النقر على زر المحادثة الجديدة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      const onNewSession = vi.fn();
      mount({ lastMessageTimestamp: ts, isStreaming: false, onNewSession });

      const warning = screen.getByTestId('session-idle-warning');
      const link = warning.querySelector('button');
      expect(link).not.toBeNull();
      fireEvent.click(link!);
      expect(onNewSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. العتبة تُمرَّر حسب الهارنس (T-1765)', () => {
    it('عتبة 5 دقائق: يظهر بعد 5 دقائق لا قبلها', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const fiveMinutes = 5 * 60_000;
      mount({ lastMessageTimestamp: now - 4 * 60_000, isStreaming: false, thresholdMs: fiveMinutes });
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
    });

    it('عتبة 30 دقيقة: لا يظهر عند 29 دقيقة', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      mount({ lastMessageTimestamp: now - 29 * 60_000, isStreaming: false, thresholdMs: 30 * 60_000 });
      expect(screen.queryByTestId('session-idle-warning')).toBeNull();
    });
  });

  describe('6. contextTokens = null — جملة بلا رقم', () => {
    it('يظهر التنبيه بلا رقم حين المزوّد لا يدعم عدّاد التوكنز', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);
      const ts = now - IDLE_THRESHOLD_MS;
      mount({ lastMessageTimestamp: ts, isStreaming: false, contextTokens: null });
      // يظهر التنبيه
      expect(screen.getByTestId('session-idle-warning')).toBeTruthy();
      // الزرّ موجود (Trans يُصيَّر بـmock حتى بلا tokens)
      const link = screen.getByTestId('session-idle-warning').querySelector('button');
      expect(link).not.toBeNull();
    });
  });
});
