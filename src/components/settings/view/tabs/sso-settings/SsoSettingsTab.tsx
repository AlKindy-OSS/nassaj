/**
 * Owner-only «الدخول الموحّد» / "Single sign-on (SSO)" settings tab
 * (ADR-194 D8, design brief docs/design/sso-settings-brief.md, T-1962 S7).
 *
 * Layout (brief §2): [A] title · [B] status header · [C] banners ·
 * [D] live configuration · [E] setup/change wizard · [F] technical details.
 * Copy names "your identity provider" only, never a product.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Info, Loader2, LogIn } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsCollapsible from '../../SettingsCollapsible';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import StatusBadge from '../../StatusBadge';
import { useSsoSettings } from '../../../hooks/useSsoSettings';
import type { SettingsMainTab } from '../../../types/types';

import { SsoDisableDialog } from './SsoDialogs';
import {
  bannersOf,
  canDisable,
  draftPending,
  HEADER_TONE,
  headerStateOf,
  linkedCount,
  unavailableFaultOf,
  type BannerId,
  type HeaderState,
  type StepId,
} from './ssoModel';
import { BusyLine, CopyField, SsoError, Tech } from './SsoParts';
import SsoStepUpDialog from './SsoStepUpDialog';
import SsoWizard from './SsoWizard';
import type { SsoActionFailure, SsoActionResult, SsoStatus } from './ssoTypes';
import { useSsoStepUp } from './useSsoStepUp';

type Props = { onNavigateTab?: (tab: SettingsMainTab) => void };
type PageAction = 'disable' | 'enable' | 'import';

const MAX_VISIBLE_BANNERS = 2;

export default function SsoSettingsTab({ onNavigateTab }: Props) {
  const { t } = useTranslation('settings');
  const sso = useSsoSettings();
  const { requestStepUp, dialogProps } = useSsoStepUp();
  const [disableOpen, setDisableOpen] = useState(false);
  const [busy, setBusy] = useState<PageAction | null>(null);
  const [failure, setFailure] = useState<{ action: PageAction; result: SsoActionFailure } | null>(null);
  const [importWarnings, setImportWarnings] = useState<Array<{ code: string; legacyRedirectUri?: string; redirectUri?: string }>>([]);
  const [wizardOpen, setWizardOpen] = useState<boolean | null>(null);
  const [focusStep, setFocusStep] = useState<{ id: StepId; nonce: number } | null>(null);

  const title = (
    <SettingsSection level="page" icon={LogIn} title={t('sso.title')} description={t('sso.description')}>
      {null}
    </SettingsSection>
  );

  if (!sso.status) {
    return (
      <div className="space-y-8">
        {title}
        {sso.loading ? (
          <div className="flex justify-center py-10"><BusyLine>{t('sso.loading')}</BusyLine></div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="flex items-center gap-1.5 text-[13px] text-danger">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />{t('sso.error.load')}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => { void sso.reload(); }}>{t('sso.action.retry')}</Button>
          </div>
        )}
      </div>
    );
  }

  const status = sso.status;
  const state = headerStateOf(status);
  const banners = bannersOf(status);
  const hasActive = status.active !== null;
  const pending = draftPending(status);
  const showWizard = !status.hostDisabled;
  const fixStep: StepId | null = unavailableFaultOf(status) ? 2 : null;
  const wizardExpanded = wizardOpen ?? (!hasActive || pending || fixStep !== null || sso.testReturn !== null || state === 'paused');
  const openStep = (id: StepId) => {
    setWizardOpen(true);
    setFocusStep({ id, nonce: Date.now() });
  };

  const run = async (action: PageAction, work: () => Promise<SsoActionResult | null>) => {
    setBusy(action); setFailure(null);
    const result = await work();
    if (result && !result.ok) setFailure({ action, result });
    setBusy(null);
    return result;
  };

  const disable = (keep: boolean) => {
    setDisableOpen(false);
    const guarded = status.ssoState === 'active' || keep;
    void run('disable', async () => {
      const first = guarded ? await requestStepUp((stepUp) => sso.disable(keep, stepUp)) : await sso.disable(false);
      if (first && !first.ok && first.code === 'step_up_required') {
        return requestStepUp((stepUp) => sso.disable(keep, stepUp));
      }
      return first;
    });
  };

  const enableAgain = () => { void run('enable', () => requestStepUp((stepUp) => sso.enable(stepUp))); };

  const importEnv = () => {
    void run('import', async () => {
      const result = await sso.importEnv();
      if (result.ok) {
        setImportWarnings(Array.isArray(result.data.warnings) ? result.data.warnings : []);
        openStep(3);
      }
      return result;
    });
  };

  const pageError = (action: PageAction) => failure?.action === action
    ? <SsoError code={failure.result.code} details={failure.result.details} retryAfterSeconds={failure.result.retryAfterSeconds} />
    : null;

  return (
    <div className="space-y-8">
      {title}

      <StatusHeader status={status} state={state} busy={busy}
        onDisable={() => setDisableOpen(true)} error={pageError('disable')} />

      {banners.length > 0 && (
        <Banners banners={banners} status={status} busy={busy} onImport={importEnv} importError={pageError('import')}
          onOpenStep={openStep} onDisable={() => setDisableOpen(true)} onRetry={() => { void sso.reload(); }} />
      )}

      {importWarnings.length > 0 && <ImportWarnings warnings={importWarnings} />}

      {hasActive && status.active && (
        <SettingsSection level="section" title={state === 'offByOwner' ? t('sso.summary.titleNotInUse') : t('sso.summary.title')}>
          <LiveSummary status={status} faulty={state === 'unavailable'} />
          {state === 'offByOwner' && !status.hostDisabled && (
            <div className="space-y-2 pt-3">
              <Button type="button"  disabled={busy !== null} onClick={enableAgain}>
                {busy === 'enable' && <Loader2 className="animate-spin" aria-hidden="true" />}
                {t('sso.action.enableAgain')}
              </Button>
              {pageError('enable')}
            </div>
          )}
        </SettingsSection>
      )}

      {showWizard && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-foreground">{hasActive ? t('sso.action.change') : t('sso.action.setup')}</h3>
            {pending && <StatusBadge tone="warning">{t('sso.draft.pending')}</StatusBadge>}
          </div>
          {!hasActive && state === 'off' && <p className="text-[13px] leading-relaxed text-muted-foreground">{t('sso.intro')}</p>}
          {state === 'paused' && !status.draft && (
            <Button type="button" variant="link" className="h-auto px-0" onClick={() => openStep(0)}>
              {t('sso.action.startFresh')}
            </Button>
          )}
          {wizardExpanded ? (
            <SsoWizard sso={{ ...sso, status }} requestStepUp={requestStepUp} focusStep={focusStep}
              onOpenConnectors={() => onNavigateTab?.('connectors')} />
          ) : (
            <Button type="button" variant="outline"  onClick={() => setWizardOpen(true)}>
              {t('sso.action.change')}
            </Button>
          )}
        </section>
      )}

      <TechnicalDetails status={status} />

      <SsoDisableDialog open={disableOpen} active={status.ssoState === 'active'}
        linked={linkedCount(status)} onCancel={() => setDisableOpen(false)} onConfirm={disable} />
      <SsoStepUpDialog {...dialogProps} onOpenProfile={() => onNavigateTab?.('profile')} />
    </div>
  );
}

function StatusHeader({ status, state, busy, onDisable, error }: {
  status: SsoStatus; state: HeaderState; busy: PageAction | null; onDisable: () => void; error: ReactNode;
}) {
  const { t, i18n } = useTranslation('settings');
  const blocked = state === 'unavailable' || state === 'paused';
  const linked = linkedCount(status, status.active?.issuer);
  const since = status.active?.updatedAt;
  const sinceText = since ? new Date(typeof since === 'number' ? since : Date.parse(String(since)))
    .toLocaleDateString([`${i18n.language}-u-nu-latn`, 'en'], { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  return (
    <div className="space-y-1.5 border-b border-border pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-foreground">{t('sso.status.heading')}</h3>
          <StatusBadge tone={HEADER_TONE[state]}>{t(`sso.status.${state === 'offByOwner' ? 'off' : state}`)}</StatusBadge>
        </div>
        {canDisable(state) && (
          <Button type="button" variant="outline" size="sm"  disabled={busy !== null} onClick={onDisable}>
            {busy === 'disable' && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('sso.action.disable')}
          </Button>
        )}
      </div>
      <p className="text-sm text-foreground">{t(`sso.status.meaning.${state}`)}</p>
      {(blocked || state === 'active') && <p className="text-[13px] text-muted-foreground">{t('sso.status.ownerNote')}</p>}
      {state === 'active' && sinceText && (
        <p className="text-[13px] text-muted-foreground">{t('sso.status.liveSince', { date: sinceText, count: linked })}</p>
      )}
      {error}
    </div>
  );
}

const ICON_COLOR = { info: 'text-primary', warning: 'text-warning', danger: 'text-danger' } as const;

const BANNER_TONE: Record<BannerId, 'info' | 'warning' | 'danger'> = {
  hostDisabled: 'info', endpointChanged: 'danger', unavailable: 'danger', linksNoConfig: 'danger',
  paused: 'warning', originMismatch: 'warning', noBackchannel: 'warning', noAuthTime: 'warning',
};

function Banners({ banners, status, busy, onImport, importError, onOpenStep, onDisable, onRetry }: {
  banners: BannerId[]; status: SsoStatus; busy: PageAction | null; onImport: () => void; importError: ReactNode;
  onOpenStep: (id: StepId) => void; onDisable: () => void; onRetry: () => void;
}) {
  const { t } = useTranslation('settings');
  const fault = unavailableFaultOf(status);
  const render = (id: BannerId) => {
    const tone = BANNER_TONE[id];
    const Icon = tone === 'info' ? Info : tone === 'danger' ? AlertCircle : AlertTriangle;
    let body: ReactNode = null;
    let actions: ReactNode = null;
    switch (id) {
      case 'hostDisabled': body = t('sso.banner.hostDisabled'); break;
      case 'endpointChanged':
        body = <>{t('sso.banner.endpointChanged')} {t('sso.banner.unavailableTail')}</>;
        actions = <Button type="button" size="sm"  onClick={() => onOpenStep(2)}>{t('sso.action.recheck')}</Button>;
        break;
      case 'unavailable':
        body = <>{t(`sso.fault.${fault ?? 'cannotUse'}`)} {t('sso.banner.unavailableTail')}</>;
        actions = <>
          {fault === 'cannotUse'
            ? <Button type="button" size="sm" variant="outline"  onClick={onRetry}>{t('sso.action.retry')}</Button>
            : <Button type="button" size="sm"  onClick={() => onOpenStep(2)}>{t('sso.action.review')}</Button>}
          <Button type="button" size="sm" variant="outline"  onClick={onDisable}>{t('sso.action.disable')}</Button>
        </>;
        break;
      case 'linksNoConfig':
        body = t('sso.banner.linksNoConfig');
        actions = <>
          <Button type="button" size="sm"  onClick={() => onOpenStep(0)}>{t('sso.action.setup')}</Button>
          <Button type="button" size="sm" variant="outline"  onClick={onDisable}>{t('sso.banner.linksNoConfigOff')}</Button>
        </>;
        break;
      case 'paused':
        body = t('sso.banner.paused');
        actions = <Button type="button" size="sm"  disabled={busy !== null} onClick={onImport}>
          {busy === 'import' && <Loader2 className="animate-spin" aria-hidden="true" />}{t('sso.action.import')}
        </Button>;
        break;
      case 'originMismatch':
        body = <div className="space-y-2">
          <p>{t('sso.banner.originMismatch')}</p>
          {status.active?.redirectUri && <p className="text-[13px]">{t('sso.banner.oldAddress')} <Tech className="line-through">{status.active.redirectUri}</Tech></p>}
          {status.ourValues.redirectUri && <CopyField label={t('sso.banner.newAddress')} value={status.ourValues.redirectUri} />}
        </div>;
        actions = <Button type="button" size="sm" variant="outline"  onClick={() => onOpenStep(1)}>{t('sso.action.toStep1')}</Button>;
        break;
      case 'noBackchannel':
        body = t('sso.banner.noBackchannel', { hours: status.active?.attestationMaxAgeHours ?? 12 });
        actions = <Button type="button" size="sm" variant="link" className="h-auto px-0" onClick={() => onOpenStep(5)}>{t('sso.action.toStep5')}</Button>;
        break;
      case 'noAuthTime': body = t('sso.banner.noAuthTime'); break;
      default: break;
    }
    return (
      <SettingsCard key={id} tone={tone}>
        <section aria-label={t(`sso.banner.label.${id}`)} className="flex items-start gap-3">
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${ICON_COLOR[tone]}`} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-2 text-sm text-foreground">
            <h4 className="font-semibold">{t(`sso.banner.label.${id}`)}</h4>
            <div>{body}</div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            {id === 'paused' && importError}
          </div>
        </section>
      </SettingsCard>
    );
  };
  const visible = banners.slice(0, MAX_VISIBLE_BANNERS);
  const rest = banners.slice(MAX_VISIBLE_BANNERS);
  return (
    <div className="space-y-3">
      {visible.map(render)}
      {rest.length > 0 && (
        <SettingsCollapsible summary={t('sso.banner.more', { count: rest.length })}>
          <div className="space-y-3">{rest.map(render)}</div>
        </SettingsCollapsible>
      )}
    </div>
  );
}

function ImportWarnings({ warnings }: { warnings: Array<{ code: string; legacyRedirectUri?: string; redirectUri?: string }> }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsCard tone="warning">
      <div className="space-y-2 text-sm text-foreground">
        {warnings.map((warning) => warning.code === 'redirect_uri_mismatch' ? (
          <div key={warning.code} className="space-y-2">
            <p>{t('sso.banner.importRedirect')}</p>
            {warning.legacyRedirectUri && <p className="text-[13px]">{t('sso.banner.oldAddress')} <Tech className="line-through">{warning.legacyRedirectUri}</Tech></p>}
            {warning.redirectUri && <CopyField label={t('sso.banner.newAddress')} value={warning.redirectUri} />}
          </div>
        ) : (
          <p key={warning.code}>{warning.code === 'installation_origin_unconfirmed' ? t('sso.step0.missing') : <Tech>{warning.code}</Tech>}</p>
        ))}
      </div>
    </SettingsCard>
  );
}

function LiveSummary({ status, faulty }: { status: SsoStatus; faulty: boolean }) {
  const { t } = useTranslation('settings');
  const active = status.active;
  if (!active) return null;
  const fault = unavailableFaultOf(status);
  const issuerFaulty = faulty && (fault === 'endpointChanged' || fault === 'runtimeFault');
  return (
    <SettingsGroup>
      <SettingsRow label={t('sso.step2.issuer')}>
        <Tech className={issuerFaulty ? 'text-danger' : undefined}>{active.issuer}</Tech>
      </SettingsRow>
      <SettingsRow label={t('sso.step2.clientId')}><Tech>{active.clientId}</Tech></SettingsRow>
      <SettingsRow label={t('sso.step2.type')}>
        <span className="text-[13px]">{active.clientAuth === 'none' ? t('sso.step2.public') : t('sso.step2.confidential')}</span>
      </SettingsRow>
      <SettingsRow label={t('sso.step3.path')}>
        <span className="text-[13px]"><Tech>{active.roleClaimPath}</Tech> · {t('sso.step3.ruleCount', { count: active.roleRules.length })}</span>
      </SettingsRow>
      <SettingsRow label={t('sso.step4.title')}><span className="text-[13px]">{t(`sso.summary.tenant.${active.tenantMode}`)}</span></SettingsRow>
      <SettingsRow label={t('sso.step5.jit')}><span className="text-[13px]">{active.jitEnabled ? t('sso.summary.on') : t('sso.summary.off')}</span></SettingsRow>
      <SettingsRow label={t('sso.step5.hours')}><span className="text-[13px]">{t('sso.summary.hours', { count: active.attestationMaxAgeHours })}</span></SettingsRow>
      {active.allowPrivateNetwork && (
        <SettingsRow label={t('sso.step2.private')}>
          <span className="text-[13px]">{t('sso.summary.on')}{active.issuerPort ? <> · <Tech>{String(active.issuerPort)}</Tech></> : null}</span>
        </SettingsRow>
      )}
      <SettingsRow label={t('sso.summary.linked')}><span className="text-[13px]">{linkedCount(status, active.issuer)}</span></SettingsRow>
      {faulty && active.invalidReason && (
        <SettingsRow label={t('sso.summary.problem')}><Tech className="text-danger">{active.invalidReason}</Tech></SettingsRow>
      )}
    </SettingsGroup>
  );
}

function TechnicalDetails({ status }: { status: SsoStatus }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsCollapsible summary={t('sso.technical.title')}>
      {status.ignoredEnv.length > 0 && (
        <p>{t('sso.technical.ignoredEnv')} {status.ignoredEnv.map((name, index) => (
          <span key={name}>{index > 0 && ', '}<Tech>{name}</Tech></span>
        ))}</p>
      )}
      <p>{t('sso.technical.hostSwitch')} <Tech>NASSAJ_SSO_FORCE_OFF</Tech> {status.hostDisabled ? t('sso.summary.on') : t('sso.summary.off')}</p>
      {status.active && <p>{t('sso.technical.activeVersion')} <Tech>{String(status.active.version)}</Tech></p>}
      {status.draft && <p>{t('sso.technical.draftVersion')} <Tech>{String(status.draft.draftVersion)}</Tech></p>}
    </SettingsCollapsible>
  );
}
