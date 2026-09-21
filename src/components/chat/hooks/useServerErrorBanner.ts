import { useCallback, useEffect, useRef, useState } from 'react';

import { runWhenPageActive, type CancelPageActivation } from '../../../utils/pageActivity';

/** مدّة بقاء الشريط **بعد أن تصير الصفحة أمام المستخدم**، لا بعد وصول الخطأ. */
export const SERVER_ERROR_VISIBLE_MS = 6000;

/**
 * شريط خطأ الخادم العابر: يظهر عند الخطأ، ويزول بعد أن **يُرى** لا بعد أن يمضي
 * الوقت (‏T-1294).
 *
 * العلّة التي يعالجها: المؤقّت كان يبدأ لحظة وصول الخطأ. وأكثر ما تفشل الجولة
 * والمستخدم في تبويب آخر — وهو نفس السبب الذي من أجله يُعلَن الفشل بمؤشّر
 * العنوان وبالصوت — فينقضي المؤقّت وهو غائب، ويعود إلى شاشة لا أثر فيها لِما
 * فشل ولا سبب. السياسة المستعملة هنا هي `pageActivity` نفسها التي تحكم علامة
 * العنوان: آلية واحدة لا اثنتان تتباعدان.
 *
 * خُطّاف مستقلّ لا كتلةٌ داخل `ChatInterface` كي يكون سلوكه قابلاً للقيادة في
 * اختبار على الكود الإنتاجي نفسه، لا على نسخة منه.
 */
export function useServerErrorBanner(visibleMs: number = SERVER_ERROR_VISIBLE_MS) {
  const [serverError, setServerError] = useState<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWaitRef = useRef<CancelPageActivation | null>(null);

  const showServerError = useCallback((message: string) => {
    setServerError(message);

    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    // خطأ ثانٍ قبل أن يُرى الأول: انتظارٌ واحد قائم لا انتظاران متراكمان.
    pendingWaitRef.current?.();
    pendingWaitRef.current = runWhenPageActive(() => {
      pendingWaitRef.current = null;
      dismissTimerRef.current = setTimeout(() => setServerError(null), visibleMs);
    });
  }, [visibleMs]);

  // لا مؤقّت ولا مستمع ينجو تفكيك المكوّن.
  useEffect(() => () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    pendingWaitRef.current?.();
    pendingWaitRef.current = null;
  }, []);

  return { serverError, showServerError };
}
