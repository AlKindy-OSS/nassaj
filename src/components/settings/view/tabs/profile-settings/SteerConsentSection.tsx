import { useEffect, useState } from 'react';
import { Compass, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSteerConsent, getSteerPolicy, putSteerConsent } from '../../../../session-steer/sessionSteerApi';
import SettingsCard from '../../SettingsCard';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

/**
 * T-1903/1904 e2e (bug 4) — تفضيل شخصي: هل يُسمح لأعضاء الجلسة الآخرين
 * بتوجيه (steer) أدواري الجارية؟ افتراضيّاً معطَّل (سلامة قبل الراحة). يُقرأ
 * ويُكتب عبر `/api/session-steer/consent` (ذاتي، لا يحتاج صلاحية owner/admin).
 *
 * حين يكون وضع الخادم العام `off` (SystemSettingsTab → SteerPolicySection)
 * يبقى هذا المفتاح **معطَّلاً** بملاحظة صريحة بدل أن يظهر "مفعَّلاً" بلا أثر —
 * كان المستخدم يبدّله ويرى «تم الحفظ» رغم أن الميزة كلّها مغلقة من المالك.
 */
export default function SteerConsentSection() {
  const { t } = useTranslation('settings');
  const [allowSteer, setAllowSteer] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [globallyDisabled, setGloballyDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [consent, policy] = await Promise.all([getSteerConsent(), getSteerPolicy()]);
      if (!cancelled) {
        if (consent) setAllowSteer(consent.allowSteerOnMyRuns);
        setGloballyDisabled(policy?.mode === 'off');
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (value: boolean) => {
    setAllowSteer(value);
    setIsSaving(true);
    const result = await putSteerConsent({ allowSteerOnMyRuns: value });
    setIsSaving(false);
    if (!result) {
      // فشل الحفظ: نعيد القيمة السابقة بدل ترك الواجهة تدّعي حفظاً لم يحدث.
      setAllowSteer(!value);
    }
  };

  return (
    <SettingsSection boxed icon={Compass} title={t('steer.consent.title', { defaultValue: 'Mid-turn steering' })}>
      {globallyDisabled && (
        <SettingsCard tone="warning">
          <p className="text-[13px] leading-relaxed text-warning">
            {t('steer.consent.globallyDisabledNote', {
              defaultValue: 'The owner/admin turned this feature off for everyone.',
            })}
          </p>
        </SettingsCard>
      )}
      <SettingsGroup>
        <SettingsRow
          label={t('steer.consent.toggleLabel', {
            defaultValue: 'Allow others to steer my running sessions',
          })}
          description={t('steer.consent.toggleDescription', {
            defaultValue: 'Another member can inject a short message into a turn you started.',
          })}
        >
          <div className="flex items-center gap-2">
            {isSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
            <SettingsToggle
              checked={allowSteer && !globallyDisabled}
              onChange={(value) => void handleChange(value)}
              ariaLabel={t('steer.consent.toggleLabel', { defaultValue: 'Allow others to steer my running sessions' })}
              disabled={isLoading || isSaving || globallyDisabled}
            />
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
