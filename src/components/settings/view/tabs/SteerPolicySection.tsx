/**
 * SteerPolicySection — T-1903 (ADR-190): بوابة المالك/الإدارة على ميزة
 * التوجيه أثناء الدور، على مستوى الخادم كله: `off` تعطيلها للجميع، أو
 * `per_user` تركها لموافقة كل عضو على جلساته (SteerConsentSection الشخصية).
 */

import { useEffect, useState } from 'react';
import { Loader2, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSteerPolicy, putSteerPolicy } from '../../../session-steer/sessionSteerApi';
import type { SteerPolicyMode } from '../../../../../shared/session-steer.contract';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

/**
 * T-1904 e2e (bug 7) — نفس صنف المنسدلات في تبويب التخزين
 * (`StoragePolicySection`) و«المظهر»: سطحُ تحكّمٍ واحد لا ثلاثة أشكال.
 * كان هذا المنسدل بلا `w-full`، فيضيق العرض المُحسوب تلقائياً على نصّ عربيّ
 * طويل («حسب المستخدم (كلّ عضو يوافق بنفسه)») حتى يكاد يلاصق سهم الاختيار.
 */
const SELECT_CLASS =
  'w-full touch-manipulation rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

export default function SteerPolicySection() {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<SteerPolicyMode>('off');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const policy = await getSteerPolicy();
      if (!cancelled && policy) setMode(policy.mode);
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (next: SteerPolicyMode) => {
    const previous = mode;
    setMode(next);
    setIsSaving(true);
    const result = await putSteerPolicy({ mode: next });
    setIsSaving(false);
    if (!result) setMode(previous);
  };

  return (
    <SettingsSection
      boxed
      icon={Radio}
      title={t('systemSettings.steer.title', { defaultValue: 'Mid-turn steering' })}
      description={t('systemSettings.steer.description', {
        defaultValue: 'Server-wide switch for letting session members inject text into a running turn.',
      })}
    >
      <SettingsGroup>
        <SettingsRow label={t('systemSettings.steer.modeLabel', { defaultValue: 'Mode' })}>
          <div className="flex items-center gap-2">
            {(isLoading || isSaving) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
            <select
              value={mode}
              disabled={isLoading || isSaving}
              onChange={(event) => void handleChange(event.target.value as SteerPolicyMode)}
              className={`${SELECT_CLASS} sm:w-72`}
            >
              <option value="off">{t('systemSettings.steer.modeOff', { defaultValue: 'Off (disabled for everyone)' })}</option>
              <option value="per_user">{t('systemSettings.steer.modePerUser', { defaultValue: 'Per user (each member opts in)' })}</option>
            </select>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
