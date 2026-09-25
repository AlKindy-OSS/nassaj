import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '../../../../../auth/context/AuthContext';
import { useHarnessAutoUpdateSettings, type HarnessAutoUpdateDraft } from '../../../../../../hooks/useHarnessVersion';
import { Button, Input } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';
import SettingsSection from '../../../SettingsSection';

const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 10_080;

function safeDate(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function HarnessAutoUpdateSection({ viewerRole }: { viewerRole?: string } = {}) {
  const { t, i18n } = useTranslation('settings');
  const auth = useOptionalAuth();
  const isOwner = viewerRole ? viewerRole === 'owner' : auth?.user?.role === 'owner';
  const { settings, status, save, reload } = useHarnessAutoUpdateSettings(isOwner);
  const [draft, setDraft] = useState<HarnessAutoUpdateDraft | null>(null);
  const locale = i18n.resolvedLanguage === 'ar' ? 'ar-SA' : 'en-US';

  useEffect(() => {
    if (settings) setDraft({ enabled: settings.enabled, intervalMinutes: settings.intervalMinutes });
    else setDraft(null);
  }, [settings]);

  const intervalValid = Boolean(draft && Number.isSafeInteger(draft.intervalMinutes)
    && draft.intervalMinutes >= MIN_INTERVAL_MINUTES && draft.intervalMinutes <= MAX_INTERVAL_MINUTES);
  const unchanged = Boolean(settings && draft && settings.enabled === draft.enabled
    && settings.intervalMinutes === draft.intervalMinutes);
  const canSave = Boolean(draft && intervalValid && !unchanged && status !== 'saving');
  const intervalDisplay = useMemo(() => draft
    ? new Intl.NumberFormat(locale).format(draft.intervalMinutes)
    : '', [draft, locale]);

  if (!isOwner) return null;
  const fallbackDate = t('harnessAutoUpdate.notYet', { defaultValue: 'لا يوجد' });

  return <SettingsSection
    title={t('harnessAutoUpdate.title', { defaultValue: 'التحديث التلقائي العام' })}
    description={t('harnessAutoUpdate.description', { defaultValue: 'إعداد عام يطبّق على أدوات المزوّدين المدعومة.' })}
  >
    <SettingsCard>
      {status === 'loading' && !settings ? (
        <p role="status" className="text-sm text-foreground">{t('common.loading', { defaultValue: 'جارٍ التحميل…' })}</p>
      ) : settings && draft ? (
        <div className="space-y-4">
          <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-foreground">
            <span>{t('harnessAutoUpdate.enabled', { defaultValue: 'تشغيل التحديث التلقائي العام' })}</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={draft.enabled}
              disabled={status === 'saving'}
              onChange={event => setDraft(current => current ? { ...current, enabled: event.target.checked } : current)}
            />
          </label>
          <label className="block space-y-1.5 text-sm text-foreground">
            <span>{t('harnessAutoUpdate.interval', { defaultValue: 'الفاصل بالدقائق' })}</span>
            <Input
              type="number"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              step={1}
              inputMode="numeric"
              value={draft.intervalMinutes}
              disabled={status === 'saving'}
              aria-invalid={!intervalValid}
              onChange={event => setDraft(current => current ? { ...current, intervalMinutes: Number(event.target.value) } : current)}
            />
            <span className="text-[13px] text-foreground">
              {t('harnessAutoUpdate.currentInterval', { interval: intervalDisplay, defaultValue: `الفاصل الحالي: ${intervalDisplay} دقيقة` })}
            </span>
            {!intervalValid && <span role="alert" className="block text-[13px] text-danger">{t('harnessAutoUpdate.intervalError', { defaultValue: 'أدخل عدداً صحيحاً بين 30 و10080 دقيقة.' })}</span>}
          </label>
          <dl className="grid gap-2 text-[13px] text-foreground sm:grid-cols-2">
            <div><dt className="font-medium">{t('harnessAutoUpdate.lastRun', { defaultValue: 'آخر تشغيل' })}</dt><dd>{safeDate(settings.lastRunAt, locale, fallbackDate)}</dd></div>
            <div><dt className="font-medium">{t('harnessAutoUpdate.nextRun', { defaultValue: 'التشغيل التالي' })}</dt><dd>{safeDate(settings.nextRunAt, locale, fallbackDate)}</dd></div>
          </dl>
          {status === 'error' && <p role="alert" className="text-sm text-danger">{t('harnessAutoUpdate.saveError', { defaultValue: 'تعذّر حفظ الإعداد. بقيت تعديلاتك ويمكنك إعادة الحفظ.' })}</p>}
          <Button type="button" size="sm" disabled={!canSave} onClick={() => { if (draft) void save(draft); }}>
            {status === 'saving' ? t('harnessAutoUpdate.saving', { defaultValue: 'جارٍ الحفظ…' }) : t('harnessAutoUpdate.save', { defaultValue: 'حفظ الإعداد العام' })}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-danger">{t('harnessAutoUpdate.error', { defaultValue: 'تعذّر تحميل إعداد التحديث العام.' })}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}><RefreshCw className="me-2 h-4 w-4" aria-hidden />{t('harnessVersion.recheck', { defaultValue: 'إعادة المحاولة' })}</Button>
        </div>
      )}
    </SettingsCard>
  </SettingsSection>;
}
