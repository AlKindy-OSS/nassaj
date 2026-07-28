import { ExternalLink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth/context/AuthContext';
import { useUpstreamReleaseWatch } from '../../../../hooks/useUpstreamReleaseWatch';

const UPSTREAM_OWNER = 'siteboon';
const UPSTREAM_REPO = 'claudecodeui';

/**
 * Owner-only notice shown in the sidebar footer when the upstream repository
 * (siteboon/claudecodeui) publishes a release newer than the last one the
 * owner acknowledged. Separate from the fork's own update channel
 * (useVersionCheck against this build's configured source repo).
 *
 * Disabled by owner decision (2026-07-01): nassaj is a fork that does not track
 * upstream automatically, so this notice was confusing noise implying nassaj is
 * out of date. We keep the component (and hook) but never enable the watch, so
 * no GitHub releases API call is made and nothing is ever rendered.
 */
const UPSTREAM_NOTICE_ENABLED = false;

export default function UpstreamReleaseNotice() {
  const { t } = useTranslation('sidebar');
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  // `enabled = false` short-circuits the watch hook before any GitHub fetch.
  const { newRelease, acknowledge } = useUpstreamReleaseWatch(
    UPSTREAM_OWNER,
    UPSTREAM_REPO,
    UPSTREAM_NOTICE_ENABLED && isOwner,
  );

  if (!UPSTREAM_NOTICE_ENABLED || !isOwner || !newRelease) {
    return null;
  }

  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/70 px-2.5 py-1.5 dark:border-amber-700/40 dark:bg-amber-900/15">
        <a
          href={newRelease.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-xs font-medium text-amber-700 transition-colors hover:text-amber-800 hover:underline dark:text-amber-300 dark:hover:text-amber-200"
          aria-label={t('upstream.openRelease', { version: newRelease.version })}
        >
          {t('upstream.newRelease', { version: newRelease.version })}
          <ExternalLink className="ms-1 inline h-3 w-3 align-[-1px]" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={acknowledge}
          aria-label={t('upstream.acknowledge')}
          title={t('upstream.acknowledge')}
          className="flex-shrink-0 rounded p-0.5 text-amber-600/70 transition-colors hover:bg-amber-100 hover:text-amber-700 dark:text-amber-400/70 dark:hover:bg-amber-900/30 dark:hover:text-amber-300"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
