import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/context/AuthContext';
import ParticipantAvatar from '../participants/ParticipantAvatar';
import type { SessionParticipant } from '../participants/types';
import { Tooltip } from '../../shared/view/ui';
import type { Project } from '../../types/app';

import { usePresence, type PresenceUser } from './usePresence';
import { ActiveConversationsMenu } from './ActiveConversationsMenu';

/**
 * Live presence panel (C-MU-UX-PRESENCE, compact redesign
 * C-MU-UX-PRESENCE-COMPACT).
 *
 * One dense row instead of one card per brother: a tiny "Online" label +
 * an overlapping avatar stack. Who is connected and what they are doing moved
 * into each avatar's tooltip (username, "(you)", "Working on: <project>" or
 * "Idle"), so the sidebar loses almost no information but a lot of height.
 *
 * - Avatars: shared ParticipantAvatar with a presence-specific tooltip.
 * - Status dot: emerald = online; it pulses while the brother is actively
 *   running a provider command (the tooltip names the project/session).
 * - More than MAX_VISIBLE brothers collapse into a "+N" chip whose tooltip
 *   lists the hidden ones with the same status line.
 * - RTL-friendly: logical spacing only (`-ms-*`), no hard-coded left/right.
 * - Renders nothing until the first snapshot arrives.
 */

/** How many avatars to show before collapsing the rest behind "+N". */
const MAX_VISIBLE = 5;

/** Last path segment of a project path, for a compact "working on" label. */
function projectLabel(projectPath: string | null, sessionId: string | null): string | null {
  if (projectPath) {
    const trimmed = projectPath.replace(/[/\\]+$/, '');
    const segments = trimmed.split(/[/\\]+/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      return last;
    }
  }
  if (sessionId) {
    // Fall back to a short session id fragment so there is always a hint.
    return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
  }
  return null;
}

/**
 * Adapts a presence entry to the minimal SessionParticipant shape the shared
 * ParticipantAvatar expects (it reads userId/username/role plus the optional
 * profile picture for rendering).
 */
function toParticipant(user: PresenceUser): SessionParticipant {
  return {
    userId: user.userId,
    username: user.username,
    role: 'user',
    first_seen: '',
    last_seen: '',
    message_count: 0,
    avatarUrl: user.avatarUrl,
  };
}

type PresencePanelProps = {
  /** Project list from the sidebar — used to map running sessions to project names. */
  projects?: Project[];
  /**
   * Select a project — forwarded to the active-conversations menu so clicking a
   * project row in the (now interactive) popover navigates to it.
   */
  onProjectSelect?: (project: Project) => void;
  /**
   * Extra control pinned to the row's inline-end (B-332): the sidebar puts the
   * archive toggle here when the search row that normally hosts it is hidden.
   * A non-null value also keeps the row rendered while nobody is online, so the
   * control never disappears with the presence list.
   */
  trailing?: ReactNode;
  /** Reserve space for bulk actions while keeping connected people visible. */
  compact?: boolean;
};

export default function PresencePanel({ projects = [], onProjectSelect, trailing = null, compact = false }: PresencePanelProps) {
  const { t, i18n } = useTranslation('presence');
  const { user: currentUser } = useAuth();
  const { users: presenceUsers, activeConversations } = usePresence();

  const currentUserId = currentUser?.id !== undefined && currentUser?.id !== null
    ? String(currentUser.id)
    : null;

  /** "Working on: <target>" while active, "Idle" otherwise. */
  const statusText = (presenceUser: PresenceUser): string => {
    const working = presenceUser.active
      ? projectLabel(presenceUser.activeProjectPath, presenceUser.activeSessionId)
      : null;
    return working
      ? t('workingOn', { defaultValue: 'Working on: {{target}}', target: working })
      : t('idle', { defaultValue: 'Idle' });
  };

  /** "<username> (you)" for self, plain username otherwise. */
  const displayName = (presenceUser: PresenceUser): string => {
    const isSelf = currentUserId !== null && presenceUser.userId === currentUserId;
    return isSelf
      ? `${presenceUser.username} ${t('you', { defaultValue: '(you)' })}`
      : presenceUser.username;
  };

  // Sort: current user first, then active users, then idle — for a stable,
  // meaningful stack order (leftmost = most relevant).
  const sorted = [...presenceUsers].sort((a, b) => {
    const aSelf = currentUserId !== null && a.userId === currentUserId ? 1 : 0;
    const bSelf = currentUserId !== null && b.userId === currentUserId ? 1 : 0;
    if (aSelf !== bSelf) return bSelf - aSelf; // self first
    if (a.active !== b.active) return (b.active ? 1 : 0) - (a.active ? 1 : 0); // active before idle
    return a.since - b.since; // earlier join first
  });

  const visibleLimit = compact ? 2 : MAX_VISIBLE;
  const visible = sorted.slice(0, visibleLimit);
  const overflow = sorted.slice(visibleLimit);

  // Badge: derive counts from the same presenceUsers list shown by the avatars.
  // All entries in the list are human users (the server sends one entry per
  // connected brother, not per agent/session).
  const totalConnected = presenceUsers.length;

  // Nothing to say and nothing to host — render no strip at all.
  if (presenceUsers.length === 0 && !trailing) {
    return null;
  }

  return (
    <div
      className="flex h-11 w-full flex-shrink-0 items-center justify-between px-3"
      data-presence-panel
    >
      {/* Left group: label + avatar stack. Empty while nobody is online and the
        * row exists only to host `trailing` — the spacer keeps the control at
        * the inline-end edge. */}
      <div className="flex min-w-0 items-center gap-2">
        {presenceUsers.length > 0 && (
        <>
        {/* "Online" label only — the avatar stack conveys who is connected. */}
        {/* بلا tracking: اللصيقة تُترجَم للعربية، والتباعد الحرفي يفكّ التحام حروفها. */}
        <span className={compact ? 'sr-only' : 'min-w-0 truncate text-[10px] font-semibold uppercase text-muted-foreground'}>
          {t('title', { defaultValue: 'Online' })}
        </span>

        <ul
          className="flex shrink-0 items-center"
          aria-label={`${t('title', { defaultValue: 'Online' })} (${totalConnected})`}
        >
          {visible.map((presenceUser) => {
            const status = statusText(presenceUser);
            const name = displayName(presenceUser);

            return (
              <li key={presenceUser.userId} className="-ms-1.5 flex items-center first:ms-0">
                {/* Wrapper: explicit h-6 w-6 so both image and initial variants
                  * occupy an identical bounding box. inline-flex + items-center
                  * prevents the img replaced-element baseline from shifting the
                  * circle relative to initial-letter circles. */}
                {/* بلا حلقة: أُزيلت الهالة خلف صور المستخدمين في كل الواجهة
                  * (قرار المالك)؛ حلقة النقطة الخضراء وحدها تبقى لأنها تفصل
                  * النقطة عن الصورة لا عن الخلفية. */}
                <span className="relative inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full">
                  <ParticipantAvatar
                    participant={toParticipant(presenceUser)}
                    size="sm"
                    locale={i18n.language}
                    t={t}
                    avatarUrl={presenceUser.avatarUrl ?? undefined}
                    ariaLabel={`${name} — ${status}`}
                    tooltipContent={
                      <span className="flex flex-col gap-0.5 text-start">
                        <span className="font-semibold">{name}</span>
                        <span className="opacity-80">{status}</span>
                      </span>
                    }
                  />
                  {/* Active dot: centred horizontally (start-0 end-0 mx-auto) so it
                    * sits above the owner's face in the 16px clear band between
                    * overlapping rings — never on the neighbour, never clipped.
                    * Measurement: avatar 24px, -ms-1.5 overlap 6px → visible
                    * band 18px, minus 2px for the next ring = 16px clear.
                    * The dot (8px wide, centered at 8..16px from avatar start)
                    * sits at 0px clearance — touching the next ring's edge.
                    * CAUTION: rounding -ms-1.5 up to -ms-2 (8px overlap) moves
                    * the next ring 2px further into this space and covers the dot.
                    * Only shown when the user is actively running a session. */}
                  {presenceUser.active && (
                    <span
                      // B-824: رمز `--success` لا `emerald-500` الخام — نقطةُ
                      // النشاط هنا تقول ما تقوله شارةُ الصفّ، فتُصبغ بصبغتها.
                      className="absolute bottom-0 end-0 start-0 mx-auto h-2 w-2 animate-pulse rounded-full bg-success ring-2 ring-background"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </li>
            );
          })}

          {overflow.length > 0 && (
            <li className="-ms-1.5 flex items-center">
              <Tooltip
                content={
                  <span className="flex flex-col gap-0.5 text-start">
                    {overflow.map((presenceUser) => (
                      <span key={presenceUser.userId}>
                        <span className="font-semibold">{displayName(presenceUser)}</span>
                        <span className="opacity-80"> — {statusText(presenceUser)}</span>
                      </span>
                    ))}
                  </span>
                }
              >
                <span
                  className="inline-flex h-6 w-6 flex-shrink-0 select-none items-center justify-center rounded-full bg-muted align-middle text-[10px] font-semibold text-muted-foreground"
                  role="img"
                  aria-label={t('more', { defaultValue: '{{count}} more', count: overflow.length })}
                >
                  +{overflow.length}
                </span>
              </Tooltip>
            </li>
          )}
        </ul>
        </>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
      {/* Active conversations counter — pinned to inline-end of the full row.
        * Now the *same* interactive popover as the collapsed rail (shared
        * ActiveConversationsMenu, placement="bottom"): clicking a project row
        * navigates to it. Renders nothing until the first snapshot arrives
        * (activeConversations === null), and lists each visible project from
        * byProject plus a «N elsewhere» line so total equals the badge count. */}
      {!compact && <ActiveConversationsMenu
        activeConversations={activeConversations}
        projects={projects}
        onProjectSelect={onProjectSelect}
        placement="bottom"
      />}
      {trailing}
      </div>
    </div>
  );
}
