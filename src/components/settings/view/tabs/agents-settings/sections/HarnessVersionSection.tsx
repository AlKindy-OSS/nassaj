import { ChevronDown, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentProvider } from '../../../../types/types';
import { useOptionalAuth } from '../../../../../auth/context/AuthContext';
import { mayRetryAfterFreshStatus } from '../../../../../../hooks/harnessVersionMapping';
import { useHarnessVersion } from '../../../../../../hooks/useHarnessVersion';
import { Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

const busy = new Set(['queued', 'running']);
const terminal = new Set(['succeeded', 'failed', 'skipped-live', 'pinned-refused']);

export default function HarnessVersionSection({ agent, viewerRole }: { agent: AgentProvider; viewerRole?: string }) {
  const { t } = useTranslation('settings');
  const auth = useOptionalAuth();
  const isOwner = viewerRole ? viewerRole === 'owner' : auth?.user?.role === 'owner';
  const { state, checkNow, startUpdate } = useHarnessVersion(agent, isOwner);
  const previousAnnouncement = useRef('');
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
              {busy.has(state.status) && t(`harnessVersion.phase.${state.phase ?? 'queued'}`, { defaultValue: state.phase ?? 'queued' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state.version && <bdi dir="ltr" className="rounded-md bg-muted px-2 py-1 font-mono text-[13px] text-foreground">{state.version}</bdi>}
            {state.latestVersion && state.latestVersion !== state.version && <bdi dir="ltr" className="font-mono text-[13px] text-foreground">→ {state.latestVersion}</bdi>}
          </div>
        </div>

        {busy.has(state.status) && <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.progressPercent ?? 0} aria-label={t('harnessVersion.progress', { defaultValue: 'تقدّم التحديث' })} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${state.progressPercent ?? 0}%` }} /></div>}

        <div className="flex flex-wrap gap-2">
          {(state.status === 'unknown' || needsFreshCheck) && <Button type="button" size="sm" variant="outline" onClick={checkNow}><RefreshCw className="me-2 h-4 w-4" aria-hidden />{t('harnessVersion.recheck', { defaultValue: 'إعادة التحقق' })}</Button>}
          {canStart && <Button type="button" size="sm" onClick={() => void startUpdate()}>{t(mayRetryAfterFreshStatus(state) ? 'harnessVersion.retry' : 'harnessVersion.update', { defaultValue: mayRetryAfterFreshStatus(state) ? 'إعادة المحاولة' : 'تحديث' })}</Button>}
        </div>

        {state.log && state.log.length > 0 && <details className="rounded-md border border-border"><summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-foreground"><ChevronDown className="h-4 w-4" aria-hidden />{t('harnessVersion.logs', { defaultValue: 'سجل التحديث' })}</summary><pre dir="ltr" aria-live="off" className="max-h-48 overflow-auto border-t border-border bg-muted p-3 text-start font-mono text-xs text-foreground">{state.log.slice(-200).join('\n')}</pre></details>}
        <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement !== previousAnnouncement.current ? announcement : ''}</span>
        {carrierOnly && <p className="text-[13px] leading-relaxed text-foreground">{t('harnessVersion.glmManagedNote', { defaultValue: 'يعرض GLM حالة ناقل OpenCode ويُحدَّث معه؛ لا توجد عملية تحديث ثانية.' })}</p>}
        {!isOwner && <p className="text-[13px] text-foreground">{t('harnessVersion.ownerOnly', { defaultValue: 'يمكن للمالك تشغيل التحديث؛ حالة الإصدار متاحة لجميع الأعضاء.' })}</p>}
      </div>
    </SettingsCard>
  );
}
