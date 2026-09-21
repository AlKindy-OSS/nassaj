import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import {
  useAnySessionFrozen,
  useAnySessionProcessing,
} from '../../stores/sessionProcessStateStore';
import { useProjectOutcome } from '../../stores/sessionCompletionStore';

type ProjectBusyDotProps = {
  /** Ids of the project's (loaded) sessions — the dot aggregates their states. */
  sessionIds: ReadonlyArray<string | null | undefined>;
  className?: string;
};

/** 10px — the same step the row's status plate uses, so the two read as one system. */
const DOT = 'relative inline-flex h-2.5 w-2.5 flex-shrink-0';

/**
 * Activity dot next to a project's name in the sidebar — the rollup of its
 * sessions' states:
 *
 *  - question → نقطة `--primary` نابضة: محادثةٌ تنتظر جواب المستخدم. تعلو على
 *               الكلّ — حتى على جولةٍ حيّة: تلك تنتظر النموذج، وهذه تنتظره هو
 *               (B-544).
 *  - running  → نقطة `--primary` نابضة: جولةٌ حيّة في إحدى جلساته.
 *  - frozen   → نقطة `--warning`: جلسةٌ مجمَّدة بـ`kill -STOP` (B-824 — كانت
 *               هذه الحالة غير مرئية على مستوى المشروع أصلاً).
 *  - error    → نقطة `--danger`: جلسةٌ انتهت بخطأ أو توقّفت بلا ردّ ولم تُفتح.
 *  - done     → نقطة `--success` ثابتة: جلسةٌ اكتملت ولم تُفتح. فتحُها يُطفئها.
 *  - idle     → renders nothing.
 *
 * الألوان رموزٌ لا قيمٌ خام (كانت `bg-blue-500`/`bg-green-500`)، فتتكلّم النقطةُ
 * وشارةُ الصفّ وشارةُ الرأس لغةً واحدة. واللون ليس الإشارة الوحيدة: لكل حالة
 * `role`/`title`/`aria-label` خاصّ بها. التخطيط flex/gap فلا يحتاج RTL تجاوزات.
 */
export default function ProjectBusyDot({ sessionIds, className }: ProjectBusyDotProps) {
  const { t } = useTranslation('common');
  const busy = useAnySessionProcessing(sessionIds);
  const frozen = useAnySessionFrozen(sessionIds);
  const outcome = useProjectOutcome(sessionIds);

  if (outcome === 'question') {
    return <PulsingDot hint={t('sessionProcessState.projectQuestionHint')} tone="bg-primary" className={className} />;
  }

  if (busy) {
    return <PulsingDot hint={t('sessionProcessState.projectBusyHint')} tone="bg-primary" className={className} />;
  }

  if (frozen) {
    return <SteadyDot hint={t('sessionProcessState.projectFrozenHint')} tone="bg-warning" className={className} />;
  }

  if (outcome === 'error') {
    return <SteadyDot hint={t('sessionProcessState.projectErrorHint')} tone="bg-danger" className={className} />;
  }

  if (outcome === 'done') {
    return <SteadyDot hint={t('sessionProcessState.projectDoneHint')} tone="bg-success" className={className} />;
  }

  return null;
}

type DotProps = { hint: string; tone: string; className?: string };

/** Live states only: the ping is what says "right now". */
function PulsingDot({ hint, tone, className }: DotProps) {
  return (
    <span role="status" aria-label={hint} title={hint} className={cn(DOT, className)}>
      <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', tone)} aria-hidden="true" />
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', tone)} aria-hidden="true" />
    </span>
  );
}

/** Settled states: a result waiting to be read, not an animation to be watched. */
function SteadyDot({ hint, tone, className }: DotProps) {
  return (
    <span role="status" aria-label={hint} title={hint} className={cn(DOT, className)}>
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', tone)} aria-hidden="true" />
    </span>
  );
}
