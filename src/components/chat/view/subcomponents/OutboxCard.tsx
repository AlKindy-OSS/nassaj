import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2Icon, PencilIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';

import { resolveTextDirection } from '../../../../utils/textDirection';
import { SERVER_ERROR_CODE_KEYS } from '../../hooks/useChatRealtimeHandlers';
import { outboxRetryMode, readOutboxImages, type OutboxEntry } from '../../utils/messageOutbox';
import CoordinationLevelBadge from './CoordinationLevelBadge';

interface OutboxCardProps {
  entry: OutboxEntry;
  onRetry: (entryId: string) => void;
  onEdit: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  onVerify: (entryId: string) => void;
}

/** أطول ما يُعرض من نصّ الرسالة داخل البطاقة قبل الطيّ. */
const PREVIEW_LIMIT = 320;

/**
 * T-1295 — بطاقة رسالةٍ لم تصل.
 *
 * ثلاثة أفعال ولا رابع: **إعادة الإرسال** و**التعديل** و**الحذف** — وهي حرفياً
 * ما طلبه المالك. و«تعديل» يعيد النصّ والصور إلى المُؤلِّف ويُبقي الإدخال محفوظاً
 * حتى يُرسَل أو يُحذف، فلا تعود الرسالة رهينةَ حقلٍ متطاير.
 *
 * وإدخالٌ حالته `unconfirmed` (أُرسل ثم أُغلقت الصفحة قبل أن يصل حكمُه) فعلُه
 * الأوّل **«تحقّق» لا «أعد الإرسال»**: قد تكون الجولة نجحت، وإعادةُ الإرسال
 * حينها إرسالٌ مزدوج — والمستخدم لا يملك ما يميّز الحالتين.
 */
export default function OutboxCard({ entry, onRetry, onEdit, onDelete, onVerify }: OutboxCardProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [thumbnails, setThumbnails] = useState<string[]>([]);

  // اتجاه أساس **واحد** لنصّ الرسالة (درس B-207): `dir="auto"` لكل كتلة يستنتج
  // الاتجاه من أوّل حرف قويّ، فرسالة عربية تبدأ بأمرٍ لاتيني تُحسب LTR فينقلب
  // ترتيب مقاطعها. الاتجاه يُحسب من النصّ كاملاً ويوضع على عنصر النصّ وحده.
  const textDir = useMemo(() => resolveTextDirection(entry.text) ?? undefined, [entry.text]);

  useEffect(() => {
    if (entry.imageNames.length === 0) {
      return undefined;
    }
    let cancelled = false;
    let urls: string[] = [];

    void readOutboxImages(entry.id).then((files) => {
      if (cancelled || files.length === 0) {
        return;
      }
      urls = files.map((file) => URL.createObjectURL(file));
      setThumbnails(urls);
    });

    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [entry.id, entry.imageNames.length]);

  // B-521: `pending` لا تصل هنا إلا وقد حكم عليها المُصفّي بالشكّ (مضت المهلة
  // ولا جولة تعمل)، فتُعرض بلغة «لم يصل تأكيد» — لا بلغة الفشل: الرسالة قد
  // تكون سُلِّمت، وزرّها الأول تحقُّقٌ لا إعادةُ إرسال.
  const isDelivered = entry.status === 'delivered';
  const isUnconfirmed = entry.status === 'unconfirmed' || entry.status === 'pending';
  const retryMode = outboxRetryMode(entry);

  /**
   * السبب يُترجَم عند العرض من **الرمز** المحفوظ، لا من نصٍّ مترجَم وقت الفشل:
   * البطاقة قد تُعرض بعد أن يبدّل المستخدم لغة الواجهة.
   */
  const reason = useMemo(() => {
    if (isDelivered) return t('outbox.reason.delivered');
    if (entry.retryBlockCode) return t(`outbox.reason.${entry.retryBlockCode}`);
    if (isUnconfirmed) {
      return t('outbox.reason.unconfirmed');
    }
    const code = entry.reasonCode ?? 'unknown';
    const localKey = `outbox.reason.${code}`;
    const local = t(localKey, { defaultValue: '' });
    const headline = local
      || t(SERVER_ERROR_CODE_KEYS[code] ?? 'serverError.unknown', {
        defaultValue: t('serverError.unknown'),
      });
    return entry.reasonDetail ? `${headline} (${entry.reasonDetail})` : headline;
  }, [entry.reasonCode, entry.reasonDetail, entry.retryBlockCode, isUnconfirmed, isDelivered, t]);

  const isTruncated = entry.text.length > PREVIEW_LIMIT;
  const preview = expanded || !isTruncated ? entry.text : `${entry.text.slice(0, PREVIEW_LIMIT)}…`;

  return (
    <div
      role="group"
      aria-label={t('outbox.cardLabel')}
      data-testid="outbox-card"
      className={`mx-auto mb-2 max-w-4xl rounded-lg border px-3 py-2 text-sm ${
        isDelivered
          ? 'border-border bg-background text-foreground'
          : isUnconfirmed
          ? 'border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-600/40 dark:bg-amber-900/15 dark:text-amber-200'
          : 'border-red-300/60 bg-red-50 text-red-700 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">
          {isDelivered ? t('outbox.titleDelivered') : isUnconfirmed ? t('outbox.titleUnconfirmed') : t('outbox.titleFailed')}
        </span>
        <span className="min-w-0 break-words text-xs opacity-80">{reason}</span>
      </div>

      <CoordinationLevelBadge level={entry.intent.coordinationLevel} className="mt-2" />

      <p
        dir={textDir}
        className="mt-1 whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/80"
        data-testid="outbox-text"
      >
        {preview}
      </p>

      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((previous) => !previous)}
          className="mt-1 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
        >
          {expanded ? t('outbox.showLess') : t('outbox.showMore')}
        </button>
      )}

      {entry.imageNames.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {thumbnails.length > 0
            ? thumbnails.map((url, index) => (
              <img
                key={url}
                src={url}
                alt={entry.imageNames[index] ?? ''}
                className="h-12 w-12 rounded border border-border/50 object-cover"
              />
            ))
            : entry.imageNames.map((name) => (
              // انحدار رشيق: تعذّر قراءة كائن الصورة لا يخفي أن الرسالة تحمل صوراً.
              <span
                key={name}
                className="rounded border border-border/50 px-2 py-1 text-xs opacity-80"
              >
                {name}
              </span>
            ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!isDelivered && (retryMode === 'verify' ? (
          <button
            type="button"
            onClick={() => onVerify(entry.id)}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            <CheckCircle2Icon className="h-4 w-4" aria-hidden="true" />
            {t('outbox.verify')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRetry(entry.id)}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            <RefreshCwIcon className="h-4 w-4" aria-hidden="true" />
            {retryMode === 'same_id' ? t('outbox.retry') : t('outbox.tryAgain')}
          </button>
        ))}

        {!isDelivered && <button
          type="button"
          onClick={() => onEdit(entry.id)}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
        >
          <PencilIcon className="h-4 w-4" aria-hidden="true" />
          {t('outbox.edit')}
        </button>}

        <button
          type="button"
          onClick={() => onDelete(entry.id)}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
        >
          <Trash2Icon className="h-4 w-4" aria-hidden="true" />
          {isDelivered ? t('outbox.dismissDelivered') : t('outbox.delete')}
        </button>
      </div>
    </div>
  );
}
