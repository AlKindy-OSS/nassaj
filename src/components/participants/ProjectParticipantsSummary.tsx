import { useEffect, useMemo } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import type { ProjectSession, SessionRowParticipant } from '../../types/app';

import type { SessionParticipant } from './types';
import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useProjectParticipants } from './hooks';

type ProjectParticipantsSummaryProps = {
  projectId: string;
  locale: string;
  t: TFunction;
  // Fetch gate. The sidebar now activates this as soon as the row renders (the
  // avatars are meant to be scanned down the list, so hover-gated loading made
  // them invisible exactly when they were useful).
  active: boolean;
  /**
   * Draw the avatar stack? False on a single-account install: every project
   * belongs to the only human, so the faces carry no information. The textual
   * "N users · M agents" summary stays either way — the agent count is real
   * information even with one human.
   */
  showAvatars?: boolean;
  /**
   * Avatars only — no visible "N users · M agents" text.
   *
   * The sidebar's project card is ~300px on a phone, and that phrase spent a
   * whole line to show "2 users · 14 a…": a truncated fragment nobody can read,
   * on the row's most contested axis. In compact mode the faces carry the
   * information and the full phrase survives where it costs no space — as the
   * slot's tooltip and its screen-reader text.
   *
   * NOTE: compact is silently downgraded to false when showAvatars is false.
   * Compact works because faces carry the information — without faces the text
   * is the information, and hiding it leaves a blank 20px box with nothing.
   */
  compact?: boolean;
  /** Maximum visible faces before the accessible overflow count. */
  maxAvatars?: number;
  className?: string;
  /** Known humans from loaded session rows; avoids aggregate history scanning. */
  loadedSessions?: ProjectSession[];
};

/** Deduplicate known session humans without implying a complete project roster. */
function knownSessionUsers(sessions: ProjectSession[]): SessionParticipant[] {
  const users = new Map<string, SessionParticipant>();
  for (const session of sessions) {
    const rows: SessionRowParticipant[] = session.participants?.length ? session.participants
      : session.owner ? [{ ...session.owner, role: 'owner' }] : [];
    for (const row of rows) {
      const key = String(row.userId);
      if (users.has(key)) continue;
      users.set(key, {
        userId: row.userId, username: row.username, role: row.role,
        avatarUrl: row.avatarUrl, first_seen: '', last_seen: row.lastSeen ?? '', message_count: 0,
      });
    }
  }
  return [...users.values()];
}

/**
 * Project-level participation line (F-3): "N users · M agents" with a small
 * avatar stack, rendered under the project name. Lazy-loaded.
 *
 * Layout stability: this line used to render `null` until first hover and
 * then pop in (skeleton → summary), which made every sidebar project row jump
 * under the cursor. The wrapper now ALWAYS occupies a fixed-height slot
 * (h-5 — the avatar-stack height, the tallest content) and the lazy content
 * fades in with an opacity transition instead of entering/leaving the flow,
 * so the row's dimensions are identical with and without hover.
 */
export default function ProjectParticipantsSummary({
  projectId,
  locale,
  t,
  active,
  showAvatars = true,
  compact = false,
  maxAvatars = 3,
  className,
  loadedSessions,
}: ProjectParticipantsSummaryProps) {
  const remote = useProjectParticipants(loadedSessions ? null : projectId);
  const knownUsers = useMemo(() => knownSessionUsers(loadedSessions ?? []), [loadedSessions]);
  const { status, agents, agentsSource, load } = remote;
  const users = loadedSessions ? knownUsers : remote.users;

  // Compact mode only makes sense when avatars are the information carrier.
  // On a single-account install showAvatars is false, so compact would produce
  // a blank 20px slot with the text hidden and no faces to replace it.
  const effectiveCompact = compact && showAvatars;

  useEffect(() => {
    if (active && !loadedSessions) {
      load();
    }
  }, [active, load, loadedSessions]);

  const loaded = Boolean(loadedSessions) || status === 'success';
  // Cache-sourced agents are previously parsed observations, not a complete
  // project roster, so never present their count as an aggregate.
  const hasParticipants = loaded && (loadedSessions || agentsSource === 'cache'
    ? users.length > 0
    : users.length > 0 || agents.length > 0);
  const showSkeleton = active && status !== 'error' && !loaded;

  const summary = !hasParticipants
    ? ''
    : loadedSessions
      ? t('participants.loadedSessionUsers', { count: users.length, defaultValue: 'Participants in loaded conversations: {{count}}' })
      : agentsSource === 'cache'
      ? t('participants.usersAria', {
        count: users.length,
        defaultValue: '{{count}} participants',
      })
      : t('participants.projectSummary', {
        users: users.length,
        agents: agents.length,
        defaultValue: '{{users}} users · {{agents}} agents',
      });

  return (
    <span
      data-project-participants-source={loadedSessions ? 'loaded-sessions' : 'aggregate'}
      // The tooltip is the compact mode's replacement for the text it drops;
      // harmless in the full mode, where the same words are already on screen.
      title={effectiveCompact && hasParticipants ? summary : undefined}
      className={cn(
        // Fixed-height slot reserved unconditionally — see the layout-stability
        // note above. h-5 matches the xs avatar stack so no state changes the
        // row height; overflow-hidden guards against any taller intruder.
        'mt-0.5 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground',
        className,
      )}
    >
      {showSkeleton ? (
        <span className="inline-flex items-center gap-1" aria-hidden>
          <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted/60" />
          <span className="h-2.5 w-16 animate-pulse rounded bg-muted/40" />
        </span>
      ) : (
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 transition-opacity duration-200',
            hasParticipants ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={!hasParticipants}
        >
          {showAvatars && users.length > 0 && (
            <ParticipantAvatarStack participants={users} size="xs" max={maxAvatars} locale={locale} t={t} />
          )}
          {/* `sr-only`, not `aria-label`: this is a plain span with no role, and
              a bare aria-label on one is not reliably announced. */}
          {hasParticipants && (
            <span className={effectiveCompact ? 'sr-only' : 'truncate'}>{summary}</span>
          )}
        </span>
      )}
    </span>
  );
}
