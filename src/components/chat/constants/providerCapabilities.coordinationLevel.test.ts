/**
 * T-1315 (الموجة الثانية، قرار المالك 2026-08-17) — «الزرّ يشتغل على كل الأجساد».
 *
 * يثبت أنّ التوسعة تقول الحقيقة بدل أن تُسوّي بين المحرّكات:
 *   • كل مزوّد له مُشعِل تشغيل خادمي ⇒ supported=true (المقود يظهر للجميع).
 *   • sakana (stub بلا فرع في الموزّع) ⇒ supported=false و enforcement='none'.
 *   • claude وحده 'mechanical' — لا أحد غيره يُرقّى بلا دليل.
 *   • codex 'textual' صراحةً: `agents.max_depth` لم يُرفع (ضابط أمني Gate 2).
 *   • المزوّد المجهول يسقط إلى أضيق قيمة ممكنة (fail-closed).
 *   • الواصف لا ينفرط عن مصدره المشترك في shared/.
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/components/chat/constants/providerCapabilities.coordinationLevel.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  COORDINATION_ENFORCEMENT,
  normalizeCoordinationLevel,
  withCoordinationDirective,
} from '../../../../shared/coordinationDirectives';

import { PROVIDER_UI_CAPABILITIES, getProviderCapabilities } from './providerCapabilities';

const ALL_PROVIDERS = Object.keys(PROVIDER_UI_CAPABILITIES);

describe('coordinationLevel — كل الأجساد الاثنا عشر', () => {
  it('الواصف يغطّي اثني عشر مزوّداً بلا نقصان', () => {
    expect(ALL_PROVIDERS).toHaveLength(12);
  });

  it('كل مزوّد يحمل درجة إنفاذ صريحة من الاتحاد المعرَّف', () => {
    for (const id of ALL_PROVIDERS) {
      expect(['mechanical', 'textual', 'none'])
        .toContain(getProviderCapabilities(id).coordinationLevel.enforcement);
    }
  });

  it('المقود يظهر لكل مزوّد له مُشعِل تشغيل — أي الأحد عشر ما عدا sakana', () => {
    const shown = ALL_PROVIDERS.filter((id) => getProviderCapabilities(id).coordinationLevel.supported);
    expect(shown).toHaveLength(11);
    expect(shown).not.toContain('sakana');
  });

  it('sakana: stub بلا قناة ⇒ لا يُعرض المقود ولا يُوعد بإنفاذ', () => {
    const caps = getProviderCapabilities('sakana').coordinationLevel;
    expect(caps.supported).toBe(false);
    expect(caps.enforcement).toBe('none');
  });

  it('claude وحده mechanical — لا ترقية بلا دليل', () => {
    const mechanical = ALL_PROVIDERS
      .filter((id) => getProviderCapabilities(id).coordinationLevel.enforcement === 'mechanical');
    expect(mechanical).toEqual(['claude']);
  });

  it('codex نصّي صراحةً: agents.max_depth ضابط أمني لم يُرفع مع المستوى', () => {
    expect(getProviderCapabilities('codex').coordinationLevel.enforcement).toBe('textual');
  });

  it('كل مزوّد مدعوم غير claude درجته textual — لا ادّعاء منعٍ ميكانيكي', () => {
    for (const id of ALL_PROVIDERS) {
      const caps = getProviderCapabilities(id).coordinationLevel;
      if (!caps.supported || id === 'claude') continue;
      expect(caps.enforcement, id).toBe('textual');
    }
  });

  it('الواصف مشتقّ من المصدر المشترك حرفياً — لا نسخة تزحف عنه', () => {
    for (const id of ALL_PROVIDERS) {
      expect(getProviderCapabilities(id).coordinationLevel.enforcement, id)
        .toBe(COORDINATION_ENFORCEMENT[id]);
    }
  });

  it('مزوّد مجهول يسقط fail-closed إلى أضيق قيمة', () => {
    const caps = getProviderCapabilities('futureprovider').coordinationLevel;
    expect(caps.supported).toBe(false);
    expect(caps.enforcement).toBe('none');
  });
});

describe('withCoordinationDirective — قناة المطالبة للمحرّكات النصّية', () => {
  it('direct يُعيد الأمر حرفياً (سلوك اليوم بلا تغيير بايتاً واحداً)', () => {
    expect(withCoordinationDirective('اكتب اختباراً', 'direct')).toBe('اكتب اختباراً');
  });

  it('غياب المستوى أو null يستخدم الافتراضي delegate ويحقن توجيهه', () => {
    expect(normalizeCoordinationLevel(undefined)).toBe('delegate');
    expect(normalizeCoordinationLevel(null)).toBe('delegate');
    expect(withCoordinationDirective('س', undefined)).toContain('<coordination>');
    expect(withCoordinationDirective('س', null)).toContain('<coordination>');
  });

  it('قيمة صريحة غير معروفة تفشل مغلقاً إلى direct بلا حقن', () => {
    expect(normalizeCoordinationLevel('delegate_review_plus')).toBe('direct');
    expect(withCoordinationDirective('س', 'delegate_review_plus')).toBe('س');
  });

  it('delegate يغلّف التوجيه ويُبقي نصّ المستخدم في آخره سليماً', () => {
    const out = withCoordinationDirective('نفّذ المهمة', 'delegate');
    expect(out.startsWith('<coordination>')).toBe(true);
    expect(out.endsWith('نفّذ المهمة')).toBe(true);
    expect(out).toContain('delegated');
  });

  it('delegate_review نصٌّ مختلف عن delegate — لا مستويان بنصٍّ واحد', () => {
    const a = withCoordinationDirective('س', 'delegate');
    const b = withCoordinationDirective('س', 'delegate_review');
    expect(a).not.toBe(b);
    expect(b).toContain('review');
  });

  it('أمر فارغ يُنتج التوجيه وحده بلا أسطر فارغة معلّقة', () => {
    const out = withCoordinationDirective('', 'delegate');
    expect(out.endsWith('</coordination>')).toBe(true);
  });

  it('أمر غير نصّي (حمولة مشوَّهة) لا يرمي ولا يطبع undefined', () => {
    expect(withCoordinationDirective(undefined, 'direct')).toBe('');
    expect(withCoordinationDirective(null, 'delegate')).not.toContain('null');
  });
});
