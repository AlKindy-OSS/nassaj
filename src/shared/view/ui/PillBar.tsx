import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../../../lib/utils';

/* ── Container ─────────────────────────────────────────────────── */
type PillBarProps = {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>;

// T-1867: `ref` مُوجَّه إلى الحاوية — مصدر السكرول الأفقي في الجوّال — كي
// يمكن تمرير اللصيقة النشطة إليه (`scrollIntoView`) عند تغيّر التبويب من
// مصدرٍ غير النقر عليه مباشرة (رابط عميق، مؤشّر نصّي في قسم آخر).
export const PillBar = forwardRef<HTMLDivElement, PillBarProps>(function PillBar(
  { children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={cn('inline-flex items-center gap-[2px] rounded-lg bg-muted/60 p-[3px]', className)}
    >
      {children}
    </div>
  );
});

/* ── Individual pill button ────────────────────────────────────── */
type PillProps = {
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'children'>;

export function Pill({ isActive, onClick, children, className, ...rest }: PillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className={cn(
        'flex touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150',
        isActive
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground active:bg-background/50',
        className,
      )}
    >
      {children}
    </button>
  );
}
