/**
 * Setup / change wizard [E] of the SSO tab (brief §2, §5): a vertical ordered
 * list of steps 0–7, one open at a time. Holds the draft form and runs every
 * wizard write (with step-up where ADR-194 I5 requires it).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Lock } from 'lucide-react';

import { cn } from '../../../../../lib/utils';
import StatusBadge from '../../StatusBadge';
import type { useSsoSettings } from '../../../hooks/useSsoSettings';

import { SsoApplyDialog, SsoPrivateNetworkDialog, type ApplyDecision } from './SsoDialogs';
import {
  defaultOpenStep,
  draftNeedsStepUp,
  formFrom,
  isLocked,
  stepsOf,
  type StepId,
  type StepView,
} from './ssoModel';
import { Tech } from './SsoParts';
import {
  StepAccounts,
  StepApply,
  StepOrigin,
  StepOurValues,
  StepProvider,
  StepRoles,
  StepTenant,
  StepTestSignIn,
  type StepProps,
  type WizardAction,
} from './SsoWizardSteps';
import type { SsoActionResult, SsoDraftForm, StepUpEvidence } from './ssoTypes';

type Sso = ReturnType<typeof useSsoSettings>;

type Props = {
  sso: Sso & { status: NonNullable<Sso['status']> };
  requestStepUp: (run: (stepUp: StepUpEvidence) => Promise<SsoActionResult>) => Promise<SsoActionResult | null>;
  /** Step to open from outside (banners); `nonce` re-triggers the same step. */
  focusStep: { id: StepId; nonce: number } | null;
  onOpenConnectors: () => void;
};

const STEP_BODIES: Record<StepId, ComponentType<StepProps>> = {
  0: StepOrigin, 1: StepOurValues, 2: StepProvider, 3: StepRoles,
  4: StepTenant, 5: StepAccounts, 6: StepTestSignIn, 7: StepApply,
};

export default function SsoWizard({ sso, requestStepUp, focusStep, onOpenConnectors }: Props) {
  const { t } = useTranslation('settings');
  const { status } = sso;
  const [ackedOurValues, setAckedOurValues] = useState(false);
  const steps = useMemo(() => stepsOf(status, ackedOurValues), [status, ackedOurValues]);
  const [openStep, setOpenStep] = useState<StepId>(() => (sso.testReturn ? 6 : defaultOpenStep(steps)));
  const [form, setFormState] = useState<SsoDraftForm>(() => formFrom(status.draft ?? status.active));
  const [busy, setBusy] = useState<WizardAction | null>(null);
  const [failure, setFailure] = useState<StepProps['failure']>(null);
  const [savedNotice, setSavedNotice] = useState<WizardAction | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const draftVersion = status.draft?.draftVersion;

  // A saved (or freshly checked) draft is the new baseline of the form.
  useEffect(() => {
    if (status.draft) setFormState(formFrom(status.draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVersion]);

  useEffect(() => {
    if (focusStep) setOpenStep(focusStep.id);
  }, [focusStep]);

  useEffect(() => {
    if (sso.testReturn?.kind !== 'result') return;
    setOpenStep(6);
    requestAnimationFrame(() => resultHeadingRef.current?.focus());
  }, [sso.testReturn]);

  const setForm = useCallback((patch: Partial<SsoDraftForm>) => {
    setFormState((previous) => ({ ...previous, ...patch }));
    setSavedNotice(null);
  }, []);

  const finish = (action: WizardAction, result: SsoActionResult | null): boolean => {
    if (result && !result.ok) setFailure({ action, result });
    return Boolean(result?.ok);
  };

  const check = async () => {
    setBusy('check'); setFailure(null);
    finish('check', await sso.testDiscovery());
    setBusy(null);
  };

  const save = async (action: WizardAction, options: { thenCheck?: boolean; form?: SsoDraftForm } = {}) => {
    const next = options.form ?? form;
    setBusy(action); setFailure(null); setSavedNotice(null);
    const hadProof = Boolean(status.lastProofs.discovery || status.lastProofs.signIn);
    let result: SsoActionResult | null = draftNeedsStepUp(status.draft, next)
      ? await requestStepUp((stepUp) => sso.saveDraft(next, stepUp))
      : await sso.saveDraft(next);
    if (result && !result.ok && result.code === 'step_up_required') {
      result = await requestStepUp((stepUp) => sso.saveDraft(next, stepUp));
    }
    if (!finish(action, result)) { setBusy(null); return; }
    if (options.thenCheck) {
      setBusy('check');
      finish('check', await sso.testDiscovery());
    } else if (hadProof) {
      setSavedNotice(action);
    }
    setBusy(null);
  };

  const confirmOrigin = async (origin: string) => {
    setBusy('origin'); setFailure(null);
    if (finish('origin', await requestStepUp((stepUp) => sso.confirmOrigin(origin, stepUp)))) setOpenStep(1);
    setBusy(null);
  };

  const startTest = async () => {
    setBusy('test'); setFailure(null);
    sso.dismissTestReturn();
    const result = await sso.startTestLogin();
    // On success the page is leaving for the identity provider; keep the button busy.
    if (!result.ok) { finish('test', result); setBusy(null); }
  };

  const applyWith = async (decision: ApplyDecision) => {
    setApplyOpen(false);
    setBusy('apply'); setFailure(null);
    const enable = status.ssoState === 'active' ? undefined : true;
    finish('apply', await requestStepUp((stepUp) => sso.apply({ ...decision, ...(enable ? { enable } : {}) }, stepUp)));
    setBusy(null);
  };

  const togglePrivate = (on: boolean) => {
    if (!on) { setForm({ allowPrivateNetwork: false, issuerPort: '' }); return; }
    if (!form.allowPrivateNetwork) setPrivateOpen(true);
  };

  const allowPrivate = () => {
    setPrivateOpen(false);
    const next = { ...form, allowPrivateNetwork: true };
    setForm({ allowPrivateNetwork: true });
    setOpenStep(2);
    if (next.issuer.trim() && next.clientId.trim()) void save('save2', { thenCheck: true, form: next });
  };

  const stepProps: StepProps = {
    status, form, setForm, busy, failure, savedNotice, discovery: sso.discovery,
    lastTestResult: sso.lastTestResult, testReturn: sso.testReturn, resultHeadingRef,
    ackedOurValues, setAckedOurValues,
    actions: {
      confirmOrigin: (origin) => { void confirmOrigin(origin); },
      save: (action, options) => { void save(action, options); },
      check: () => { void check(); },
      togglePrivate, startTest: () => { void startTest(); },
      openApply: () => setApplyOpen(true), openStep: setOpenStep, openConnectors: onOpenConnectors,
    },
  };

  return (
    <>
      <ol className="space-y-2">
        {steps.map((step) => {
          const Body = STEP_BODIES[step.id];
          return (
            <StepItem key={step.id} step={step} open={openStep === step.id} summary={summaryOf(step, status, t)}
              onToggle={() => setOpenStep(step.id)}>
              <Body {...stepProps} />
            </StepItem>
          );
        })}
      </ol>
      <SsoApplyDialog open={applyOpen} impact={status.applyImpact} firstEnable={!status.applyImpact?.policyEnforcedNow}
        onCancel={() => setApplyOpen(false)} onConfirm={(decision) => { void applyWith(decision); }} />
      <SsoPrivateNetworkDialog open={privateOpen} onCancel={() => setPrivateOpen(false)} onAllow={allowPrivate} />
    </>
  );
}

function summaryOf(step: StepView, status: Props['sso']['status'], t: (key: string, options?: Record<string, unknown>) => string) {
  const draft = status.draft;
  switch (step.id) {
    case 0: return status.ourValues.origin ? <Tech>{status.ourValues.origin}</Tech> : null;
    case 2: return draft?.issuer ? <Tech>{draft.issuer}</Tech> : null;
    case 3: return draft?.roleClaimPath ? <><Tech>{draft.roleClaimPath}</Tech> · {t('sso.step3.ruleCount', { count: draft.roleRules.length })}</> : null;
    case 4: return draft ? t(`sso.summary.tenant.${draft.tenantMode}`) : null;
    case 5: return draft ? `${draft.jitEnabled ? t('sso.summary.jitOn') : t('sso.summary.jitOff')} · ${t('sso.summary.hours', { count: draft.attestationMaxAgeHours })}` : null;
    default: return null;
  }
}

function StepItem({ step, open, summary, onToggle, children }: {
  step: StepView; open: boolean; summary: ReactNode; onToggle: () => void; children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const locked = isLocked(step);
  const panelId = `sso-step-panel-${step.id}`;
  const badge = locked ? null
    : step.recheck ? <StatusBadge tone="warning">{t('sso.draft.recheckNeeded')}</StatusBadge>
      : step.done ? <StatusBadge tone="success">{t('sso.step.done')}</StatusBadge> : null;
  const reason = step.lockedReason === 'import' ? t('sso.step.lockedImport')
    : step.lockedBy !== null ? t('sso.step.locked', { n: step.lockedBy }) : null;

  return (
    <li aria-current={open ? 'step' : undefined}
      className={cn('border-s-2 ps-4', open ? 'border-primary' : 'border-border', locked && 'opacity-60')}>
      <button type="button" aria-expanded={open && !locked} aria-controls={panelId} aria-disabled={locked || undefined}
        onClick={() => { if (!locked) onToggle(); }}
        className="flex min-h-11 w-full items-center gap-3 rounded-md py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
          step.done && !step.recheck ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')} aria-hidden="true">
          {locked ? <Lock className="h-3.5 w-3.5" /> : step.done && !step.recheck ? <Check className="h-3.5 w-3.5" /> : step.id}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold leading-snug text-foreground">
            <span className="sr-only">{t('sso.step.number', { n: step.id })} </span>{t(`sso.step${step.id}.title`)}
          </span>
          {!open && !locked && summary && <span className="mt-0.5 block text-[13px] text-muted-foreground">{summary}</span>}
          {locked && reason && <span className="mt-0.5 block text-[13px] text-muted-foreground">{reason}</span>}
        </span>
        {badge}
        {!open && !locked && step.done && <span className="text-[13px] text-primary">{t('sso.step.edit')}</span>}
      </button>
      {open && !locked && <div id={panelId} className="pb-4 pt-2">{children}</div>}
    </li>
  );
}
