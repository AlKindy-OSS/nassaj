import { AlertTriangle, ChevronDown, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentProvider } from '../../../../types/types';
import { useOptionalAuth } from '../../../../../auth/context/AuthContext';
import { mayRetryAfterFreshStatus } from '../../../../../../hooks/harnessVersionMapping';
import { useHarnessVersion } from '../../../../../../hooks/useHarnessVersion';
import { Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

import HarnessUpdateConfirmDialog from './HarnessUpdateConfirmDialog';

const busy = new Set(['queued', 'running']);
const terminal = new Set(['succeeded', 'failed', 'skipped-live', 'pinned-refused', 'noop', 'rolled-back', 'rollback-failed']);

/** T-1871 stage 4: default server message when the client has no specific string for an action-refusal code. */
const ACTION_ERROR_DEFAULTS: Record<string, string> = {
  STORE_IN_USE: 'الأداة تستخدم ملفات بياناتها الآن؛ أغلقها ثم أعد المحاولة.',
  STORE_ACCESS_UNPROVABLE: 'الأداة تستخدم ملفات بياناتها الآن؛ أغلقها ثم أعد المحاولة.',
  INSUFFICIENT_STORAGE: 'المساحة المتاحة لا تكفي لتحديث آمن.',
};

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
              {state.status === 'no-cli' && t('harnessVersion.noCli', { defaultValue: 'لا توجد أداة سطر أوامر لهذا المزوّد.' })}
              {state.status === 'managed-external' && (noRollback
                ? t('harnessVersion.rollbackUnavailableStatus', { defaultValue: 'التحديث غير متاح لأن الأداة لا تدعم الاسترجاع الآمن.' })
                : t('harnessVersion.managedExternal', { defaultValue: 'تُدار هذه الأداة من خارج نسّاج.' }))}
              {state.status === 'current' && t('harnessVersion.current', { defaultValue: 'تعمل بأحدث إصدار.' })}
              {state.status === 'unverified' && t('harnessVersion.unverified', { defaultValue: 'تعذّر التحقق من أحدث إصدار.' })}
              {state.status === 'update-available' && t('harnessVersion.available', { defaultValue: 'يتوفر إصدار أحدث.' })}
              {state.status === 'pinned-refused' && t('harnessVersion.pinned', { defaultValue: 'قفل الإصدار المفعَّل يمنع التحديث.' })}
              {state.status === 'skipped-live' && t('harnessVersion.liveBusy', { defaultValue: 'توجد جلسة نشطة؛ أعد التحقق بعد انتهائها.' })}
              {state.status === 'failed' && (needsOperator ? t('harnessVersion.recoveryFailed', { defaultValue: 'تعذّر الاسترجاع الآمن؛ يلزم تدخّل يدوي.' }) : noRollback ? t('harnessVersion.rollbackUnavailable', { defaultValue: 'فشل التحديث ولا يتوفر استرجاع تلقائي.' }) : t('harnessVersion.failed', { defaultValue: 'فشل التحديث.' }))}
              {state.status === 'succeeded' && t('harnessVersion.succeeded', { defaultValue: 'اكتمل التحديث.' })}
              {state.status === 'noop' && t('harnessVersion.noop', { defaultValue: 'تعمل بأحدث إصدار.' })}
              {state.status === 'rolled-back' && t('harnessVersion.rolledBack', { defaultValue: 'فشل التحديث وأُعيدت النسخة السابقة تلقائياً.' })}
              {state.status === 'rollback-failed' && t('harnessVersion.rollbackFailed', { defaultValue: 'فشل الاسترجاع التلقائي؛ يلزم تدخّل المالك.' })}
              {busy.has(state.status) && t(`harnessVersion.phase.${state.phase ?? 'queued'}`, { defaultValue: state.phase ?? 'queued' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state.version && <bdi dir="ltr" className="rounded-md bg-muted px-2 py-1 font-mono text-[13px] text-foreground">{state.version}</bdi>}
            {state.latestVersion && state.latestVersion !== state.version && <bdi dir="ltr" className="font-mono text-[13px] text-foreground">→ {state.latestVersion}</bdi>}
          </div>
        </div>

        {busy.has(state.status) && <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.progressPercent ?? 0} aria-label={t('harnessVersion.progress', { defaultValue: 'تقدّم التحديث' })} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${state.progressPercent ?? 0}%` }} /></div>}

        {state.drift?.detected && (
          <p data-testid="harness-drift" className="flex flex-wrap items-start gap-1.5 text-[13px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>
              {t('harnessVersion.drift.from', { defaultValue: 'تغيّر الإصدار من' })}{' '}
              <bdi dir="ltr" className="font-mono">{state.drift.from}</bdi>{' '}
              {t('harnessVersion.drift.to', { defaultValue: 'إلى' })}{' '}
              <bdi dir="ltr" className="font-mono">{state.drift.to}</bdi>{' '}
              {t('harnessVersion.drift.outside', { defaultValue: 'خارج نسّاج' })}
              {state.drift.at && <>{' · '}{t('harnessVersion.drift.date', { defaultValue: `في ${state.drift.at.slice(0, 10)}`, date: state.drift.at.slice(0, 10) })}</>}
            </span>
          </p>
        )}

        {isOwner && !carrierOnly && state.notices && (state.notices.dataNotBackedUp || state.notices.selfUpdating) && (
          <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-[13px] leading-relaxed text-foreground">
            {state.notices.dataNotBackedUp && <p>{t('harnessVersion.notices.dataNotBackedUp', { defaultValue: 'لا تُنسخ بيانات هذه الأداة احتياطياً قبل التحديث.' })}</p>}
            {state.notices.selfUpdating && <p>{t('harnessVersion.notices.selfUpdating', { defaultValue: 'قد تُحدِّث الأداة نفسها خارج نسّاج.' })}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(state.status === 'unknown' || state.status === 'unverified' || needsFreshCheck) && <Button type="button" size="sm" variant="outline" onClick={checkNow}><RefreshCw className="me-2 h-4 w-4" aria-hidden />{t('harnessVersion.recheck', { defaultValue: 'إعادة التحقق' })}</Button>}
          {canStart && <Button type="button" size="sm" onClick={() => void startUpdate()} disabled={submitting}>{t(mayRetryAfterFreshStatus(state) ? 'harnessVersion.retry' : 'harnessVersion.update', { defaultValue: mayRetryAfterFreshStatus(state) ? 'إعادة المحاولة' : 'تحديث' })}</Button>}
          {isOwner && !carrierOnly && state.restoreCompatible && (
            <Button type="button" size="sm" variant="outline" onClick={() => void startRestoreCompatible()} disabled={submitting}>
              {t('harnessVersion.restoreCompatible.button', { defaultValue: `استرجاع الإصدار ${state.restoreCompatible.version}`, version: state.restoreCompatible.version })}
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
            {t('harnessVersion.restoreCompatible.unverified', { defaultValue: 'لم يُجرَّب هذا الاسترجاع على هذا الخادم بعد.' })}
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
                    {t('harnessVersion.rollback.button', { defaultValue: 'الرجوع إلى ما قبل آخر تحديث' })}
                  </Button>
                  <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-foreground">
                    <input type="checkbox" checked={rollbackWithData} onChange={(event) => setRollbackWithData(event.target.checked)} disabled={submitting} />
                    {t('harnessVersion.rollback.withData', { defaultValue: 'مع البيانات' })}
                  </label>
                </div>
                )
              : <p className="text-[13px] text-muted-foreground">{t('harnessVersion.rollback.none', { defaultValue: 'لا توجد نسخة استرجاع لهذه الأداة.' })}</p>
        )}

        {actionError && <p role="alert" className="text-[13px] text-destructive">{actionErrorText}</p>}

        {state.log && state.log.length > 0 && <details className="rounded-md border border-border"><summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-foreground"><ChevronDown className="h-4 w-4" aria-hidden />{t('harnessVersion.logs', { defaultValue: 'سجلّ التحديث' })}</summary><pre dir="ltr" aria-live="off" className="max-h-48 overflow-auto border-t border-border bg-muted p-3 text-start font-mono text-[13px] text-foreground">{state.log.slice(-200).join('\n')}</pre></details>}
        <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement !== previousAnnouncement.current ? announcement : ''}</span>
        {carrierOnly && <p className="text-[13px] leading-relaxed text-foreground">{t('harnessVersion.glmManagedNote', { defaultValue: 'يعمل GLM عبر OpenCode ويُحدَّث معه.' })}</p>}
        {!isOwner && <p className="text-[13px] text-foreground">{t('harnessVersion.ownerOnly', { defaultValue: 'التحديث متاح للمالك وحده.' })}</p>}
        {/* T-1866: كانت `HarnessAutoUpdateSection` (سياسة الفاصل/التفعيل) تُكرَّر
            هنا في كل صفحة وكيل — نقلها إلى تبويب «النظام» الجديد ووحّدها في
            مكان واحد؛ هذا المؤشّر يبقي الأثر مقروءاً من هنا. */}
        {isOwner && !state.manualOnly && (
          onOpenSystemTab
            ? <button type="button" onClick={onOpenSystemTab} className="inline-flex min-h-11 items-center text-[13px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t('harnessVersion.autoUpdateMovedNote', { defaultValue: 'إعدادات التحديث التلقائي في تبويب «النظام»' })}</button>
            : <p className="text-[13px] text-foreground">{t('harnessVersion.autoUpdateMovedNote', { defaultValue: 'إعدادات التحديث التلقائي في تبويب «النظام»' })}</p>
        )}
        {isOwner && state.manualOnly && <p className="text-[13px] text-muted-foreground">{t('harnessVersion.manualOnlyNote', { defaultValue: 'لا يشملها التحديث التلقائي؛ تُحدَّث يدوياً.' })}</p>}
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
