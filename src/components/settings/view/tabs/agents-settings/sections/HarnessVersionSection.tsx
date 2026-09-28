import type { TFunction } from 'i18next';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, HelpCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { HarnessCompatibility, HarnessCompatibilityState } from '../../../../../../../shared/harness-update.contract';
import type { AgentProvider } from '../../../../types/types';
import { useOptionalAuth } from '../../../../../auth/context/AuthContext';
import { compatReasonKey, mayRetryAfterFreshStatus } from '../../../../../../hooks/harnessVersionMapping';
import { useHarnessVersion } from '../../../../../../hooks/useHarnessVersion';
import { Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';
import StatusBadge from '../../../StatusBadge';

import HarnessUpdateConfirmDialog from './HarnessUpdateConfirmDialog';

const busy = new Set(['queued', 'running']);
const terminal = new Set(['succeeded', 'failed', 'skipped-live', 'pinned-refused', 'noop', 'rolled-back', 'rollback-failed']);

/** T-1871 stage 4: default server message when the client has no specific string for an action-refusal code. */
const ACTION_ERROR_DEFAULTS: Record<string, string> = {
  STORE_IN_USE: 'الأداة تستعمل ملفات بياناتها الآن، أغلقها ثم أعد المحاولة.',
  STORE_ACCESS_UNPROVABLE: 'الأداة تستعمل ملفات بياناتها الآن، أغلقها ثم أعد المحاولة.',
  INSUFFICIENT_STORAGE: 'لا تتوفر مساحة تخزين كافية لإجراء هذا التحديث بأمان.',
};

/** Tone + icon per compatibility verdict (T-1871 stage 2, ADR-159 Addendum 4). Never color-only: every badge also carries a text label (WCAG 1.4.1). */
const COMPAT_TONE_ICON: Record<HarnessCompatibilityState, { tone: 'success' | 'info' | 'warning' | 'danger'; Icon: typeof CheckCircle2 }> = {
  compatible: { tone: 'success', Icon: CheckCircle2 },
  baseline: { tone: 'info', Icon: Clock },
  untested: { tone: 'warning', Icon: HelpCircle },
  incompatible: { tone: 'danger', Icon: ShieldAlert },
};

const COMPAT_STATE_DEFAULTS: Record<Exclude<HarnessCompatibilityState, 'baseline'>, string> = {
  compatible: 'متوافق',
  untested: 'غير مجرَّب',
  incompatible: 'غير متوافق',
};

const COMPAT_REASON_DEFAULTS: Record<string, string> = {
  'pin-match': 'يطابق الإصدار المعتمد المثبَّت.',
  'pin-armed-blocked': 'نسّاج يرفض تشغيل هذا الإصدار: القفل الأمني مفعَّل.',
  'glm-carrier-blocked': 'GLM متوقف: نسّاج يقبل ناقل opencode {{reference}} فقط.',
  'pin-mismatch-unreviewed': 'هذه النسخة لم تُراجَع أمنياً بعد.',
  'baseline-match': 'يطابق إصدار خط الأساس المسجَّل.',
  'not-baselined': 'لا تتوفر بيانات خط أساس لهذا الإصدار.',
  'no-compat-data': 'لا تتوفر بيانات توافق لهذا المزوّد بعد.',
  'version-unknown': 'تعذّر تحديد الإصدار للمقارنة.',
  'mode-blocked': 'هذا الوضع متوقف لنسّاج: {{mode}}.',
  unknown: '',
};

/** Renders one compatibility verdict as a label + icon badge, plus a short plain-Arabic reason line. Display-only (T-1871 stage 2); no update/rollback affordance here. */
function CompatibilityRow({ label, versionNode, compat, t }: { label: string; versionNode?: ReactNode; compat: HarnessCompatibility; t: TFunction }) {
  const { tone, Icon } = COMPAT_TONE_ICON[compat.state];
  const stateLabel = compat.state === 'baseline'
    ? t('harnessVersion.compat.state.baseline', { defaultValue: `خط الأساس بتاريخ ${compat.asOf ?? '—'}`, date: compat.asOf ?? '—' })
    : t(`harnessVersion.compat.state.${compat.state}`, { defaultValue: COMPAT_STATE_DEFAULTS[compat.state] });
  const reasonKey = compatReasonKey(compat.reason);
  const mode = reasonKey === 'mode-blocked' ? compat.reason.replace(/-blocked$/, '') : '';
  const reasonText = t(`harnessVersion.compat.reason.${reasonKey}`, {
    defaultValue: COMPAT_REASON_DEFAULTS[reasonKey] ?? '',
    reference: compat.referenceVersion ?? '',
    mode,
  });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {versionNode}
        <StatusBadge tone={tone}>
          <Icon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {stateLabel}
        </StatusBadge>
      </div>
      {reasonText && <p className="text-[12px] leading-snug text-muted-foreground">{reasonText}</p>}
    </div>
  );
}

export default function HarnessVersionSection({ agent, viewerRole, onOpenSystemTab }: {
  agent: AgentProvider; viewerRole?: string;
  /** T-1866: opens the النظام tab, where the auto-update policy moved. Absent ⇒ plain text pointer. */
  onOpenSystemTab?: () => void;
}) {
  const { t } = useTranslation('settings');
  const auth = useOptionalAuth();
  const isOwner = viewerRole ? viewerRole === 'owner' : auth?.user?.role === 'owner';
  const {
    state, checkNow, startUpdate,
    confirmation, confirmPending, refreshConfirmation, cancelConfirmation,
    actionError, submitting,
    startRestoreCompatible, startRollback, startRecovery,
    snapshots, loadSnapshots,
  } = useHarnessVersion(agent, isOwner);
  const previousAnnouncement = useRef('');
  const [rollbackWithData, setRollbackWithData] = useState(false);
  const [rollbackPanelOpen, setRollbackPanelOpen] = useState(false);
  const announcement = terminal.has(state.status)
    ? t(`harnessVersion.outcome.${state.status}`, { defaultValue: state.status === 'succeeded' ? 'اكتمل تحديث الأداة.' : 'انتهت محاولة التحديث.' })
    : busy.has(state.status) && state.phase
      ? t(`harnessVersion.phase.${state.phase}`, { defaultValue: `مرحلة التحديث: ${state.phase}` }) : '';
  useEffect(() => { previousAnnouncement.current = announcement; }, [announcement]);

  const carrierOnly = agent === 'glm';
  const canStart = !carrierOnly && isOwner && (state.status === 'update-available' || state.status === 'unverified' || mayRetryAfterFreshStatus(state));
  const needsOperator = state.reason === 'recovery_failed';
  const noRollback = state.reason === 'rollback-unavailable' || state.reason === 'rollback_unavailable';
  const needsFreshCheck = state.status === 'skipped-live' || (state.status === 'failed' && !noRollback && (needsOperator || !state.retryReady));

  /**
   * Snapshot listing hashes every data store on the server (can be ~1GB, stalls
   * the event loop) and shares the owner-action rate limit — it must only run
   * on an explicit owner gesture, never on mount / never polled (qa release
   * condition on 01c31f990). Toggling the panel closed does not clear the
   * cached list; reopening re-fetches so a completed rollback/update is reflected.
   */
  const toggleRollbackPanel = () => {
    setRollbackPanelOpen((open) => {
      const next = !open;
      if (next) void loadSnapshots();
      return next;
    });
  };

  const latestSnapshot = snapshots && snapshots.length > 0
    ? snapshots.reduce((newest, entry) => (entry.createdAt >= newest.createdAt ? entry : newest))
    : null;
  const actionErrorText = actionError
    ? t(`harnessVersion.actionError.${actionError.code}`, {
        defaultValue: ACTION_ERROR_DEFAULTS[actionError.code] ?? t('harnessVersion.actionError.generic', { defaultValue: 'تعذّر تنفيذ الإجراء.' }),
      })
    : '';

  return (
    <SettingsCard>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-[15px] font-medium text-foreground">{t('harnessVersion.title', { defaultValue: 'إصدار أداة المزوّد' })}</h4>
            <p className="mt-1 text-[13px] leading-relaxed text-foreground">
              {state.status === 'checking' && t('harnessVersion.checking', { defaultValue: 'جارٍ التحقق من الإصدار…' })}
              {state.status === 'unknown' && t('harnessVersion.unknown', { defaultValue: 'تعذّر التحقق من الإصدار.' })}
              {state.status === 'no-cli' && t('harnessVersion.noCli', { defaultValue: 'لا توجد أداة CLI لهذا المزوّد.' })}
              {state.status === 'managed-external' && (noRollback
                ? t('harnessVersion.rollbackUnavailableStatus', { defaultValue: 'التحديث المباشر غير متاح لأن هذه الأداة لا تدعم الاسترجاع الآمن.' })
                : t('harnessVersion.managedExternal', { defaultValue: 'تُدار هذه الأداة خارج نسّاج.' }))}
              {state.status === 'current' && t('harnessVersion.current', { defaultValue: 'الإصدار المثبت مطابق لأحدث إصدار متحقق منه.' })}
              {state.status === 'unverified' && t('harnessVersion.unverified', { defaultValue: 'الإصدار مثبت، لكن أحدث نسخة لم يمكن التحقق منها.' })}
              {state.status === 'update-available' && t('harnessVersion.available', { defaultValue: 'يتوفر إصدار أحدث.' })}
              {state.status === 'pinned-refused' && t('harnessVersion.pinned', { defaultValue: 'الأداة مثبّتة بسياسة؛ يلزم تعديل التثبيت قبل التحديث.' })}
              {state.status === 'skipped-live' && t('harnessVersion.liveBusy', { defaultValue: 'توجد جلسة نشطة. أعد التحقق بعد انتهائها.' })}
              {state.status === 'failed' && (needsOperator ? t('harnessVersion.recoveryFailed', { defaultValue: 'تعذّر الاسترجاع الآمن. يلزم إصلاح المشغّل.' }) : noRollback ? t('harnessVersion.rollbackUnavailable', { defaultValue: 'فشل التحديث ولا يتوفر استرجاع تلقائي.' }) : t('harnessVersion.failed', { defaultValue: 'فشل التحديث.' }))}
              {state.status === 'succeeded' && t('harnessVersion.succeeded', { defaultValue: 'اكتمل التحديث.' })}
              {state.status === 'noop' && t('harnessVersion.noop', { defaultValue: 'النسخة محدّثة أصلاً.' })}
              {state.status === 'rolled-back' && t('harnessVersion.rolledBack', { defaultValue: 'فشل التحديث فأُرجعت النسخة السابقة تلقائياً.' })}
              {state.status === 'rollback-failed' && t('harnessVersion.rollbackFailed', { defaultValue: 'فشل الاسترجاع الآمن التلقائي. يلزم تدخّل المالك.' })}
              {busy.has(state.status) && t(`harnessVersion.phase.${state.phase ?? 'queued'}`, { defaultValue: state.phase ?? 'queued' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state.version && <bdi dir="ltr" className="rounded-md bg-muted px-2 py-1 font-mono text-[13px] text-foreground">{state.version}</bdi>}
            {state.latestVersion && state.latestVersion !== state.version && <bdi dir="ltr" className="font-mono text-[13px] text-foreground">→ {state.latestVersion}</bdi>}
          </div>
        </div>

        {busy.has(state.status) && <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.progressPercent ?? 0} aria-label={t('harnessVersion.progress', { defaultValue: 'تقدّم التحديث' })} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${state.progressPercent ?? 0}%` }} /></div>}

        {(state.compatibility || state.targetCompatibility || state.drift?.detected) && (
          <div className="space-y-2 rounded-md border border-border/60 bg-muted p-3">
            {state.compatibility && (
              <CompatibilityRow
                t={t}
                compat={state.compatibility}
                label={t('harnessVersion.compat.installedLabel', { defaultValue: 'الإصدار المثبَّت:' })}
              />
            )}
            {state.targetCompatibility && (
              <CompatibilityRow
                t={t}
                compat={state.targetCompatibility}
                label={t('harnessVersion.compat.targetLabel', { defaultValue: 'أحدث نسخة:' })}
                versionNode={state.latestVersion ? <bdi dir="ltr" className="font-mono text-[13px] text-foreground">{state.latestVersion}</bdi> : undefined}
              />
            )}
            {state.drift?.detected && (
              <p data-testid="harness-drift" className="flex flex-wrap items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span>
                  {t('harnessVersion.compat.driftPrefix', { defaultValue: 'تغيّرت من' })}{' '}
                  <bdi dir="ltr" className="font-mono">{state.drift.from}</bdi>{' '}
                  {t('harnessVersion.compat.driftTo', { defaultValue: 'إلى' })}{' '}
                  <bdi dir="ltr" className="font-mono">{state.drift.to}</bdi>{' '}
                  {t('harnessVersion.compat.driftSuffix', { defaultValue: 'خارج نسّاج' })}
                  {state.drift.at && <>{' · '}{t('harnessVersion.compat.driftDate', { defaultValue: `بتاريخ ${state.drift.at.slice(0, 10)}`, date: state.drift.at.slice(0, 10) })}</>}
                </span>
              </p>
            )}
          </div>
        )}

        {isOwner && !carrierOnly && state.notices && (state.notices.dataNotBackedUp || state.notices.selfUpdating) && (
          <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-[13px] leading-relaxed text-foreground">
            {state.notices.dataNotBackedUp && <p>{t('harnessVersion.notices.dataNotBackedUp', { defaultValue: 'بيانات هذه الأداة لا تُنسخ احتياطياً قبل التحديث.' })}</p>}
            {state.notices.selfUpdating && <p>{t('harnessVersion.notices.selfUpdating', { defaultValue: 'قد تُحدِّث هذه الأداة نفسها خارج نسّاج.' })}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(state.status === 'unknown' || needsFreshCheck) && <Button type="button" size="sm" variant="outline" onClick={checkNow}><RefreshCw className="me-2 h-4 w-4" aria-hidden />{t('harnessVersion.recheck', { defaultValue: 'إعادة التحقق' })}</Button>}
          {canStart && <Button type="button" size="sm" onClick={() => void startUpdate()} disabled={submitting}>{t(mayRetryAfterFreshStatus(state) ? 'harnessVersion.retry' : 'harnessVersion.update', { defaultValue: mayRetryAfterFreshStatus(state) ? 'إعادة المحاولة' : 'تحديث' })}</Button>}
          {isOwner && !carrierOnly && state.restoreCompatible && (
            <Button type="button" size="sm" variant="outline" onClick={() => void startRestoreCompatible()} disabled={submitting}>
              {t('harnessVersion.restoreCompatible.button', { defaultValue: 'أرجِع النسخة المتوافقة' })}
            </Button>
          )}
          {isOwner && !carrierOnly && state.status === 'rollback-failed' && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => void startRecovery('retry')} disabled={submitting}>
                {t('harnessVersion.recovery.retry', { defaultValue: 'إعادة محاولة الاسترجاع' })}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void startRecovery('acknowledge')} disabled={submitting}>
                {t('harnessVersion.recovery.acknowledge', { defaultValue: 'تأكيد' })}
              </Button>
            </>
          )}
          {isOwner && !carrierOnly && (
            <Button type="button" size="sm" variant="ghost" aria-expanded={rollbackPanelOpen} onClick={toggleRollbackPanel}>
              {t('harnessVersion.rollback.panelToggle', { defaultValue: 'خيارات الاسترجاع' })}
            </Button>
          )}
        </div>

        {isOwner && !carrierOnly && state.restoreCompatible && !state.restoreCompatible.verified && (
          <p className="text-[12px] leading-snug text-muted-foreground">
            {t('harnessVersion.restoreCompatible.unverified', { defaultValue: 'لم يُثبَت هذا المسار بعملية استرجاع حقيقية على هذا الجهاز بعد.' })}
          </p>
        )}

        {isOwner && !carrierOnly && rollbackPanelOpen && (
          snapshots === null
            ? <p className="text-[13px] text-muted-foreground">{t('harnessVersion.rollback.loading', { defaultValue: 'جارٍ تحميل نسخ الاسترجاع…' })}</p>
            : latestSnapshot
              ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => void startRollback(latestSnapshot.jobId, rollbackWithData ? 'binary+data' : 'binary')}
                  >
                    {t('harnessVersion.rollback.button', { defaultValue: 'رجوع لآخر تحديث' })}
                  </Button>
                  <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-foreground">
                    <input type="checkbox" checked={rollbackWithData} onChange={(event) => setRollbackWithData(event.target.checked)} disabled={submitting} />
                    {t('harnessVersion.rollback.withData', { defaultValue: 'مع البيانات' })}
                  </label>
                </div>
                )
              : <p className="text-[13px] text-muted-foreground">{t('harnessVersion.rollback.none', { defaultValue: 'لا تتوفر نسخة استرجاع لهذه الأداة.' })}</p>
        )}

        {actionError && <p role="alert" className="text-[13px] text-destructive">{actionErrorText}</p>}

        {state.log && state.log.length > 0 && <details className="rounded-md border border-border"><summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-foreground"><ChevronDown className="h-4 w-4" aria-hidden />{t('harnessVersion.logs', { defaultValue: 'سجل التحديث' })}</summary><pre dir="ltr" aria-live="off" className="max-h-48 overflow-auto border-t border-border bg-muted p-3 text-start font-mono text-[13px] text-foreground">{state.log.slice(-200).join('\n')}</pre></details>}
        <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement !== previousAnnouncement.current ? announcement : ''}</span>
        {carrierOnly && <p className="text-[13px] leading-relaxed text-foreground">{t('harnessVersion.glmManagedNote', { defaultValue: 'يعرض GLM حالة ناقل OpenCode ويُحدَّث معه؛ لا توجد عملية تحديث ثانية.' })}</p>}
        {!isOwner && <p className="text-[13px] text-foreground">{t('harnessVersion.ownerOnly', { defaultValue: 'يمكن للمالك تشغيل التحديث؛ حالة الإصدار متاحة لجميع الأعضاء.' })}</p>}
        {/* T-1866: كانت `HarnessAutoUpdateSection` (سياسة الفاصل/التفعيل) تُكرَّر
            هنا في كل صفحة وكيل — نقلها إلى تبويب «النظام» الجديد ووحّدها في
            مكان واحد؛ هذا المؤشّر يبقي الأثر مقروءاً من هنا. */}
        {isOwner && (
          onOpenSystemTab
            ? <button type="button" onClick={onOpenSystemTab} className="inline-flex min-h-11 items-center text-[13px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('harnessVersion.autoUpdateMovedNote', { defaultValue: 'التحديث التلقائي يُضبط من الإعدادات ← النظام' })}</button>
            : <p className="text-[13px] text-foreground">{t('harnessVersion.autoUpdateMovedNote', { defaultValue: 'التحديث التلقائي يُضبط من الإعدادات ← النظام' })}</p>
        )}
        {isOwner && state.manualOnly && <p className="text-[13px] text-muted-foreground">{t('harnessVersion.manualOnlyNote', { defaultValue: 'هذه الأداة تُحدَّث يدوياً فقط؛ لا يشملها الجدول التلقائي.' })}</p>}
      </div>
      {confirmation && (
        <HarnessUpdateConfirmDialog
          confirmation={confirmation}
          submitting={submitting}
          onConfirm={(acks) => void confirmPending(acks)}
          onCancel={cancelConfirmation}
          onRefresh={() => void refreshConfirmation()}
        />
      )}
    </SettingsCard>
  );
}
