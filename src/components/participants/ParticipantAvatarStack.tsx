import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import ParticipantAvatar from './ParticipantAvatar';
import type { SessionParticipant } from './types';
import { isOwnerRole } from './utils';

type SizeToken = 'xs' | 'sm';

type ParticipantAvatarStackProps = {
  participants: SessionParticipant[];
  size?: SizeToken;
  // Owner first, then by recency, then cap the rest behind a "+N" chip.
  max?: number;
  locale: string;
  t: TFunction;
  className?: string;
};

const OVERFLOW_SIZE_CLASSES: Record<SizeToken, string> = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
};

/** Owner-first ordering, then most-recently-seen first. */
function orderParticipants(participants: SessionParticipant[]): SessionParticipant[] {
  return [...participants].sort((a, b) => {
    const ownerA = isOwnerRole(a.role) ? 1 : 0;
    const ownerB = isOwnerRole(b.role) ? 1 : 0;
    if (ownerA !== ownerB) {
      return ownerB - ownerA;
    }
    const seenA = new Date(a.last_seen).getTime() || 0;
    const seenB = new Date(b.last_seen).getTime() || 0;
    return seenB - seenA;
  });
}

export default function ParticipantAvatarStack({
  participants,
  size = 'sm',
  max = 4,
  locale,
  t,
  className,
}: ParticipantAvatarStackProps) {
  if (participants.length === 0) {
    return null;
  }

  const ordered = orderParticipants(participants);
  const visible = ordered.slice(0, max);
  const overflow = ordered.slice(max);

  return (
    <div
      // [&>*+*]:-ms-2 applies the overlap offset to every direct child after
      // the first. The explicit avatar wrappers and Tooltip overflow wrapper
      // share that direct level, so every face (and +N) overlaps consistently.
      className={cn('flex items-center [&>*+*]:-ms-2', className)}
      role="group"
      aria-label={t('participants.usersAria', {
        count: participants.length,
        defaultValue: '{{count}} participants',
      })}
    >
      {/* B-824 — لا زخرفة زاوية هنا بعد اليوم. كانت حالةُ المحادثة تُمرَّر
          `cornerAdornment` فتُركَّب على الوجه الأول، وهذا الغلاف يذوب إلى
          `opacity-0` عند التحويم — فتختفي الحالة عند الإشارة إلى الصفّ. مكانها
          صندوقُ الشعار دائماً (SidebarSessionItem). الوجوه تبقى معلَّمةً
          بـ`data-participant-primary-avatar` لأن الأول هو المالك. */}
      {visible.map((participant, index) => (
        <div
          key={participant.userId}
          {...(index === 0 ? { 'data-participant-primary-avatar': participant.userId } : {})}
          className="inline-flex flex-none"
        >
          <ParticipantAvatar
            participant={participant}
            size={size}
            locale={locale}
            t={t}
            avatarUrl={participant.avatarUrl ?? undefined}
          />
        </div>
      ))}
      {overflow.length > 0 && (
        <Tooltip
          content={
            <span className="flex flex-col gap-0.5 text-start">
              {overflow.map((participant) => (
                <span key={participant.userId}>{participant.username}</span>
              ))}
            </span>
          }
        >
          <span
            className={cn(
              'inline-flex aspect-square flex-shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none align-middle',
              // -ms-2 removed: the container's [&>*+*]:-ms-2 provides it.
              // ولا حلقة حولها كي تطابق الصور المجاورة بعد إزالة الظل.
              'bg-muted text-muted-foreground',
              OVERFLOW_SIZE_CLASSES[size],
            )}
          >
            +{overflow.length}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
