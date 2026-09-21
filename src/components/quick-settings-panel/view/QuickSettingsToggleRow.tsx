import { memo } from 'react';
import type { LucideIcon } from 'lucide-react';

import { CHECKBOX_CLASS, TOGGLE_ROW_CLASS } from '../constants';

type QuickSettingsToggleRowProps = {
  label: string;
  icon: LucideIcon;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /**
   * يُعطَّل حين تفرض البيئةُ القيمةَ فلا يملك المستخدم تغييرها هنا.
   * التعطيل هو الفرع الصادق الوحيد: لو بقي فعّالاً وقرأ القيمة المحلولة
   * لارتدّ أمام العين بعد كل ضغطة، ولو قرأ المخزَّنة لما أحدثت ضغطُه أثراً
   * مرئياً — وكلاهما يُعلّم المستخدم ألّا يثق بالتحكّم.
   */
  disabled?: boolean;
  /** سبب التعطيل، سطراً تحت اللصيقة. */
  hint?: string;
};

function QuickSettingsToggleRow({
  label,
  icon: Icon,
  checked,
  onCheckedChange,
  disabled = false,
  hint,
}: QuickSettingsToggleRowProps) {
  return (
    <label className={`${TOGGLE_ROW_CLASS}${disabled ? ' opacity-60' : ''}`}>
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          {label}
          {hint && (
            <span className="block text-xs leading-tight text-muted-foreground">{hint}</span>
          )}
        </span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className={CHECKBOX_CLASS}
      />
    </label>
  );
}

export default memo(QuickSettingsToggleRow);
