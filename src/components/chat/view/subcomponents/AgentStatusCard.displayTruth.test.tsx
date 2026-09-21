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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

const translationLanguage = vi.hoisted(() => ({ value: 'en' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // نُعيد `defaultValue` بعد استبدال المتغيّرات كي يكون النصّ المعروض واقعياً.
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
    i18n: { get language() { return translationLanguage.value; } },
  }),
}));

import type { RunAgent } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';

// `globals: false` في vite.config.js ⇒ لا تنظيف تلقائي بين الحالات؛ بدونه
// تتراكم أشجار DOM من حالات سابقة وتُلوّث استعلامات `screen`.
afterEach(() => {
  translationLanguage.value = 'en';
  cleanup();
});

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

  it('يعرض تسمية الإيقاف العربية في واجهة عربية', () => {
    translationLanguage.value = 'ar';
    renderCard({ agents: [agent({})], runStartedAt: null });
    assert.equal(screen.getAllByText('إيقاف').length, 1);
  });

  it('مع مرساة حقيقية ⇒ المؤقّت يعرض القيمة الفعلية لا صفراً', () => {
    const { container } = renderCard({
      agents: [agent({})],
      runStartedAt: Date.now() - 125_000, // ‏2m 5s
    });

    assert.equal(
      /2m\s*5\.0s/.test(container.textContent ?? ''),
      true,
      `المؤقّت لم يستأنف من القيمة الحقيقية: ${container.textContent}`,
    );
  });

  it('يظهر في البطاقة الموحّدة حتى عند تعذّر الإيقاف ولا يُحجب في العرض الضيق', () => {
    const { container } = render(
      <AgentStatusCard
        agents={[agent({})]}
        status={{ text: 'Working', can_interrupt: false }}
        onAbort={() => {}}
        isLoading
        provider="claude"
        runStartedAt={Date.now() - 5_000}
        progress={null}
      />,
    );

    const timer = container.querySelector('[data-testid="current-run-elapsed"]');
    assert.equal(timer?.textContent, '5.0s');
    assert.equal(timer?.className.includes('hidden'), false);
    assert.equal((container.textContent ?? '').includes('STOP'), false);
  });

  it('يظهر في ClaudeStatus مستقلاً عن زر الإيقاف', () => {
    const { container } = render(
      <AgentStatusCard
        agents={[]}
        status={{ text: 'Working', can_interrupt: false }}
        onAbort={() => {}}
        isLoading
        provider="claude"
        runStartedAt={Date.now() - 7_000}
        progress={null}
      />,
    );

    const timer = container.querySelector('[data-testid="current-run-elapsed"]');
    assert.equal(timer?.textContent, '7.0s');
    assert.equal(timer?.className.includes('hidden'), false);
    assert.equal((container.textContent ?? '').includes('STOP'), false);
  });

  it('يبدأ من حافة التشغيل المحلية إذا لم يصل طابع الرسالة بعد', () => {
    const { container, rerender } = render(
      <AgentStatusCard
        agents={[]}
        status={null}
        onAbort={() => {}}
        isLoading={false}
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );

    rerender(
      <AgentStatusCard
        agents={[]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={() => {}}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );

    assert.equal(
      container.querySelector('[data-testid="current-run-elapsed"]')?.textContent,
      '0ms',
    );
  });

  it('يعرض وحدات الساعة في ClaudeStatus بدل تجميع المدة في دقائق', () => {
    const { container } = render(
      <AgentStatusCard
        agents={[]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={() => {}}
        isLoading
        provider="claude"
        runStartedAt={Date.now() - 3_780_000}
        progress={null}
      />,
    );

    assert.equal(
      container.querySelector('[data-testid="current-run-elapsed"]')?.textContent,
      '1h 3m 0.0s',
    );
  });

  it('يعرض وحدات اليوم في البطاقة الموحّدة', () => {
    const { container } = renderCard({
      agents: [agent({})],
      runStartedAt: Date.now() - 93_784_000,
    });

    assert.equal(
      container.querySelector('[data-testid="current-run-elapsed"]')?.textContent,
      '1d 2h 3m 4.0s',
    );
  });

  it('يستخدم وحدات عربية عندما تكون لغة الواجهة عربية', () => {
    translationLanguage.value = 'ar-SA';
    const { container } = renderCard({
      agents: [agent({})],
      runStartedAt: Date.now() - 3_780_000,
    });

    assert.equal(
      container.querySelector('[data-testid="current-run-elapsed"]')?.textContent,
      '1س 3د 0.0ث',
    );
  });
});

// ── عنوان الورشة الخلفية: لا يدّعي حياةً لم يشهد بها الخادم ──────────────────
//
// العطل: `backgroundOnly` كان يطبع نصّاً ثابتاً «Background workflow running»
// لأيّ ورشة تُعرض صفوفها. لكن `useWorkflowStripAgents` يُظهر `unknown` و`frozen`
// أيضاً (SURFACED_STATUSES) — فورشة رفض الخادم صراحةً الشهادةَ بحياتها، وأخرى
// موقوفة بـSIGSTOP، كلتاهما كانتا تُقرآن «تعمل». الحكم الصادق كان موجوداً في
// المتجر طوال الوقت ولم يكن موصولاً بالمكوّن.
//
// المُحاكي أعلاه يُرجع `defaultValue` أو المفتاح؛ ونداء الحالة يُمرَّر بلا
// defaultValue عمداً، فالمعروض هو المفتاح نفسه — وهو ما يُقاس هنا، مع التحقّق
// من الحزمة الحقيقية أن ذلك المفتاح لا يترجم إلى كلمة «running».
describe('عنوان الورشة الخلفية', () => {
  const backgroundRow = agent({ id: 'wf_10000000-demo:a1', type: '10000000 · #1' });

  function renderBackgroundCard(workflowStatus: unknown) {
    return render(
      <AgentStatusCard
        agents={[]}
        workflowAgents={[backgroundRow]}
        workflowStatus={workflowStatus as never}
        status={null}
        isLoading={false}
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );
  }

  it('ورشة حيويتها غير مثبتة ⇒ لا تُطبع كلمة running', () => {
    const { container } = renderBackgroundCard({
      state: 'unknown',
      labelKey: 'workflowStatus.unknown',
      hintKey: 'workflowStatus.unknownHint',
      pulse: false,
      progress: null,
    });

    const text = container.textContent ?? '';
    assert.equal(
      text.includes('Background workflow running'),
      false,
      `البطاقة ما تزال تدّعي التشغيل: ${text}`,
    );
    assert.equal(text.includes('workflowStatus.unknown'), true, text);
  });

  it('ورشة مُجمَّدة ⇒ عنوانها مفتاح التجميد لا التشغيل', () => {
    const { container } = renderBackgroundCard({
      state: 'frozen',
      labelKey: 'workflowStatus.frozen',
      hintKey: 'workflowStatus.frozenHint',
      pulse: false,
      progress: null,
    });

    const text = container.textContent ?? '';
    assert.equal(text.includes('workflowStatus.frozen'), true, text);
    assert.equal(text.includes('Background workflow running'), false, text);
  });

  it('بلا واصف (مستدعٍ غير موصول) ⇒ يعود للنصّ القديم بدل الفراغ', () => {
    const { container } = renderBackgroundCard(null);

    assert.equal(
      (container.textContent ?? '').includes('Background workflow running'),
      true,
    );
  });

  it('كل الوكلاء صامتون ⇒ الملخّص لا يقول «running» بصفر', () => {
    // العطل الذي بقي بعد إصلاح العنوان: شريحة الملخّص كانت «{{running}}/{{total}}
    // running» بلا شرط، فبطاقةٌ عنوانها «حيوية غير معروفة» ظلّت تحمل بجانبه
    // «0/3 running». صفرٌ يُتبع بكلمة «يعمل» ما يزال إطاراً يدّعي التشغيل.
    const { container } = render(
      <AgentStatusCard
        agents={[]}
        workflowAgents={[
          agent({ id: 'w:1', type: '3f7bacaf · #1', status: 'done' }),
          agent({ id: 'w:2', type: '3f7bacaf · #2', status: 'stale' as never }),
          agent({ id: 'w:3', type: '3f7bacaf · #3', status: 'stale' as never }),
        ]}
        workflowStatus={{
          state: 'unknown',
          labelKey: 'workflowStatus.unknown',
          hintKey: 'workflowStatus.unknownHint',
          pulse: false,
          progress: null,
        } as never}
        status={null}
        isLoading={false}
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );

    const text = container.textContent ?? '';
    assert.equal(/0\/3 running/.test(text), false, `الملخّص ما يزال يقول running: ${text}`);
    assert.equal(text.includes('1/3 done'), true, text);
  });

  it('الحزمة الحقيقية: مفتاح unknown لا يترجم إلى «running»', async () => {
    // الحارس الذي يمنع إصلاحاً شكلياً: لو صار `workflowStatus.unknown` يوماً
    // يقرأ «running» في العربية أو الإنجليزية، عاد الكذب من باب الترجمة.
    const en = (await import('../../../../i18n/locales/en/common.json')).default;
    const label = en.workflowStatus?.unknown ?? '';
    assert.equal(label.length > 0, true, 'المفتاح مفقود من الحزمة الإنجليزية');
    assert.equal(/running/i.test(label), false, `الترجمة تدّعي التشغيل: ${label}`);
  });
});

// ── T-1744: طيّ/توسيع البطاقة عبر النقر على صف الرأس ─────────────────────────
describe('تبديل الطيّ بالنقر على صف الرأس (T-1744)', () => {
  function renderToggleCard(onAbortMock = vi.fn()) {
    return render(
      <AgentStatusCard
        agents={[agent({})]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={onAbortMock}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );
  }

  it('النقر على صف الرأس يُطوي صفوف الوكلاء ثم يوسّعها مرة أخرى', () => {
    const { container } = renderToggleCard();

    // البطاقة موسَّعة في البداية — صفوف الوكلاء ظاهرة.
    assert.equal(
      container.querySelector('.border-t') !== null,
      true,
      'البطاقة يجب أن تكون موسَّعة في البداية',
    );

    // النقر على نصّ الحالة (Working) داخل صف الرأس.
    const statusText = screen.getByText(/Working/);
    fireEvent.click(statusText);

    // البطاقة الآن مطويّة — صفوف الوكلاء مخفيّة.
    assert.equal(
      container.querySelector('.border-t') !== null,
      false,
      'يجب أن تُطوى البطاقة بعد النقر',
    );

    // نقرة ثانية تُعيد التوسيع.
    fireEvent.click(statusText);
    assert.equal(
      container.querySelector('.border-t') !== null,
      true,
      'يجب أن تعود البطاقة موسَّعة',
    );
  });

  it('النقر على زر STOP يُستدعى onAbort ولا يُطوي البطاقة', () => {
    const onAbortMock = vi.fn();
    const { container } = renderToggleCard(onAbortMock);

    // نجد زرّ STOP بالـaria-label أو نجده من خلال النصّ المرئي.
    // الـspan المحتوي على «STOP» ليس هو الزرّ — نصعد إلى أقرب button.
    const stopSpan = container.querySelector('span.hidden.sm\\:inline');
    const stopBtn = stopSpan?.closest('button') as HTMLButtonElement | null;
    assert.equal(stopBtn !== null, true, 'زرّ STOP يجب أن يوجد');
    fireEvent.click(stopBtn!);

    // onAbort استُدعي.
    assert.equal(onAbortMock.mock.calls.length, 1, 'onAbort يجب أن يُستدعى مرة واحدة');

    // البطاقة ما تزال موسَّعة.
    assert.equal(
      container.querySelector('.border-t') !== null,
      true,
      'النقر على STOP يجب ألّا يُطوي البطاقة',
    );
  });

  it('النقر على زر chevron يُطوي مرة واحدة فقط (لا toggle مزدوج)', () => {
    const { container } = renderToggleCard();

    const chevronBtn = screen.getByLabelText('Collapse agent activity');
    fireEvent.click(chevronBtn);

    // مطويّة مرة واحدة — لو كانت مزدوجة لعادت موسَّعة.
    assert.equal(
      container.querySelector('.border-t') !== null,
      false,
      'chevron يجب أن يُطوي البطاقة مرة واحدة فقط',
    );
  });
});
