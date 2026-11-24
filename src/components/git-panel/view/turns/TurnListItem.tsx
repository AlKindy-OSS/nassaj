import { ChevronRight, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TurnCheckpointCounts, TurnCheckpointSummary, TurnFileDiffState } from '../../types/turnCheckpoints';
import { turnFileKey } from '../../hooks/useTurnCheckpoints';
import { getStatusBadgeClass } from '../../utils/gitPanelUtils';
import { formatRelativeTime } from '../../utils/turnCheckpointUtils';

import TurnFileItem, { EXPANDER } from './TurnFileItem';

type TurnListItemProps = {
  turn: TurnCheckpointSummary;
  isExpanded: boolean;
  expandedFiles: ReadonlySet<string>;
  fileDiffs: Record<string, TurnFileDiffState>;
  isMobile: boolean;
  wrapText: boolean;
  onToggle: () => void;
  onToggleFile: (path: string) => void;
};

const COUNT_BADGE = 'inline-flex h-5 items-center gap-0.5 rounded border px-1 text-[10px] font-bold';
const COUNTS: { key: keyof TurnCheckpointCounts; status: 'A' | 'M' | 'D' | null }[] = [
  { key: 'added', status: 'A' },
  { key: 'modified', status: 'M' },
  { key: 'deleted', status: 'D' },
  { key: 'withheld', status: null },
];

function CountBadges({ counts }: { counts: TurnCheckpointCounts }) {
  const { t } = useTranslation('common');
  return (
    <span className="flex flex-shrink-0 items-center gap-1">
      {COUNTS.filter(({ key }) => counts[key] > 0).map(({ key, status }) => (
        <span
          key={key}
          className={`${COUNT_BADGE} ${getStatusBadgeClass(status ?? 'U')}`}
          title={t(`git.turns.count.${key}`, { count: counts[key] })}
        >
          {status ?? <Lock className="h-3 w-3" aria-hidden="true" />}
          <span aria-hidden="true">{counts[key]}</span>
          <span className="sr-only">{t(`git.turns.count.${key}`, { count: counts[key] })}</span>
        </span>
      ))}
    </span>
  );
}

/** T-2095: one turn row (CommitHistoryItem anatomy) and, when open, its file rows. */
export default function TurnListItem({
  turn, isExpanded, expandedFiles, fileDiffs, isMobile, wrapText, onToggle, onToggleFile,
}: TurnListItemProps) {
  const { t, i18n } = useTranslation('common');
  const when = formatRelativeTime(turn.completedAt ?? turn.startedAt, i18n.language);
  return (
    <div className="border-b border-border last:border-0" data-turn-seq={turn.turnSeq}>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-start gap-2 border-0 bg-transparent p-3 text-start transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mt-1 rounded p-0.5">
          <ChevronRight className={`h-3 w-3 transition-transform duration-200 ${EXPANDER(isExpanded)}`} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{t('git.turns.turnN', { n: turn.turnSeq })}</span>
            <CountBadges counts={turn.counts} />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {turn.provider && <bdi>{turn.provider}</bdi>}
            {when && <span>{when}</span>}
            {turn.status !== 'complete' && (
              <span className="text-xs italic text-muted-foreground/80">{t(`git.turns.status.${turn.status}`)}</span>
            )}
          </span>
        </span>
      </button>

      {isExpanded && (
        <div className="bg-muted/30 ps-6">
          {turn.files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('git.turns.noFiles')}</p>
          ) : (
            turn.files.map((file) => (
              <TurnFileItem
                key={`${file.status}:${file.path}`}
                file={file}
                isMobile={isMobile}
                isExpanded={expandedFiles.has(file.path)}
                diff={fileDiffs[turnFileKey(turn.turnSeq, file.path)]}
                wrapText={wrapText}
                onToggle={() => onToggleFile(file.path)}
              />
            ))
          )}
          {turn.filesTruncated && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('git.turns.filesTruncated')}</p>
          )}
        </div>
      )}
    </div>
  );
}
