/**
 * InlineModelSwitcher.test.tsx — T-1028 / B-247 / B-251 / B-252 / B-311
 *
 * يُغطّي ثماني خصائص إلزامية:
 * (أ) استعمال مزوّد الجلسة لا العام عند اختلافهما — انحدار B-247.
 * (ب) إخفاء المبدّل لمزوّد لا يدعم التبديل (hermes) — حالة rows=[].
 * (ج) تمرير معرّف opencode المؤهَّل بلا تشذيب (T-1021/6be3c7ab).
 * (د) B-352 — محور المحرّك معروض ومحكوم بالمفتاح المخزَّن، والاختيار يمرّر
 *     المحورين معاً (model + engine) في الاتجاهين.
 * (هـ) B-251 — إفصاح النطاق قبل الاختيار وتأكيده بعده من scope الخادم.
 * (و) B-252 — خيار «اتبع الافتراضي»: ظهوره وغيابه ونصّه واستدعاء DELETE.
 * (ز) B-ENG/B-352 — جلسة مختومة بمحرّك: يُعلَن اسمه ويبقى المبدّل فعّالاً.
 * (ح) B-311 — استنباط المحرّك من النموذج الفعّال حين يغيب ختم localStorage،
 *     بلا تقييد زائد على معرّف بائت ولا على جسد غير claude.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/InlineModelSwitcher.test.tsx
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';

import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import InlineModelSwitcher from './InlineModelSwitcher';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; model?: string; engine?: string }) => {
      // إن احتوى على model أو engine، أعِد «key:value» حتى يمكن اختبار كليهما
      if (opts?.model) return `${key}:${opts.model}`;
      if (opts?.engine) return `${key}:${opts.engine}`;
      return (opts && opts.defaultValue) || key;
    },
    i18n: { language: 'ar' },
  }),
}));

/**
 * B-352: مفاتيح المورّدين تحكم أي صفوف محرّك تُعرض أصلاً. مفتاح مخزَّن ⇒ صفّ
 * قابل للتشغيل يظهر؛ لا مفتاح ⇒ صفّ locked يُرشَّح. القيمة قابلة للتبديل بين
 * الاختبارات عبر `vendorKeys`.
 */
const vendorKeys: Record<string, boolean> = { kimi: false, glm: false, deepseek: false };
vi.mock('../../../provider-auth/hooks/useVendorKeyStatuses', () => ({
  useVendorKeyStatuses: () => ({ statuses: vendorKeys, loading: false, refresh: vi.fn() }),
}));

// createPortal → renderは通常のDOMに出力させる
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

// requestAnimationFrame stub: يُنفَّذ الـcallback فوراً بدل الجولة التالية.
// هذا يجعل dropdownStyle يُحدَّث قبل أن تبحث الاختبارات عن الخيارات،
// فلا يبقى الـvisibility:hidden المبدئي على القائمة.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vendorKeys.kimi = false;
  vendorKeys.glm = false;
  vendorKeys.deepseek = false;
  cleanup();
});

// ─── Catalog helpers ─────────────────────────────────────────────────────────

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((value) => ({ value, label: value })),
  DEFAULT: values[0],
});

const CLAUDE_CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: def('claude-sonnet-4-5', 'claude-opus-4-8'),
  // محرّكات — يجب ألا تظهر في القائمة
  glm: def('glm-5.2'),
  kimi: def('kimi-k2.6'),
};

const OPENCODE_CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  opencode: def('glm/glm-5.2', 'opencode/big-pickle'),
};

const KIMI_CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  kimi: def('kimi-k2.6', 'kimi-k1.5-long-context'),
};

// ─── (ب) حالة rows فارغة — لا نماذج في الكتالوج ───────────────────────────

describe('(ب) حالة المزوّد الذي لا نماذج له في الكتالوج', () => {
  it('يُعرَض الزرّ معطّلاً مع title يشير لعدم وجود نماذج', () => {
    const onSelect = vi.fn();
    render(
      <InlineModelSwitcher
        provider="hermes"
        currentModel=""
        catalog={{}}
        onSelect={onSelect}
      />,
    );
    const btn = screen.getByRole('button');
    // الزرّ يبقى لكنه معطَّل (rows=[] → isDisabled=true)
    expect(btn).toBeDefined();
    // disabled حين rows.length===0
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('لا يُستدعى onSelect عند النقر على زرّ معطّل', () => {
    const onSelect = vi.fn();
    render(
      <InlineModelSwitcher
        provider="hermes"
        currentModel=""
        catalog={{}}
        onSelect={onSelect}
      />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── (د) B-352 — صفوف المحرّك تُعرض بمقدار ما هو قابل للتشغيل ──────────────

describe('(د) B-352 — محور المحرّك معروض ومحكوم بالمفتاح المخزَّن', () => {
  const openOptions = () => {
    fireEvent.click(screen.getByRole('button'));
    return screen
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent || '');
  };

  it('يُخفي صفوف محرّك بلا مفتاح مخزَّن — لا مسار إعدادات من وسط المحادثة', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
      />,
    );
    const modelValues = openOptions();
    expect(modelValues.some((v) => v.includes('claude-sonnet-4-5'))).toBe(true);
    expect(modelValues.some((v) => v.includes('claude-opus-4-8'))).toBe(true);
    // لا مفتاح ⇒ الصفّ locked ⇒ مُرشَّح
    expect(modelValues.some((v) => v.includes('glm-5.2'))).toBe(false);
    expect(modelValues.some((v) => v.includes('kimi-k2.6'))).toBe(false);
  });

  it('يعرض نماذج المحرّك الذي له مفتاح، جنباً إلى جنب مع نماذج Claude', () => {
    vendorKeys.kimi = true;
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
      />,
    );
    const modelValues = openOptions();
    expect(modelValues.some((v) => v.includes('claude-opus-4-8'))).toBe(true);
    expect(modelValues.some((v) => v.includes('kimi-k2.6'))).toBe(true);
    // glm ما زال بلا مفتاح ⇒ غائب
    expect(modelValues.some((v) => v.includes('glm-5.2'))).toBe(false);
  });

  it('يمرّر محرّك الصفّ مع النموذج — المحوران يتحرّكان معاً', () => {
    vendorKeys.kimi = true;
    const onSelect = vi
      .fn()
      .mockResolvedValue({ scope: 'session' as const, model: 'kimi-k2.6' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-dual-axis"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('option', { name: /kimi-k2\.6/i, hidden: true }));
    expect(onSelect).toHaveBeenCalledWith('kimi-k2.6', 'kimi');
  });

  it('العودة إلى نموذج Claude من جلسة محرَّكة تمرّر محرّكاً null (فكّ الختم)', () => {
    vendorKeys.kimi = true;
    const onSelect = vi
      .fn()
      .mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="kimi-k2.6"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-back-to-claude"
        engineProvider="kimi"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-4-8/i, hidden: true }));
    expect(onSelect).toHaveBeenCalledWith('claude-opus-4-8', null);
  });
});

// ─── (ج) معرّف opencode المؤهَّل يُمرَّر بلا تشذيب ──────────────────────────

describe('(ج) معرّف opencode المؤهَّل يُمرَّر حرفياً', () => {
  it('يُستدعى onSelect بـglm/glm-5.2 بلا حذف البادئة (T-1021)', async () => {
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'glm/glm-5.2' });
    render(
      <InlineModelSwitcher
        provider="opencode"
        currentModel="opencode/big-pickle"
        catalog={OPENCODE_CATALOG}
        onSelect={onSelect}
      />,
    );

    // افتح القائمة
    fireEvent.click(screen.getByRole('button'));

    // اختر النموذج المؤهَّل
    const glmOption = screen.getByRole('option', { name: /glm\/glm-5\.2/i, hidden: true });
    fireEvent.click(glmOption);

    // تحقّق: القيمة الكاملة المؤهَّلة وصلت بلا تشذيب
    expect(onSelect).toHaveBeenCalledWith('glm/glm-5.2', null);
    expect(onSelect).not.toHaveBeenCalledWith('glm-5.2', null);
  });
});

// ─── (أ) onSelect يتلقّى model الصف كما هو — لا اشتقاق ──────────────────────

describe('(أ) انحدار B-247 — onSelect يتلقّى model الصف كما جاء من rowsForBody', () => {
  it('يُمرَّر model الصف المختار حرفياً دون معالجة إضافية', async () => {
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'kimi-k1.5-long-context' });
    render(
      <InlineModelSwitcher
        provider="kimi"
        currentModel="kimi-k2.6"
        catalog={KIMI_CATALOG}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const longCtxOption = screen.getByRole('option', { name: /kimi-k1\.5-long-context/i, hidden: true });
    fireEvent.click(longCtxOption);

    // onSelect يُستدعى بالقيمة الخام من الكتالوج
    expect(onSelect).toHaveBeenCalledWith('kimi-k1.5-long-context', null);
  });

  it('لا يُستدعى onSelect حين يختار المستخدم النموذج الحالي ذاته', async () => {
    const onSelect = vi.fn();
    render(
      <InlineModelSwitcher
        provider="kimi"
        currentModel="kimi-k2.6"
        catalog={KIMI_CATALOG}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    const currentOption = screen.getByRole('option', { name: /kimi-k2\.6/i, hidden: true });
    fireEvent.click(currentOption);

    // النموذج الحالي = لا تبديل = onSelect لا يُستدعى
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── سلوك RTL — aria-label يحتوي اسم النموذج ────────────────────────────────

describe('إتاحة — aria-label يحتوي النموذج الحالي', () => {
  it('زرّ التبديل يحمل aria-label مع اسم النموذج الفعّال', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
      />,
    );
    const btn = screen.getByRole('button');
    // الـmock يُعيد `key:model` — نتحقّق من وجود اسم النموذج في الـaria-label
    expect(btn.getAttribute('aria-label')).toContain('claude-opus-4-8');
  });
});

// ─── (هـ) B-251 — إفصاح النطاق قبل الاختيار وتأكيده بعده ───────────────────

describe('(هـ) B-251 — شارة النطاق قبل الاختيار', () => {
  it('تعرض شارة scopeSession حين sessionId موجود', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    // الـmock يُعيد المفتاح كما هو لأن scopeSession لا يحتوي model
    expect(screen.getByText('inlineModelSwitcher.scopeSession')).toBeDefined();
  });

  it('تعرض شارة scopeDefault حين لا sessionId', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'default' as const, model: 'claude-sonnet-4-5' })}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('inlineModelSwitcher.scopeDefault')).toBeDefined();
  });

  it('تعرض شارة scopeDefault حين sessionId غير محدَّد', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'default' as const, model: 'claude-sonnet-4-5' })}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('inlineModelSwitcher.scopeDefault')).toBeDefined();
  });

  it('يعرض تأكيد confirmedSession بعد الاختيار في جلسة قائمة', async () => {
    const returnedModel = 'claude-opus-4-8';
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: returnedModel });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-abc"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const option = screen.getByRole('option', { name: /claude-opus-4-8/i, hidden: true });
    await act(async () => { fireEvent.click(option); });
    // الـmock يُعيد «inlineModelSwitcher.confirmedSession:claude-opus-4-8»
    expect(
      screen.getByText(/inlineModelSwitcher\.confirmedSession.*claude-opus-4-8/),
    ).toBeDefined();
  });

  it('يعرض تأكيد confirmedDefault بعد الاختيار بلا جلسة', async () => {
    const returnedModel = 'claude-opus-4-8';
    const onSelect = vi.fn().mockResolvedValue({ scope: 'default' as const, model: returnedModel });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const option = screen.getByRole('option', { name: /claude-opus-4-8/i, hidden: true });
    await act(async () => { fireEvent.click(option); });
    expect(
      screen.getByText(/inlineModelSwitcher\.confirmedDefault.*claude-opus-4-8/),
    ).toBeDefined();
  });
});

// ─── (و) B-252 — خيار «اتبع الافتراضي»: ظهور / غياب / نص / DELETE ──────────

describe('(و) B-252 — خيار «اتبع الافتراضي الحالي»', () => {
  it('يظهر الخيار حين sessionId + sessionModelChanged + onClearSessionModel', () => {
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
        sessionModelChanged={true}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('inlineModelSwitcher.followDefault')).toBeDefined();
  });

  it('لا يظهر الخيار حين sessionModelChanged === false', () => {
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
        sessionModelChanged={false}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('inlineModelSwitcher.followDefault')).toBeNull();
  });

  it('لا يظهر الخيار حين لا sessionId', () => {
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId={null}
        sessionModelChanged={true}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('inlineModelSwitcher.followDefault')).toBeNull();
  });

  it('نص الخيار لا يحتوي «تراجع» ولا «نموذج الإنشاء»', () => {
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
        sessionModelChanged={true}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const clearBtn = screen.getByText('inlineModelSwitcher.followDefault');
    const btnText = clearBtn.textContent ?? '';
    expect(btnText).not.toContain('تراجع');
    expect(btnText).not.toContain('نموذج الإنشاء');
    expect(btnText).not.toContain('undo');
    expect(btnText).not.toContain('revert');
    expect(btnText).not.toContain('original');
  });

  it('يستدعي onClearSessionModel عند النقر على خيار المسح', async () => {
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
        sessionModelChanged={true}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const clearBtn = screen.getByText('inlineModelSwitcher.followDefault');
    await act(async () => { fireEvent.click(clearBtn); });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('يعرض clearedNotice بالنموذج العائد من DELETE بعد المسح', async () => {
    const clearedModel = 'claude-sonnet-4-5';
    const onClear = vi.fn().mockResolvedValue({ model: clearedModel });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-opus-4-8"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-opus-4-8' })}
        sessionId="session-abc"
        sessionModelChanged={true}
        onClearSessionModel={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const clearBtn = screen.getByText('inlineModelSwitcher.followDefault');
    await act(async () => { fireEvent.click(clearBtn); });
    // الـmock يُعيد «inlineModelSwitcher.clearedNotice:claude-sonnet-4-5»
    expect(
      screen.getByText(/inlineModelSwitcher\.clearedNotice.*claude-sonnet-4-5/),
    ).toBeDefined();
  });
});

// ─── (ز) B-ENG/B-352 — جلسة مختومة بمحرّك: تُعلَن ولا تُقفَل ────────────────

describe('(ز) B-ENG — جلسة مختومة بمحرّك', () => {
  it('B-352: الختم يفتح القائمة ولا يعطّلها، والمسح يبقى متاحاً', async () => {
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-sonnet-4-5' });
    const onClear = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-eng"
        sessionModelChanged={true}
        onClearSessionModel={onClear}
        engineProvider="glm"
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.hasAttribute('disabled')).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    // القائمة تُفتح فعلاً بنماذج الجسد — مخرج المستخدم من المحرّك
    expect(screen.getByText('claude-opus-4-8')).toBeDefined();
    expect(screen.getByText('inlineModelSwitcher.followDefault')).toBeDefined();
  });

  it('يعمل الزرّ بصورة طبيعية حين لا يوجد engineProvider (انحدار)', () => {
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-sonnet-4-5' });
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-plain"
      />,
    );
    const btn = screen.getByRole('button');
    // غير معطَّل — engineProvider غائب
    expect(btn.hasAttribute('disabled')).toBe(false);
    // النقر يفتح القائمة
    fireEvent.click(btn);
    // يجب أن تظهر نماذج الكتالوج — نختبر بالنموذج الثاني الذي يظهر في القائمة فقط
    expect(screen.getByText('claude-opus-4-8')).toBeDefined();
  });

  it('يحتوي title الزرّ على اسم المحرّك حين الجلسة مختومة', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
        sessionId="session-eng"
        engineProvider="kimi"
      />,
    );
    const btn = screen.getByRole('button');
    const title = btn.getAttribute('title') ?? '';
    // ADR-073 §6: الاسم المعروض من ENGINE_PROVIDER_LABEL لا من معرّف السلك.
    // B-352: صار إخباراً عن الموضع لا اعتذاراً عن التعطيل.
    expect(title).toContain('inlineModelSwitcher.engineRunning:Kimi');
  });

  it('B-352: جلسة مختومة بمحرّك تبقى قابلة للتبديل بعد الانتقال إليها', async () => {
    const onSelect = vi.fn().mockResolvedValue({ scope: 'session' as const, model: 'claude-sonnet-4-5' });
    const { rerender } = render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-a"
        engineProvider={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('claude-opus-4-8')).toBeDefined();

    // انتقل إلى جلسة مختومة بمحرّك
    await act(async () => {
      rerender(
        <InlineModelSwitcher
          provider="claude"
          currentModel="claude-sonnet-4-5"
          catalog={CLAUDE_CATALOG}
          onSelect={onSelect}
          sessionId="session-b"
          engineProvider="glm"
        />,
      );
    });

    // الزرّ يبقى فعّالاً — الختم لم يعد سبب تعطيل (نُقض ميدانياً)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false);
    // ونماذج Claude تبقى معروضة كخيار خروج من المحرّك
    expect(screen.getByText('claude-opus-4-8')).toBeDefined();
  });
});

// ─── (ح) B-311 — استنباط المحرّك من النموذج حين يغيب الختم ──────────────────

describe('(ح) B-311 — جلسة محرَّكة بلا ختم في localStorage', () => {
  it('يستنبط المحرّك ويُعلنه في الـtitle — بلا تعطيل (B-352)', () => {
    const onSelect = vi.fn();
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="glm-5.2"
        catalog={CLAUDE_CATALOG}
        onSelect={onSelect}
        sessionId="session-lost-stamp"
        engineProvider={null}
      />,
    );
    const btn = screen.getByRole('button');
    // الاستنباط ما زال يعمل — لكن ثمرته إخبارٌ بالموضع لا قفلُ الباب
    expect(btn.getAttribute('title')).toContain('inlineModelSwitcher.engineRunning:GLM');
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('الاستنباط يضبط الصفّ المُحدَّد على محرّكه لا على صفّ Claude متشابه', () => {
    vendorKeys.glm = true;
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="glm-5.2"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
        sessionId="session-lost-stamp-2"
        engineProvider={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const selected = screen
      .getAllByRole('option', { hidden: true })
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('glm-5.2');
  });

  it('لا يُعطَّل حين النموذج من كتالوج Claude نفسه (لا استنباط زائد)', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-sonnet-4-5"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
        sessionId="session-official"
        engineProvider={null}
      />,
    );
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false);
  });

  it('لا يُعطَّل على معرّف بائت لا ينتمي لأي كتالوج (فشل مفتوح مقصود — درس B-250)', () => {
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="claude-retired-3"
        catalog={CLAUDE_CATALOG}
        onSelect={vi.fn()}
        sessionId="session-stale"
        engineProvider={null}
      />,
    );
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false);
  });

  it('لا يستنبط لجسد غير claude — نموذج opencode مؤهَّل يبقى قابلاً للتبديل', () => {
    render(
      <InlineModelSwitcher
        provider="opencode"
        currentModel="glm/glm-5.2"
        catalog={OPENCODE_CATALOG}
        onSelect={vi.fn()}
        sessionId="session-oc"
        engineProvider={null}
      />,
    );
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false);
  });

  it('يعرض لصيقة النموذج من كتالوج المحرّك لا المعرّف الخام', () => {
    const catalog = {
      claude: def('claude-sonnet-4-5'),
      glm: { OPTIONS: [{ value: 'glm-5.2', label: 'GLM 5.2' }], DEFAULT: 'glm-5.2' },
    } as Partial<Record<LLMProvider, ProviderModelsDefinition>>;
    render(
      <InlineModelSwitcher
        provider="claude"
        currentModel="glm-5.2"
        catalog={catalog}
        onSelect={vi.fn()}
        sessionId="session-lost-stamp"
        engineProvider={null}
      />,
    );
    expect(screen.getByText('GLM 5.2')).toBeDefined();
  });
});
