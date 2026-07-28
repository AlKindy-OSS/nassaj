import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, CircleDot, Wrench, XCircle } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { issueAnchorId } from '../lib/boardStats';
import { normalizeIssueStatus, normalizeSeverity } from '../lib/boardVocabulary';
import type { BoardIssue, IssueSeverity, ProjectBoardState } from '../types';

const SEVERITY_STYLES: Record<IssueSeverity, string> = {
  low: 'bg-muted text-muted-foreground border-border',
  medium: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  critical: 'bg-destructive/10 text-destructive border-destructive/30',
};

function IssueRow({ issue, highlighted }: { issue: BoardIssue; highlighted: boolean }) {
  const { t } = useTranslation('projectBoard');
  const severity = normalizeSeverity(issue.severity);
  const status = normalizeIssueStatus(issue.status);

  return (
    <div
      id={issueAnchorId(issue.id)}
      className={cn(
        'rounded-lg border border-border/60 bg-card p-3 transition-shadow duration-300',
        highlighted && 'ring-2 ring-destructive/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* No severity in the file ⇒ no chip. Interpolating the missing value
            into the key printed a literal "issues.severity.undefined" on 16 of
            Diwan's rows. */}
        {severity && (
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              SEVERITY_STYLES[severity],
            )}
          >
            {t(`issues.severity.${severity}`, { defaultValue: severity })}
          </span>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">{issue.id}</span>
        <span
          className={cn(
            'text-sm',
            status.resolved ? 'text-muted-foreground' : 'font-medium text-foreground',
          )}
        >
          {issue.title}
        </span>
        <span className="ms-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          {status.bucket === 'fixed' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
          {status.bucket === 'open' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          {status.bucket === 'in_progress' && <CircleDot className="h-3.5 w-3.5 text-sky-500" />}
          {status.bucket === 'wontfix' && <XCircle className="h-3.5 w-3.5" />}
          {/* The file's own word — "resolved" is not rewritten to "fixed". */}
          {t(`issues.status.${status.raw}`, { defaultValue: status.raw })}
        </span>
      </div>
      {issue.fix && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Wrench className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{issue.fix}</span>
        </p>
      )}
    </div>
  );
}

type IssuesViewProps = {
  state: ProjectBoardState;
  /**
   * The issue a bug-task link asked for. Set by the panel BEFORE this tab
   * mounts, so the scroll runs from an effect here rather than at the click:
   * when the click happens the issue rows are not in the document yet.
   */
  highlightedIssue?: string | null;
};

/**
 * "Issues" tab — every logged defect, open ones first and by severity inside
 * each group, so the top of the list is always what still hurts.
 */
export default function IssuesView({ state, highlightedIssue = null }: IssuesViewProps) {
  const { t } = useTranslation('projectBoard');
  const issues = state.issues ?? [];

  // Bug-task → issue link, completed across a tab switch. Re-runs whenever a new
  // issue is requested, so clicking a second link while this tab is already open
  // scrolls again.
  useEffect(() => {
    if (!highlightedIssue) {
      return;
    }
    document
      .getElementById(issueAnchorId(highlightedIssue))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedIssue]);

  // Unresolved issues first, then by severity inside each group. "Unresolved"
  // is the normalised sense: an issue marked `in_progress` used to sort with the
  // closed ones purely because the string was not the literal "open".
  const severityWeight: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...issues].sort((a, b) => {
    const openDelta =
      Number(normalizeIssueStatus(a.status).resolved) - Number(normalizeIssueStatus(b.status).resolved);
    if (openDelta !== 0) return openDelta;
    const sevA = normalizeSeverity(a.severity);
    const sevB = normalizeSeverity(b.severity);
    return (sevA ? severityWeight[sevA] : 4) - (sevB ? severityWeight[sevB] : 4);
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('issues.title')}</h3>
        {sorted.length ? (
          <div className="space-y-2">
            {sorted.map((issue) => (
              <IssueRow key={issue.id} issue={issue} highlighted={issue.id === highlightedIssue} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t('issues.empty', { defaultValue: 'No issues logged.' })}
          </p>
        )}
      </div>
    </div>
  );
}
