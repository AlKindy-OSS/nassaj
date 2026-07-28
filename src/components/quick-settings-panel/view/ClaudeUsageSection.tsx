import { AlertCircle, Database, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ClaudeUsage } from '../claudeUsageTypes';
import { useClaudeUsage } from '../hooks/useClaudeUsage';
import { formatCredits } from '../claudeUsageHelpers';
import { getProviderCapabilities } from '../../chat/constants/providerCapabilities';

import QuickSettingsSection from './QuickSettingsSection';
import ClaudeUsageBar from './ClaudeUsageBar';

type ClaudeUsageSectionProps = {
  // Drives fetching: only poll while the panel is open.
  isOpen: boolean;
  /**
   * مزوّد الجلسة المفتوحة حالياً (selectedSession?.__provider)، إن وُجدت.
   * بيانات حساب Claude لا تنطبق على مزوّد آخر — تُحجَب أشرطة الحصة ويُعرَض
   * بدلها سطر توضيحي حين الجلسة المفتوحة ليست claude (تعديل على T-5/T-904).
   */
  sessionProvider?: string | null;
};

// Order of standard windows + their label keys. Rendered when non-null.
const USAGE_WINDOWS = [
  { key: 'session', labelKey: 'claudeUsage.windows.session' },
  { key: 'weeklyAllModels', labelKey: 'claudeUsage.windows.weeklyAllModels' },
  { key: 'weeklySonnet', labelKey: 'claudeUsage.windows.weeklySonnet' },
  { key: 'weeklyOpus', labelKey: 'claudeUsage.windows.weeklyOpus' },
] as const;

function UsageContent({ data }: { data: ClaudeUsage }) {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  const { extraUsage } = data;

  return (
    <div className="space-y-4">
      {USAGE_WINDOWS.map(({ key, labelKey }) => {
        const window = data[key];
        if (!window) return null;
        return (
          <ClaudeUsageBar
            key={key}
            label={t(labelKey)}
            utilization={window.utilization}
            resetsAt={window.resetsAt}
          />
        );
      })}

      {extraUsage?.enabled && (
        <div className="space-y-1 border-t border-border pt-3">
          <ClaudeUsageBar
            label={t('claudeUsage.windows.extraUsage')}
            utilization={extraUsage.utilization}
            resetsAt={null}
          />
          <p className="text-xs text-muted-foreground">
            {t('claudeUsage.extraUsageDetail', {
              used: formatCredits(extraUsage.usedCredits, extraUsage.currency, locale),
              limit: formatCredits(extraUsage.monthlyLimit, extraUsage.currency, locale),
            })}
          </p>
        </div>
      )}

      {data.stale && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Database className="h-3 w-3" aria-hidden="true" />
          {t('claudeUsage.stale')}
        </p>
      )}
    </div>
  );
}

/**
 * "Claude Usage" panel section. Mirrors claude.ai usage limits.
 * Owns loading/error/empty/success states; data comes from useClaudeUsage.
 */
export default function ClaudeUsageSection({ isOpen, sessionProvider }: ClaudeUsageSectionProps) {
  const { t } = useTranslation('settings');

  // Claude account usage doesn't apply to a non-claude session (T-5/T-904
  // superseded) — skip fetching it and show a note instead of the bars.
  const capabilities = getProviderCapabilities(sessionProvider);
  const isClaudeSession = capabilities.quota.isClaudeAccount;
  const usage = useClaudeUsage(isOpen && isClaudeSession);

  // Title row carries the plan badge once data is available.
  const plan = isClaudeSession && usage.status === 'success' ? usage.data.plan : null;

  const title = (
    <span className="flex items-center gap-2">
      {t('claudeUsage.title')}
      {plan && (
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold normal-case text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
          {plan}
        </span>
      )}
    </span>
  );

  return (
    <QuickSettingsSection title={title}>
      {!isClaudeSession && (
        <p className="py-2 text-xs text-muted-foreground/80">
          {t('claudeUsage.notApplicable', { provider: capabilities.displayName })}
        </p>
      )}

      {isClaudeSession && (usage.status === 'idle' || usage.status === 'loading') && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('claudeUsage.loading')}
        </div>
      )}

      {isClaudeSession && usage.status === 'error' && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('claudeUsage.error')}</span>
        </div>
      )}

      {isClaudeSession && usage.status === 'success' && <UsageContent data={usage.data} />}
    </QuickSettingsSection>
  );
}
