import { AlertCircle, ChevronDown, Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSubscriptionCosts } from '../hooks/useSubscriptionCosts';
import { formatPricesAsOf } from '../subscriptionHelpers';

import QuickSettingsSection from './QuickSettingsSection';
import SubscriptionCard from './SubscriptionCard';

type SubscriptionsSectionProps = {
  /** Panel visibility. Fetching also needs the section itself to be expanded. */
  isOpen: boolean;
};

/**
 * "Active subscriptions" — month-to-date cost per SUBSCRIPTION, collapsed by
 * default. Sits under ClaudeUsageSection and borrows its visual language.
 *
 * A card is a VENDOR (who is paid), not a harness (which CLI ran): GLM reached
 * through both `opencode` and `glm-cli` is one card with a harness breakdown
 * inside it, not a "GLM — Not available" card next to an "OpenCode" card
 * carrying GLM's spend. The nesting lives in SubscriptionCard.
 *
 * Collapsed is not just a layout choice: the fetch is gated on panel-open AND
 * expanded because the server re-reads session transcripts to answer it.
 */
export default function SubscriptionsSection({ isOpen }: SubscriptionsSectionProps) {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  const [isExpanded, setIsExpanded] = useState(false);
  const uid = useId();
  const contentId = `${uid}-subscriptions`;

  const costs = useSubscriptionCosts(isOpen && isExpanded);

  const pricesAsOf =
    costs.status === 'success' ? formatPricesAsOf(costs.data.pricesAsOf, locale) : null;

  const title = (
    <button
      type="button"
      onClick={() => setIsExpanded((previous) => !previous)}
      aria-expanded={isExpanded}
      aria-controls={contentId}
      className="flex w-full items-center gap-1.5 text-start transition-colors hover:text-foreground"
    >
      {/* Vertical flip only — a sideways chevron would need mirroring under RTL. */}
      <ChevronDown
        className={`h-3.5 w-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        aria-hidden="true"
      />
      {t('subscriptions.title', { defaultValue: 'Active subscriptions' })}
    </button>
  );

  return (
    <QuickSettingsSection title={title}>
      <div id={contentId}>
        {isExpanded && (
          <div className="space-y-2">
            {(costs.status === 'idle' || costs.status === 'loading') && (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('subscriptions.loading', { defaultValue: 'Loading subscription costs…' })}
              </div>
            )}

            {costs.status === 'error' && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {t('subscriptions.error', { defaultValue: 'Could not load subscription costs.' })}
                </span>
              </div>
            )}

            {costs.status === 'success' && costs.data.subscriptions.length === 0 && (
              <p className="py-2 text-xs text-muted-foreground/80">
                {t('subscriptions.empty', { defaultValue: 'No active subscriptions.' })}
              </p>
            )}

            {costs.status === 'success' && costs.data.subscriptions.length > 0 && (
              <>
                <ul className="space-y-2">
                  {costs.data.subscriptions.map((subscription) => (
                    <SubscriptionCard
                      key={subscription.provider}
                      subscription={subscription}
                      locale={locale}
                    />
                  ))}
                </ul>

                {/* Said once for the whole section: every amount here is priced
                    off one dated table (ADR-078 §3), so the date belongs to the
                    section, not to each card. */}
                {pricesAsOf && (
                  <p className="text-[11px] text-muted-foreground/80">
                    {t('subscriptions.pricesAsOf', {
                      date: pricesAsOf,
                      defaultValue: 'Prices as of {{date}}',
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </QuickSettingsSection>
  );
}
