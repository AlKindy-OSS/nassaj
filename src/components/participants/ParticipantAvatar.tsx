import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import { colorClassFromAvatarUrl } from './avatarChoice';
import type { SessionParticipant } from './types';
import { avatarColorForUser, formatLastSeen, initialForName } from './utils';

type SizeToken = 'xs' | 'sm';

const SIZE_CLASSES: Record<SizeToken, string> = {
  // 20px stacked avatars (project-level, denser).
  xs: 'h-5 w-5 text-[9px]',
  // 24px stacked avatars (session row / header).
  sm: 'h-6 w-6 text-[10px]',
};

type ParticipantAvatarProps = {
  participant: SessionParticipant;
  size?: SizeToken;
  locale: string;
  t: TFunction;
  // When true, render a subtle ring/badge to mark the project/session owner.
  stacked?: boolean;
  // Optional profile picture. When present (and it loads), it replaces the
  // coloured initial circle. On load failure we fall back to initial + colour.
  avatarUrl?: string;
  // Optional overrides for contexts (e.g. live presence) where the default
  // role/last-seen tooltip is wrong. `tooltipContent` replaces the tooltip
  // body; `ariaLabel` replaces the default "username — role" label.
  tooltipContent?: ReactNode;
  ariaLabel?: string;
};

function roleLabel(role: string, t: TFunction): string {
  return t(`participants.roles.${role}`, { defaultValue: role });
}

export default function ParticipantAvatar({
  participant,
  size = 'sm',
  locale,
  t,
  stacked = true,
  avatarUrl,
  tooltipContent,
  ariaLabel,
}: ParticipantAvatarProps) {
  const lastSeen = formatLastSeen(participant.last_seen, locale);

  // A `color:` sentinel is a chosen palette colour for the lettered avatar, not
  // an image. When present we paint that colour behind the initial and skip the
  // <img> path entirely.
  const chosenColorClass = colorClassFromAvatarUrl(avatarUrl);

  // Track image load failure so we can fall back to the coloured initial.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(avatarUrl) && !chosenColorClass && !imageFailed;

  const defaultTooltipContent = (
    <span className="flex flex-col gap-0.5 text-start">
      <span className="font-semibold">{participant.username}</span>
      <span className="opacity-80">{roleLabel(participant.role, t)}</span>
      {lastSeen && (
        <span className="opacity-70">
          {t('participants.lastSeen', { defaultValue: 'Last seen' })}: {lastSeen}
        </span>
      )}
    </span>
  );

  return (
    <Tooltip content={tooltipContent ?? defaultTooltipContent}>
      <span
        role="img"
        aria-label={ariaLabel ?? `${participant.username} — ${roleLabel(participant.role, t)}`}
        className={cn(
          // `aspect-square` + `flex-shrink-0` lock the box to a fixed square so
          // a lettered avatar (tiny min-content width) cannot be squeezed by the
          // stack's negative margins while an <img> avatar (full intrinsic size)
          // resists shrinking — the divergence that made photo avatars look
          // larger/higher than initial circles in the same row.
          'relative inline-flex aspect-square flex-shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold leading-none text-white',
          SIZE_CLASSES[size],
          // Always paint a colour disc: the user's chosen palette colour, or the
          // deterministic userId-derived one. It shows through transparent
          // gallery SVGs (DiceBear `fill="none"`) so image avatars sit on the
          // same solid disc as lettered ones; opaque photos simply cover it.
          chosenColorClass ?? avatarColorForUser(participant.userId),
          // Stacked: overlap offset + a ring that visually separates avatars.
          stacked && '-ms-1.5 first:ms-0 ring-2 ring-background',
        )}
      >
        {showImage ? (
          <img
            src={avatarUrl}
            alt=""
            // `absolute inset-0` pins the image to the box's four edges inside
            // the `relative` parent, sidestepping the flex `h-full` ambiguity
            // (a non-stretched flex child under `align-items:center` may not
            // resolve `height:100%`, letting the photo bounce to its larger
            // intrinsic size and look taller than lettered avatars). `h-full
            // w-full object-cover` then fills the same square cleanly.
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          initialForName(participant.username)
        )}
      </span>
    </Tooltip>
  );
}
