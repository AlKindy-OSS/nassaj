import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

/**
 * قسم قابل للطي (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §2.9).
 *
 * سطحٌ بلا إطار (`bg-muted`): في الوضع الداكن `--border` و`--muted` متطابقان
 * حرفياً في `src/index.css`، فحدٌّ حول سطحٍ مصبوغ لا يرسم بكسلاً واحداً هناك
 * ويضيف ضجيجاً في الفاتح.
 *
 * **لا يُطوى تحذيرٌ مشروطٌ بحالة قائمة أبداً** — الطيّ للشرح الذي يحتاجه بعض
 * المستخدمين بعض الوقت، لا لتحذيرٍ يعني أن حاجزاً مرفوع الآن.
 *
 * ‏`duration-200` للتخطيط و`duration-150` للون: أقرب ما في مقياس Tailwind إلى
 * بذرة الحركة Snap (220ms / 120ms). والسهم يدور حول محور أفقي فلا يُعكس في RTL.
 */
type SettingsCollapsibleProps = {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
};

export default function SettingsCollapsible({
  summary,
  children,
  defaultOpen,
  className,
}: SettingsCollapsibleProps) {
  return (
    <details className={cn('group', className)} open={defaultOpen}>
      <summary
        className={cn(
          // بلا سطح ولا حشو مرئي: السطح المصبوغ كان يعيد رسم صندوقٍ لسطرٍ واحد.
          // min-h-[2.75rem] يضمن هدفاً للمسّ ≥44px (WCAG 2.5.8) دون رفع
          // الحشو المرئي وتغيير نسب التبويبات الأخرى.
          'flex min-h-[2.75rem] w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm',
          'text-[13px] leading-relaxed text-muted-foreground transition-colors duration-150',
          'hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {summary}
        <ChevronDown
          className="h-4 w-4 flex-shrink-0 transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
