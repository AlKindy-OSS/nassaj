import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TabsDisplayMode } from '../hooks/useUiPreferences';

import {
  COARSE_POINTER_QUERY,
  NARROW_QUERY,
  TABS_TEXT_MIN_WIDTH,
  resolveTabsMode,
} from './tabs-display-mode';

/*
 * ‏T-1319 — الحلّ الوحيد لوضع عرض شريط التبويبات.
 *
 * الدالّة نقيّة بلا DOM، فتُختبَر جدولياً على كل تقاطع بلا تركيب أي مكوّن.
 */

const narrow = { isNarrowOrCoarse: true };
const wide = { isNarrowOrCoarse: false };
const ALL_MODES: TabsDisplayMode[] = ['full', 'compact', 'minimal', 'hidden'];

describe('resolveTabsMode', () => {
  it('يضمّ في البيئة الضيّقة أو اللمسية، ويُبقي المخزَّن في الواسعة', () => {
    assert.equal(resolveTabsMode('full', narrow), 'compact');
    assert.equal(resolveTabsMode('full', wide), 'full');
    assert.equal(resolveTabsMode('compact', narrow), 'compact');
    assert.equal(resolveTabsMode('compact', wide), 'compact');
  });

  /* نيّةٌ صريحة لا تُنقض بالبيئة: من أخفى التبويبات أرادها مخفيّة أينما كان،
   * وإلغاءُ ذلك على شاشةٍ ضيّقة يترك المستخدم أمام شريطٍ لم يطلبه. */
  it('لا يمسّ minimal ولا hidden في أي بيئة', () => {
    for (const env of [narrow, wide]) {
      assert.equal(resolveTabsMode('minimal', env), 'minimal');
      assert.equal(resolveTabsMode('hidden', env), 'hidden');
    }
  });

  /* البرهان الذي أسقط القيمة الخامسة `'auto'`: ما دام الحلّ يُطبَّق على
   * `'full'` الصريحة أيضاً، فإن `resolve('auto')` كان سيساوي `resolve('full')`
   * في كل خانة — أي قيمةٌ بلا معلومة، ثمنها ترحيلٌ على كتلة مُزامَنة. */
  it('الحلّ حتميّ ومغلق على قيم الـenum نفسها', () => {
    for (const mode of ALL_MODES) {
      for (const env of [narrow, wide]) {
        const resolved = resolveTabsMode(mode, env);
        assert.ok(ALL_MODES.includes(resolved), `مخرَج خارج الـenum: ${resolved}`);
        assert.equal(resolveTabsMode(resolved, env), resolved, 'الحلّ مستقرّ عند إعادة تطبيقه');
      }
    }
  });

  /* الزرّ الدوّار ينطلق من المحلول، فكلّ ضغطة تُنتج انتقالاً مرئياً. هذه
   * الحالة هي العطل الأصلي: مخزَّن `full` على شاشة ضيّقة كان يعرض «فرد» بينما
   * الشاشة أيقونات، وأوّل ضغطة تُنتج `compact` = صفر تغيير مرئي. */
  it('يكشف تطابق full وcompact بصرياً في البيئة الضيّقة', () => {
    assert.equal(
      resolveTabsMode('full', narrow),
      resolveTabsMode('compact', narrow),
      'الوضعان متطابقان تحت العتبة — ولهذا وجب أن يعرض التحكّم المحلولَ لا المخزَّن',
    );
  });
});

describe('استعلامات البيئة', () => {
  /* العتبة يجب أن تطابق `lg` في Tailwind حرفياً: كانت الطبقة CSS
   * (`hidden lg:inline`) هي الحاكم، فأي انزياح بينهما يُعيد إنتاج عتبتين
   * متنافستين على قرارٍ واحد — وهو أصل العطل لا علاجه. */
  it('حدّ العرض يطابق عتبة lg ولا يتداخل معها', () => {
    assert.equal(TABS_TEXT_MIN_WIDTH, 1024);
    assert.equal(NARROW_QUERY, '(max-width: 1023.98px)');
  });

  it('يلتقط المؤشّر الخشن ليغطّي الجهاز اللوحي أفقياً (‏≥ lg)', () => {
    assert.equal(COARSE_POINTER_QUERY, '(pointer: coarse)');
  });
});
