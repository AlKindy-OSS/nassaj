/**
 * engineGuard.test.ts — B-311 / B-312
 *
 * الحارس نقيّ بلا DOM، فهذه الاختبارات تُثبِّت العقد نفسه الذي يعتمده سطحان:
 * InlineModelSwitcher ولوحة /models. المحاور:
 *   (١) الختم يفوز دائماً ويُقبل كما هو.
 *   (٢) الاستنباط من النموذج حين لا ختم — وشروطه الثلاثة معاً.
 *   (٣) الغموض يُعيد null (لا تقييد زائد — درس B-250).
 *   (٤) engineModelLabel يقرأ من كتالوج المحرّك ولا يختلق لصيقة.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/engineGuard.test.ts
 */

import { describe, it, expect } from 'vitest';

import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import {
  catalogHasModel,
  engineModelLabel,
  inferEngineFromModel,
  resolveEffectiveEngine,
} from './engineGuard';

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((value) => ({ value, label: value })),
  DEFAULT: values[0],
});

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: def('opus[1m]', 'sonnet', 'haiku'),
  glm: def('glm-5.2'),
  kimi: def('kimi-k2.6'),
  opencode: def('glm/glm-5.2', 'opencode/big-pickle'),
};

describe('(١) الختم يفوز', () => {
  it('يُعيد الختم كما هو حتى لو كان النموذج من كتالوج Claude', () => {
    expect(resolveEffectiveEngine('glm', 'claude', 'sonnet', CATALOG)).toBe('glm');
  });

  it('يقلّم الفراغ ويتجاهل الختم الفارغ', () => {
    expect(resolveEffectiveEngine('  kimi  ', 'claude', 'sonnet', CATALOG)).toBe('kimi');
    expect(resolveEffectiveEngine('   ', 'claude', 'sonnet', CATALOG)).toBeNull();
    expect(resolveEffectiveEngine(null, 'claude', 'sonnet', CATALOG)).toBeNull();
    expect(resolveEffectiveEngine(undefined, 'claude', 'sonnet', CATALOG)).toBeNull();
  });
});

describe('(٢) الاستنباط من النموذج حين لا ختم', () => {
  it('نموذج محرّك مؤهَّل على جسد claude ⇒ اسم المحرّك', () => {
    expect(resolveEffectiveEngine(null, 'claude', 'glm-5.2', CATALOG)).toBe('glm');
    expect(inferEngineFromModel('claude', 'kimi-k2.6', CATALOG)).toBe('kimi');
  });

  it('نموذج من كتالوج Claude ⇒ null', () => {
    expect(inferEngineFromModel('claude', 'opus[1m]', CATALOG)).toBeNull();
  });

  it('جسد غير claude ⇒ null ولو كان النموذج مؤهَّلاً بالاسم', () => {
    expect(inferEngineFromModel('opencode', 'glm/glm-5.2', CATALOG)).toBeNull();
    expect(inferEngineFromModel('kimi', 'kimi-k2.6', CATALOG)).toBeNull();
  });
});

describe('(٣) الغموض يُعيد null', () => {
  it('معرّف بائت لا ينتمي لأي كتالوج', () => {
    expect(inferEngineFromModel('claude', 'claude-retired-3', CATALOG)).toBeNull();
  });

  it('كتالوج غير محمَّل بعد', () => {
    expect(inferEngineFromModel('claude', 'glm-5.2', {})).toBeNull();
  });

  it('نموذج فارغ', () => {
    expect(inferEngineFromModel('claude', '', CATALOG)).toBeNull();
  });

  /**
   * كان هذا الاختبار يقرأ: «محرّك **غير مؤهَّل** (deepseek) لا يُستنبط ولو حُمِّل
   * كتالوجه» — وهو توثيقٌ صحيح لقرارٍ **انقلب**: B-424 (‏15bf86c2، 2026-08-03)
   * أهّل DeepSeek محرّكاً تحت جسد Claude بقرار المالك، فصار الاستنباط هو السلوك
   * الصحيح والفشلُ هو الحارس يشتكي من الميزة.
   *
   * فانقسم إلى نصفين، وهذا هو الفرق بين توثيق قائمةٍ وتوثيق قاعدة: الأول يوثّق
   * **ما تقوله القائمة اليوم**، والثاني يوثّق **أن القائمة هي البوّابة** — وهو
   * الوعد الذي لا ينقلب مع كل قرار مالك.
   */
  it('محرّك مؤهَّل (deepseek بعد B-424) يُستنبط من كتالوجه', () => {
    const withDeepseek = { ...CATALOG, deepseek: def('deepseek-chat') };
    expect(inferEngineFromModel('claude', 'deepseek-chat', withDeepseek)).toBe('deepseek');
  });

  it('حضورُ الكتالوج لا يكفي: معرّفٌ ليس محرّكاً أصلاً لا يُستنبط', () => {
    // ‏`openrouter` مورّدٌ حقيقي في نسّاج ولا نقطةَ Anthropic-compatible له، فليس
    // في `ENGINE_ANTHROPIC_ENDPOINT` البتّة. وهذا هو نصف القاعدة الذي كان
    // الاختبار السابق يحرسه فعلاً: البوّابة هي قائمة الأهلية لا وجودُ النموذج.
    const withOpenrouter = { ...CATALOG, openrouter: def('some-model') } as typeof CATALOG;
    expect(inferEngineFromModel('claude', 'some-model', withOpenrouter)).toBeNull();
  });
});

describe('(٤) مساعدو الكتالوج', () => {
  it('catalogHasModel يطابق القيمة لا اللصيقة', () => {
    expect(catalogHasModel(CATALOG, 'claude', 'sonnet')).toBe(true);
    expect(catalogHasModel(CATALOG, 'claude', 'glm-5.2')).toBe(false);
    expect(catalogHasModel(CATALOG, 'sakana', 'sonnet')).toBe(false);
  });

  it('engineModelLabel يقرأ اللصيقة من كتالوج المحرّك، وundefined عند غيابها', () => {
    const catalog = {
      ...CATALOG,
      glm: { OPTIONS: [{ value: 'glm-5.2', label: 'GLM 5.2' }], DEFAULT: 'glm-5.2' },
    } as Partial<Record<LLMProvider, ProviderModelsDefinition>>;
    expect(engineModelLabel(catalog, 'glm', 'glm-5.2')).toBe('GLM 5.2');
    expect(engineModelLabel(catalog, 'glm', 'glm-9')).toBeUndefined();
    expect(engineModelLabel({}, 'glm', 'glm-5.2')).toBeUndefined();
  });
});
