import { useTranslation } from 'react-i18next';
import { Archive, ArchiveRestore } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { Button } from '../../../../shared/view/ui';

type CloseConversationButtonProps = {
  closed: boolean;
  /** طلب طائر — يُعطَّل الزرّ ريثما يُحسم كي لا يُطلَق تبديلان متعاكسان. */
  pending?: boolean;
  /** آخر محاولة فشلت وتراجعت الحالة — يُقال ذلك لا يُبتلع. */
  failed?: boolean;
  onToggle: () => void;
  className?: string;
};

/**
 * زرّ إغلاق/إعادة فتح المحادثة (عرضٌ فقط).
 *
 * الحالة كلها في `useConversationClosed` لدى الأب لأن نفس القيمة تُغذّي هذا
 * الزرّ ووسم «مغلقة» في الشريط معاً — مصدرا حقيقة لشيء واحد يفترقان حتماً.
 *
 * الأيقونة أرشيف/استعادة لا سهم اتجاه: الإغلاق فعل حالة لا حركة في التدفّق،
 * فلا تُعكَس بين RTL وLTR.
 */
export default function CloseConversationButton({
  closed,
  pending = false,
  failed = false,
  onToggle,
  className,
}: CloseConversationButtonProps) {
  const { t } = useTranslation('chat');

  const actionLabel = closed
    ? t('closeConversation.reopen', { defaultValue: 'Reopen conversation' })
    : t('closeConversation.close', { defaultValue: 'Close conversation' });

  const failedLabel = t('closeConversation.failed', {
    defaultValue: 'Could not update the conversation state',
  });

  const Icon = closed ? ArchiveRestore : Archive;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-pressed={closed}
        aria-label={actionLabel}
        title={failed ? `${actionLabel} — ${failedLabel}` : actionLabel}
        onClick={onToggle}
        className={cn(
          'h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground',
          closed && 'text-foreground',
          failed && 'text-destructive hover:text-destructive',
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </Button>

      {/* الفشل يصل قارئ الشاشة أيضاً؛ التلميح وحده لا يُنطَق. */}
      <span role="status" aria-live="polite" className="sr-only">
        {failed ? failedLabel : ''}
      </span>
    </>
  );
}
