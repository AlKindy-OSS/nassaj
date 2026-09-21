import type { ReactNode } from 'react';
import { useId } from 'react';
import { X } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';

/**
 * صدفة مودالات إدارة المستخدمين (الدعوة وإعادة التعيين).
 *
 * وُجدت لأن اللوح نفسه كان منسوخاً حرفياً في ملفين — نفس الغطاء، ونفس
 * `max-w-md`، ونفس شريط العنوان بزرّ الإغلاق. نسختان للشكل الواحد تنحرفان
 * بأول تعديل يلمس إحداهما.
 *
 * `rounded-xl` باقٍ هنا وحده: صدفة المودال خارج نطاق لغة سطوح الإعدادات،
 * وهي الاستثناء الوحيد المسموح به لهذه الاستدارة
 * (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §1).
 *
 * **لا سلوك في الصدفة:** لا مفتاح Escape ولا حبس تركيز — كلاهما يختلف اليوم
 * بين المودالين، وإضافته هنا تغيّر سلوك أحدهما بلا طلب.
 */
type UserDialogShellProps = {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional stable id from the caller (useId). Falls back to an internal id. */
  titleId?: string;
};

export default function UserDialogShell({
  title,
  closeLabel,
  onClose,
  children,
  titleId: titleIdProp,
}: UserDialogShellProps) {
  const internalId = useId();
  const titleId = titleIdProp ?? internalId;
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id={titleId} className="text-base font-semibold leading-snug text-foreground">{title}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="w-9 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
