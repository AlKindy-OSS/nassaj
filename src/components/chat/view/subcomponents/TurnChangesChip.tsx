import { FileDiff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TurnCheckpointEvent } from '../../types/types';

type TurnChangesChipProps = {
  /** The turn's live checkpoint outcome; null renders nothing (non-owners never get one). */
  checkpoint: TurnCheckpointEvent | null;
  /** Opens the git panel's "Turn changes" tab on this turn. */
  onOpen: (turnSeq: number) => void;
};

const SKIP_REASONS = new Set(['not_overlay', 'no_principal', 'not_owner', 'low_disk', 'timeout']);
const LINE = 'flex w-full items-start gap-2 py-0.5 text-xs text-muted-foreground';
const TRIGGER = 'inline-flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-transparent px-2 text-xs '
  + 'text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * T-2095: one line under an agent reply saying what the turn changed. A captured
 * turn with changes is a button opening that turn in the git panel.
 */
export default function TurnChangesChip({ checkpoint, onOpen }: TurnChangesChipProps) {
  const { t } = useTranslation('chat');
  if (!checkpoint) return null;

  if (checkpoint.status === 'running') {
    return (
      <p className={LINE} aria-live="polite" data-turn-checkpoint>
        <RefreshCw className="mt-0.5 h-3 w-3 flex-shrink-0 animate-spin" aria-hidden="true" />
        <span>{t('turnCheckpoint.running')}</span>
      </p>
    );
  }
  if (checkpoint.status === 'skipped') {
    const reason = SKIP_REASONS.has(String(checkpoint.reason)) ? checkpoint.reason : 'not_overlay';
    return <p className={LINE} data-turn-checkpoint>{t(`turnCheckpoint.skip.${reason}`)}</p>;
  }
  if (checkpoint.status === 'failed') {
    return (
      <p className={LINE} role="status" data-turn-checkpoint>
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{t('turnCheckpoint.failed')}</span>
      </p>
    );
  }

  const { added, modified, deleted } = checkpoint.counts;
  const changed = added + modified + deleted;
  const withheld = checkpoint.withheldCount;
  if ((changed === 0 && withheld === 0) || checkpoint.turnSeq == null) {
    return <p className={LINE} data-turn-checkpoint>{t('turnCheckpoint.noChanges')}</p>;
  }

  const changedText = changed > 0 ? t('turnCheckpoint.filesChanged', { count: changed }) : t('turnCheckpoint.noChanges');
  const withheldText = withheld > 0 ? t('turnCheckpoint.withheld', { count: withheld }) : '';
  const turnSeq = checkpoint.turnSeq;
  return (
    <div className="flex w-full py-0.5" data-turn-checkpoint>
      <button
        type="button"
        className={TRIGGER}
        aria-label={t('turnCheckpoint.openLabel', { summary: [changedText, withheldText].filter(Boolean).join(' ') })}
        onClick={() => onOpen(turnSeq)}
      >
        <FileDiff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{changedText}</span>
        {withheldText && <span className="text-warning">{withheldText}</span>}
      </button>
    </div>
  );
}
