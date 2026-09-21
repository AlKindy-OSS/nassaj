import { AlertTriangle, Check, HelpCircle, LoaderCircle, Pause, Unplug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import {
  useSessionProcessState,
  useSessionProcessStateAuthority,
} from '../../stores/sessionProcessStateStore';
import { useSessionOutcome } from '../../stores/sessionCompletionStore';
import { useSessionWorkflows } from '../../stores/workflowStatusStore';
import {
  deriveSessionRowIndicatorState,
  type SessionRowIndicatorState,
} from '../../components/sidebar/view/subcomponents/sessionRowIndicatorState';

type SessionProcessBadgeProps = {
  sessionId?: string | null;
  className?: string;
};

const PILL = 'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4';

const STATE_ICON: Record<SessionRowIndicatorState, LucideIcon> = {
  question: HelpCircle,
  error: AlertTriangle,
  done: Check,
  frozen: Pause,
  running: LoaderCircle,
  orphan: Unplug,
};

const STATE_STYLE: Record<SessionRowIndicatorState, string> = {
  question: 'border-primary/30 bg-primary/10 text-primary',
  error: 'border-danger/30 bg-danger/10 text-danger',
  done: 'border-success/30 bg-success/10 text-success',
  frozen: 'border-warning/40 bg-warning/10 text-warning',
  running: 'border-success/30 bg-success/10 text-success',
  orphan: 'border-warning/40 bg-warning/10 text-warning',
};

/**
 * شارة حالة المحادثة النصّية — الكلمة التي يقرؤها المالك: «سؤال / خطأ / انتهت /
 * مجمّدة / تعمل».
 *
 * ‏B-824: هذه الشارة هي التي حذفها الضغطُ من صفّ الشريط الجانبي فبقيت الحالة
 * صامتةً في صورةٍ صغيرة. مكانها الآن رأسُ المحادثة المفتوحة — فيه من العرض ما
 * ليس في صفٍّ ارتفاعه 47px، فتعود الكلمة بلا أن يعود سطرٌ ثانٍ إلى عشرين صفّاً.
 *
 * الترتيب والدلالة من `deriveSessionRowIndicatorState` وحدها، فالشارة والصفّ
 * لا يختلفان أبداً على حالة المحادثة نفسها. اللون رمزيّ (‏`--primary`/`--success`
 * /`--warning`/`--danger`) لا خاماً، كي تتكلّم كل مؤشّرات الحالة لغةً واحدة.
 *
 * اللون ليس الإشارة الوحيدة أبداً: لكل حالة أيقونتُها ونصُّها و`title`.
 * التخطيط بـgap/تدفّق منطقي، فلا يحتاج RTL تجاوزات.
 */
export default function SessionProcessBadge({ sessionId, className }: SessionProcessBadgeProps) {
  const { t } = useTranslation('common');
  const processState = useSessionProcessState(sessionId);
  const processStateAuthoritative = useSessionProcessStateAuthority(sessionId);
  const outcome = useSessionOutcome(sessionId);
  const workflows = useSessionWorkflows(sessionId);
  const hasRunningWorkflow = workflows.some(
    (workflow) => workflow.status === 'running',
  );
  const hasOrphanWorkflow = workflows.some((workflow) => workflow.status === 'orphan');
  const state = deriveSessionRowIndicatorState(
    processStateAuthoritative ? processState : null,
    outcome,
    hasRunningWorkflow,
    hasOrphanWorkflow,
  );

  if (!state) return null;

  const Icon = STATE_ICON[state];
  return (
    <span
      role="status"
      data-session-status-pill={state}
      title={t(`sessionProcessState.${state}Hint`)}
      className={cn(PILL, STATE_STYLE[state], className)}
    >
      <Icon
        className={cn(
          'h-2.5 w-2.5',
          state === 'running' && 'motion-safe:animate-spin motion-reduce:animate-none',
        )}
        aria-hidden="true"
      />
      {t(`sessionProcessState.${state}`)}
    </span>
  );
}
