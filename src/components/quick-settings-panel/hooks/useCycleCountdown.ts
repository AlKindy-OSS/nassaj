import { useEffect, useMemo, useState } from 'react';

import {
  findCycleRow,
  nextCountdownTickMs,
  resolveCycleDisplay,
  type CycleDisplay,
  type ProviderCycleRow,
} from '../providerCycleHelpers';

/**
 * عدّاد «يتجدّد بعد N يوماً» لمزوّدٍ بعينه — مشترَك بين الشريط العلوي والشريط
 * الجانبي المطويّ كي لا يتشعّب السطحان (شرط A1 من المراجعة النقدية).
 *
 * كل قواعد الصدق في `providerCycleHelpers` النقية: غياب الصفّ، أو مرساة
 * `unknown`/`derived`، أو دورة انتهت ⇒ `null` أي لا يُعرض شيء.
 *
 * ما يضيفه هذا الهوك هو **إعادة الحساب في الوقت الصحيح**: العدّاد يبقى ساكناً
 * في تبويب مفتوح، فيُعرض «بعد 3 أيام» بعد أن تصير يومين. الجدولة مؤقّتٌ واحد
 * إلى لحظة نقصان العدّاد بالضبط (‏`nextCountdownTickMs`) لا استقصاء كل دقيقة،
 * ولا منتصف ليل المتصفّح (وهو ليس لحظة النقصان إلا في منطقة الخادم).
 */
export function useCycleCountdown(
  rows: readonly ProviderCycleRow[] | null | undefined,
  provider: string | null | undefined,
): CycleDisplay | null {
  const row = useMemo(() => findCycleRow(rows, provider), [rows, provider]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const display = useMemo(() => resolveCycleDisplay(row, nowMs), [row, nowMs]);

  useEffect(() => {
    if (!display) return undefined;

    const endMs = Date.parse(display.renewsAt);
    if (!Number.isFinite(endMs)) return undefined;

    // حدٌّ أدنى ثانية واحدة: مؤقّت بتأخير 0 (أو سالب لو زاغت الساعة) كان
    // سيتحوّل إلى حلقة إعادة تصيير محكومة بسرعة المعالج.
    const delay = Math.max(1_000, nextCountdownTickMs(endMs, nowMs) - nowMs);
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [display, nowMs]);

  return display;
}
