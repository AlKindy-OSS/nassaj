import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';

/**
 * حقل نصّي يتبعه إجراء (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §2.7).
 *
 * وُجد لأن الفكرة نفسها كانت بأربعة تخطيطات مختلفة: زرّ أسفل الحقل، وزرّ بجانبه
 * داخل صندوق مؤطَّر، وزرّ بجانبه بلا صندوق، و`justify-end`.
 *
 * **حدّ الحقل ليس طبقةً من طبقات §1:** حدود التحكّمات مطلوبة بـWCAG 1.4.11
 * لتحديد المكوّن، وهي خارج ميزانية الإطارات. المعيار لا يُوسَّع (STYLE_LOCK §2.5)
 * ولا يُضيَّق.
 *
 * ‏`dir="ltr"` + `unicodeBidi: isolate` للقيم التقنية (أمر، مسار، مفتاح): العزل
 * يمنع تسرّب الأساس العربي إلى داخل القيمة دون أن يمنح القيمة أساساً خاصاً بها.
 */
type FieldWithActionProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  actionLabel: string;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  /** قيمة تقنية (أمر/مسار/مفتاح): اتجاه لاتيني معزول وخطّ أحادي المسافة. */
  technical?: boolean;
  className?: string;
};

export default function FieldWithAction({
  id,
  label,
  value,
  onChange,
  onSubmit,
  actionLabel,
  placeholder,
  hint,
  error,
  disabled,
  technical,
  className,
}: FieldWithActionProps) {
  const canSubmit = !disabled && value.trim().length > 0;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-foreground">
        {label}
      </label>
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          dir={technical ? 'ltr' : undefined}
          style={technical ? { unicodeBidi: 'isolate' } : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            'min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5',
            'text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            technical && 'font-mono text-[13px]',
          )}
        />
        <Button
          size="sm"
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="flex-shrink-0 px-3"
        >
          {actionLabel}
        </Button>
      </div>
      {hint && <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[13px] leading-relaxed text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
