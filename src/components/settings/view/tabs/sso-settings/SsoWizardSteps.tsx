/**
 * Bodies of the SSO wizard steps 0–7 (brief §5). Each step is presentational;
 * saving, checks, step-up and navigation come in through `StepProps.actions`.
 */
import { useId, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, CheckCircle2, Loader2, X } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import SegmentedControl from '../../SegmentedControl';
import SettingsCard from '../../SettingsCard';
import SettingsCollapsible from '../../SettingsCollapsible';
import SettingsRow from '../../SettingsRow';
import SettingsToggle from '../../SettingsToggle';
import type { SsoTestReturn } from '../../../hooks/useSsoSettings';

import RoleRulesTable from './RoleRulesTable';
import {
  claimPathUserEditable,
  discoveryCurrent,
  extraScopesValid,
  invalidEmailLines,
  isEmailTenantPath,
  proofsReady,
  roleCollisionRisk,
  roleShapeOf,
  type StepId,
} from './ssoModel';
import { BusyLine, CopyField, SsoError, Tech } from './SsoParts';
import { HINT_CLASS, INPUT_CLASS, LABEL_CLASS, TECH_INPUT_CLASS, useRelativeTime, useSlowFlag } from './ssoUi';
import { SsoDiscoveryCard, SsoTestResultCard } from './SsoResultCards';
import type {
  SsoActionFailure,
  SsoClientAuth,
  SsoDiscoveryResult,
  SsoDraftForm,
  SsoStatus,
  SsoTenantMode,
  SsoTestResult,
} from './ssoTypes';

export type WizardAction = 'origin' | 'save2' | 'save3' | 'save4' | 'save5' | 'check' | 'test' | 'apply';

export type StepProps = {
  status: SsoStatus;
  form: SsoDraftForm;
  setForm: (patch: Partial<SsoDraftForm>) => void;
  busy: WizardAction | null;
  failure: { action: WizardAction; result: SsoActionFailure } | null;
  savedNotice: WizardAction | null;
  discovery: SsoDiscoveryResult | null;
  lastTestResult: SsoTestResult | null;
  testReturn: SsoTestReturn | null;
  resultHeadingRef: RefObject<HTMLHeadingElement>;
  ackedOurValues: boolean;
  setAckedOurValues: (value: boolean) => void;
  actions: {
    confirmOrigin: (origin: string) => void;
    save: (action: WizardAction, options?: { thenCheck?: boolean }) => void;
    check: () => void;
    togglePrivate: (on: boolean) => void;
    startTest: () => void;
    openApply: () => void;
    openStep: (id: StepId) => void;
    openConnectors: () => void;
  };
};

function ErrorFor({ props, action }: { props: StepProps; action: WizardAction }) {
  const f = props.failure;
  if (!f || f.action !== action) return null;
  return <SsoError code={f.result.code} details={f.result.details} retryAfterSeconds={f.result.retryAfterSeconds} />;
}

function SaveRow({ props, action, label, disabled, children }: {
  props: StepProps; action: WizardAction; label?: string; disabled?: boolean; children?: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const busy = props.busy === action;
  const slow = useSlowFlag(busy && action === 'save2');
  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button"  disabled={props.busy !== null || disabled}
          onClick={() => props.actions.save(action, action === 'save2' ? { thenCheck: true } : undefined)}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {label ?? t('sso.action.save')}
        </Button>
        {children}
      </div>
      {slow && <BusyLine>{t('sso.contacting')}</BusyLine>}
      <ErrorFor props={props} action={action} />
      {props.savedNotice === action && <p role="status" className={HINT_CLASS}>{t('sso.draft.savedRetest')}</p>}
    </div>
  );
}

function TextField({ label, value, onChange, hint, error, technical = true, type = 'text', inputMode, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; hint?: ReactNode; error?: ReactNode;
  technical?: boolean; type?: string; inputMode?: 'numeric'; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
      <input id={id} type={type} value={value} inputMode={inputMode} placeholder={placeholder}
        dir={technical ? 'ltr' : undefined} style={technical ? { unicodeBidi: 'isolate' } : undefined}
        autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false}
        className={technical ? TECH_INPUT_CLASS : INPUT_CLASS} onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined} />
      {hint && <p id={`${id}-hint`} className={HINT_CLASS}>{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
    </div>
  );
}

/** Step 0: the confirmed installation address (ADR-193 origin). */
export function StepOrigin(props: StepProps) {
  const { t } = useTranslation('settings');
  const [origin, setOrigin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));
  const { ourValues } = props.status;
  if (ourValues.originConfirmed && ourValues.origin) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
        {t('sso.step0.confirmed')} <Tech>{ourValues.origin}</Tech>
      </p>
    );
  }
  const managedByConnectors = props.failure?.result.code === 'installation_origin_managed_by_connectors';
  return (
    <SettingsCard tone="warning">
      <div className="space-y-3">
        <p className="text-sm text-foreground">{t('sso.step0.missing')}</p>
        <TextField label={t('sso.step0.field')} value={origin} onChange={setOrigin} hint={t('sso.step0.fieldHint')} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button"  disabled={props.busy !== null || !origin.trim()}
            onClick={() => props.actions.confirmOrigin(origin.trim())}>
            {props.busy === 'origin' && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('sso.step0.action')}
          </Button>
          <Button type="button" variant="link" className="h-auto px-0" onClick={props.actions.openConnectors}>
            {t('sso.step0.connectors')}
          </Button>
        </div>
        {!managedByConnectors && <ErrorFor props={props} action="origin" />}
        {managedByConnectors && <p role="alert" className="text-[13px] text-foreground">{t('sso.diag.installation_origin_managed_by_connectors')}</p>}
      </div>
    </SettingsCard>
  );
}

/** Step 1: values the owner pastes into the identity provider. */
export function StepOurValues(props: StepProps) {
  const { t } = useTranslation('settings');
  const { ourValues } = props.status;
  const checkId = useId();
  const requirement = (text: ReactNode) => (
    <li className="flex items-start gap-2 text-[13px] text-foreground">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </li>
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground">{t('sso.step1.lead')}</p>
      {ourValues.redirectUri && (
        <CopyField label={t('sso.step1.redirect')} value={ourValues.redirectUri} where={t('sso.step1.redirectWhere')} />
      )}
      {ourValues.backchannelLogoutUri && (
        <CopyField label={t('sso.step1.backchannel')} value={ourValues.backchannelLogoutUri} where={t('sso.step1.backchannelWhere')} />
      )}
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">{t('sso.step1.choose')}</p>
        <ul className="space-y-1.5">
          {requirement(t('sso.step1.req.code'))}
          {requirement(<>{t('sso.step1.req.pkce')} <Tech>S256</Tech></>)}
          {requirement(t('sso.step1.req.signed'))}
          {requirement(t('sso.step1.req.roles'))}
          {requirement(<>{t('sso.step1.req.scopes')} <Tech>{ourValues.scopes}</Tech></>)}
        </ul>
      </div>
      <label htmlFor={checkId} className="flex min-h-11 items-center gap-2 text-sm text-foreground">
        <input id={checkId} type="checkbox" className="h-4 w-4" checked={props.ackedOurValues}
          onChange={(event) => props.setAckedOurValues(event.target.checked)} />
        {t('sso.step1.done')}
      </label>
    </div>
  );
}

/** Step 2: issuer, client, secret, private network, extra scopes; save then check. */
export function StepProvider(props: StepProps) {
  const { t } = useTranslation('settings');
  const { form, setForm, status } = props;
  const saved = status.draft;
  const [replacing, setReplacing] = useState(false);
  const bindingChanged = Boolean(saved?.hasClientSecret && (saved.issuer !== form.issuer.trim() || saved.clientId !== form.clientId.trim()));
  const secretKept = Boolean(saved?.hasClientSecret) && !form.clearClientSecret && !bindingChanged && !replacing;
  const scopesError = extraScopesValid(form.extraScopes) ? undefined : t('sso.step2.extraScopesInvalid');
  const portError = form.issuerPort.trim() && !/^\d{1,5}$/.test(form.issuerPort.trim()) ? t('sso.step2.portInvalid') : undefined;
  const confidential = form.clientAuth !== 'none';
  const typeOptions = [
    { value: 'public', label: t('sso.step2.public') },
    { value: 'confidential', label: t('sso.step2.confidential') },
  ] as const;
  const methodOptions: Array<{ value: SsoClientAuth; label: string }> = [
    { value: 'client_secret_basic', label: t('sso.step2.methodBasic') },
    { value: 'client_secret_post', label: t('sso.step2.methodPost') },
  ];
  // A passed card is shown only while its proof still matches the saved draft.
  const result = props.discovery && (!props.discovery.passed || discoveryCurrent(status)) ? props.discovery : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground">{t('sso.step2.lead')}</p>
      <TextField label={t('sso.step2.issuer')} value={form.issuer} onChange={(issuer) => setForm({ issuer })}
        hint={t('sso.step2.issuerHint')} placeholder="https://" />
      <TextField label={t('sso.step2.clientId')} value={form.clientId} onChange={(clientId) => setForm({ clientId })} />
      <div className="space-y-1.5">
        <p className={LABEL_CLASS}>{t('sso.step2.type')}</p>
        <SegmentedControl label={t('sso.step2.type')} options={typeOptions}
          value={confidential ? 'confidential' : 'public'}
          onChange={(value) => setForm({ clientAuth: value === 'public' ? 'none' : 'client_secret_basic' })} />
        <p className={HINT_CLASS}>{t('sso.step2.typeHint')}</p>
      </div>
      {confidential && (
        <div className="space-y-4 border-s-2 border-border ps-4">
          {secretKept ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <span>{t('sso.step2.secretSaved')}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>{t('sso.step2.secretReplace')}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ clearClientSecret: true, clientSecret: '' })}>{t('sso.step2.secretRemove')}</Button>
            </div>
          ) : (
            <TextField label={t('sso.step2.secret')} type="password" value={form.clientSecret}
              onChange={(clientSecret) => setForm({ clientSecret, clearClientSecret: false })}
              hint={bindingChanged ? t('sso.step2.secretStale') : undefined} />
          )}
          <div className="space-y-1.5">
            <p className={LABEL_CLASS}>{t('sso.step2.method')}</p>
            <SegmentedControl label={t('sso.step2.method')} options={methodOptions} value={form.clientAuth}
              onChange={(clientAuth) => setForm({ clientAuth })} />
          </div>
        </div>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
        <input type="checkbox" className="h-4 w-4" checked={form.allowPrivateNetwork}
          onChange={(event) => props.actions.togglePrivate(event.target.checked)} />
        {t('sso.step2.private')}
      </label>
      {form.allowPrivateNetwork && (
        <TextField label={t('sso.step2.port')} value={form.issuerPort} inputMode="numeric"
          onChange={(issuerPort) => setForm({ issuerPort })} hint={t('sso.step2.portHint')} error={portError} />
      )}
      <SettingsCollapsible summary={t('sso.step2.advanced')} defaultOpen={Boolean(form.extraScopes)}>
        <TextField label={t('sso.step2.extraScopes')} value={form.extraScopes}
          onChange={(extraScopes) => setForm({ extraScopes })} hint={t('sso.step2.extraScopesHint')} error={scopesError} />
      </SettingsCollapsible>
      <SaveRow props={props} action="save2" label={t('sso.step2.check')}
        disabled={!form.issuer.trim() || !form.clientId.trim() || Boolean(scopesError) || Boolean(portError)} />
      {props.busy === 'check' && <BusyLine>{t('sso.contacting')}</BusyLine>}
      <ErrorFor props={props} action="check" />
      {result && <SsoDiscoveryCard result={result} onOfferPrivate={() => props.actions.togglePrivate(true)} />}
    </div>
  );
}

/** Step 3: role claim path, rules, collision warning, live preview. */
export function StepRoles(props: StepProps) {
  const { t } = useTranslation('settings');
  const { form, setForm } = props;
  const editable = claimPathUserEditable(form.roleClaimPath, 'role');
  const shape = roleShapeOf(props.status, props.lastTestResult);
  const values = Array.isArray(props.lastTestResult?.roleClaimValue) ? props.lastTestResult.roleClaimValue : null;
  const previewRole = values ? form.roleRules.reduce<'admin' | 'user' | null>((best, rule) => (
    values.includes(rule.value.trim()) && (best === null || rule.role === 'admin') ? rule.role : best), null) : null;
  const outcome = previewRole === 'admin' ? t('sso.step3.roleAdmin') : previewRole === 'user' ? t('sso.step3.roleMember') : t('sso.step3.noAccess');
  const hasRule = form.roleRules.some((rule) => rule.value.trim());

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground">{t('sso.step3.lead')}</p>
      <TextField label={t('sso.step3.path')} value={form.roleClaimPath} onChange={(roleClaimPath) => setForm({ roleClaimPath })}
        hint={<>{t('sso.step3.pathHint')} <Tech>roles</Tech> {t('sso.step3.or')} <Tech>realm_access.roles</Tech></>}
        error={editable ? t('sso.step3.pathEditable') : undefined} />
      {shape && <p className={HINT_CLASS}>{t(`sso.step3.shape.${shape}`)}</p>}
      <RoleRulesTable rules={form.roleRules} onChange={(roleRules) => setForm({ roleRules })} />
      {roleCollisionRisk(form) && (
        <SettingsCard tone="warning">
          <p className="flex items-start gap-2 text-[13px] text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />{t('sso.step3.collision')}
          </p>
        </SettingsCard>
      )}
      {values && (
        <p className="text-[13px] text-foreground">
          {t('sso.step3.previewLead')} <Tech>{JSON.stringify(values)}</Tech> {t('sso.result.arrow')} {outcome}
        </p>
      )}
      <SaveRow props={props} action="save3" disabled={editable || !form.roleClaimPath.trim() || !hasRule} />
    </div>
  );
}

/** Step 4: tenant restriction with the D5 e-mail rule. */
export function StepTenant(props: StepProps) {
  const { t } = useTranslation('settings');
  const { form, setForm } = props;
  const valuesId = useId();
  const grouped = Boolean(props.status.lastProofs.signIn?.shapeFlags?.roleClaimObjectOfObjects);
  const grantBlocked = !grouped && form.tenantMode !== 'role_grant_scope' ? t('sso.step4.grantBlocked') : null;
  const options = [
    { value: 'none' as const, label: t('sso.step4.none') },
    { value: 'claim' as const, label: t('sso.step4.claim') },
    { value: 'role_grant_scope' as const, label: t('sso.step4.grant'), blockedReason: grantBlocked },
  ];
  const email = isEmailTenantPath(form);
  const pathEditable = form.tenantMode === 'claim' && claimPathUserEditable(form.tenantClaimPath, 'tenant');
  const badLines = email ? invalidEmailLines(form.tenantValuesText) : [];
  const valueCount = form.tenantValuesText.split('\n').filter((line) => line.trim()).length;
  const valuesInvalid = form.tenantMode !== 'none' && (valueCount < 1 || valueCount > 64);
  const blocked = pathEditable || badLines.length > 0 || valuesInvalid
    || (form.tenantMode === 'claim' && !form.tenantClaimPath.trim());

  return (
    <div className="space-y-4">
      <SegmentedControl<SsoTenantMode> label={t('sso.step4.title')} options={options} value={form.tenantMode}
        onChange={(tenantMode) => setForm({ tenantMode, ...(tenantMode === 'none' ? { jitEnabled: false } : {}) })} />
      {grantBlocked && <p className={HINT_CLASS}>{grantBlocked}</p>}
      {form.tenantMode === 'none' && <p className={HINT_CLASS}>{t('sso.step4.noneHint')}</p>}
      {form.tenantMode === 'claim' && (
        <TextField label={t('sso.step4.path')} value={form.tenantClaimPath}
          onChange={(tenantClaimPath) => setForm({ tenantClaimPath })}
          error={pathEditable ? t('sso.step3.pathEditable') : undefined} />
      )}
      {form.tenantMode !== 'none' && (
        <div className="space-y-1.5">
          <label htmlFor={valuesId} className={LABEL_CLASS}>{email ? t('sso.step4.emailValues') : t('sso.step4.values')}</label>
          <textarea id={valuesId} dir="ltr" style={{ unicodeBidi: 'isolate' }} rows={4} spellCheck={false}
            className={TECH_INPUT_CLASS} value={form.tenantValuesText}
            aria-invalid={badLines.length > 0 || undefined}
            onChange={(event) => setForm({ tenantValuesText: event.target.value })} />
          {badLines.length > 0 && <p role="alert" className="text-[13px] text-danger">{t('sso.step4.emailInvalid')}</p>}
        </div>
      )}
      {email && (
        <SettingsCard tone="warning">
          <p className="flex items-start gap-2 text-[13px] text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />{t('sso.step4.emailWarning')}
          </p>
        </SettingsCard>
      )}
      <SaveRow props={props} action="save4" disabled={blocked} />
    </div>
  );
}

/** Step 5: JIT accounts and the re-check window. */
export function StepAccounts(props: StepProps) {
  const { t } = useTranslation('settings');
  const { form, setForm } = props;
  const hoursId = useId();
  const jitBlocked = form.tenantMode === 'none';
  const hoursValid = Number.isInteger(form.attestationMaxAgeHours) && form.attestationMaxAgeHours >= 1 && form.attestationMaxAgeHours <= 24;
  return (
    <div className="space-y-2">
      <SettingsRow label={t('sso.step5.jit')}
        description={<>{t('sso.step5.jitHint')}{jitBlocked && <span className="mt-1 block">{t('sso.step5.jitBlocked')}</span>}</>}>
        <SettingsToggle checked={form.jitEnabled && !jitBlocked} disabled={jitBlocked} ariaLabel={t('sso.step5.jit')}
          onChange={(jitEnabled) => setForm({ jitEnabled })} />
      </SettingsRow>
      <SettingsRow label={<label htmlFor={hoursId}>{t('sso.step5.hours')}</label>} description={t('sso.step5.hoursHint')}>
        <div className="flex items-center gap-2">
          <input id={hoursId} type="number" inputMode="numeric" min={1} max={24} step={1}
            value={Number.isFinite(form.attestationMaxAgeHours) ? form.attestationMaxAgeHours : ''}
            aria-invalid={!hoursValid || undefined}
            onChange={(event) => setForm({ attestationMaxAgeHours: event.target.value === '' ? NaN : Number(event.target.value) })}
            className={`${INPUT_CLASS} w-20`} />
          <span className="text-[13px] text-muted-foreground">{t('sso.step5.unit')}</span>
        </div>
      </SettingsRow>
      {!hoursValid && <p role="alert" className="text-[13px] text-danger">{t('sso.step5.hoursInvalid')}</p>}
      <SaveRow props={props} action="save5" disabled={!hoursValid} />
    </div>
  );
}

/** Step 6: test sign-in at the identity provider and its one-time result. */
export function StepTestSignIn(props: StepProps) {
  const { t } = useTranslation('settings');
  const ready = discoveryCurrent(props.status);
  const slow = useSlowFlag(props.busy === 'test');
  const ret = props.testReturn;
  const rules = props.status.draft?.roleRules ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">{t('sso.step6.lead')}</p>
      <p className={HINT_CLASS}>{t('sso.step6.leaveNote')}</p>
      {!ready && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] text-muted-foreground">{t('sso.diag.sso_test_discovery_required')}</p>
          <Button type="button" variant="outline" size="sm"  disabled={props.busy !== null} onClick={props.actions.check}>
            {props.busy === 'check' && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('sso.step6.checkFirst')}
          </Button>
        </div>
      )}
      <ErrorFor props={props} action="check" />
      {!(ret?.kind === 'result') && (
        <Button type="button"  disabled={!ready || props.busy !== null} onClick={props.actions.startTest}>
          {props.busy === 'test' && <Loader2 className="animate-spin" aria-hidden="true" />}
          {t('sso.step6.start')}
        </Button>
      )}
      {slow && <BusyLine>{t('sso.contacting')}</BusyLine>}
      <ErrorFor props={props} action="test" />
      {ret?.kind === 'error' && <SsoError code={ret.code} />}
      {ret?.kind === 'alreadyShown' && <p className={HINT_CLASS}>{t('sso.step6.alreadyShown')}</p>}
      {ret?.kind === 'result' && (
        <SsoTestResultCard ref={props.resultHeadingRef} result={ret.result} rules={rules}
          busy={props.busy !== null || !ready} onTestAgain={props.actions.startTest} />
      )}
    </div>
  );
}

/** Step 7: apply-proof checklist and the apply button. */
export function StepApply(props: StepProps) {
  const { t } = useTranslation('settings');
  const relative = useRelativeTime();
  const { status } = props;
  const discovery = status.lastProofs.discovery;
  const signIn = status.lastProofs.signIn;
  const ready = proofsReady(status);
  const live = status.ssoState === 'active';
  const item = (ok: boolean, label: string, at: number | string | undefined) => (
    <li className="flex items-start gap-2 text-[13px] text-foreground">
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        : <X className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />}
      <span className="min-w-0">
        {label}
        <span className="sr-only">{ok ? ` ${t('sso.result.yes')}` : ` ${t('sso.result.no')}`}</span>
        {ok && at !== undefined && <span className="text-muted-foreground"> · {relative(at)} · {t('sso.step7.validFor')}</span>}
      </span>
    </li>
  );
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {item(Boolean(discovery?.passed && discovery.current), t('sso.step7.checkConn'), discovery?.createdAt)}
        {item(Boolean(ready), t('sso.step7.checkTest'), signIn?.createdAt)}
      </ul>
      <Button type="button"  disabled={!ready || props.busy !== null} onClick={props.actions.openApply}>
        {props.busy === 'apply' && <Loader2 className="animate-spin" aria-hidden="true" />}
        {live ? t('sso.step7.applyChanges') : t('sso.step7.apply')}
      </Button>
      {!ready && <p className={HINT_CLASS}>{t('sso.step7.notReady')}</p>}
      <ErrorFor props={props} action="apply" />
    </div>
  );
}
