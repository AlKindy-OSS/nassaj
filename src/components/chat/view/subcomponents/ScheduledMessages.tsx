import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarClock, Loader2, Pencil, RefreshCcw, Trash2, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, PromptInputButton } from '../../../../shared/view/ui';
import type { ScheduledMessage } from '../../hooks/useScheduledMessages';

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

function toLocalFields(date: Date): { date: string; time: string } {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const [day, time] = shifted.toISOString().split('T');
  return { date: day, time: time.slice(0, 5) };
}

function fromLocalFields(date: string, time: string): Date | null {
  const value = new Date(`${date}T${time}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function ScheduledMessagesPanel({
  messages,
  loading,
  busyId,
  error,
  errorKind,
  onEdit,
  onRetry,
  onCancel,
  onRefresh,
}: {
  messages: ScheduledMessage[];
  loading: boolean;
  busyId: string | null;
  error: string | null;
  errorKind?: 'load' | 'action' | null;
  onEdit: (message: ScheduledMessage) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation('chat');
  const language = i18n.language || 'en';
  if (!loading && !error && messages.length === 0) return null;
  return (
    <section className="mb-2 rounded-xl border border-border/70 bg-card/80 p-2.5 shadow-sm" aria-label={t('scheduled.panelTitle')}>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
          <CalendarClock aria-hidden="true" className="size-4 text-primary" />
          <span>{t('scheduled.panelTitle')}</span>
          {messages.length > 0 && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">{messages.length}</span>}
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduled.refresh')}>
          <RefreshCcw aria-hidden="true" className={`size-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        </button>
      </div>
      {error && <div role="alert" className="mt-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"><AlertCircle aria-hidden="true" className="size-4 shrink-0"/><span>{t(errorKind === 'action' ? 'scheduled.errors.save' : 'scheduled.errors.load')}</span></div>}
      <div className="mt-1.5 space-y-1.5">
        {messages.map((message) => {
          const busy = busyId === message.id;
          return (
            <article key={message.id} className="flex items-start gap-2 rounded-lg border border-border/50 bg-background/70 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${message.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{t(`scheduled.status.${message.status}`)}</span>
                  <time dateTime={message.scheduledFor} className="text-[11px] text-muted-foreground">{new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.scheduledFor))}</time>
                </div>
                <p dir="auto" className="mt-1 line-clamp-2 text-start text-xs text-foreground/85">{message.content}</p>
                {message.status === 'failed' && message.lastErrorCode && <p className="mt-1 text-[11px] text-destructive">{t('scheduled.failureMessage')} (<bdi>{message.lastErrorCode}</bdi>)</p>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {busy ? <Loader2 aria-hidden="true" className="m-1.5 size-3.5 animate-spin motion-reduce:animate-none"/> : <>
                  <button type="button" onClick={() => onEdit(message)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduled.edit')}><Pencil aria-hidden="true" className="size-3.5"/></button>
                  {message.status === 'failed' && <button type="button" onClick={() => onRetry(message.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduled.retry')}><RefreshCcw aria-hidden="true" className="size-3.5"/></button>}
                  <button type="button" onClick={() => onCancel(message.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduled.cancel')}><Trash2 aria-hidden="true" className="size-3.5"/></button>
                </>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ScheduleMessageButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation('chat');
  return <PromptInputButton type="button" onClick={onClick} disabled={disabled} className="h-8 w-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4" tooltip={{ content: t('scheduled.open') }} aria-label={t('scheduled.open')}><CalendarClock /></PromptInputButton>;
}

export function ScheduleMessageDialog({
  open,
  message,
  initialContent,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  message: ScheduledMessage | null;
  initialContent: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (content: string, scheduledFor: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation('chat');
  const language = i18n.language || 'en';
  const direction = ['ar', 'fa', 'ur'].some((code) => language.toLowerCase().startsWith(code)) ? 'rtl' : 'ltr';
  const contentId = useId();
  const dateId = useId();
  const timeId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [content, setContent] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [validationTouched, setValidationTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const initialDate = message ? new Date(message.scheduledFor) : new Date(Date.now() + 60 * 60 * 1000);
    const fields = toLocalFields(initialDate);
    setContent(message?.content ?? initialContent);
    setDate(fields.date);
    setTime(fields.time);
    setFormError(null);
    setValidationTouched(false);
  }, [initialContent, message, open]);

  const selected = useMemo(() => fromLocalFields(date, time), [date, time]);
  const validationKey = !content.trim() ? 'scheduled.errors.empty'
    : !selected ? 'scheduled.errors.invalid'
      : selected.getTime() < Date.now() + MIN_DELAY_MS ? 'scheduled.errors.tooSoon'
        : selected.getTime() > Date.now() + MAX_DELAY_MS ? 'scheduled.errors.tooLate' : null;
  const pickPreset = (kind: '15m' | '1h' | 'evening' | 'tomorrow') => {
    const next = new Date();
    if (kind === '15m') next.setMinutes(next.getMinutes() + 15);
    if (kind === '1h') next.setHours(next.getHours() + 1);
    if (kind === 'evening') {
      next.setHours(20, 0, 0, 0);
      if (next.getTime() < Date.now() + MIN_DELAY_MS) next.setDate(next.getDate() + 1);
    }
    if (kind === 'tomorrow') {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    }
    const fields = toLocalFields(next);
    setDate(fields.date);
    setTime(fields.time);
    setFormError(null);
    setValidationTouched(false);
  };
  const visibleError = formError ?? (validationTouched ? validationKey : null);
  const dateTimeError = visibleError === 'scheduled.errors.invalid'
    || visibleError === 'scheduled.errors.tooSoon'
    || visibleError === 'scheduled.errors.tooLate';
  const submit = async () => {
    if (validationKey || !selected) {
      setFormError(validationKey);
      return;
    }
    try {
      await onSave(content.trim(), selected.toISOString());
      onOpenChange(false);
    } catch {
      setFormError('scheduled.errors.save');
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto rounded-2xl p-0 sm:w-full"
      dir={direction}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div><DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{t(message ? 'scheduled.editTitle' : 'scheduled.title')}</DialogTitle><p id={descriptionId} className="mt-1 text-xs text-muted-foreground">{t('scheduled.description')}</p></div>
        <button type="button" onClick={() => onOpenChange(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduled.close')}><X aria-hidden="true" className="size-4"/></button>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div><label htmlFor={contentId} className="mb-1.5 block text-sm font-medium">{t('scheduled.message')}</label><textarea id={contentId} value={content} onChange={(event) => { setContent(event.target.value); setFormError(null); setValidationTouched(true); }} rows={5} maxLength={32768} dir="auto" aria-invalid={visibleError === 'scheduled.errors.empty' || undefined} aria-describedby={visibleError === 'scheduled.errors.empty' ? errorId : undefined} className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
        <fieldset><legend className="mb-1.5 text-sm font-medium">{t('scheduled.quickTime')}</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['15m', '1h', 'evening', 'tomorrow'] as const).map((preset) => <Button key={preset} type="button" variant="outline" size="sm" onClick={() => pickPreset(preset)}>{t(`scheduled.presets.${preset}`)}</Button>)}</div></fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><label htmlFor={dateId} className="mb-1.5 block text-sm font-medium">{t('scheduled.date')}</label><input id={dateId} type="date" value={date} onChange={(event) => { setDate(event.target.value); setFormError(null); setValidationTouched(true); }} aria-invalid={dateTimeError || undefined} aria-describedby={dateTimeError ? errorId : undefined} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div><div><label htmlFor={timeId} className="mb-1.5 block text-sm font-medium">{t('scheduled.time')}</label><input id={timeId} type="time" value={time} onChange={(event) => { setTime(event.target.value); setFormError(null); setValidationTouched(true); }} aria-invalid={dateTimeError || undefined} aria-describedby={dateTimeError ? errorId : undefined} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div></div>
        {selected && !validationKey && <p role="status" className="bg-primary/8 rounded-lg px-3 py-2 text-xs text-muted-foreground">{t('scheduled.summary', { value: new Intl.DateTimeFormat(language, { dateStyle: 'full', timeStyle: 'short' }).format(selected) })}</p>}
        {visibleError && <p id={errorId} role="alert" className="flex items-center gap-2 text-xs text-destructive"><AlertCircle aria-hidden="true" className="size-4"/>{t(visibleError)}</p>}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border/70 px-5 py-4 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('scheduled.close')}</Button><Button type="button" onClick={() => void submit()} disabled={busy || Boolean(validationKey)}>{busy && <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none"/>}{t(message ? 'scheduled.saveChanges' : 'scheduled.schedule')}</Button></div>
    </DialogContent>
  </Dialog>;
}
