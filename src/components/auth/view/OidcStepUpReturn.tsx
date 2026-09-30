import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  CONNECTOR_SETTINGS_PATH,
  recordConnectorStepUpOutcome,
  submitConnectorStepUp,
  type ConnectorStepUpOutcomeInput,
  type StepUpReturn,
} from '../../settings/view/tabs/connectorStepUpClient';

import AuthScreenLayout from './AuthScreenLayout';

/**
 * Connector step-up return (T-1939 slice 6C). The grant is scrubbed from the
 * address bar first, redeemed exactly once (StrictMode re-runs effects) and
 * never stored. The outcome code is left for the
 * connectors tab, which reopens where the member started.
 */
export default function OidcStepUpReturn({ result, scrubUrl }: { result: StepUpReturn; scrubUrl: () => void }) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    scrubUrl();
    const finish = (outcome: ConnectorStepUpOutcomeInput) => {
      recordConnectorStepUpOutcome(outcome);
      navigate(CONNECTOR_SETTINGS_PATH, { replace: true });
    };
    // A URL can only ever report a refusal; "verified" needs a 204 below.
    if ('errorCode' in result) { finish({ verified: false, code: result.errorCode }); return; }
    void submitConnectorStepUp({ method: 'oidc_grant', grant: result.grant })
      // A refused grant (expired, other browser) is not a wrong password.
      .then(outcome => finish(outcome.ok ? { verified: true } : {
        verified: false, code: outcome.code === 'step_up_failed' ? 'sso_grant_failed' : outcome.code,
      }));
  }, [navigate, result, scrubUrl]);

  return (
    <AuthScreenLayout
      title={t('connectorsSettings.stepUp.returnTitle')}
      description={t('connectorsSettings.stepUp.description')}
      footerText=""
    >
      <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t('connectorsSettings.stepUp.returning')}
      </p>
    </AuthScreenLayout>
  );
}
