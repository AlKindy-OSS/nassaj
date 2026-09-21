import type { KeyboardEvent } from 'react';

import { cn } from '../../../lib/utils';

/**
 * منتقٍ مجزّأ (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §2.4).
 *
 * **يحلّ محلّ `TierMatrix`، وسببُ إحلاله مقيسٌ على لقطة لا مستنتَج.** المصفوفة
 * وضعت أسماء الخيارات في رؤوس أعمدةٍ وتركت الخلايا فارغة، فخرجت على الشاشة اثني
 * عشر مربّعاً صامتاً تُقرأ جدولاً معطوباً لا تحكّماً — والاسم كان في `aria-label`
 * وحده، أي أن قارئ الشاشة كان يعرف ما لا تعرفه العين.
 *
 * القاعدة المستخلصة والمُلزِمة هنا: **لا خيارَ يُعرَف بموضعه.** كل خيار يحمل نصّه
 * داخله.
 *
 * والحالة النشطة ترتفع بسطحٍ أفتح لا بلونٍ صارخ — إلا الخَطِر، فهو الوحيد الذي
 * يستحقّ `bg-destructive`، ولو صُبغ غيرُه لضاعت الإشارة.
 */
export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** يرفع حاجزاً أمنياً أو ينفّذ فعلاً لا رجعة فيه. */
  danger?: boolean;
  /** سبب المنع نصّاً — يظهر في `title`. الخيار الممنوع يبقى مرئياً لا يُخفى. */
  blockedReason?: string | null;
};

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** لصيقة المجموعة لقارئ الشاشة. */
  label: string;
  className?: string;
};

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<T>) {
  /**
   * ‏[a11y — WCAG 2.1.1] تنقّلٌ بالأسهم داخل المجموعة.
   *
   * ‏`roving tabindex` وحده كان يجعل المجموعة محطة تبويب واحدة **ويقطع الطريق
   * إلى بقية الخيارات**: الفعّال وحده كان `tabIndex=0` والباقي `-1`، ولا معالج
   * أسهم — فمستخدم لوحة المفاتيح يصل إلى التحكّم ولا يستطيع تغيير قيمته. وهذا
   * هو نصف العقد المفقود في نمط `radiogroup`: الأسهم تنقل التركيز **وتغيّر
   * القيمة** كما في مجموعة الأزرار الأصلية.
   *
   * والاتجاه منطقيّ لا فيزيائي: في RTL يمضي `ArrowLeft` إلى **التالي** لأن
   * الترتيب البصري معكوس، وإلّا تحرّك المؤشّر عكس ما تراه العين في كل واجهة
   * عربية.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
      return;
    }

    const selectable = options.filter((option) => !option.blockedReason);
    if (selectable.length === 0) {
      return;
    }

    const isRtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = key === 'ArrowDown'
      || (key === 'ArrowRight' && !isRtl)
      || (key === 'ArrowLeft' && isRtl);

    const currentIndex = selectable.findIndex((option) => option.value === value);
    let nextIndex: number;
    if (key === 'Home') {
      nextIndex = 0;
    } else if (key === 'End') {
      nextIndex = selectable.length - 1;
    } else if (currentIndex === -1) {
      nextIndex = 0;
    } else {
      // لفٌّ دائري كما في مجموعة الأزرار الأصلية.
      nextIndex = (currentIndex + (forward ? 1 : -1) + selectable.length) % selectable.length;
    }

    const next = selectable[nextIndex];
    if (!next || next.value === value) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    onChange(next.value);
    // التركيز يتبع القيمة: الزرّ الجديد هو الوحيد الذي يصير `tabIndex=0`.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
    const domIndex = options.findIndex((option) => option.value === next.value);
    buttons[domIndex]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex rounded-md border border-input bg-muted p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option.value === value;
        const blocked = Boolean(option.blockedReason);

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            // roving tabindex: المجموعة كلها محطة تبويب واحدة.
            tabIndex={isActive ? 0 : -1}
            disabled={blocked}
            title={option.blockedReason ?? undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[5px] px-3 py-1.5 text-[13px] font-medium leading-none',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // فروعٌ متنافية بالكامل: صنفان يضبطان `background-color` يحسمهما
              // ترتيب الملف المولَّد لا النيّة (جذر B-373).
              isActive && option.danger && 'bg-destructive font-semibold text-danger-foreground',
              // السطح الأفتح وحده لم يكن يُرى: على نسق الكريم الفارق بين
              // `bg-background` و`bg-muted` بضع نقاط إضاءة، فكان المالك يبدّل
              // القيمة ولا يرى أيّها اختار (لقطة 2026-08-04). الحلّ يبقى ضمن
              // قاعدة «سطحٌ أفتح لا لونٌ صارخ»، لكنه يضيف إليها ثلاث إشارات
              // مستقلّة — إطار وظلّ ووزن خطّ — فلا يعتمد التمييز على فارق
              // إضاءةٍ واحد قد يبتلعه أي نسق.
              isActive && !option.danger && 'bg-background font-semibold text-foreground shadow-sm ring-1 ring-border',
              !isActive && 'text-muted-foreground hover:text-foreground',
              blocked && 'cursor-not-allowed opacity-40',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
