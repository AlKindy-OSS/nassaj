/**
 * AgentUsageSection — قسم «حدود الاستخدام» داخل تبويب الحساب لكل هارنس.
 *
 * المصادر الموجودة في الباك-إند:
 *  • claude  → خدمة منفصلة (useClaudeUsage / GET /api/providers/claude/usage)
 *  • codex / glm / kimi → /api/providers/:provider/quota (QUOTA_WINDOW_PROVIDERS)
 *  • بقية المزوّدات → لا مصدر، رسالة محايدة
 *
 * القاعدة: كلا الـhook يُستدعيان دائماً (rules of hooks) والـenabled يوقفهما.
 */
import { AlertCircle, Gauge, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgentProvider } from '../../../../../types/types';
// T-1822: نفس نقطة النهاية ونفس الاعتماد — آمن للدمج في المخزن المشترك.
import { useClaudeUsageShared as useClaudeUsage } from '../../../../../../quick-settings-panel/hooks/useClaudeUsageShared';
import { useAuth } from '../../../../../../auth/context/AuthContext';
import { useProviderQuota } from '../../../../../../quick-settings-panel/hooks/useProviderQuota';
import {
  clampUtilization,
  formatCredits,
  hasDisplayableExtraUsageCredits,
} from '../../../../../../quick-settings-panel/claudeUsageHelpers';
import { resolveWindowLength } from '../../../../../../quick-settings-panel/providerQuotaHelpers';
import ClaudeUsageBar from '../../../../../../quick-settings-panel/view/ClaudeUsageBar';
import SettingsSection from '../../../../SettingsSection';

/** المزوّدات التي يدعمها /api/providers/:provider/quota في الباك-إند. */
const QUOTA_WINDOW_PROVIDERS = new Set<string>(['codex', 'glm', 'kimi']);

/** نوافذ حساب Claude المعروضة — نفس ترتيب ClaudeUsageSection. */
const CLAUDE_WINDOWS = [
  { key: 'session', labelKey: 'claudeUsage.windows.session' },
  { key: 'weeklyAllModels', labelKey: 'claudeUsage.windows.weeklyAllModels' },
  { key: 'weeklySonnet', labelKey: 'claudeUsage.windows.weeklySonnet' },
  { key: 'weeklyOpus', labelKey: 'claudeUsage.windows.weeklyOpus' },
] as const;

type AgentUsageSectionProps = {
  agent: AgentProvider;
};

/**
 * يتحقق من عقد رصيد Codex قبل عرضه. الصفر رصيد صحيح، أمّا الرصيد السالب أو
 * الناقص فليس صفراً ويجب ألا يتحوّل إلى ادعاءٍ للمستخدم.
 */
export function hasDisplayableCodexCredits(
  credits: { balance: number; unlimited: boolean } | undefined,
): boolean {
  return Boolean(
    credits &&
      typeof credits.unlimited === 'boolean' &&
      typeof credits.balance === 'number' &&
      Number.isFinite(credits.balance) &&
      credits.balance >= 0,
  );
}

/**
 * يعرض نوافذ استخدام الهارنس المحدَّد.
 * يُدمج مباشرةً في تبويب الحساب (account) في AgentCategoryContentSection.
 */
export default function AgentUsageSection({ agent }: AgentUsageSectionProps) {
  const { t, i18n } = useTranslation('settings');
  const { user } = useAuth();

  const isClaudeAgent = agent === 'claude';
  const isQuotaProvider = QUOTA_WINDOW_PROVIDERS.has(agent);

  /* كلا الـhook يُستدعيان غير مشروطَين — الـenabled يوقف الجلب فقط */
  const claudeUsage = useClaudeUsage(isClaudeAgent, user?.id);
  const providerQuota = useProviderQuota(agent, null, isQuotaProvider);
  const codexCredits =
    agent === 'codex' && providerQuota.status === 'success'
      ? providerQuota.data.extraUsageCredits
      : undefined;
  const hasCodexCredits = hasDisplayableCodexCredits(codexCredits);
  const hasProviderUsageData =
    providerQuota.status === 'success' && (providerQuota.windows.length > 0 || hasCodexCredits);

  return (
    <SettingsSection
      title={t('agentUsage.title')}
      /* أيقونة القسم: كان هذا وحده من أقسام تبويب الحساب الثلاثة بلا أيقونة،
         فبدا عنوانه من عائلةٍ أخرى وإن طابق مقاسَ جارَيه (‏T-1700). */
      icon={Gauge}
      description={
        isClaudeAgent
          ? t('agentUsage.claudeDescription')
          : isQuotaProvider
            ? t('agentUsage.providerDescription')
            : undefined
      }
    >
      {/* ───── Claude ───── */}
      {isClaudeAgent && (
        <>
          {(claudeUsage.status === 'idle' || claudeUsage.status === 'loading') && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('claudeUsage.loading')}
            </div>
          )}

          {claudeUsage.status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('claudeUsage.error')}</span>
            </div>
          )}

          {claudeUsage.status === 'success' && (
            <div className="space-y-4">
              {CLAUDE_WINDOWS.map(({ key, labelKey }) => {
                const win = claudeUsage.data[key];
                if (!win) return null;
                return (
                  <ClaudeUsageBar
                    key={key}
                    label={t(labelKey)}
                    utilization={win.utilization}
                    resetsAt={win.resetsAt}
                  />
                );
              })}

              {hasDisplayableExtraUsageCredits(claudeUsage.data.extraUsage) && (
                <div className="space-y-1 border-t border-border pt-3">
                  <ClaudeUsageBar
                    label={t('claudeUsage.windows.extraUsage')}
                    utilization={claudeUsage.data.extraUsage.utilization}
                    resetsAt={null}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('claudeUsage.extraUsageDetail', {
                      used: formatCredits(
                        claudeUsage.data.extraUsage.usedCredits,
                        claudeUsage.data.extraUsage.currency,
                        i18n.language,
                      ),
                      limit: formatCredits(
                        claudeUsage.data.extraUsage.monthlyLimit,
                        claudeUsage.data.extraUsage.currency,
                        i18n.language,
                      ),
                    })}
                  </p>
                </div>
              )}

              {claudeUsage.data.stale && (
                <p className="text-sm text-muted-foreground">{t('claudeUsage.stale')}</p>
              )}
            </div>
          )}
        </>
      )}

      {/* ───── Codex / GLM / Kimi ───── */}
      {isQuotaProvider && (
        <>
          {(providerQuota.status === 'idle' || providerQuota.status === 'loading') && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('claudeUsage.loading')}
            </div>
          )}

          {providerQuota.status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('claudeUsage.error')}</span>
            </div>
          )}

          {/* لا مصدر لهذا المزوّد أو نوافذ منتهية */}
          {(providerQuota.status === 'none' ||
            (providerQuota.status === 'success' && !hasProviderUsageData)) && (
            <p className="py-2 text-sm text-muted-foreground/80">
              {t('agentUsage.noData')}
            </p>
          )}

          {hasProviderUsageData && providerQuota.status === 'success' && (
            <div className="space-y-4">
              {providerQuota.windows.map((win) => {
                const length = resolveWindowLength(win.windowSeconds);
                const label = length
                  ? t(`providerQuota.length.${length.kind}`, {
                      value: length.value,
                      defaultValue: win.key,
                    })
                  : t('providerQuota.windowGeneric');
                return (
                  <ClaudeUsageBar
                    key={win.key}
                    label={label}
                    utilization={clampUtilization(win.usedPercent)}
                    resetsAt={win.resetsAt}
                  />
                );
              })}

              {hasCodexCredits && codexCredits && (
                <div className="space-y-1 border-t border-border pt-3">
                  <p className="text-sm font-medium text-foreground">
                    {t('agentUsage.codexExtraCredits')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {codexCredits.unlimited
                      ? t('agentUsage.unlimited')
                      : t('agentUsage.creditUnits', {
                          formattedCount: new Intl.NumberFormat(i18n.language, {
                            maximumFractionDigits: 2,
                          }).format(codexCredits.balance),
                        })}
                  </p>
                </div>
              )}

              {providerQuota.plan && (
                <p className="text-sm text-muted-foreground">
                  {t('providerQuota.plan', { plan: providerQuota.plan })}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* ───── بقية المزوّدات بلا مصدر حصّة ───── */}
      {!isClaudeAgent && !isQuotaProvider && (
        <p className="py-2 text-sm text-muted-foreground/80">
          {t('agentUsage.noData')}
        </p>
      )}
    </SettingsSection>
  );
}
