import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import {
  getSessionProcessState,
  isSessionProcessStateAuthoritative,
  subscribeSessionProcessState,
} from '../../stores/sessionProcessStateStore';
import { getSessionOutcome, subscribeSessionCompletion } from '../../stores/sessionCompletionStore';
import { getSessionWorkflows, subscribeWorkflowStatus } from '../../stores/workflowStatusStore';
import { useProjectIndicatorSessionIds } from '../../stores/projectIndicatorSessionIds';
import {
  deriveProjectIndicatorState,
  deriveSessionRowIndicatorState,
  type SessionRowIndicatorState,
} from '../../components/sidebar/view/subcomponents/sessionRowIndicatorState';

type ProjectBusyDotProps = {
  /** DB project id (server's `projectId`), or null when unknown. */
  projectId: string | null;
  /** Ids of the project's loaded/paginated sessions. */
  loadedIds: ReadonlyArray<string | null | undefined>;
  className?: string;
};

/**
 * Non-reactive: reduces one project's session ids to the single indicator
 * state `ProjectBusyDot` renders, reusing the exact per-row derivation the
 * sidebar row and chat-header badge already use (`deriveSessionRowIndicatorState`)
 * so the three surfaces can never disagree about the same session (B-824's
 * parity, extended to the project rollup in B-1431).
 */
function computeProjectIndicatorState(ids: ReadonlyArray<string>): SessionRowIndicatorState | null {
  const rowStates = ids.map((id) => {
    const processState = isSessionProcessStateAuthoritative(id) ? getSessionProcessState(id) : null;
    const outcome = getSessionOutcome(id);
    const workflows = getSessionWorkflows(id);
    const hasRunningWorkflow = workflows.some((workflow) => workflow.status === 'running');
    const hasOrphanWorkflow = workflows.some((workflow) => workflow.status === 'orphan');
    return deriveSessionRowIndicatorState(processState, outcome, hasRunningWorkflow, hasOrphanWorkflow);
  });
  return deriveProjectIndicatorState(rowStates);
}

function subscribeAllIndicatorStores(listener: () => void): () => void {
  const unsubProcess = subscribeSessionProcessState(listener);
  const unsubOutcome = subscribeSessionCompletion(listener);
  const unsubWorkflow = subscribeWorkflowStatus(listener);
  return () => {
    unsubProcess();
    unsubOutcome();
    unsubWorkflow();
  };
}

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
 *  - orphan   → نقطة `--warning` ثابتة: ورشةٌ خلفية توقفت قبل نتيجة مكتملة —
 *               أضعف الحالات المرئية، فتُطفئها أي حالةٍ أخرى في المشروع (B-1431).
 *  - idle     → renders nothing.
 *
 * الألوان رموزٌ لا قيمٌ خام (كانت `bg-blue-500`/`bg-green-500`)، فتتكلّم النقطةُ
 * وشارةُ الصفّ وشارةُ الرأس لغةً واحدة. واللون ليس الإشارة الوحيدة: لكل حالة
 * `role`/`title`/`aria-label` خاصّ بها. التخطيط flex/gap فلا يحتاج RTL تجاوزات.
 *
 * ‏B-1431: `sessionIds` كانت جلسات المشروع **المحمَّلة** فقط (صفحة الشريط
 * الجانبي)، فجلسةٌ حيّة/سؤال/خطأ/انتهاء/تجميد خارج تلك الصفحة لا تُشعل رأس
 * المشروع أبداً. الآن `projectId` + `loadedIds` يُمرَّران إلى
 * `useProjectIndicatorSessionIds`، التي تضمّ إلى المحمَّل كل جلسةٍ تنسبها
 * الخوادم (presence/session_outcome/workflows) إلى نفس المشروع، فيصل المؤشر
 * إلى جلساتٍ لم تُفتح صفوفها قط.
 */
export default function ProjectBusyDot({ projectId, loadedIds, className }: ProjectBusyDotProps) {
  const { t } = useTranslation('common');
  const ids = useProjectIndicatorSessionIds(projectId, loadedIds);
  const state = useSyncExternalStore(subscribeAllIndicatorStores, () => computeProjectIndicatorState(ids));

  if (state === 'question') {
    return <PulsingDot hint={t('sessionProcessState.projectQuestionHint')} tone="bg-primary" className={className} />;
  }

  if (state === 'running') {
    return <PulsingDot hint={t('sessionProcessState.projectBusyHint')} tone="bg-primary" className={className} />;
  }

  if (state === 'frozen') {
    return <SteadyDot hint={t('sessionProcessState.projectFrozenHint')} tone="bg-warning" className={className} />;
  }

  if (state === 'error') {
    return <SteadyDot hint={t('sessionProcessState.projectErrorHint')} tone="bg-danger" className={className} />;
  }

  if (state === 'done') {
    return <SteadyDot hint={t('sessionProcessState.projectDoneHint')} tone="bg-success" className={className} />;
  }

  if (state === 'orphan') {
    return <SteadyDot hint={t('sessionProcessState.projectOrphanHint')} tone="bg-warning" className={className} />;
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
