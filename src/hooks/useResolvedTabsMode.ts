import {
  COARSE_POINTER_QUERY,
  NARROW_QUERY,
  resolveTabsMode,
} from '../lib/tabs-display-mode';

import { useUiPreferences, type TabsDisplayMode } from './useUiPreferences';
import { useMediaQuery } from './useMediaQuery';

/**
 * الوضع الذي يُعرض فعلاً على هذه الشاشة الآن.
 *
 * يقرؤه كلّ مستهلك بدل القيمة الخام، فيتطابق ما يقوله التحكّم مع ما تراه العين.
 * والقيمة المخزَّنة **لا تُمَسّ**: هذه طبقة عرضٍ لا تخزين، فلا كتابة ولا مزامنة
 * ولا ترحيل — ومن ضيّق نافذته ثمّ وسّعها استعاد النصوص كما كانت.
 *
 * المخرَج بدائيّ (قيمة enum) فلا خطر هوية عند المستهلك، والتبعيتان بوليانان
 * من `useMediaQuery` — ولذلك لا حاجة لـ`useMemo` هنا أصلاً.
 */
export function useResolvedTabsMode(): TabsDisplayMode {
  const { preferences } = useUiPreferences();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isCoarse = useMediaQuery(COARSE_POINTER_QUERY);

  return resolveTabsMode(preferences.tabsDisplayMode, {
    isNarrowOrCoarse: isNarrow || isCoarse,
  });
}
