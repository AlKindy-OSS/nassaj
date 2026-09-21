import {
  Check,
  HelpCircle,
  LoaderCircle,
  Pause,
  Unplug,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';

import type { SessionRowIndicatorState } from './sessionRowIndicatorState';

type SessionRowStatusIndicatorProps = {
  state: SessionRowIndicatorState | null;
  className?: string;
};

const HINT_KEYS: Record<SessionRowIndicatorState, string> = {
  question: 'sessionProcessState.questionHint',
  frozen: 'sessionProcessState.frozenHint',
  running: 'sessionProcessState.runningHint',
  orphan: 'sessionProcessState.orphanHint',
  error: 'sessionProcessState.errorHint',
  done: 'sessionProcessState.doneHint',
};

/** 14px plate — the step the row's own pin uses (SidebarSessionItem Bookmark). */
const PLATE = 'inline-flex h-3.5 w-3.5 items-center justify-center ring-2 ring-card';
/** 10px glyph — the icon step every status pill in this app already uses. */
const GLYPH = 'h-2.5 w-2.5';

/**
 * Corner status plate attached to the row's provider logo.
 *
 * B-824 — what the compact rewrite lost was not glyph SIZE, it was the plate
 * and the word beside it: a 10px glyph reads only when something separates it
 * from whatever it sits on. So every state here carries a filled plate on a
 * 14px slot, and the word itself returns in the chat header
 * (SessionProcessBadge), which has the room a 47px sidebar row does not.
 *
 * Every state has a distinct silhouette as well as a token-based colour, so the
 * meaning survives colour-vision differences AND `prefers-reduced-motion`:
 * `running` and `done` necessarily share `--success` (there are only four
 * semantic hues), so once the spin stops the open arc and the check are the
 * whole difference — never shrink either one back into a bare stroke.
 *
 * The error plate is a 10px square turned 45°, whose bounding box is therefore
 * 10·√2 ≈ 14.1px: it fills the slot exactly instead of bursting out of it, and
 * it carries its own rotated `ring-card` halo rather than sitting inside a
 * circular ring smaller than itself.
 *
 * This is deliberately not a live region: hydrating a long session list must not
 * announce every badge at once. The translated label remains available to
 * assistive technology and as a pointer tooltip.
 */
export default function SessionRowStatusIndicator({
  state,
  className,
}: SessionRowStatusIndicatorProps) {
  const { t } = useTranslation('common');
  if (!state) return null;

  const hint = t(HINT_KEYS[state]);

  return (
    <span
      role="img"
      aria-label={hint}
      title={hint}
      data-session-row-status={state}
      className={cn(
        'pointer-events-none absolute -bottom-1 -end-1 z-10 inline-flex h-3.5 w-3.5 flex-none items-center justify-center',
        className,
      )}
    >
      {renderPlate(state)}
    </span>
  );
}

/** One filled plate per state: colour is the fast cue, silhouette is the honest one. */
function renderPlate(state: SessionRowIndicatorState): ReactNode {
  if (state === 'question') {
    return (
      <span className={cn(PLATE, 'rounded-full bg-primary text-primary-foreground')}>
        <HelpCircle className={GLYPH} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }

  if (state === 'running') {
    return (
      <span className={cn(PLATE, 'rounded-full bg-success text-card')}>
        <LoaderCircle
          className={cn(GLYPH, 'motion-safe:animate-spin motion-reduce:animate-none')}
          strokeWidth={3}
          aria-hidden="true"
        />
      </span>
    );
  }

  if (state === 'done') {
    return (
      <span className={cn(PLATE, 'rounded-full bg-success text-card')}>
        <Check className={GLYPH} strokeWidth={3.5} aria-hidden="true" />
      </span>
    );
  }

  if (state === 'frozen') {
    return (
      <span className={cn(PLATE, 'rounded-[4px] bg-warning text-card')}>
        <Pause className="h-2 w-2 fill-current" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }

  if (state === 'orphan') {
    return (
      <span className={cn(PLATE, 'rounded-full bg-warning text-card')}>
        <Unplug className={GLYPH} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className="inline-flex h-2.5 w-2.5 rotate-45 items-center justify-center rounded-[3px] bg-danger text-card ring-2 ring-card">
      <span className="-rotate-45 text-[10px] font-bold leading-none" aria-hidden="true">!</span>
    </span>
  );
}
