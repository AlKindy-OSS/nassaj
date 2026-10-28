import { Tooltip } from '../../../../shared/view/ui';

// ---------------------------------------------------------------------------
// QuotaErrorBadge — خالصة بلا hooks، تعرض حالة تعذّر القراءة.
// مفصولة عن المكوّن الأب لتبقى ≤50 سطراً وعمقاً ≤3 (قاعدة التنظيف).
// ---------------------------------------------------------------------------
export interface QuotaErrorBadgeProps {
  /** نصّ قصير لـ aria-label والسطر الأول من التلميح. */
  errorLabel: string;
  /** وصف سبب التعذّر للتلميح (اسم المزوّد مُضمَّن). */
  errorTooltipText: string;
  /** معلومة التجديد الثانوية — تُعرض في نهاية التلميح كسياق لا كشارة أساسية. */
  cycleSecondaryText: string | null;
  /** مِقبض اختبار؛ الافتراضي لشارة حصّة المزوّد. */
  testId?: string;
}

/**
 * شارة مكتومة تُشير إلى تعذّر قراءة حصّة المزوّد — لا تُظهر رقم الدورة
 * كشارة أساسية. الدورة (إن كانت) تظهر فقط في نهاية التلميح.
 */
export default function QuotaErrorBadge({
  errorLabel,
  errorTooltipText,
  cycleSecondaryText,
  testId = 'provider-quota-error-badge',
}: QuotaErrorBadgeProps) {
  const tooltip = (
    <div className="space-y-0.5">
      <div className="font-medium">{errorLabel}</div>
      <div className="opacity-75">{errorTooltipText}</div>
      {cycleSecondaryText && (
        <div className="mt-0.5 opacity-50">{cycleSecondaryText}</div>
      )}
    </div>
  );
  return (
    <div
      className="flex flex-shrink-0 select-none items-center"
      aria-label={errorLabel}
      data-testid={testId}
    >
      <Tooltip content={tooltip} position="bottom" tapToToggle multiline>
        <span className="flex items-baseline text-xs" aria-hidden="true">
          <span className="font-semibold text-muted-foreground opacity-60" aria-hidden="true">
            ⚠
          </span>
        </span>
      </Tooltip>
    </div>
  );
}
