import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, Paperclip } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { requestComposerInsert } from '../../../../stores/composerInsertStore';
import { buildCaptureBlock } from '../../oneShot/captureBlock';
import {
  isLiveOneShotRun,
  requestOneShotCapture,
  useCanCaptureOneShot,
  type OneShotRun,
} from '../../oneShot/oneShotRunsStore';
import { isKnownOneShotRefusalCode, ONESHOT_DENIED_COMMAND_PREFIX } from '../../utils/reconnect';

type OneShotRunStripProps = {
  /** Display name of the session's agent, e.g. "Claude". */
  providerName: string;
  runs: readonly OneShotRun[];
  /** null = the agent's interactive CLI is shown. */
  activeRunId: string | null;
  onSelect: (runId: string | null) => void;
  /** Called after output was placed in the composer draft (e.g. go to chat). */
  onAttached?: () => void;
};

/** Localized reason for a refused run (`denied_command:<rule>` carries a rule). */
function useRefusalText(): (code: string | null) => string {
  const { t } = useTranslation('chat');
  return (code) => {
    if (code?.startsWith(ONESHOT_DENIED_COMMAND_PREFIX)) {
      return t('shellMode.disabledReason.denied_command', {
        rule: code.slice(ONESHOT_DENIED_COMMAND_PREFIX.length),
      });
    }
    return isKnownOneShotRefusalCode(code)
      ? t(`shellMode.disabledReason.${code}`)
      : t('shellMode.disabledReason.unknown');
  };
}

function RunStatus({ run }: { run: OneShotRun }) {
  const { t } = useTranslation('chat');
  if (run.status === 'running' && !isLiveOneShotRun(run.runId)) {
    // Restored from an earlier page: no longer followed here, never re-attached.
    return <span className="text-muted-foreground">{t('shellRuns.stale')}</span>;
  }
  if (run.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {t('shellRuns.running')}
      </span>
    );
  }
  if (run.status === 'refused') {
    return <span className="text-destructive">{t('shellRuns.outcome.refused')}</span>;
  }
  if (run.status === 'interrupted') {
    return <span className="text-amber-700 dark:text-amber-400">{t('shellRuns.outcome.interrupted')}</span>;
  }
  if (run.status === 'unknown' || run.exitCode === null) {
    // Never green: without a numeric exit code nothing proves it succeeded.
    return <span className="text-muted-foreground">{t('shellRuns.outcome.unknown')}</span>;
  }
  const failed = run.exitCode !== 0;
  return (
    <span className={failed ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}>
      {t('shellRuns.exit', { code: run.exitCode })}
    </span>
  );
}

/**
 * T-2037 — the Shell tab's run picker: the agent's interactive CLI first, then
 * the project's last one-shot runs (browser-local). The active run can attach
 * its captured output to the chat draft — inserted for review, never sent.
 */
export default function OneShotRunStrip({
  providerName,
  runs,
  activeRunId,
  onSelect,
  onAttached,
}: OneShotRunStripProps) {
  const { t } = useTranslation('chat');
  const refusalText = useRefusalText();
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const activeRun = runs.find((run) => run.runId === activeRunId) ?? null;
  const canCapture = useCanCaptureOneShot(activeRun?.runId ?? null);

  const handleAttach = async () => {
    if (!activeRun || attaching) return;
    setAttaching(true);
    setNotice(null);
    try {
      const capture = await requestOneShotCapture(activeRun.runId);
      if (!capture) {
        setNotice(t('shellRuns.captureFailed'));
        return;
      }
      const exitCode = capture.exitCode ?? activeRun.exitCode;
      const block = buildCaptureBlock(
        { command: activeRun.command, text: capture.text, exitCode, truncated: capture.truncated },
        {
          header: t('shellRuns.exit', { code: exitCode ?? '?' }),
          truncatedNote: t('shellRuns.truncated'),
        },
      );
      requestComposerInsert(block);
      setNotice(t('shellRuns.attached'));
      onAttached?.();
    } finally {
      setAttaching(false);
    }
  };

  const itemClass = (selected: boolean) =>
    cn(
      'inline-flex h-8 max-w-[18rem] shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected
        ? 'border-primary/40 bg-primary/10 text-foreground'
        : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
    );

  return (
    <div className="flex-shrink-0 border-b border-border bg-card" data-testid="oneshot-run-strip">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <nav aria-label={t('shellRuns.label')} className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            className={itemClass(activeRunId === null)}
            aria-current={activeRunId === null ? 'true' : undefined}
            onClick={() => onSelect(null)}
          >
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t('shellRuns.agentCli', { provider: providerName })}</span>
          </button>
          {runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={itemClass(run.runId === activeRunId)}
              aria-current={run.runId === activeRunId ? 'true' : undefined}
              onClick={() => onSelect(run.runId)}
            >
              <bdi dir="ltr" className="min-w-0 truncate font-mono text-foreground">{run.command}</bdi>
              <span className="shrink-0">
                <RunStatus run={run} />
              </span>
            </button>
          ))}
        </nav>
        {activeRun && activeRun.status !== 'refused' && canCapture && (
          <button
            type="button"
            onClick={() => void handleAttach()}
            aria-disabled={attaching || undefined}
            disabled={attaching}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              attaching && 'opacity-60',
            )}
          >
            {attaching
              ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Paperclip className="size-3.5" aria-hidden="true" />}
            <span className="hidden sm:inline">{t('shellRuns.attach')}</span>
            <span className="sr-only sm:hidden">{t('shellRuns.attach')}</span>
          </button>
        )}
      </div>
      {activeRun?.status === 'refused' && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {activeRun.refusalCode ? refusalText(activeRun.refusalCode) : t('shellRuns.outcome.refused')}
        </p>
      )}
      <p aria-live="polite" className={cn('px-3 text-xs text-muted-foreground', notice ? 'pb-2' : 'sr-only')}>
        {notice}
      </p>
    </div>
  );
}
