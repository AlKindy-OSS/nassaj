import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarClock, Eye, EyeOff, Loader2, MessageSquare, Pencil, RefreshCcw, Trash2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import type { ScheduledMessage } from '../../chat/hooks/useScheduledMessages';
import { ScheduleMessageDialog } from '../../chat/view/subcomponents/ScheduledMessages';
import { getAllSessions } from '../../sidebar/utils/utils';
import type { useAllScheduledMessages } from '../hooks/useAllScheduledMessages';
import { groupScheduledMessages } from '../utils/groupScheduledMessages';

type Controller = ReturnType<typeof useAllScheduledMessages>;
type Filter = 'all' | 'upcoming' | 'failed';
function sessionLabels(projects: Project[]): Map<string, { session: string; project: string }> {
  const labels = new Map<string, { session: string; project: string }>();
  for (const project of projects) {
    for (const session of getAllSessions(project)) {
      labels.set(session.id, {
        session: session.title || session.summary || session.name || session.id,
        project: project.displayName,
      });
    }
  }
  return labels;
}

export default function ScheduledMessagesCenter({
  controller,
  projects,
  onOpenSession,
}: {
  controller: Controller;
  projects: Project[];
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation('chat');
  const [filter, setFilter] = useState<Filter>('all');
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const labels = useMemo(() => sessionLabels(projects), [projects]);
  const visible = useMemo(() => controller.messages.filter((message) => {
    if (filter === 'failed') return message.status === 'failed';
    if (filter === 'upcoming') return message.status === 'pending' || message.status === 'running';
    return true;
  }), [controller.messages, filter]);
  const groups = useMemo(() => groupScheduledMessages(visible), [visible]);
  const visibleTotal = filter === 'failed'
    ? controller.pages.failed.total
    : filter === 'upcoming'
      ? controller.pages.pending.total + controller.pages.running.total
      : controller.total;
  const filterHasMore = filter === 'failed'
    ? controller.pages.failed.hasMore
    : filter === 'upcoming'
      ? controller.pages.pending.hasMore || controller.pages.running.hasMore
      : controller.hasMore;
  const language = i18n.language || 'en';
  const recoverFocus = () => {
    requestAnimationFrame(() => {
      const firstRowAction = document.querySelector<HTMLElement>('[data-scheduled-message-row] button');
      (firstRowAction ?? document.getElementById('scheduled-center-title'))?.focus();
    });
  };
  const cancelMessage = async (message: ScheduledMessage) => {
    setSuccessMessage('');
    await controller.cancel(message.id);
    setSuccessMessage(t('scheduled.center.cancelledSuccess'));
    recoverFocus();
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto" aria-labelledby="scheduled-center-title">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><CalendarClock aria-hidden="true" className="size-5" /></div>
            <h1 id="scheduled-center-title" tabIndex={-1} className="rounded-sm text-xl font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-2xl">{t('scheduled.center.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('scheduled.center.description')}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void controller.refresh()} disabled={controller.loading}>
            <RefreshCcw aria-hidden="true" className={controller.loading ? 'animate-spin motion-reduce:animate-none' : ''} />
            {t('scheduled.refresh')}
          </Button>
        </header>

        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label={t('scheduled.center.filtersLabel')}>
          {(['all', 'upcoming', 'failed'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`h-[var(--control-height-compact)] rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filter === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>
              {t(`scheduled.center.filters.${value}`)}
            </button>
          ))}
        </div>
        {(!controller.loading || controller.messages.length > 0) && <p className="sr-only" role="status" aria-live="polite">{t('scheduled.center.resultCount', { count: visible.length })}</p>}
        <p className="sr-only" role="status" aria-live="polite">{successMessage}</p>

        {controller.error && (
          <div role="alert" className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-3 text-sm ${controller.stale ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{t(controller.stale ? 'scheduled.center.stale' : controller.errorKind === 'action' ? 'scheduled.errors.save' : 'scheduled.errors.load')}</span>
          </div>
        )}

        {controller.loading && controller.messages.length === 0 ? <ScheduledCenterSkeleton /> : visible.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-border px-5 py-12 text-center">
            <CalendarClock aria-hidden="true" className="mx-auto size-8 text-muted-foreground/60" />
            <h2 className="mt-3 text-sm font-semibold">{t('scheduled.center.emptyTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('scheduled.center.emptyDescription')}</p>
          </div>
        ) : (
          <div className="mt-6 space-y-7">
            {(['failed', 'today', 'tomorrow', 'later'] as const).map((group) => groups[group].length > 0 && (
              <section key={group} aria-labelledby={`scheduled-${group}`}>
                <h2 id={`scheduled-${group}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`scheduled.center.groups.${group}`)}</h2>
                <div className="space-y-2" role="list">
                  {groups[group].map((message) => {
                    const label = labels.get(message.sessionId);
                    const projectName = label?.project ?? t('scheduled.center.unknownProject');
                    const sessionName = label?.session ?? t('scheduled.center.unknownSession');
                    const statusLabel = t(`scheduled.status.${message.status}`);
                    const scheduledTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.scheduledFor));
                    const isRevealed = revealed.has(message.id);
                    const running = message.status === 'running';
                    const busy = controller.busyIds.has(message.id);
                    return (
                      <article key={message.id} role="listitem" aria-label={t('scheduled.center.rowLabel', { project: projectName, session: sessionName, status: statusLabel, time: scheduledTime })} aria-busy={busy} data-scheduled-message-row data-scheduled-message-id={message.id} className="rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <bdi data-scheduled-project className="max-w-full truncate text-xs font-semibold text-foreground" title={projectName}>{projectName}</bdi>
                              <span data-scheduled-status className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${message.status === 'failed' ? 'bg-destructive/10 text-destructive' : message.status === 'running' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{statusLabel}</span>
                              <time dateTime={message.scheduledFor} className="text-xs text-muted-foreground">{scheduledTime}</time>
                            </div>
                            <button type="button" onClick={() => onOpenSession(message.sessionId)} className="mt-2 flex max-w-full items-center gap-1.5 text-start text-sm font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
                              <bdi className="truncate">{sessionName}</bdi>
                            </button>
                            <div className="mt-3 rounded-lg bg-muted/45 px-3 py-2.5">
                              {isRevealed ? <p dir="auto" className="whitespace-pre-wrap break-words text-start text-sm text-foreground/90">{message.content}</p> : <p className="text-sm text-muted-foreground">{t('scheduled.center.contentHidden')}</p>}
                            </div>
                            {message.status === 'failed' && message.lastErrorCode && <p className="mt-2 text-xs text-destructive">{t('scheduled.failureMessage')} (<bdi>{message.lastErrorCode}</bdi>)</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button type="button" onClick={() => setRevealed((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t(isRevealed ? 'scheduled.center.hideContent' : 'scheduled.center.showContent')}>
                              {isRevealed ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
                            </button>
                            {busy && <Loader2 aria-hidden="true" className="m-2 size-4 animate-spin motion-reduce:animate-none" />}
                            {!running && <>
                              <button type="button" disabled={busy} onClick={() => { setSuccessMessage(''); setEditing(message); }} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" aria-label={t(message.status === 'failed' ? 'scheduled.center.reschedule' : 'scheduled.edit')}><Pencil aria-hidden="true" className="size-4" /></button>
                              <button type="button" disabled={busy} onClick={() => void cancelMessage(message).catch(() => undefined)} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" aria-label={t('scheduled.cancel')}><Trash2 aria-hidden="true" className="size-4" /></button>
                            </>}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        {!controller.loading && controller.messages.length > 0 && (
          <div className="mt-6 flex flex-col items-center gap-3 border-t border-border/70 pt-5">
            <p className="text-sm text-muted-foreground">{t('scheduled.center.showingOf', { shown: visible.length, total: visibleTotal })}</p>
            {filterHasMore && <Button type="button" variant="outline" onClick={() => void controller.loadMore()} disabled={controller.loadingMore}>
              {controller.loadingMore && <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
              {t('scheduled.center.loadMore')}
            </Button>}
          </div>
        )}
      </div>
      <ScheduleMessageDialog open={Boolean(editing)} message={editing} initialContent="" busy={Boolean(editing && controller.busyIds.has(editing.id))} onOpenChange={(open) => { if (!open) setEditing(null); }} onSave={async (content, scheduledFor) => { if (!editing) return; setSuccessMessage(''); await controller.update(editing.id, content, scheduledFor); setEditing(null); setSuccessMessage(t('scheduled.center.rescheduledSuccess')); recoverFocus(); }} />
    </main>
  );
}

function ScheduledCenterSkeleton() {
  const { t } = useTranslation('chat');
  return <div className="mt-6 space-y-3" aria-busy="true" aria-label={t('scheduled.center.loading')}><div className="h-5 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />{[0, 1, 2].map((row) => <div key={row} className="h-28 animate-pulse rounded-xl border border-border/60 bg-muted/45 motion-reduce:animate-none" />)}</div>;
}
