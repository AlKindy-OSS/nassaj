/**
 * SessionIdleWarning — تنبيه خمول الجلسة (T-1764، T-1765).
 *
 * يظهر أسفل آخر رسالة في الجلسة عندما تمرّ مدة كاش الهارنس (thresholdMs) على
 * آخر رسالة وكانت الجلسة غير نشطة (لا بثّ جارٍ). يختفي فور إرسال رسالة جديدة
 * أو عند بدء بثّ جديد، ويعود فقط إن مرّت المدة نفسها مرة أخرى.
 *
 * - العتبة تُحسب خارجه (resolveIdleThresholdMs)؛ الأب لا يُصيِّره حين تكون null
 * - لا يظهر في جلسة فارغة (lastMessageTimestamp = null)
 * - لا يظهر أثناء البثّ (isStreaming = true)
 * - يُعاد تقييمه بمؤقّت لا عند إعادة الرسم فقط
 * - حجم السياق: contextTokens = tokenBudget.used (المصدر نفسه كـTokenUsageSummary)
 *   يُمرَّر null عندما المزوّد لا يدعم عدّاد التوكنز → جملة بلا رقم
 * - لا اعتمادية على ConversationCostContext (T-1764 fix)
 */

import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

import { formatCompactTokens } from './conversationCostFormat';

const MINUTE_MS = 60 * 1_000;

/** دقيقة واحدة — تكرار المؤقّت للتحقّق من تجاوز العتبة. */
const TICK_MS = MINUTE_MS;

type Props = {
  /** Unix ms لآخر رسالة؛ null = جلسة فارغة → لا تنبيه. */
  lastMessageTimestamp: number | null;
  /** true = بثّ جارٍ → يُخفي التنبيه ويُوقف المؤقّت. */
  isStreaming: boolean;
  /**
   * حجم السياق الحالي (tokenBudget.used أو input+output) — يُمرَّر null
   * حين لا يدعم المزوّد عدّاد التوكنز؛ في هذه الحالة تُعرض الجملة بلا رقم.
   */
  contextTokens: number | null;
  /** مدة الخمول بالمللي ثانية التي يظهر بعدها التنبيه (مدة كاش الهارنس). */
  thresholdMs: number;
  /** يُستدعى عند النقر على رابط «محادثة جديدة». */
  onNewSession: () => void;
};

/**
 * يحسب هل يجب عرض التنبيه بناءً على آخر وقت رسالة والبثّ والعتبة.
 * يُعاد التقييم بمؤقّت كل دقيقة؛ يُصفَّر فور تغيّر أيٍّ من المدخلات.
 */
function useIdleVisible(
  lastMessageTimestamp: number | null,
  isStreaming: boolean,
  thresholdMs: number,
): boolean {
  const [visible, setVisible] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // أعِد الضبط عند كل تغيير (رسالة جديدة / بدء بثّ / انتهاؤه / تغيّر العتبة)
    setVisible(false);
    if (tickRef.current) clearInterval(tickRef.current);

    if (!lastMessageTimestamp || isStreaming) return;

    const check = () => {
      const elapsed = Date.now() - lastMessageTimestamp;
      if (elapsed >= thresholdMs) {
        setVisible(true);
        if (tickRef.current) clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };

    // فحص فوري — قد نكون دخلنا على جلسة تجاوزت العتبة بالفعل
    check();

    // مؤقّت دقيقي مستمر حتى تتجاوز العتبة
    tickRef.current = setInterval(check, TICK_MS);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [lastMessageTimestamp, isStreaming, thresholdMs]);

  return visible;
}

export default function SessionIdleWarning({
  lastMessageTimestamp,
  isStreaming,
  contextTokens,
  thresholdMs,
  onNewSession,
}: Props) {
  const { t } = useTranslation('chat');
  const visible = useIdleVisible(lastMessageTimestamp, isStreaming, thresholdMs);

  if (!visible) return null;

  // عرض التوكنز فقط إن كانت القيمة موثوقة وموجودة (>0)
  const tokensText = contextTokens !== null && contextTokens > 0
    ? formatCompactTokens(contextTokens)
    : null;

  const minutes = Math.round(thresholdMs / MINUTE_MS);
  const duration = minutes === 60
    ? t('sessionIdleWarning.duration_hour', { defaultValue: 'an hour' })
    : t('sessionIdleWarning.duration_minutes', {
        count: minutes,
        defaultValue: '{{count}} minutes',
      });

  const i18nKey = tokensText
    ? 'sessionIdleWarning.message_tokens'
    : 'sessionIdleWarning.message_no_tokens';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-idle-warning"
      className="flex justify-center px-4 pb-4 pt-2"
    >
      <div className="inline-flex max-w-lg items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-muted-foreground shadow-sm">
        <Clock
          className="mt-px h-4 w-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <p className="leading-relaxed">
          <Trans
            ns="chat"
            i18nKey={i18nKey}
            values={{ tokens: tokensText ?? '', duration }}
            defaults={
              tokensText
                ? 'It has been {{duration}} — resuming will cost re-reading the full context ({{tokens}} tokens). Prefer to start a <link>new conversation</link>.'
                : 'It has been {{duration}} — resuming this session costs re-reading the full context. Prefer to start a <link>new conversation</link>.'
            }
            components={{
              link: (
                <button
                  type="button"
                  onClick={onNewSession}
                  className="font-medium text-foreground underline underline-offset-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                />
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
}
