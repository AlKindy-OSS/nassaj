import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ParticipantAvatar from '../participants/ParticipantAvatar';
import type { SessionParticipant } from '../participants/types';
import type { SteerDeliveryStatus } from '../../../shared/session-steer.contract';

export interface SteerBubbleProps {
  senderUserId: number | string | null | undefined;
  senderName: string;
  content: string;
  deliveryStatus?: SteerDeliveryStatus;
  contentDir?: 'rtl' | 'ltr' | 'auto';
  formattedTime?: string | null;
}

/**
 * T-1903 (ADR-190) — فقاعة رسالة «توجيه» مُحقنة في دور جارٍ من عضوٍ آخر.
 *
 * تُبنى **فقط** من إشارة صريحة (`injected:true` من السجلّ، أو حدث
 * steer-queued/steer-delivered حيّ) — أبداً بتحليل النصّ. مستقلّة لوناً عن
 * `--primary`/`--project-accent` (توكن `--session-steer-accent` ثابت، انظر
 * index.css) ومختلفة عن فقاعة المستخدم العادية وعن محادثة الفريق الداخلية
 * (‏`--session-internal-accent`، ADR-187) — اختبار الحرس في
 * SteerBubble.colorGuard.test.tsx.
 */
export default function SteerBubble({
  senderUserId,
  senderName,
  content,
  deliveryStatus = 'queued',
  contentDir = 'auto',
  formattedTime,
}: SteerBubbleProps) {
  const { t, i18n } = useTranslation('chat');

  const participant: SessionParticipant = {
    userId: senderUserId ?? 0,
    username: senderName,
    role: 'user',
    first_seen: '',
    last_seen: '',
    message_count: 0,
  };

  const statusLabel =
    deliveryStatus === 'delivered'
      ? t('steer.status.delivered', { defaultValue: 'Delivered' })
      : deliveryStatus === 'unconfirmed'
        ? t('steer.status.unconfirmed', { defaultValue: 'Unconfirmed' })
        : t('steer.status.queued', { defaultValue: 'Queued' });

  return (
    <div
      className="w-full"
      data-steer-injected="true"
      aria-label={t('steer.bubble.ariaLabel', {
        name: senderName,
        defaultValue: 'Steer from {{name}} sent mid-turn',
      })}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <ParticipantAvatar participant={participant} size="sm" locale={i18n.language} t={t} />
        <Compass className="h-4 w-4 flex-shrink-0 text-[color:var(--session-steer-accent)]" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-[color:var(--session-steer-accent)]">
          {t('steer.bubble.headingPrefix', { defaultValue: 'Steer from' })} <bdi>{senderName}</bdi>
        </span>
      </div>
      <div
        className="border-[color:var(--session-steer-accent)]/40 bg-[color:var(--session-steer-accent)]/10 ms-9 rounded-lg border px-3 py-2"
      >
        <div className="whitespace-pre-wrap break-words text-sm text-foreground" dir={contentDir}>
          {content}
        </div>
        <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-[color:var(--session-steer-accent)]">
          <span>{statusLabel}</span>
          {formattedTime && <time className="cursor-default text-muted-foreground">{formattedTime}</time>}
        </div>
      </div>
    </div>
  );
}
