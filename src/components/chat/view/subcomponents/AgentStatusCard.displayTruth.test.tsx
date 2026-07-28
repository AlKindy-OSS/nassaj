/**
 * B-208 (بند 8 — فيتو صدق العرض) — اختبار مكوّن على `AgentStatusCard`.
 *
 * القاعدة المفروضة: ما لا يمكن استعادته من القرص لا يُعرض مُلفَّقاً.
 *  - عدّاد الاستدعاءات والأداة الجارية يأتيان من `childTools` وحدها؛ وكيل ما
 *    يزال يعمل بعد تحديث الصفحة لا يملك أياً منهما (صفر صفوف `parentToolUseId`
 *    في transcripts حيّة) ⇒ يُخفى الحقلان بدل عرض «0».
 *  - المؤقّت المنقضي بلا مرساة حقيقية (`runStartedAt = null`، يقع آخر صفّ
 *    مستخدم خارج نافذة الجلب) كان يبدأ من الآن فيعرض «0s» لتشغيل عمره دقائق
 *    ⇒ يُخفى حتى تُحلّ المرساة.
 *
 * ⚠️ قاعدة كتابة إلزامية في هذا الملف: **لا يُمرَّر عنصر DOM إلى `node:assert`.**
 * النسخة الأولى كتبت `assert.equal(container.querySelector(...), null)`؛ وحين
 * فشلت (البطاقة كانت ما تزال تعرض الشارة) حاول `node:assert` بناء رسالة الفرق
 * باستنطاق عنصر jsdom بعمق ومع الـgetters، فمات عامل vitest كلّه
 * (`Worker exited unexpectedly`) ولم يُنفَّذ أيٌّ من الاختبارات الخمسة — عطلٌ
 * يتنكّر في هيئة «الاختبارات لا تعمل». تُقارَن هنا قيم أوّلية فقط
 * (‏boolean/string/number) كي يُبلِّغ الفشلُ عن نفسه بدل أن يقتل المُشغِّل.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // نُعيد `defaultValue` بعد استبدال المتغيّرات كي يكون النصّ المعروض واقعياً.
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

import type { RunAgent } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';

// `globals: false` في vite.config.js ⇒ لا تنظيف تلقائي بين الحالات؛ بدونه
// تتراكم أشجار DOM من حالات سابقة وتُلوّث استعلامات `screen`.
afterEach(cleanup);

function agent(overrides: Partial<RunAgent>): RunAgent {
  return {
    id: 'toolu_1',
    type: 'frontend-dev',
    description: 'إصلاح البطاقة',
    status: 'running',
    callCount: 0,
    startedAt: Date.now(),
    ...overrides,
  };
}

function renderCard(props: {
  agents: RunAgent[];
  runStartedAt?: number | null;
}) {
  return render(
    <AgentStatusCard
      agents={props.agents}
      status={{ text: 'Working', can_interrupt: true }}
      onAbort={() => {}}
      isLoading
      provider="claude"
      runStartedAt={props.runStartedAt ?? null}
      progress={null}
    />,
  );
}

/** عنوان شارة العدّاد إن وُجدت — نصّاً لا عقدةً (انظر قاعدة الملف أعلاه). */
function callsBadgeText(container: HTMLElement): string | null {
  const badge = container.querySelector('[title*="tool calls"]');
  return badge ? (badge.textContent ?? '').trim() : null;
}

describe('عدّاد الاستدعاءات', () => {
  it('وكيل حيّ بعد تحديث الصفحة (callCount = 0) ⇒ لا شارة عدّاد ولا «0»', () => {
    const { container } = renderCard({ agents: [agent({ callCount: 0 })] });

    assert.equal(
      screen.getAllByText(/frontend-dev/).length,
      1,
      'صفّ الوكيل نفسه يجب أن يظهر',
    );
    assert.equal(
      callsBadgeText(container),
      null,
      'ظهرت شارة عدّاد لقيمة غير معروفة',
    );
    assert.equal(
      /(^|\D)0(\D|$)/.test(container.textContent ?? ''),
      false,
      `ظهر صفر ملفَّق في نصّ البطاقة: ${container.textContent}`,
    );
  });

  it('عدّاد معروف (> 0) يُعرض كما هو', () => {
    const { container } = renderCard({ agents: [agent({ callCount: 63 })] });

    assert.equal(callsBadgeText(container), '63');
  });

  it('«الأداة الجارية» لا تُعرض لوكيل بلا childTools', () => {
    const { container } = renderCard({ agents: [agent({ callCount: 0, currentTool: undefined })] });

    assert.equal((container.textContent ?? '').includes('now'), false);
  });
});

describe('المؤقّت المنقضي', () => {
  it('بلا مرساة تشغيل (runStartedAt = null) ⇒ لا مؤقّت (لا عدّ من صفر)', () => {
    const { container } = renderCard({ agents: [agent({})], runStartedAt: null });

    assert.equal(
      /\b\d+s\b/.test(container.textContent ?? ''),
      false,
      `عُرض مؤقّت من صفر رغم غياب المرساة: ${container.textContent}`,
    );
    // زرّ الإيقاف يبقى — إخفاء المؤقّت لا يمسّ التحكّم.
    assert.equal(screen.getAllByText('STOP').length, 1);
  });

  it('مع مرساة حقيقية ⇒ المؤقّت يعرض القيمة الفعلية لا صفراً', () => {
    const { container } = renderCard({
      agents: [agent({})],
      runStartedAt: Date.now() - 125_000, // ‏2m 5s
    });

    assert.equal(
      /2m\s*5s/.test(container.textContent ?? ''),
      true,
      `المؤقّت لم يستأنف من القيمة الحقيقية: ${container.textContent}`,
    );
  });
});
