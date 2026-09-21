import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useBuildVersion } from '../../hooks/useBuildVersion'

/**
 * BuildUpdateBanner — a non-intrusive floating strip that appears when the
 * server has deployed a newer client build while the user's tab is open.
 *
 * - Floats at the bottom of the viewport; does NOT block content (z-40 < modals z-50).
 * - Reload is always user-initiated — never automatic.
 * - Fully RTL-aware: uses logical CSS properties (ms-/me-) throughout.
 * - Hidden until useBuildVersion reports updateReady === true.
 */
export default function BuildUpdateBanner() {
  const { t } = useTranslation('common')
  const { updateReady } = useBuildVersion()
  const [dismissed, setDismissed] = useState(false)

  if (!updateReady || dismissed) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
      role="status"
      aria-live="polite"
      aria-label={t('buildUpdate.ariaLabel')}
    >
      <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
        {/* Icon */}
        <RefreshCw
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />

        {/* Message */}
        <p className="flex-1 text-sm text-foreground">
          {t('buildUpdate.available')}
        </p>

        {/* Dismiss — hides for the session, no reload */}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('buildUpdate.dismiss')}
        >
          {t('buildUpdate.dismiss')}
        </button>

        {/* Primary action — reload */}
        <button
          type="button"
          onClick={() => location.reload()}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('buildUpdate.reload')}
        >
          {t('buildUpdate.reload')}
        </button>
      </div>
    </div>
  )
}
