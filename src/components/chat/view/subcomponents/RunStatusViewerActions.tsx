/**
 * RunStatusViewerActions — T-1904 (ADR-190): the single shared piece for
 * "who does this running-status bar belong to, and what control does the
 * VIEWER get" — used by both ClaudeStatus (no sub-agents) and MergedCard
 * (AgentStatusCard.tsx, sub-agents present). Both surfaces render the exact
 * same running bar concept; before this file each had its own copy of the
 * label-swap and its own STOP button, which is exactly the kind of mirrored
 * logic that drifts (one gets a viewer fix, the other doesn't — see
 * feedback_mirrored_logic_needs_parity_guard). Extracting the decision here
 * makes "a viewer never sees STOP" a single code path, not a convention two
 * components must each remember.
 */

import { Compass } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import { Tooltip } from '../../../../shared/view/ui';

export interface RunStatusIdentityLabelProps {
  /** True when the CURRENT viewer is not this run's starter (name is known). */
  isViewer: boolean;
  viewerStarterName?: string | null;
  /** The translated provider label ("CLAUDE", "Codex", …) for the starter's own bar. */
  providerLabel: string;
  className?: string;
}

/**
 * Provider label (starter's own bar) OR the starter's name (a viewer's bar).
 * `<bdi>` isolates the name's own bidi direction from the Arabic UI around it;
 * truncation + `title` cover a long display name.
 */
export function RunStatusIdentityLabel({
  isViewer,
  viewerStarterName,
  providerLabel,
  className,
}: RunStatusIdentityLabelProps) {
  if (isViewer && viewerStarterName) {
    return (
      <span
        className={cn('max-w-[16ch] shrink-0 truncate text-[10px] font-bold text-foreground', className)}
        title={viewerStarterName}
      >
        <bdi>{viewerStarterName}</bdi>
      </span>
    );
  }
  return (
    <span className={cn('shrink-0 text-[10px] font-bold uppercase text-muted-foreground/70', className)}>
      {providerLabel}
    </span>
  );
}

export interface RunStatusActionsProps {
  /**
   * T-1904 e2e (BLOCKER) — fail-closed authoritative signal: true ONLY when
   * the current user is POSITIVELY known to be this run's starter (server
   * steer-turn-state.starterUserId === me, or the locally-authored triggering
   * message is theirs). The caller must never derive this from "not a known
   * viewer" (absence of proof is not proof of being the starter) — a late
   * joiner during a session's first turn was shown the full STOP/Esc bar
   * before this was fixed, because the old signal defaulted OPEN whenever
   * starter identity was still unknown.
   */
  canStop: boolean;
  onAbort?: () => void;
  /** Only meaningful when `!canStop`: the Steer pill (steerable for this viewer). */
  steerable?: boolean;
  onSteerClick?: () => void;
  t: TFunction;
  isArabic: boolean;
}

/**
 * Renders the run's ONE action control: STOP for the confirmed starter, the
 * Steer pill for a steerable non-starter, nothing otherwise (including while
 * starter identity is still unknown — fail-closed). The starter is not
 * denied steering here — he already has STOP, and steers his own running
 * turn through `/steer <text>` in the composer instead of this pill.
 */
export function RunStatusActions({
  canStop,
  onAbort,
  steerable = false,
  onSteerClick,
  t,
  isArabic,
}: RunStatusActionsProps) {
  if (canStop && onAbort) {
    return (
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onAbort(); }}
        className="group flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-[10px] font-bold text-destructive transition-all hover:bg-destructive hover:text-destructive-foreground"
      >
        <svg className="h-3 w-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6h12v12H6z" />
        </svg>
        <span className="hidden sm:inline">{isArabic ? 'إيقاف' : 'STOP'}</span>
        <kbd className="hidden rounded bg-black/10 px-1 text-[9px] group-hover:bg-card/20 sm:block">
          ESC
        </kbd>
      </button>
    );
  }

  if (!canStop && steerable && onSteerClick) {
    return (
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onSteerClick(); }}
        aria-label={t('claudeStatus.steerButton.ariaLabel', { defaultValue: 'Steer' })}
        title={t('claudeStatus.steerButton.tooltip', { defaultValue: 'Steer this turn' })}
        className="border-[color:var(--session-steer-accent)]/30 bg-[color:var(--session-steer-accent)]/12 hover:bg-[color:var(--session-steer-accent)]/20 flex min-h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold text-[color:var(--session-steer-accent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-steer-accent)]"
      >
        <Compass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">{t('claudeStatus.steerButton.label', { defaultValue: 'Steer' })}</span>
      </button>
    );
  }

  return null;
}

export interface RunStatusSteerHintProps {
  /**
   * T-1956 — true only for the viewer's OWN running turn (confirmed starter
   * who can steer): the same condition under which the composer used to show
   * the permanent `/steer` line. The line was noise on every turn, so the text
   * now lives behind this indicator, on demand.
   */
  show: boolean;
  t: TFunction;
  /** Click/tap/Enter/Space: writes `/steer ` into the composer (idempotent). */
  onSteerClick?: () => void;
}

/**
 * Small compass indicator in the running-status bar whose tooltip explains
 * that the starter steers his own turn with `/steer <text>`. It is a real
 * button: click/tap/Enter/Space writes the `/steer ` prefix into the composer
 * (the tooltip stays a hover hint; no `tapToToggle`/`keyboard`, which would add
 * a second tab stop and swallow the tap). The wrapper stops click propagation so a tap
 * never toggles MergedCard's collapsible header row. The icon carries a short
 * name; the full sentence is the tooltip, exposed as its description
 * (`aria-describedby`) so a screen reader does not read it twice.
 */
export function RunStatusSteerHint({ show, t, onSteerClick }: RunStatusSteerHintProps) {
  if (!show) return null;
  const hint = t('steer.composerNoteSelf', {
    defaultValue: 'Type /steer followed by your message to deliver it into your running turn.',
  });
  return (
    <span className="flex shrink-0" onClick={(event) => event.stopPropagation()}>
      <Tooltip content={hint} position="top" multiline wrapperClassName="flex rounded-full">
        <button
          type="button"
          onClick={() => onSteerClick?.()}
          aria-label={t('steer.hintLabel', { defaultValue: 'Steering hint' })}
          aria-describedby="run-status-steer-hint-desc"
          data-testid="run-status-steer-hint"
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-[color:var(--session-steer-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-steer-accent)]"
        >
          <Compass className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
      <span id="run-status-steer-hint-desc" className="sr-only">{hint}</span>
    </span>
  );
}
