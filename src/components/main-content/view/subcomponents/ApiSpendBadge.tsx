import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { formatApiSpend } from '../../../quick-settings-panel/claudeUsageHelpers';
import type { AnthropicApiSpendState } from '../../../quick-settings-panel/hooks/useAnthropicApiSpend';
import { isolateBidi } from '../../../quick-settings-panel/subscriptionHelpers';

import QuotaErrorBadge from './QuotaErrorBadge';

/**
 * ADR-214 / T-2066: شارة إنفاق Anthropic API منذ بداية الشهر (UTC) في الهيدر.
 *
 * **الاستثناء الوحيد** من ADR-081 («لا مبالغ على الأسطح الدائمة»): المبلغ هنا
 * يقرؤه الخادم بمفتاح Admin الخاص بالمستخدم نفسه، لا تقديراً ولا إدخالاً يدوياً.
 *
 * - idle/loading/none ⇒ لا شيء (none = لا مفتاح مُعدّ، 404).
 * - success بلا بيانات (`hasData=false`) ⇒ «—» لا «$0.00» مختلقة.
 * - خطأ ⇒ شارة التعذّر المكتومة نفسها المستخدمة لحصص المزوّدين.
 */
export default function ApiSpendBadge({ state }: { state: AnthropicApiSpendState }) {
  const { i18n, t } = useTranslation('settings');

  if (state.status === 'error') {
    const isAuth = state.code === 'API_SPEND_AUTH';
    return (
      <QuotaErrorBadge
        testId="api-spend-error-badge"
        errorLabel={t(isAuth ? 'apiSpend.authErrorLabel' : 'apiSpend.unavailableLabel')}
        errorTooltipText={t(isAuth ? 'apiSpend.authErrorTooltip' : 'apiSpend.unavailableTooltip')}
        cycleSecondaryText={null}
      />
    );
  }
  if (state.status !== 'success') return null;

  const { data } = state;
  const amount = formatApiSpend(data, i18n.language);
  const sinceText = new Date(data.periodStart).toLocaleDateString(i18n.language, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  // الطرفان بتوقيت UTC معاً، مطابقةً لوسم «(UTC)» في النص.
  const untilText = new Date(data.observedAt).toLocaleString(i18n.language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const periodText = t('apiSpend.period', {
    since: isolateBidi(sinceText),
    until: isolateBidi(untilText),
  });
  const valueText = amount ?? t('apiSpend.noDataShort');
  const ariaLabel = amount
    ? `${t('apiSpend.title')}: ${amount} — ${periodText}`
    : `${t('apiSpend.title')}: ${t('apiSpend.noData')}`;

  const tooltip = (
    <div className="space-y-0.5">
      <div className="font-medium">{t('apiSpend.title')}</div>
      {amount ? (
        <div className="opacity-75">{isolateBidi(amount)}</div>
      ) : (
        <div className="opacity-75">{t('apiSpend.noData')}</div>
      )}
      <div className="opacity-75">{periodText}</div>
      {data.excludesPriorityTier && (
        <div className="opacity-60">{t('apiSpend.excludesPriorityTier')}</div>
      )}
    </div>
  );

  return (
    <Tooltip content={tooltip} position="bottom" tapToToggle multiline>
      <span
        className="flex items-baseline gap-0.5 text-xs"
        aria-label={ariaLabel}
        data-testid="api-spend-badge"
        data-has-data={data.hasData ? 'true' : 'false'}
      >
        {/* وسمٌ كحروف C/W/+ المجاورة: بدونه يُقرأ المبلغ امتداداً لرصيد «+». */}
        <span className="font-semibold text-primary" aria-hidden="true">
          {t('apiSpend.mark')}
        </span>
        <span
          className={`tabular-nums ${amount ? 'text-muted-foreground' : 'text-muted-foreground opacity-60'}`}
        >
          {isolateBidi(valueText)}
        </span>
      </span>
    </Tooltip>
  );
}
