/**
 * Result cards (brief §7.1 connection check, §7.2 test sign-in). Values are
 * rendered as text only, never as links or HTML.
 */
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Check } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsCollapsible from '../../SettingsCollapsible';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';

import { wouldSignIn } from './ssoModel';
import { Tech } from './SsoParts';
import { useRelativeTime, useSsoMessage } from './ssoUi';
import type { SsoDiscoveryResult, SsoRoleRule, SsoTestResult } from './ssoTypes';

function Line({ tone, children }: { tone: 'ok' | 'warn' | 'fail'; children: React.ReactNode }) {
  const Icon = tone === 'ok' ? Check : tone === 'warn' ? AlertTriangle : AlertCircle;
  const color = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-danger';
  return (
    <li className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Brief §7.1. `onOfferPrivate` is shown only when the server says the private-network opt-in would help. */
export function SsoDiscoveryCard({ result, onOfferPrivate }: {
  result: SsoDiscoveryResult; onOfferPrivate?: () => void;
}) {
  const { t } = useTranslation('settings');
  const message = useSsoMessage();
  const relative = useRelativeTime();
  const pkceWarning = result.warnings.includes('discovery_pkce_methods_unadvertised');
  const tone = !result.passed ? 'danger' : pkceWarning ? 'warning' : 'success';
  const failure = result.failure ? message(result.failure) : null;

  return (
    <SettingsCard tone={tone}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-base font-semibold text-foreground">
          {result.passed ? t('sso.discovery.passed') : t('sso.discovery.failed')}
        </p>
        {result.checkedAt && <span className="text-[13px] text-muted-foreground">{t('sso.discovery.checked', { when: relative(result.checkedAt) })}</span>}
      </div>
      <ul className="mt-2 space-y-1.5">
        {result.passed ? (
          <>
            <Line tone="ok">{t('sso.discovery.issuerOk')}</Line>
            <Line tone="ok">{t('sso.discovery.httpsOk')}</Line>
            <Line tone="ok">{t('sso.discovery.codeFlowOk')}</Line>
            <Line tone="ok">{t('sso.discovery.keysOk', { count: result.jwksKeyCount })}</Line>
            {pkceWarning && <Line tone="warn">{t('sso.diag.discovery_pkce_methods_unadvertised')}</Line>}
            {result.flags?.backchannel_logout_supported
              ? <Line tone="ok">{t('sso.discovery.backchannelOk')}</Line>
              : <Line tone="warn">{t('sso.discovery.backchannelMissing')}</Line>}
          </>
        ) : failure && result.failure && (
          <Line tone="fail">
            <span className="text-danger">{failure.text}</span>
            {!failure.known && <> <Tech>{result.failure}</Tech></>}
            {result.addressCategory && (
              <span className="mt-1 block text-muted-foreground">
                {t('sso.discovery.category')} <Tech>{result.addressCategory}</Tech>
              </span>
            )}
            {result.oauthError && (
              <span className="mt-1 block">{t('sso.result.oauthErrorLabel')} <Tech>{result.oauthError}</Tech></span>
            )}
          </Line>
        )}
      </ul>
      {!result.passed && result.privateNetworkMayHelp && onOfferPrivate && (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onOfferPrivate}>
          {t('sso.step2.private')}
        </Button>
      )}
      {result.passed && result.endpoints && (
        <SettingsCollapsible summary={t('sso.step2.pinned')} className="mt-2">
          <ul className="space-y-1">
            {(['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const).map((key) => result.endpoints?.[key] && (
              <li key={key}><span className="text-muted-foreground">{t(`sso.discovery.endpoint.${key}`)}</span>{' '}<Tech>{result.endpoints[key]}</Tech></li>
            ))}
          </ul>
        </SettingsCollapsible>
      )}
    </SettingsCard>
  );
}

function valueText(value: SsoTestResult['roleClaimValue']): string | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return JSON.stringify(value);
}

/** Brief §7.2. The heading takes focus on return from the identity provider. */
export const SsoTestResultCard = forwardRef<HTMLHeadingElement, {
  result: SsoTestResult; rules: SsoRoleRule[]; onTestAgain?: () => void; busy?: boolean;
}>(function SsoTestResultCard({ result, rules, onTestAgain, busy }, headingRef) {
  const { t } = useTranslation('settings');
  const message = useSsoMessage();
  const passed = wouldSignIn(result);
  const roleLabel = result.mappedRole === 'admin' ? t('sso.step3.roleAdmin') : t('sso.step3.roleMember');
  const roleNames = Array.isArray(result.roleClaimValue) ? result.roleClaimValue : [];
  const matched = rules.find((rule) => rule.role === result.mappedRole && roleNames.includes(rule.value));
  const roleValue = valueText(result.roleClaimValue);
  const tenantValue = valueText(result.tenantClaimValue);
  const tooLarge = (value: unknown) => Boolean(value && !Array.isArray(value) && typeof value === 'object');

  return (
    <SettingsCard tone={passed ? 'success' : 'danger'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-foreground outline-none">
            {passed ? t('sso.result.passed') : t('sso.result.failed')}
          </h4>
          <p className="mt-1 text-sm font-medium text-foreground">
            {passed ? t('sso.result.wouldSignInAs', { role: roleLabel }) : t('sso.result.wouldNotSignIn')}
          </p>
        </div>
        {onTestAgain && (
          <Button type="button" variant="outline" size="sm"  disabled={busy} onClick={onTestAgain}>
            {t('sso.step6.again')}
          </Button>
        )}
      </div>
      {result.diagnostics.length > 0 && (
        <ul className="mt-2 space-y-1">
          {result.diagnostics.map((code) => {
            const m = message(code);
            return <Line key={code} tone="fail">{m.text}{!m.known && <> <Tech>{code}</Tech></>}</Line>;
          })}
        </ul>
      )}
      {result.oauthError && (
        <p className="mt-2 text-[13px] text-foreground">{t('sso.result.oauthErrorLabel')} <Tech>{result.oauthError}</Tech></p>
      )}
      <SettingsGroup className="mt-3">
        {(roleValue || tooLarge(result.roleClaimValue)) && (
          <SettingsRow label={t('sso.result.roleValue')}>
            {roleValue ? <Tech>{roleValue}</Tech> : <span className="text-[13px]">{t('sso.diag.claim_too_large')}</span>}
          </SettingsRow>
        )}
        {matched && (
          <SettingsRow label={t('sso.result.rule')}>
            <span className="text-[13px]"><Tech>{matched.value}</Tech> {t('sso.result.arrow')} {roleLabel}</span>
          </SettingsRow>
        )}
        {(tenantValue || result.tenantOk) && (
          <SettingsRow label={t('sso.result.tenant')}>
            <span className="text-[13px]">
              {result.tenantOk ? t('sso.result.tenantPassed') : t('sso.result.tenantFailed')}
              {tenantValue && <> <Tech>{tenantValue}</Tech></>}
            </span>
          </SettingsRow>
        )}
        <SettingsRow label={t('sso.result.authTime')}>
          <span className="text-[13px]">{result.authTimePresent ? t('sso.result.yes') : t('sso.result.no')}</span>
        </SettingsRow>
      </SettingsGroup>
      {!result.authTimeFresh && passed && (
        <p className="mt-2 flex items-start gap-2 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          {t('sso.diag.auth_time')}
        </p>
      )}
      {result.claimNames.length > 0 && (
        <SettingsCollapsible summary={t('sso.result.claims')} className="mt-2">
          <Tech>{result.claimNames.join(', ')}</Tech>
        </SettingsCollapsible>
      )}
    </SettingsCard>
  );
});
