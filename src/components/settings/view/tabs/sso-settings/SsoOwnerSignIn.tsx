/**
 * ADR-194 A1: the owner's own "sign in with SSO using a passkey" switch, in
 * the SSO tab outside the wizard. Turning it on asks for local step-up
 * (password or passkey here); turning it off does not. Disabled with a hint
 * while the caller has no link to the active identity provider.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

import { SsoError } from './SsoParts';
import { HINT_CLASS } from './ssoUi';
import type { SsoActionFailure, SsoActionResult, SsoOwnerSignIn as OwnerSignIn, StepUpEvidence } from './ssoTypes';

type Props = {
  ownerSignIn: OwnerSignIn;
  setOwnerSignIn: (enabled: boolean, stepUp?: StepUpEvidence) => Promise<SsoActionResult>;
  requestStepUp: (run: (stepUp: StepUpEvidence) => Promise<SsoActionResult>, intro?: ReactNode) => Promise<SsoActionResult | null>;
};

export default function SsoOwnerSignIn({ ownerSignIn, setOwnerSignIn, requestStepUp }: Props) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SsoActionFailure | null>(null);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setFailure(null);
    const result = enabled
      ? await requestStepUp((stepUp) => setOwnerSignIn(true, stepUp), t('sso.ownerSignIn.stepUpIntro'))
      : await setOwnerSignIn(false);
    if (result && !result.ok) setFailure(result);
    setBusy(false);
  };

  return (
    <SettingsSection level="section" title={t('sso.ownerSignIn.title')}>
      <SettingsGroup>
        <SettingsRow label={t('sso.ownerSignIn.label')} description={t('sso.ownerSignIn.description')}>
          <SettingsToggle
            checked={ownerSignIn.enabled}
            ariaLabel={t('sso.ownerSignIn.label')}
            disabled={busy || !ownerSignIn.linked}
            onChange={(value) => { void change(value); }}
          />
        </SettingsRow>
      </SettingsGroup>
      {!ownerSignIn.linked && <p className={`${HINT_CLASS} pt-2`}>{t('sso.ownerSignIn.notLinked')}</p>}
      {failure && (
        <div className="pt-2">
          <SsoError code={failure.code} details={failure.details} retryAfterSeconds={failure.retryAfterSeconds} />
        </div>
      )}
    </SettingsSection>
  );
}
