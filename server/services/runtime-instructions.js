/**
 * runtime-instructions — القناة التي يستوردها كلُّ مُشعِل مزوّد (T-1804).
 *
 * `shared/documentSharingInstructions.ts` نقيّ ولا يعرف قرصاً، لكنّ كتلةَ نشر
 * الصفحات العامّة تحمل **مسار الناشر المطلق على هذا الجهاز** وهو أمرٌ لا يُعرف
 * إلا بفحص القرص. فلا يبقى إلا موضعان: أن يحلّه كلُّ مُشعِلٍ بنفسه (عشر نسخ من
 * قرارٍ واحد، ونسخةٌ تُنسى عند كلّ مزوّدٍ جديد)، أو هذه الواجهةُ الرفيعة يستوردها
 * الجميع بنفس الاسمين السابقين. الثاني: موضعُ حلٍّ واحد، ومُشعِلاتٌ لم تتغيّر
 * مواضعُ استدعائها.
 */
import {
  getRuntimeInstructions as composeRuntimeInstructions,
  withRuntimeInstructions as composeWithRuntimeInstructions,
} from '../../shared/documentSharingInstructions.js';

import {
  resolvePublicPageContentRoot, resolvePublicPageOrigin, resolvePublicPagePublisher,
} from './public-page-agent-guidance.js';

/** كلُّ ما يختلف بين جهازٍ وجهاز، محلولاً مرّةً واحدة لكلتا القناتين. */
function place() {
  return {
    publisherPath: resolvePublicPagePublisher(),
    contentRoot: resolvePublicPageContentRoot(),
    origin: resolvePublicPageOrigin(),
  };
}

/** التعليمات لقناةٍ أصيلة (system/developer)، بمسار ناشر هذا الجهاز. */
export function getRuntimeInstructions(level) {
  return composeRuntimeInstructions(level, place());
}

/** التفافُ مطالبةٍ صادرة لمزوّدٍ لا يملك إلا مُدخَل نصّ، بمسار ناشر هذا الجهاز. */
export function withRuntimeInstructions(command, level) {
  return composeWithRuntimeInstructions(command, level, place());
}
