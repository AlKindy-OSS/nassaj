import { History, RefreshCw, ServerCrash } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTurnCheckpoints } from '../../hooks/useTurnCheckpoints';
import FileStatusLegend from '../changes/FileStatusLegend';

import TurnListItem from './TurnListItem';

type TurnChangesViewProps = {
  projectId: string | null;
  sessionId: string | null;
  /** Turn the chat chip asked to show; expanded once it is listed. */
  focusTurnSeq?: number | null;
  isMobile: boolean;
  wrapText: boolean;
};

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function CenteredMessage({ text }: { text: string }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
      <History className="mb-2 h-10 w-10 opacity-40" aria-hidden="true" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

/** GitRepositoryErrorState layout with a retry action (500 and 429). */
function LoadErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-muted-foreground" role="alert">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
        <ServerCrash className="h-8 w-8 opacity-40" aria-hidden="true" />
      </div>
      <h3 className="mb-6 text-center text-lg font-medium text-foreground">{t('git.turns.loadError')}</h3>
      <button
        type="button"
        onClick={onRetry}
        className={`flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 ${FOCUS_RING}`}
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        <span>{t('git.turns.retry')}</span>
      </button>
    </div>
  );
}

/**
 * T-2095: the git panel's "Turn changes" tab: what each agent turn of one
 * session overlay changed, newest first. Read-only.
 */
export default function TurnChangesView({ projectId, sessionId, focusTurnSeq = null, isMobile, wrapText }: TurnChangesViewProps) {
  const { t } = useTranslation('common');
  const { status, turns, hasOlder, isLoadingOlder, fileDiffs, retry, loadOlder, loadFileDiff } = useTurnCheckpoints({
    projectId, sessionId,
  });
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Record<number, Set<string>>>({});

  useEffect(() => {
    if (focusTurnSeq == null || !turns.some((turn) => turn.turnSeq === focusTurnSeq)) return;
    setExpandedTurns((previous) => (previous.has(focusTurnSeq) ? previous : new Set(previous).add(focusTurnSeq)));
    document.querySelector(`[data-turn-seq="${focusTurnSeq}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusTurnSeq, turns]);

  const toggleFile = useCallback((turnSeq: number, path: string) => {
    setExpandedFiles((previous) => {
      const current = previous[turnSeq] ?? new Set<string>();
      if (!current.has(path)) void loadFileDiff(turnSeq, path);
      return { ...previous, [turnSeq]: toggled(current, path) };
    });
  }, [loadFileDiff]);

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex h-32 flex-1 items-center justify-center">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  if (status === 'notFound') return <div className="flex-1"><CenteredMessage text={t('git.turns.notFound')} /></div>;
  if (status === 'error') return <LoadErrorState onRetry={retry} />;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <FileStatusLegend isMobile={isMobile} showWithheld />
      <div className="flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <CenteredMessage text={t('git.turns.empty')} />
        ) : (
          <div className={isMobile ? 'pb-4' : ''}>
            {turns.map((turn) => (
              <TurnListItem
                key={turn.turnSeq}
                turn={turn}
                isExpanded={expandedTurns.has(turn.turnSeq)}
                expandedFiles={expandedFiles[turn.turnSeq] ?? new Set()}
                fileDiffs={fileDiffs}
                isMobile={isMobile}
                wrapText={wrapText}
                onToggle={() => setExpandedTurns((previous) => toggled(previous, turn.turnSeq))}
                onToggleFile={(path) => toggleFile(turn.turnSeq, path)}
              />
            ))}
            {hasOlder && (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={isLoadingOlder}
                className={`flex w-full items-center justify-center gap-2 p-3 text-sm text-primary transition-colors hover:bg-accent/50 disabled:opacity-60 ${FOCUS_RING}`}
              >
                {isLoadingOlder && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
                <span>{t('git.turns.loadOlder')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
