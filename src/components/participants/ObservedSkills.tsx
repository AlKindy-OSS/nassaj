import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { SkillCoverage, SkillObservation, SkillSummary, ProjectSkillProjection } from '../../../shared/skillObservations';
import type { SessionSkillsState } from './useSessionSkills';
import { summarizeSkillObservations } from './skillObservationHelpers';

const FOCUS = 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
/** Keep the Arabic numbering convention explicit across Intl runtime versions. */
export const formatObservedCount = (value: number, locale: string) => value.toLocaleString(locale.startsWith('ar') ? 'ar-u-nu-arab' : locale);

/** Safe public identifier only; never echo a command or filesystem path. */
function skillLabel(name: string, unresolved: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(name) ? name : unresolved;
}

/** A count describes observed identities, never successful application. */
export function ObservedSkillCount({ count, coverage }: { count: number; coverage?: SkillCoverage }) {
  const { t, i18n } = useTranslation('chat');
  const unknown = !coverage || ['unsupported', 'unavailable'].includes(coverage.state);
  return <span className="text-xs text-foreground">{t('skillObservations.count', { value: unknown ? '—' : formatObservedCount(count, i18n.language) })}{coverage?.state === 'partial' ? ` · ${t('skillObservations.partial')}` : ''}</span>;
}

/** Disclosure of scan coverage, distinct from detector completeness. */
export function SkillCoverageNote({ coverage }: { coverage?: SkillCoverage }) {
  const { t, i18n } = useTranslation('chat');
  const stamp = coverage?.asOf && Number.isFinite(Date.parse(coverage.asOf)) ? new Date(coverage.asOf).toLocaleString(i18n.language) : null;
  return <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
    <p>{t(`skillObservations.${coverage?.state ?? 'unsupported'}`)}</p>
    <p>{t('skillObservations.limited')}</p>
    {stamp && <p>{t('skillObservations.updated', { value: stamp })}</p>}
    {coverage?.nextCursor && <p>{t('skillObservations.pageLimited')}</p>}
  </div>;
}

/** Keep instruction reads and invocation outcomes independently inspectable. */
export function SkillCounters({ summary }: { summary: SkillSummary }) {
  const { t, i18n } = useTranslation('chat');
  const number = (value: number) => formatObservedCount(value, i18n.language);
  return <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
    <p>{t('skillObservations.reads', { value: number(summary.readSucceeded) })}</p>
    <p>{t('skillObservations.attempts', { value: number(summary.invocationAttempts) })}</p>
    {summary.invocationAttempts > 0 && <p>{t('skillObservations.outcomes', { succeeded: number(summary.invocationSucceeded), failed: number(summary.invocationFailed), pending: number(summary.invocationPending), unknown: number(summary.invocationUnknown) })}</p>}
    {(summary.readFailed + summary.readPending + summary.readUnknown > 0) && <p>{t('skillObservations.otherReads', { failed: number(summary.readFailed), pending: number(summary.readPending), unknown: number(summary.readUnknown) })}</p>}
  </div>;
}

/** Status mark matching the tool-call list: tick = used, red = failed only, amber = unresolved. */
function SkillMark({ summary, label }: { summary: SkillSummary; label: string }) {
  if (summary.readSucceeded + summary.invocationSucceeded > 0) {
    return <svg className="h-2.5 w-2.5 shrink-0 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label={label}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>;
  }
  const failed = summary.invocationFailed + summary.readFailed > 0;
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-amber-400'}`} aria-label={label} role="img" />;
}

/**
 * One line per skill, styled like the agent's tool-call list: mark + name,
 * plus ×N only when the skill was invoked more than once. No raw evidence.
 */
export function ObservedSkillsList({ observations }: { observations: SkillObservation[] }) {
  const { t, i18n } = useTranslation('chat');
  const groups = new Map<string, SkillObservation[]>();
  for (const item of new Map(observations.map(item => [item.id, item])).values()) groups.set(item.skillKey, [...(groups.get(item.skillKey) ?? []), item]);
  return <ul className="py-0.5">
    {[...groups].map(([key, items]) => {
      const summary = summarizeSkillObservations(items);
      const outcome = summary.readSucceeded + summary.invocationSucceeded > 0 ? 'succeeded' : summary.invocationFailed + summary.readFailed > 0 ? 'failed' : 'unknown';
      return <li key={key} className="flex items-center gap-1.5 py-0.5 text-[11px]">
        <SkillMark summary={summary} label={t(`skillObservations.outcome.${outcome}`)} />
        <bdi className="truncate font-mono text-foreground/80">{skillLabel(items[0].skillName, t('skillObservations.unresolved'))}</bdi>
        {summary.invocationAttempts > 1 && <span className="shrink-0 tabular-nums text-muted-foreground">×{formatObservedCount(summary.invocationAttempts, i18n.language)}</span>}
      </li>;
    })}
  </ul>;
}

/**
 * Conversation scope — compact version matching the agents section density.
 * Header: title left, "N skills · this conversation" + refresh icon right.
 * State signals (partial/stale/empty) stay visible in one line each.
 */
export function SessionSkillsSection({ state }: { state: SessionSkillsState }) {
  const { t, i18n } = useTranslation('chat');
  const { projection, status, stale, refresh, loadMore } = state;
  const coverageState = projection?.coverage.state;
  const hasData = !!projection && !['unsupported', 'unavailable'].includes(coverageState ?? '');
  const count = projection?.summary.observedDistinct ?? 0;

  return (
    <div className="border-t border-border/40 px-4 py-2" role="region" aria-label={t('skillObservations.title')}>
      {/* Header — same visual weight/spacing as the agents section header */}
      <p className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs font-medium text-muted-foreground">
        <span>{t('skillObservations.title')}</span>
        <span className="flex shrink-0 items-center gap-1 font-normal">
          {hasData && (
            <span className="tabular-nums text-muted-foreground/80">
              {t('skillObservations.scopeLine', { count, value: formatObservedCount(count, i18n.language) })}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            title={t('skillObservations.refresh')}
            aria-label={t('skillObservations.refresh')}
            className={`grid h-5 w-5 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground ${FOCUS}`}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
          </button>
        </span>
      </p>

      {/* State signals — one visible line each */}
      {status === 'loading' && <p role="status" className="text-xs text-muted-foreground">{t('skillObservations.loading')}</p>}
      {!hasData && status !== 'loading' && (
        <p className="text-xs text-muted-foreground">{t(`skillObservations.${coverageState ?? status}`)}</p>
      )}
      {coverageState === 'partial' && <p className="text-xs text-muted-foreground">{t('skillObservations.partial')}</p>}
      {hasData && count === 0 && coverageState === 'complete' && <p className="text-xs text-muted-foreground">{t('skillObservations.empty')}</p>}
      {(stale || status === 'unavailable') && <p role="status" className="text-xs text-muted-foreground">{t('skillObservations.stale')}</p>}

      {/* Skills list */}
      {projection && projection.observations.length > 0 && <ObservedSkillsList observations={projection.observations} />}

      {projection?.coverage.nextCursor && loadMore && (
        <button type="button" onClick={loadMore} className={`mt-1 min-h-7 px-1 text-xs text-muted-foreground hover:bg-muted ${FOCUS}`}>
          {t('skillObservations.loadMore')}
        </button>
      )}
    </div>
  );
}

/** Cache-only project observations; absent capability never renders a false zero. */
export function ProjectSkillsSection({ skills, stale }: { skills?: ProjectSkillProjection | null; stale?: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const num = (n: number) => formatObservedCount(n, i18n.language);
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={t('skillObservations.projectTitle')}>
    <h3 className="text-base font-semibold text-foreground">{t('skillObservations.projectTitle')}</h3>
    <p className="text-xs text-muted-foreground">{t('skillObservations.projectScope')}</p>
    <SkillCoverageNote coverage={skills?.coverage} />
    {stale && <p role="status" className="text-xs text-muted-foreground">{t('skillObservations.stale')}</p>}
    {skills && !['unsupported', 'unavailable'].includes(skills.coverage.state) && <>
      <p className="text-xs text-muted-foreground">{t('skillObservations.sessions', { scanned: num(skills.scannedSessions), eligible: num(skills.eligibleSessions), partial: num(skills.partialSessions), unavailable: num(skills.unavailableSessions) })}</p>
      <ObservedSkillCount count={skills.summary.observedDistinct} coverage={skills.coverage} />
      <SkillCounters summary={skills.summary} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {skills.rows.map(row => <li key={row.skillKey} className="min-w-0 rounded-lg border border-border p-3">
          <bdi className="break-words text-sm text-foreground">{skillLabel(row.skillName, t('skillObservations.unresolved'))}</bdi>
          <SkillCounters summary={row.summary} />
        </li>)}
      </ul>
    </>}
  </section>;
}
