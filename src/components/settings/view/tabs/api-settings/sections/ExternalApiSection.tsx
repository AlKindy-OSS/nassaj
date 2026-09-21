import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '../../../SettingsCard';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import SettingsToggle from '../../../SettingsToggle';

type ExternalApiSectionProps = {
  enabled: boolean;
  canManage: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: boolean) => void;
};

/**
 * The master switch for programmatic access (ADR-102 / T-1242).
 *
 * It sits ABOVE the key list and not inside it because it governs a different
 * thing: keys are per-user credentials, this is an app-wide door. Creating a
 * key while the door is shut would look like it works and then 404 on first
 * use — so the tab shows this first, and the key list only once it is open.
 *
 * The warning card is `danger`, not `warning`, and is shown only in the ON
 * state: what it describes is not a risk of the setting, it is what the
 * setting currently permits — an agent running with permissions bypassed,
 * authenticated by a key that never expires.
 */
export default function ExternalApiSection({
  enabled,
  canManage,
  saving,
  error,
  onChange,
}: ExternalApiSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <section className="space-y-3">
      <SettingsSection
        level="page"
        icon={ShieldCheck}
        title={t('externalApi.title')}
        description={t('externalApi.description')}
      >
        {null}
      </SettingsSection>

      <SettingsRow
        label={t('externalApi.toggleLabel')}
        description={
          enabled ? t('externalApi.stateOn') : t('externalApi.stateOff')
        }
      >
        <div className="flex min-h-10 shrink-0 items-center gap-2">
          {saving && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
          <SettingsToggle
            checked={enabled}
            onChange={onChange}
            disabled={!canManage || saving}
            ariaLabel={t('externalApi.toggleLabel')}
          />
        </div>
      </SettingsRow>

      {/* A member seeing a dead switch deserves the reason, not a grey box. */}
      {!canManage && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('externalApi.ownerOnly')}
        </p>
      )}

      {enabled && (
        <SettingsCard tone="danger">
          <div
            role="alert"
            className="flex items-start gap-2 text-[13px] leading-relaxed text-danger"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">{t('externalApi.warning.title')}</p>
              <p className="mt-0.5">{t('externalApi.warning.description')}</p>
            </div>
          </div>
        </SettingsCard>
      )}

      {error && (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
