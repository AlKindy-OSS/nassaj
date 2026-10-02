import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, TimerReset } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../shared/view/ui';
import { cn } from '../../../../../../lib/utils';
import {
  parseWindowDays,
  useApiKeySsoWindow,
} from '../../../../hooks/useApiKeySsoWindow';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';

/**
 * T-1946: مدة صلاحية مفاتيح API لأعضاء الدخول الموحّد — إعداد للمالك وحده.
 *
 * مفتاح العضو المرتبط بمزوّد الهوية يتوقف إذا مضى على آخر دخول له عبره أكثر من
 * هذا العدد من الأيام، ويعود بأول دخول جديد. والإيقاف أو الإزالة أو إشعار الخروج
 * من المزوّد (back-channel logout) يحذف مفاتيحه فوراً. الحفظ صريح بزرّ لا عند مغادرة الحقل: قيمة خارج المدى تُرفض برسالة
 * مقروءة بدل أن تُقصّ صامتة إلى حدّ لم يقصده المالك.
 */
type ApiKeySsoWindowSectionProps = {
  /** Programmatic access switch; when off the setting stays editable but is noted as dormant. */
  externalApiEnabled: boolean;
};

export default function ApiKeySsoWindowSection({ externalApiEnabled }: ApiKeySsoWindowSectionProps) {
  const { t } = useTranslation('settings');
  const { windowDays, limits, loading, saving, error, savedAt, save, reload, clearStatus } =
    useApiKeySsoWindow();
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const messageId = `${inputId}-message`;

  useEffect(() => {
    if (windowDays !== null) setDraft(String(windowDays));
  }, [windowDays]);

  const parsed = parseWindowDays(draft, limits);
  const invalid = touched && parsed === null;
  const unchanged = parsed !== null && parsed === windowDays;
  const range = { min: limits.minDays, max: limits.maxDays };
  const unitCount = parsed ?? windowDays ?? limits.defaultDays;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (parsed === null) return;
    if (await save(parsed)) setTouched(false);
  };

  const errorText = invalid
    ? t('apiKeySsoWindow.errors.invalid', range)
    : error
      ? t(`apiKeySsoWindow.errors.${error}`, range)
      : null;

  return (
    <section className="space-y-3">
      <SettingsSection
        level="section"
        icon={TimerReset}
        title={t('apiKeySsoWindow.title')}
        description={t('apiKeySsoWindow.description')}
      >
        {null}
      </SettingsSection>

      {loading ? (
        <p className="flex items-center gap-2 text-[13px] leading-relaxed text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('apiKeySsoWindow.loading')}
        </p>
      ) : windowDays === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-danger">
            {t('apiKeySsoWindow.errors.load')}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => { void reload(); }}>
            {t('apiKeySsoWindow.retry')}
          </Button>
        </div>
      ) : (
        <>
          {!externalApiEnabled && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('apiKeySsoWindow.disabledNote')}
            </p>
          )}
          <form onSubmit={(event) => { void onSubmit(event); }} noValidate>
            <SettingsRow
              label={<label htmlFor={inputId}>{t('apiKeySsoWindow.label')}</label>}
              description={<span id={hintId}>{t('apiKeySsoWindow.hint', { ...range, default: limits.defaultDays })}</span>}
            >
              <div className="flex shrink-0 flex-col gap-1.5 sm:items-end">
                <div className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={limits.minDays}
                    max={limits.maxDays}
                    step={1}
                    required
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setTouched(true);
                      clearStatus();
                    }}
                    aria-invalid={invalid || error === 'invalid' ? true : undefined}
                    aria-describedby={errorText ? `${hintId} ${messageId}` : hintId}
                    disabled={saving}
                    className={cn(
                      'w-24 touch-manipulation rounded-md border bg-background px-3 py-2 text-sm text-foreground',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      invalid ? 'border-danger' : 'border-input',
                    )}
                  />
                  <span className="text-[13px] text-muted-foreground" aria-hidden="true">
                    {t('apiKeySsoWindow.unit', { count: unitCount })}
                  </span>
                  <Button type="submit" size="sm" disabled={saving || invalid || unchanged}>
                    {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" aria-hidden="true" />}
                    {t('apiKeySsoWindow.save')}
                  </Button>
                </div>
                {errorText ? (
                  <p id={messageId} role="alert" className="text-[13px] leading-relaxed text-danger">
                    {errorText}
                  </p>
                ) : savedAt !== null ? (
                  <p id={messageId} role="status" className="text-[13px] leading-relaxed text-muted-foreground">
                    {t('apiKeySsoWindow.saved')}
                  </p>
                ) : null}
              </div>
            </SettingsRow>
          </form>
        </>
      )}
    </section>
  );
}
