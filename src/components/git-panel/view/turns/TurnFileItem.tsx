import { ChevronRight, Lock, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TurnCheckpointFile, TurnFileDiffState } from '../../types/turnCheckpoints';
import { isBinaryDiff, withheldReasonKey } from '../../utils/turnCheckpointUtils';
import { getStatusBadgeClass } from '../../utils/gitPanelUtils';
import GitDiffViewer from '../shared/GitDiffViewer';

const BADGE = 'inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border text-[10px] font-bold';
/**
 * Chevron direction: points along the reading direction (mirrored in RTL) when closed,
 * down when open. Flip and rotation never combine: a mirrored chevron rotated 90deg points up.
 */
export const EXPANDER = (isExpanded: boolean) => (isExpanded ? 'rotate-90' : 'rtl:-scale-x-100');
const NOTICE = 'mb-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground';

type TurnFileItemProps = {
  file: TurnCheckpointFile;
  isMobile: boolean;
  isExpanded: boolean;
  diff?: TurnFileDiffState;
  wrapText: boolean;
  onToggle: () => void;
};

/** Label and reason of a withheld path, in words (never colour alone). */
function WithheldReason({ reason, phase }: { reason?: string; phase?: 'pre' }) {
  const { t } = useTranslation('common');
  const reasonKey = withheldReasonKey(reason);
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      <span>{phase === 'pre' ? t('git.turns.phasePre') : t('git.turns.withheldFile')}</span>
      {reasonKey && (
        <>
          {' · '}
          <span>{t(`git.turns.reasons.${reasonKey}`)}</span>
        </>
      )}
    </p>
  );
}

/** A withheld badge: the untracked class plus a lock glyph. */
export function WithheldBadge() {
  const { t } = useTranslation('common');
  return (
    <span className={`${BADGE} ${getStatusBadgeClass('U')}`} title={t('git.turns.withheldFile')}>
      <Lock className="h-3 w-3" aria-hidden="true" data-withheld-lock />
    </span>
  );
}

function FileDiffBody({ diff, isMobile, wrapText }: { diff?: TurnFileDiffState; isMobile: boolean; wrapText: boolean }) {
  const { t } = useTranslation('common');
  if (!diff || diff.status === 'loading') {
    return (
      <div className="flex h-16 items-center justify-center">
        <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  if (diff.status === 'withheld') return <div className="p-3"><WithheldReason reason={diff.reason} /></div>;
  if (diff.status === 'unavailable') return <p className="p-3 text-xs text-muted-foreground">{t('git.diff.none')}</p>;
  if (isBinaryDiff(diff.diff)) return <p className="p-3 text-xs text-muted-foreground">{t('git.turns.binary')}</p>;
  return (
    <div className="max-h-96 overflow-y-auto">
      {diff.truncated && <div className={`${NOTICE} m-2`}>{t('git.diff.largePreview')}</div>}
      <GitDiffViewer diff={diff.diff} isMobile={isMobile} wrapText={wrapText} />
    </div>
  );
}

/**
 * T-2095: one changed path of a turn (FileChangeItem anatomy without the
 * checkbox or discard). A withheld path is a plain row: there is no diff to open.
 */
export default function TurnFileItem({ file, isMobile, isExpanded, diff, wrapText, onToggle }: TurnFileItemProps) {
  const { t } = useTranslation('common');
  const rowPadding = isMobile ? 'px-2 py-1.5' : 'px-3 py-2';
  const textSize = isMobile ? 'text-xs' : 'text-sm';

  if (file.status === 'withheld') {
    return (
      <div className={`flex items-start gap-2 border-b border-border last:border-0 ${rowPadding}`}>
        <span className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <span className={`block truncate text-start ${textSize}`}><bdi dir="ltr">{file.path}</bdi></span>
          <WithheldReason reason={file.reason} phase={file.phase} />
        </div>
        <WithheldBadge />
      </div>
    );
  }

  const statusLabel = t(`git.turns.fileStatus.${file.status}`);
  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className={`flex w-full items-center gap-2 text-start transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${rowPadding}`}
      >
        <ChevronRight
          className={`h-3 w-3 flex-shrink-0 transition-transform duration-200 ${EXPANDER(isExpanded)}`}
          aria-hidden="true"
        />
        <span className={`min-w-0 flex-1 truncate text-start ${textSize}`}><bdi dir="ltr">{file.path}</bdi></span>
        <span className={`${BADGE} ${getStatusBadgeClass(file.status)}`} title={statusLabel}>
          {file.status}
          <span className="sr-only"> {statusLabel}</span>
        </span>
      </button>
      {isExpanded && (
        <div className="bg-muted/50">
          <FileDiffBody diff={diff} isMobile={isMobile} wrapText={wrapText} />
        </div>
      )}
    </div>
  );
}
