import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils';

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

// اللصيقة مفتاح لا نصّ: هذا الكائن على مستوى الوحدة، فما فيه لا يمرّ بـ`t`
// وكان يُعرض إنجليزياً في كل لغة (B-524).
const STATUS_CONFIG: Record<ToolStatus, { labelKey: string; className: string }> = {
  running: {
    labelKey: 'toolStatus.running',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  completed: {
    labelKey: 'toolStatus.completed',
    className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  },
  error: {
    labelKey: 'toolStatus.error',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  denied: {
    labelKey: 'toolStatus.denied',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  },
};

interface ToolStatusBadgeProps {
  status: ToolStatus;
  className?: string;
}

export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const { t } = useTranslation('chat');
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {t(config.labelKey)}
    </span>
  );
}
