import { Check, Circle, Compass, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SteerDeliveryStatus } from '../../../shared/session-steer.contract';

export interface SteerBubbleProps {
  senderName: string;
  content: string;
  deliveryStatus?: SteerDeliveryStatus;
  contentDir?: 'rtl' | 'ltr' | 'auto';
  formattedTime?: string | null;
  /** تابعٌ لتوجيه سابق من المرسل نفسه: بلا ترويسة، ويكمل الخطّ الرأسي نفسه. */
  isContinuation?: boolean;
}

/**
 * T-1903 (ADR-190) — فقاعة رسالة «توجيه» مُحقنة في دور جارٍ من عضوٍ آخر.
 *
 * تُبنى **فقط** من إشارة صريحة (`injected:true` من السجلّ، أو حدث
 * steer-queued/steer-delivered حيّ) — أبداً بتحليل النصّ. مستقلّة لوناً عن
 * `--primary`/`--project-accent` (توكنات `--session-steer-*` ثابتة، انظر
 * index.css) ومختلفة عن فقاعة المستخدم العادية وعن محادثة الفريق الداخلية
 * (‏`--session-internal-accent`، ADR-187) — اختبار الحرس في
 * SteerBubble.test.tsx. تصميم «هامش البوصلة»: بلا صندوق، خطّ رأسي بعرض 3px
 * على الحافة الابتدائية، وترويسة واحدة لكل سلسلة توجيهات متتالية من مرسل واحد.
 */
export default function SteerBubble({
  senderName,
  content,
  deliveryStatus = 'queued',
  contentDir = 'auto',
  formattedTime,
  isContinuation = false,
}: SteerBubbleProps) {
  const { t, i18n } = useTranslation('chat');

  const statusLabel =
    deliveryStatus === 'delivered'
      ? t('steer.status.delivered', { defaultValue: 'Delivered' })
      : deliveryStatus === 'unconfirmed'
        ? t('steer.status.unconfirmed', { defaultValue: 'Unconfirmed' })
        : t('steer.status.queued', { defaultValue: 'Queued' });
  const StatusIcon =
    deliveryStatus === 'delivered' ? Check : deliveryStatus === 'unconfirmed' ? TriangleAlert : Circle;
  const statusTone =
    deliveryStatus === 'unconfirmed' ? 'text-muted-foreground' : 'text-[color:var(--session-steer-accent)]';

  const status = (
    <span className={`ms-auto inline-flex flex-shrink-0 items-center gap-1 ${statusTone}`}>
      <StatusIcon className="h-3 w-3" aria-hidden="true" />
      {statusLabel}
    </span>
  );
  const time = formattedTime ? <time className="cursor-default">{formattedTime}</time> : null;

  return (
    <div
      className="w-full border-s-[3px] border-[color:var(--session-steer-rule)] ps-3 pb-1.5 pt-1.5"
      data-steer-injected="true"
      aria-label={t('steer.bubble.ariaLabel', {
        name: senderName,
        defaultValue: 'Steer from {{name}} sent mid-turn',
      })}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {isContinuation ? (
          time
        ) : (
          <>
            <Compass
              className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--session-steer-accent)]"
              aria-hidden="true"
            />
            <span className="font-semibold text-[color:var(--session-steer-accent)]">
              {t('steer.bubble.headingPrefix', { defaultValue: 'Steer from' })} <bdi>{senderName}</bdi>
            </span>
            {time && <span aria-hidden="true">·</span>}
            {time}
          </>
        )}
        {status}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground" dir={contentDir}>
        {content}
      </div>
    </div>
  );
}
