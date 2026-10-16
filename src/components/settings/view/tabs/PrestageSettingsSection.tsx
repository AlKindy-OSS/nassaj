/**
 * PrestageSettingsSection — T-2030 (ADR-207 decision 4): the owner chooses
 * whether this node prepares a new Nassaj release in the background before the
 * update button is pressed, and how long it waits after first seeing a release.
 *
 * Server environment wins over the stored value: `lockedByEnv` disables the
 * whole section, and `overriddenByEnv` disables only the field it names. A
 * disabled field shows the value actually in force (`effective`), while the
 * draft keeps the stored value so a save never copies an env value into storage.
 */
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '../../../auth/context/AuthContext';
import { Button, Input } from '../../../../shared/view/ui';
import {
  isValidQuarantineHours, usePrestageSettings, type PrestageErrorCode,
} from '../../hooks/usePrestageSettings';
import SettingsCard from '../SettingsCard';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

const HOURS_PATTERN = /^\d{1,3}$/;

const ERROR_KEYS: Record<PrestageErrorCode, string> = {
  prestage_settings_invalid: 'prestageSettings.errors.settingsInvalid',
  prestage_enabled_invalid: 'prestageSettings.errors.enabledInvalid',
  prestage_quarantine_hours_invalid: 'prestageSettings.errors.hoursInvalid',
  rate_limited: 'prestageSettings.errors.rateLimited',
  forbidden: 'prestageSettings.errors.forbidden',
  save_failed: 'prestageSettings.errors.saveFailed',
};

export default function PrestageSettingsSection({ viewerRole }: { viewerRole?: string } = {}) {
  const { t } = useTranslation('settings');
  const auth = useOptionalAuth();
  const isOwner = viewerRole ? viewerRole === 'owner' : auth?.user?.role === 'owner';
  const { view, status, saveError, savedAt, save, reload } = usePrestageSettings(isOwner);
  const [enabled, setEnabled] = useState(true);
  const [hoursText, setHoursText] = useState('0');
  const hoursErrorId = useId();
  const hoursHintId = useId();
  const hoursInputId = useId();

  useEffect(() => {
    if (!view) return;
    setEnabled(view.settings.prestageEnabled);
    setHoursText(String(view.settings.prestageQuarantineHours));
  }, [view]);

  if (!isOwner) return null;

  const limits = view?.limits;
  const hours = HOURS_PATTERN.test(hoursText.trim()) ? Number(hoursText.trim()) : Number.NaN;
  const hoursValid = isValidQuarantineHours(hours, limits);
  const saving = status === 'saving';
  const locked = Boolean(view?.lockedByEnv);
  const enabledOverridden = locked || Boolean(view?.overriddenByEnv.prestageEnabled);
  const hoursOverridden = locked || Boolean(view?.overriddenByEnv.prestageQuarantineHours);
  const unchanged = Boolean(view && enabled === view.settings.prestageEnabled
    && hours === view.settings.prestageQuarantineHours);
  const canSave = Boolean(view) && !locked && hoursValid && !unchanged && !saving;
  const range = { min: limits?.minQuarantineHours ?? 0, max: limits?.maxQuarantineHours ?? 168 };
  const envNote = (
    <span className="mt-1 block text-[13px] text-warning">{t('prestageSettings.overriddenByEnv')}</span>
  );

  return (
    <SettingsSection
      icon={Download}
      title={t('prestageSettings.title')}
      description={t('prestageSettings.description')}
    >
      <SettingsCard>
        {status === 'loading' && !view ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('prestageSettings.loading')}
          </p>
        ) : view ? (
          <div className="space-y-4">
            {locked && (
              <SettingsCard tone="warning">
                <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('prestageSettings.lockedByEnv')}
                </p>
              </SettingsCard>
            )}
            <SettingsGroup>
              <SettingsRow
                label={t('prestageSettings.enabledLabel')}
                description={<>
                  {t('prestageSettings.enabledHelp')}
                  {!locked && view.overriddenByEnv.prestageEnabled && envNote}
                </>}
              >
                <SettingsToggle
                  checked={enabledOverridden ? view.effective.prestageEnabled : enabled}
                  onChange={setEnabled}
                  ariaLabel={t('prestageSettings.enabledLabel')}
                  disabled={enabledOverridden || saving}
                />
              </SettingsRow>
              <SettingsRow
                stacked
                label={<label htmlFor={hoursInputId}>{t('prestageSettings.hoursLabel')}</label>}
                description={<>
                  <span id={hoursHintId}>{t('prestageSettings.hoursHint')}</span>
                  {!locked && view.overriddenByEnv.prestageQuarantineHours && envNote}
                </>}
              >
                <Input
                  id={hoursInputId}
                  type="number"
                  min={range.min}
                  max={range.max}
                  step={1}
                  inputMode="numeric"
                  dir="ltr"
                  className="max-w-[10rem] text-start"
                  value={hoursOverridden ? String(view.effective.prestageQuarantineHours) : hoursText}
                  disabled={hoursOverridden || saving}
                  aria-invalid={!hoursOverridden && !hoursValid}
                  aria-describedby={!hoursOverridden && !hoursValid ? `${hoursHintId} ${hoursErrorId}` : hoursHintId}
                  onChange={event => setHoursText(event.target.value)}
                />
                {!hoursOverridden && !hoursValid && (
                  <span id={hoursErrorId} role="alert" className="mt-1.5 block text-[13px] text-danger">
                    {t('prestageSettings.hoursError', range)}
                  </span>
                )}
              </SettingsRow>
            </SettingsGroup>
            {saveError && (
              <p role="alert" className="text-sm text-danger">{t(ERROR_KEYS[saveError], range)}</p>
            )}
            {!saveError && savedAt > 0 && unchanged && (
              <p role="status" className="text-sm text-success">{t('prestageSettings.saved')}</p>
            )}
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => { void save({ prestageEnabled: enabled, prestageQuarantineHours: hours }); }}
            >
              {saving ? t('prestageSettings.saving') : t('prestageSettings.save')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-sm text-danger">{t('prestageSettings.loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
              <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" />
              {t('prestageSettings.retry')}
            </Button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
