import * as React from 'react';

import { cn } from '../../../lib/utils';

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * `dir="auto"` is the base default, overridable per instance via `props.dir`
 * (spread after it below). Search boxes and name fields in this app take either
 * Arabic or Latin input; without it a Latin query typed into an RTL field is
 * laid out against an RTL base, so trailing punctuation and digits jump to the
 * wrong edge. The value is static (never streamed), which is exactly the case
 * the first-strong heuristic gets right.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        dir="auto"
        className={cn(
          // الارتفاع 10 (40px) وحلقة تركيز بسمك 2: مقاس الحقل في الأصل
          // (‏upstream claudecodeui). ‏h-9 + ring-1 جعل الحقل يقرأ كخليّة جدول لا
          // كمدخل، وهدف اللمس دون 44px المُوصى به على الجوّال.
          'flex h-[var(--control-height-default)] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';

export { Input };
