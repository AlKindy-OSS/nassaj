import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { AlertCircle, Check, FileKey2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../shared/view/ui';

import {
  ConnectorOwnerSetupRequestError, loadConnectorOwnerSetup, mutateConnectorOwnerSetup,
  verifyConnectorOwnerProfile,
  type ConnectorOwnerSetupStatus, type OwnerSetupStep,
} from './connectorOwnerSetupClient';
import { CONNECTOR_RECENT_AUTH_CODES } from './connectorStepUpClient';

type Props = {
  owner: boolean;
  csrfToken: string | null;
  // B-1405 follow-up: `csrfToken` is also null during the initial load and on
  // a structural/config readiness error (ConnectorsSettingsTabM1.tsx), neither
  // of which is a session problem — only a confirmed recent-auth rejection
  // offers the step-up (T-1939 6C: an inline check, never a sign-out).
  recentAuthRequired: boolean;
  /**
   * Opens the connector step-up dialog owned by the connectors tab. `code` is
   * the refusal that triggered it (absent when the member clicked the button).
   */
  onRequestStepUp?: (code?: string) => void;
  language: string;
  onReadyChange?: () => void;
};
const FILE_LIMITS = { trust: 256 * 1024, pack: 2 * 1024 * 1024 } as const;
const STEPS: OwnerSetupStep[] = ['origin', 'trust', 'provider_pack', 'activation'];

const validOrigin = (raw: string): boolean => {
  if (!raw || raw.trim() !== raw) return false;
  try {
    const parsed = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    return parsed.origin === raw && (parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback);
  } catch { return false; }
};
// Strips a single trailing slash left over from copy-pasting a page URL (e.g.
// "https://host/") so the value can equal `URL(origin).origin` without one.
// Only collapses exactly one extra slash; anything else is left for the
// explicit hint below so the owner can see what needs fixing.
const normalizeOrigin = (raw: string): string => {
  if (!raw.endsWith('/') || raw.endsWith('://')) return raw;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}/` === raw ? parsed.origin : raw;
  } catch { return raw; }
};
const readBoundedJson = async (file: File, limit: number): Promise<unknown> => {
  if (file.size < 2 || file.size > limit || !/\.json$/iu.test(file.name)) throw new Error('file_invalid');
  const value: unknown = JSON.parse(await file.text());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('file_invalid');
  return value;
};
/** i18n key (under connectorsSettings.ownerSetup.origin) explaining an origin-write refusal (B-1461). */
const ORIGIN_ERROR_KEYS: Record<string, string> = {
  CONNECTOR_ORIGIN_PROPOSAL_MISMATCH: 'errors.proposalMismatch',
  CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED: 'errors.bootstrapRefused',
  'CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED:startup_profile': 'errors.bootstrapStartupProfile',
  'CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED:existing_installation_effects': 'errors.bootstrapExistingEffects',
};
const originErrorKey = (error: string): string | undefined =>
  ORIGIN_ERROR_KEYS[error] ?? ORIGIN_ERROR_KEYS[error.split(':')[0]];
const actionableCandidate = (candidate: ConnectorOwnerSetupStatus['activationCandidates'][number]) =>
  candidate.certification === 'certified'
    && candidate.blockerCodes.every(code => code === 'CONNECTOR_ACTIVATION_REQUIRED')
    && (!candidate.profileRequired || candidate.profileState === 'ready');

export default function ConnectorOwnerSetupWizard({ owner, csrfToken, recentAuthRequired, onRequestStepUp, language, onReadyChange }: Props) {
  const ar = language.startsWith('ar');
  const say = (en: string, arabic: string) => ar ? arabic : en;
  const { t } = useTranslation('settings');
  const originText = (key: string) => t(`connectorsSettings.ownerSetup.origin.${key}`);
  const [status, setStatus] = useState<ConnectorOwnerSetupStatus | null>(null);
  const [origin, setOrigin] = useState('');
  const [trustFile, setTrustFile] = useState<File | null>(null);
  const [packFile, setPackFile] = useState<File | null>(null);
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [profileInputs, setProfileInputs] = useState<Record<string, { clientId: string; clientSecret: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A recent-auth refusal is not a setup failure: it opens the step-up instead.
  const failWith = useCallback((reason: unknown) => {
    const code = reason instanceof ConnectorOwnerSetupRequestError ? reason.code : 'CONNECTOR_SETUP_UNAVAILABLE';
    if (CONNECTOR_RECENT_AUTH_CODES.has(code) && onRequestStepUp) { onRequestStepUp(code); return; }
    // A refinement (e.g. the bootstrap-refusal reason) travels as `code:reason`.
    setError(reason instanceof ConnectorOwnerSetupRequestError && reason.reason ? `${code}:${reason.reason}` : code);
  }, [onRequestStepUp]);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const resetPrivateState = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setStatus(null); setOrigin(''); setTrustFile(null); setPackFile(null); setChanges({}); setProfileInputs({});
    setBusy(false); setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!owner) return;
    const callGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null);
    try {
      const next = await loadConnectorOwnerSetup(abort.signal);
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      // B-1461: the server's trusted-config proposal is a pre-fill only; saving stays explicit.
      // Without a usable proposal nothing can be bound, so nothing is pre-filled either.
      setStatus(next);
      setOrigin(next.origin?.canonicalOrigin ?? next.originProposal?.canonicalOrigin ?? '');
      setChanges(Object.fromEntries(next.activationCandidates.map(candidate => [
        `${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`, candidate.enabled,
      ])));
    } catch (reason) {
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      setError(reason instanceof ConnectorOwnerSetupRequestError ? reason.code : 'CONNECTOR_SETUP_UNAVAILABLE');
    } finally {
      if (callGeneration === generation.current && !abort.signal.aborted && owner) setBusy(false);
    }
  }, [owner]);

  useEffect(() => { if (owner) void refresh(); else resetPrivateState(); return () => {
    generation.current += 1; controller.current?.abort();
  }; }, [owner, refresh, resetPrivateState]);

  const mutate = async (route: 'origin'|'trust/import'|'packs/import'|'activations', method: 'PUT'|'POST',
    expectedRevision: number, body: unknown) => {
    if (!owner || !csrfToken || busy) return;
    const callGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null);
    try {
      await mutateConnectorOwnerSetup({ route, method, expectedRevision, csrfToken, body, signal: abort.signal });
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      setTrustFile(null); setPackFile(null); onReadyChange?.();
      await refresh();
    } catch (reason) {
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      failWith(reason);
      setBusy(false);
    }
  };

  const verifyProfile = async (providerId: string, authMethod: 'dcr_pkce'|'byo_app',
    expectedRevision: number) => {
    if (!owner || !csrfToken || busy) return;
    const values = profileInputs[providerId] ?? { clientId: '', clientSecret: '' };
    if (authMethod === 'byo_app' && (!values.clientId.trim() || !values.clientSecret)) return;
    const callGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null);
    try {
      await verifyConnectorOwnerProfile({ providerId, expectedRevision, csrfToken,
        body: authMethod === 'dcr_pkce' ? { method: 'dcr_pkce' }
          : { method: 'byo_app', clientId: values.clientId.trim(), clientSecret: values.clientSecret },
        signal: abort.signal });
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      setProfileInputs(current => ({ ...current,
        [providerId]: { clientId: '', clientSecret: '' } }));
      onReadyChange?.(); await refresh();
    } catch (reason) {
      if (callGeneration !== generation.current || abort.signal.aborted || !owner) return;
      failWith(reason);
      setBusy(false);
    }
  };

  // B-1405 follow-up: normalization only ever runs against a snapshot for
  // validation/submit, never fed back into the controlled input on every
  // keystroke — otherwise typing "/" while composing a real path (e.g.
  // "https://host/x") gets silently eaten mid-type. The visible field always
  // shows exactly what was typed; only blur/paste/submit commit the
  // normalized value back into state.
  const normalizedOrigin = useMemo(() => normalizeOrigin(origin), [origin]);
  const commitNormalizedOrigin = useCallback((raw: string) => {
    setOrigin(normalizeOrigin(raw));
  }, []);
  const handleOriginPaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    const pasted = event.clipboardData.getData('text');
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    commitNormalizedOrigin(target.value.slice(0, start) + pasted + target.value.slice(end));
  }, [commitNormalizedOrigin]);

  const packWarning: 'expired' | 'expiring' | null = useMemo(() => {
    if (!status) return null;
    if (status.warnings.includes('pack_expired')) return 'expired';
    if (status.warnings.includes('pack_expiring_soon')) return 'expiring';
    return null;
  }, [status]);
  const packDaysLeft = useMemo(() => status?.packExpiresAt
    ? Math.max(0, Math.ceil((Date.parse(status.packExpiresAt) - Date.now()) / 86_400_000))
    : null, [status]);
  const packDateStr = useMemo(() => status?.packExpiresAt
    ? new Intl.DateTimeFormat(ar ? 'ar-SA' : 'en', { dateStyle: 'long' })
      .format(new Date(status.packExpiresAt))
    : null, [status, ar]);

  const certified = useMemo(() => status?.activationCandidates.filter(actionableCandidate) ?? [], [status]);
  const pending = useMemo(() => status?.activationCandidates.filter(candidate => !actionableCandidate(candidate)) ?? [], [status]);
  const profileCandidates = useMemo(() => {
    const providers = new Map<string, ConnectorOwnerSetupStatus['activationCandidates'][number]>();
    for (const candidate of status?.activationCandidates ?? []) {
      if (candidate.certification !== 'certified' || candidate.profileState === 'ready'
        || candidate.profileState === 'not_required') continue;
      const existing = providers.get(candidate.providerId);
      if (existing) {
        if (existing.authMethod !== candidate.authMethod) providers.set(candidate.providerId,
          { ...candidate, authMethod: 'unsupported_shared_profile' });
        continue;
      }
      providers.set(candidate.providerId, candidate);
    }
    return [...providers.values()];
  }, [status]);
  // B-1461 L2: before the first bind the server accepts only its own proposal.
  const originBlocked = Boolean(status && !status.origin && !status.originProposal?.canonicalOrigin);
  const changed = certified.filter(candidate => changes[
    `${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`] !== candidate.enabled);
  const labels: Record<OwnerSetupStep, [string, string]> = {
    origin: ['Public address', 'العنوان العام'], trust: ['Trust bundle', 'حزمة الثقة'],
    provider_pack: ['Provider pack', 'حزمة المزوّدات'], activation: ['Activation review', 'مراجعة التفعيل'],
    complete: ['Complete', 'مكتمل'],
  };
  if (!owner) return null;

  return <section aria-labelledby="connector-owner-setup-title" className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:p-5">
    <div className="flex items-start gap-3"><span className="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck aria-hidden="true" /></span><div>
      <h3 id="connector-owner-setup-title" className="font-semibold">{say('Owner installation setup', 'إعداد التثبيت للمالك')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{say('Shared installation controls. Members never receive this data or section.', 'إعدادات مشتركة للتثبيت. لا تصل هذه البيانات أو هذا القسم إلى الأعضاء.')}</p>
    </div></div>
    {recentAuthRequired && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
      <span>{say(
        'Installation setup needs a quick identity check (valid for 10 minutes).',
        'تهيئة التثبيت تحتاج تحققاً سريعاً من هويتك (صالح 10 دقائق).',
      )}</span>
      {onRequestStepUp && <Button variant="outline" onClick={() => onRequestStepUp()}><ShieldCheck className="h-4 w-4" aria-hidden="true"/>{say("Confirm it's you", 'تأكيد هويتك')}</Button>}
    </div>}
    {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"/><span className="min-w-0 flex-1">{say('Setup could not continue', 'تعذر متابعة الإعداد')} {originErrorKey(error) && <span className="block">{originText(originErrorKey(error)!)}</span>}<code dir="ltr">{error}</code></span><Button variant="outline" onClick={() => void refresh()}>{say('Retry', 'إعادة المحاولة')}</Button></div>}
    {!status && !error ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="animate-spin" aria-label={say('Loading setup', 'جارٍ تحميل الإعداد')} /></div> : status && <>
      {packWarning && <div role="alert" aria-live="polite" className={`flex items-start gap-2 rounded-md border p-3 text-sm${packWarning === 'expired' ? ' border-danger/30 bg-danger/5 text-danger' : ' border-warning/30 bg-warning/5 text-warning'}`}>
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"/>
        <div className="min-w-0 flex-1">
          <p>
            {packWarning === 'expired'
              ? say('Pack has expired; connectors are stopped until re-import.',
                  'انتهت الحزمة؛ الموصلات متوقّفة حتى إعادة الاستيراد.')
              : <>{say(
                  `Pack expires in ${packDaysLeft ?? '?'} day${packDaysLeft === 1 ? '' : 's'}; renew it then re-import.`,
                  `تنتهي حزمة الاعتماد خلال ${packDaysLeft ?? '?'} ${packDaysLeft === 1 ? 'يوم' : 'أيام'}؛ جدّدها ثم أعد استيرادها.`
                )}{packDateStr && <> (<span dir="ltr" className="font-medium">{packDateStr}</span>)</>}</>
            }
          </p>
          <p className="mt-1 text-[13px] opacity-75">
            {say('Renewal is done via the operator CLI. See ',
              'التجديد يتم بأداة سطر الأوامر عند المشغّل. راجع ')}
            <code dir="ltr">docs/connectors-operator-setup_AR.md</code>
          </p>
        </div>
      </div>}
      <ol className="grid gap-2 sm:grid-cols-4" aria-label={say('Setup progress', 'تقدم الإعداد')}>{STEPS.map((step, index) => {
        const checkId = step === 'provider_pack' ? 'pack' : step;
        const done = status.checks.find(check => check.id === checkId)?.status === 'ok';
        const current = status.resumableStep === step;
        return <li key={step} aria-current={current ? 'step' : undefined} className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${current ? 'border-primary bg-background font-medium' : 'border-border'}`}><span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[13px]">{done ? <Check className="h-3.5 w-3.5"/> : index + 1}</span>{say(...labels[step])}</li>;
      })}</ol>

      {status.resumableStep === 'origin' && <div className="space-y-3 rounded-lg bg-background p-4">
        <label htmlFor="connector-owner-origin" className="font-medium">{say('Canonical HTTPS origin', 'عنوان HTTPS الأساسي')}</label>
        <Input id="connector-owner-origin" dir="ltr" inputMode="url" autoComplete="url" value={origin}
          onChange={event => setOrigin(event.target.value)}
          onBlur={event => commitNormalizedOrigin(event.target.value)}
          onPaste={handleOriginPaste}
          disabled={busy || originBlocked}/>
        {!status.origin && !status.originProposal && <p role="alert" className="text-[13px] text-warning">
          {t('connectorsSettings.stepUp.errors.originUnconfiguredOwner')} <code dir="ltr">{window.location.origin}</code></p>}
        {status.originProposal && (status.originProposal.canonicalOrigin === null
          ? <p role="alert" className="text-[13px] text-warning">{originText('invalidPublicOrigin')}</p>
          : <p className="text-[13px] text-muted-foreground">{originText(`proposalSource.${status.originProposal.source}`)}</p>)}
        <p className="text-[13px] text-muted-foreground">{say('No path or trailing slash. OAuth callback:', 'دون مسار أو شرطة أخيرة. رابط OAuth:')} <code dir="ltr">{validOrigin(normalizedOrigin) ? `${normalizedOrigin}/connectors/oauth/callback` : '—'}</code></p>
        {origin.endsWith('/') && !validOrigin(normalizedOrigin) && <p role="status" className="text-[13px] text-warning">{say('Remove the trailing slash from the address.', 'أزل الشرطة الأخيرة (/) من العنوان.')}</p>}
        <Button className="w-full sm:w-auto" disabled={!csrfToken || busy || originBlocked || !validOrigin(normalizedOrigin)} onClick={() => {
          commitNormalizedOrigin(origin);
          void mutate('origin', 'PUT', status.origin?.originRevision ?? 0, { canonicalOrigin: normalizedOrigin, expectedOriginRevision: status.origin?.originRevision ?? 0 });
        }}>{busy && <Loader2 className="animate-spin"/>}{say('Save and continue', 'حفظ ومتابعة')}</Button>
      </div>}

      {status.resumableStep === 'trust' && <UploadStep id="trust" title={say('Import the installation trust bundle', 'استيراد حزمة ثقة التثبيت')} help={say('Signed JSON supplied with the release or by your trusted distributor. Maximum 256 KB.', 'ملف JSON موقّع يأتي مع الإصدار أو من موزعك الموثوق. الحد 256 كيلوبايت.')} submitLabel={say('Import and verify', 'استيراد وتحقق')} file={trustFile} setFile={setTrustFile} busy={busy} onSubmit={async () => {
        if (!trustFile) return; try { const bundle = await readBoundedJson(trustFile, FILE_LIMITS.trust); void mutate('trust/import', 'POST', status.trustBundleRevision, { bundle, expectedTrustBundleRevision: status.trustBundleRevision }); } catch { setError('CONNECTOR_SETUP_FILE_INVALID'); }
      }}
      />}

      {status.resumableStep === 'provider_pack' && <UploadStep id="pack" title={say('Import the certified provider pack', 'استيراد حزمة المزوّدات المعتمدة')} help={say('Only a pack verified against the pinned trust bundle is accepted. Maximum 2 MB.', 'لا تُقبل إلا حزمة متحققة بحزمة الثقة المثبتة. الحد 2 ميجابايت.')} submitLabel={say('Import and verify', 'استيراد وتحقق')} file={packFile} setFile={setPackFile} busy={busy} onSubmit={async () => {
        if (!packFile) return; try { const envelope = await readBoundedJson(packFile, FILE_LIMITS.pack); void mutate('packs/import', 'POST', status.activePack?.sequence ?? 0, { envelope }); } catch { setError('CONNECTOR_SETUP_FILE_INVALID'); }
      }}
      />}

      {status.resumableStep === 'activation' && <div className="space-y-4 rounded-lg bg-background p-4">
        <div><h4 className="font-medium">{say('Review certified operations', 'مراجعة العمليات المعتمدة')}</h4><p className="mt-1 text-sm text-muted-foreground">{say('Enable only operations certified by the active signed pack.', 'فعّل فقط العمليات التي اعتمدتها الحزمة الموقعة النشطة.')}</p></div>
        {profileCandidates.length > 0 && <div className="space-y-3" aria-labelledby="connector-owner-profiles-title">
          <div><h5 id="connector-owner-profiles-title" className="font-medium">{say('Prepare shared sign-in', 'تهيئة تسجيل الدخول المشترك')}</h5><p className="mt-1 text-sm text-muted-foreground">{say('Installation-level provider applications are visible only to the owner. Members add only their own accounts.', 'تطبيقات المزوّد على مستوى التثبيت ظاهرة للمالك فقط. يضيف الأعضاء حساباتهم الشخصية فقط.')}</p></div>
          {profileCandidates.map(candidate => {
            const values = profileInputs[candidate.providerId] ?? { clientId: '', clientSecret: '' };
            if (candidate.authMethod === 'dcr_pkce') return <div key={candidate.providerId} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3"><span><strong className="block text-sm">{candidate.providerId}</strong><span className="text-[13px] text-muted-foreground">{candidate.profileState === 'stale' ? say('Sign-in profile needs renewal', 'ملف تسجيل الدخول يحتاج تجديداً') : say('No sign-in profile yet', 'لا يوجد ملف تسجيل دخول بعد')}</span></span><Button disabled={!csrfToken || busy} onClick={() => void verifyProfile(candidate.providerId, 'dcr_pkce', candidate.profileRevision ?? 0)}>{busy && <Loader2 className="animate-spin"/>}{say('Prepare sign-in', 'تهيئة تسجيل الدخول')}</Button></div>
            </div>;
            if (candidate.authMethod === 'byo_app') return <form key={candidate.providerId} className="space-y-3 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); void verifyProfile(candidate.providerId, 'byo_app', candidate.profileRevision ?? 0); }}>
              <strong className="block text-sm">{candidate.providerId}</strong>
              <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>{say('Client ID', 'معرّف العميل')}</span><Input dir="ltr" autoComplete="off" value={values.clientId} disabled={busy} onChange={event => setProfileInputs(current => ({ ...current, [candidate.providerId]: { ...values, clientId: event.target.value } }))}/></label><label className="space-y-1 text-sm"><span>{say('Client secret', 'سر العميل')}</span><Input dir="ltr" type="password" autoComplete="new-password" value={values.clientSecret} disabled={busy} onChange={event => setProfileInputs(current => ({ ...current, [candidate.providerId]: { ...values, clientSecret: event.target.value } }))}/></label></div>
              <Button type="submit" className="w-full sm:w-auto" disabled={!csrfToken || busy || !values.clientId.trim() || !values.clientSecret}>{busy && <Loader2 className="animate-spin"/>}{say(candidate.profileState === 'stale' ? 'Renew provider app' : 'Verify provider app', candidate.profileState === 'stale' ? 'تجديد تطبيق المزوّد' : 'التحقق من تطبيق المزوّد')}</Button>
            </form>;
            return <div key={candidate.providerId} role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{say('Unsupported shared profile type; activation is blocked.', 'نوع ملف مشترك غير مدعوم؛ التفعيل محظور.')} <code dir="ltr">{candidate.authMethod}</code></div>;
          })}
        </div>}
        {certified.length === 0 ? <p role="status" className="rounded-md bg-warning/5 p-3 text-sm text-warning">{say('The server has not published verified activation candidates. No activation is possible.', 'لم ينشر الخادم مرشحي تفعيل متحققين؛ لا يمكن التفعيل الآن.')}</p> : <ul className="space-y-2">{certified.map(candidate => {
          const key = `${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`;
          return <li key={key} className="flex min-h-14 items-center justify-between gap-3 py-2"><span><strong className="block text-sm">{candidate.serviceId}</strong><span className="text-[13px] text-muted-foreground" dir="ltr">{candidate.providerId} · {candidate.operation}</span></span><input aria-label={`${candidate.serviceId}: ${candidate.operation}`} type="checkbox" className="h-5 w-5" checked={changes[key] ?? false} disabled={busy} onChange={event => setChanges(current => ({ ...current, [key]: event.target.checked }))}/></li>;
        })}</ul>}
        {pending.length > 0 && <details><summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{say('Unavailable or pending operations', 'عمليات معلقة أو غير متاحة')} ({pending.length})</summary><ul className="space-y-2 text-sm text-muted-foreground">{pending.map(candidate => <li key={`${candidate.providerId}:${candidate.serviceId}:${candidate.operation}`}>{candidate.serviceId} — {candidate.certification === 'suspended' ? say('suspended', 'موقوفة') : candidate.profileState}</li>)}</ul></details>}
        {certified.length > 0 && <Button className="w-full sm:w-auto" disabled={!csrfToken || busy || changed.length === 0} onClick={() => void mutate('activations', 'PUT', status.activationRecordRevision, { expectedRecordRevision: status.activationRecordRevision, globalPackDigest: status.activePack!.digest, changes: changed.map(candidate => ({ providerId: candidate.providerId, serviceId: candidate.serviceId, operation: candidate.operation, enabled: changes[`${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`] })) })}>{busy && <Loader2 className="animate-spin"/>}{say('Apply reviewed changes', 'تطبيق التغييرات المراجعة')}</Button>}
      </div>}

      {status.resumableStep === 'complete' && <div role="status" className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-4 text-success"><Check className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true"/><div><h4 className="font-semibold">{say('Installation setup is complete', 'اكتمل إعداد التثبيت')}</h4><p className="mt-1 text-sm">{say('Members can now link certified services once from My accounts.', 'يمكن للأعضاء الآن ربط الخدمات المعتمدة مرة واحدة من «حساباتي».')}</p></div></div>}
      <div className="flex justify-end"><Button variant="ghost" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? 'animate-spin' : ''} aria-hidden="true"/>{say('Refresh status', 'تحديث الحالة')}</Button></div>
    </>}
  </section>;
}

function UploadStep({ id, title, help, submitLabel, file, setFile, busy, onSubmit }: { id: string; title: string; help: string; submitLabel: string; file: File|null; setFile: (file: File|null) => void; busy: boolean; onSubmit: () => void }) {
  return <div className="space-y-3 rounded-lg bg-background p-4"><div><h4 className="font-medium">{title}</h4><p className="mt-1 text-sm text-muted-foreground">{help}</p></div><label htmlFor={`connector-owner-${id}`} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm focus-within:ring-2 focus-within:ring-ring"><FileKey2 aria-hidden="true"/><span className="min-w-0 truncate">{file?.name ?? 'JSON'}</span><input id={`connector-owner-${id}`} className="sr-only" type="file" accept="application/json,.json" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/></label><Button className="w-full sm:w-auto" disabled={!file || busy} onClick={onSubmit}>{busy && <Loader2 className="animate-spin"/>}{submitLabel}</Button></div>;
}
