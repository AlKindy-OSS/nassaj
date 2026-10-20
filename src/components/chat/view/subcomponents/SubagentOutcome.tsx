/**
 * Sub-agent outcome marks (agent-progress study §3.2/§4.3, P0): one icon per
 * state. Only `completed` gets the green check; colour is never the only cue
 * (every non-success end also carries a text label at the call site).
 */

import { cn } from '../../../../lib/utils';

import type { RowOutcome } from './subagentOutcomeText';

const CHECK_PATH = 'M5 13l4 4L19 7';
const CROSS_PATH = 'M6 6l12 12M18 6L6 18';

function StrokeIcon({ path, className, testId }: { path: string; className: string; testId: string }) {
  return (
    <svg className={cn('h-3 w-3 shrink-0', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24"
      aria-hidden="true" data-testid={testId}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  );
}

/** Status mark of one agent row; decorative (the row's aria-label carries the state). */
export function OutcomeIcon({ outcome, pulse }: { outcome: RowOutcome; pulse: boolean }) {
  switch (outcome) {
    case 'running':
      return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500', pulse && 'animate-pulse')}
        aria-hidden="true" data-testid="agent-mark-running" />;
    case 'stale':
      return <span className="h-2 w-2 shrink-0 rounded-full border border-amber-500/80" aria-hidden="true"
        data-testid="agent-mark-stale" />;
    case 'completed':
      return <StrokeIcon path={CHECK_PATH} className="text-green-600 dark:text-green-400" testId="agent-mark-success" />;
    case 'failed':
      return <StrokeIcon path={CROSS_PATH} className="text-destructive" testId="agent-mark-failed" />;
    case 'stopped':
      return <span className="h-2 w-2 shrink-0 rounded-sm bg-muted-foreground/70" aria-hidden="true"
        data-testid="agent-mark-stopped" />;
    default:
      return <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-muted-foreground"
        aria-hidden="true" data-testid="agent-mark-unknown" />;
  }
}
