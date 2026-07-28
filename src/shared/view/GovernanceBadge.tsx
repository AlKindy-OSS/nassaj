import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useProviderGovernance } from '../../components/chat/hooks/useProviderGovernance';
import type { LLMProvider } from '../../types/app';

type GovernanceBadgeProps = {
  provider: LLMProvider | undefined | null;
  className?: string;
};

/**
 * Governance indicator for the active session's provider (T-900, §المرحلة 3 — قلب).
 *
 * Governance is the default assumed state — showing a positive "governed" badge
 * adds noise without signal. Three honest states:
 *
 *   governed (enforced or present) → renders nothing (expected default)
 *   ungoverned                     → soft amber warning triangle
 *   null (absent / error)          → renders nothing (fail-HIDDEN)
 *
 * A11y: role="status", aria-label carries both label and tooltip text so screen
 * readers receive the explanation without requiring a hover. RTL-safe: only
 * logical-flow gap — no left/right overrides needed.
 */
export default function GovernanceBadge({ provider, className }: GovernanceBadgeProps) {
  const { t } = useTranslation('common');
  const descriptor = useProviderGovernance(provider);

  // Fail-HIDDEN: unknown server state, absent endpoint, or governed (expected default).
  if (!descriptor || descriptor.status === 'governed') {
    return null;
  }

  // status === 'ungoverned': show a quiet warning — not the default.
  const tooltip = t('governanceBadge.tooltip.none');
  const label = t('governanceBadge.ungoverned');

  return (
    <span
      role="status"
      title={tooltip}
      aria-label={`${label} — ${tooltip}`}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
        'border-amber-400/25 bg-amber-400/5 text-amber-600/60 dark:text-amber-500/50',
        className,
      )}
    >
      <AlertTriangle className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
