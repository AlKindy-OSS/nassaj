import { GitBranch, Square, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import type { SharedWritingNotice as SharedWritingNoticeState } from '../../utils/sharedWriting';

export interface SharedWritingNoticeProps {
  notice: SharedWritingNoticeState;
  /** users.id → display name from the session roster; null when unknown. */
  resolveName: (userId: number | null) => string | null;
  /** Display name of the provider the unsupported notice is about. */
  providerName?: string;
  /** The existing abort path; shown only for a stuck reply the viewer may stop. */
  onStop?: () => void;
  /** The existing fork flow; absent when nothing in view can be forked. */
  onFork?: () => void;
  isForking?: boolean;
  onDismiss: () => void;
}

/** FSI/PDI isolation: a Latin name inside an Arabic sentence keeps its own direction. */
const isolate = (text: string) => `⁨${text}⁩`;

/**
 * ADR-173 P6 — non-blocking notice above the composer in a conversation shared
 * with another member: whose turn holds it (and in which phase), a refused stop,
 * a provider on which only the creator can continue (with the fork way out), or
 * who stopped the reply when it was not its starter (P8 B4).
 */
export default function SharedWritingNotice({
  notice,
  resolveName,
  providerName,
  onStop,
  onFork,
  isForking = false,
  onDismiss,
}: SharedWritingNoticeProps) {
  const { t } = useTranslation('chat');
  const named = (userId: number | null, fromFrame: string | null = null) =>
    isolate(fromFrame ?? resolveName(userId) ?? t('sharedWriting.someone'));

  let text: string;
  let canFork = false;
  if (notice.kind === 'stopped_by') {
    text = t('sharedWriting.stoppedBy', { name: named(notice.stoppedBy, notice.stoppedByName) });
  } else if (notice.kind === 'busy') {
    const holder = named(notice.busyBy);
    text = t(`sharedWriting.busy.${notice.phase}`, { name: holder });
  } else if (notice.kind === 'stop_forbidden') {
    text = t('sharedWriting.stopForbidden', { name: named(notice.busyBy) });
  } else {
    canFork = notice.canFork && Boolean(onFork);
    text = t(canFork ? 'sharedWriting.unsupported' : 'sharedWriting.unsupportedNoFork', {
      creator: isolate(notice.creatorName ?? t('sharedWriting.creatorFallback')),
      provider: isolate(providerName ?? notice.provider ?? ''),
    });
  }
  const stuck = notice.kind === 'busy' && notice.stuck;
  const showStop = notice.kind === 'busy' && notice.stuck && notice.canStop && Boolean(onStop);

  // P8: the same gutters and column as ChatComposer (px-2 sm:px-4, mx-auto max-w-4xl),
  // so the notice lines up with the composer and never touches the screen edge.
  return (
    <div className="px-2 sm:px-4">
      <div
        role="status"
        aria-label={t('sharedWriting.regionLabel')}
        data-shared-writing-notice={notice.kind}
        className="mx-auto mb-2 flex max-w-4xl items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
      >
        <Users className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-relaxed">{text}</p>
          {stuck && <p className="text-xs text-warning">{t('sharedWriting.busy.stuck')}</p>}
          {(showStop || canFork) && (
            <div className="flex flex-wrap items-center gap-2">
              {showStop && (
                <Button type="button" size="sm" variant="outline" onClick={onStop}>
                  <Square aria-hidden="true" />
                  {t('sharedWriting.stopStuck')}
                </Button>
              )}
              {canFork && (
                <Button type="button" size="sm" variant="outline" onClick={onFork} disabled={isForking}>
                  <GitBranch aria-hidden="true" />
                  {isForking ? t('sharedWriting.forking') : t('sharedWriting.fork')}
                </Button>
              )}
            </div>
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="-me-1 -mt-1 flex-shrink-0 text-muted-foreground"
          aria-label={t('sharedWriting.dismiss')}
          title={t('sharedWriting.dismiss')}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
