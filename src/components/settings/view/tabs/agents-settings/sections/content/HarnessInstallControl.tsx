import { ChevronDown, Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { InstallableHarnessId } from '../../../../../../../../shared/harness-install.contract';
import type { HarnessInstallState } from '../../../../../../../hooks/useHarnessInstall';
import { Button } from '../../../../../../../shared/view/ui';

/** Arabic fallbacks per refusal/job error code (i18n keys `harnessInstall.error.<code>`). */
const ERROR_DEFAULTS: Record<string, string> = {
  install_failed: 'فشل تثبيت الأداة.',
  install_timeout: 'انتهت مهلة التثبيت.',
  verify_failed: 'ثُبّتت الأداة لكن تعذّر التحقق منها.',
  script_rejected: 'رُفض سكربت التثبيت لأنه لا يطابق المصدر الموثوق.',
  PLATFORM_MODE_UNSUPPORTED: 'التثبيت من الواجهة غير متاح في هذا الوضع.',
  HARNESS_ALREADY_INSTALLED: 'الأداة مثبّتة أصلاً.',
  HARNESS_OVERRIDE_SET: 'مسار مخصّص للأداة مضبوط؛ ثبّتها يدوياً.',
  HARNESS_INSTALL_INVALID: 'يوجد تثبيت غير صالح؛ أصلحه يدوياً.',
  HARNESS_ACTION_RATE_LIMITED: 'محاولات كثيرة؛ انتظر قليلاً ثم أعد المحاولة.',
};

type Props = {
  provider: InstallableHarnessId;
  state: HarnessInstallState;
  onStart: () => void;
};

/** Owner-only Install/Retry button, rendered inline at the end of the command row (T-2062). */
export function HarnessInstallButton({ provider, state, onStart }: Props) {
  const { t } = useTranslation('settings');
  const busy = state.status === 'starting' || state.status === 'running';
  const failed = state.status === 'failed';
  return (
    <Button
      type="button"
      size="sm"
      onClick={onStart}
      disabled={busy}
      aria-busy={busy}
      className="flex-shrink-0"
      data-testid={`harness-install-${provider}`}
    >
      {failed
        ? <RefreshCw className="me-2 h-4 w-4" aria-hidden />
        : <Download className="me-2 h-4 w-4" aria-hidden />}
      {failed
        ? t('harnessInstall.retry', { defaultValue: 'إعادة المحاولة' })
        : busy ? t('harnessInstall.installing', { defaultValue: 'جارٍ التثبيت…' }) : t('harnessInstall.install', { defaultValue: 'تثبيت' })}
    </Button>
  );
}

/**
 * Full-width install feedback below the command row: progress, phase, error
 * and log tail (T-2062). Progress mirrors the update bar in HarnessVersionSection.
 */
export default function HarnessInstallProgress({ provider, state }: Omit<Props, 'onStart'>) {
  const { t, i18n } = useTranslation('settings');
  const busy = state.status === 'starting' || state.status === 'running';
  const failed = state.status === 'failed';
  const phase = state.phase ?? 'queued';
  const isArabic = i18n.language?.startsWith('ar') ?? true;
  const serverMessage = isArabic ? state.errorMessageAr : state.errorMessage;
  const errorText = failed
    ? serverMessage ?? t(`harnessInstall.error.${state.errorCode ?? 'install_failed'}`, {
      defaultValue: ERROR_DEFAULTS[state.errorCode ?? ''] ?? state.errorMessage ?? t('harnessInstall.error.generic', { defaultValue: 'تعذّر بدء التثبيت.' }),
    })
    : '';
  if (state.status === 'idle') return null;

  return (
    <div className="space-y-2" data-testid={`harness-install-progress-${provider}`}>
      {busy && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-[13px] text-foreground" aria-live="polite">
            <span>{t(`harnessVersion.phase.${phase}`, { defaultValue: phase })}</span>
            <bdi dir="ltr" className="font-mono tabular-nums">{state.percent}%</bdi>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent}
            aria-label={t('harnessInstall.progress', { defaultValue: 'تقدّم التثبيت' })}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${state.percent}%` }} />
          </div>
        </div>
      )}

      {state.status === 'busy-other' && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {t('harnessInstall.otherOperation', { defaultValue: 'توجد عملية أخرى جارية على هذه الأداة؛ أعد المحاولة بعد انتهائها.' })}
        </p>
      )}
      {failed && <p role="alert" className="text-[13px] leading-relaxed text-destructive">{errorText}</p>}
      {state.status === 'succeeded' && (
        <p role="status" className="text-[13px] text-foreground">{t('harnessInstall.succeeded', { defaultValue: 'اكتمل التثبيت.' })}</p>
      )}

      {state.log.length > 0 && (
        <details className="rounded-md border border-border">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-foreground">
            <ChevronDown className="h-4 w-4" aria-hidden />
            {t('harnessInstall.log', { defaultValue: 'سجلّ التثبيت' })}
          </summary>
          <pre dir="ltr" aria-live="off" className="max-h-48 overflow-auto border-t border-border bg-muted p-3 text-start font-mono text-[13px] text-foreground">
            {state.log.slice(-200).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
