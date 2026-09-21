import { Check } from 'lucide-react';

import { cn } from '../../../lib/utils';

/**
 * مصفوفة اختيار: عدة كيانات × نفس المجموعة المرتّبة من الطبقات
 * (`docs/design/SETTINGS-SURFACE-LANGUAGE.md` §2.5).
 *
 * **العلّة في الشكل الذي حلّت محلّه:** بطاقة مؤطَّرة لكل دور، وداخل كلٍّ منها
 * منتقٍ مؤطَّر — ستة صناديق لجدولٍ واحد، وأسماء الطبقات الأربع مكرّرة ثلاث مرات
 * (١٢ لصيقة). والأهمّ: ترتيب الطبقات تراكميٌّ لكنه كان **غير مرئي**، فاحتاج
 * فقرات شرح مطويّة في `<details>` رابع تقول ما كان يجب أن تقوله الصورة.
 *
 * **الحلّ:** شبكة واحدة، رؤوس الأعمدة تُكتب مرة واحدة، والخلايا الأدنى من
 * المحدَّد تُصبغ صبغةً خافتة — فيُقرأ التراكم بالعين لا بالنصّ.
 *
 * ثلاث قواعد تحكم التنفيذ:
 *
 * - **اللصيقات القصيرة في الرؤوس هي ما يُبقي الشبكة عاملةً على 375px** بلا تمرير
 *   أفقي؛ الاسم الكامل يعيش في `aria-label` و`title`.
 * - **الخطر عمودٌ لا نبرةَ صفّ:** العمود المعلَّم `danger` يأخذ `bg-destructive`
 *   عند تحديده فقط — لا إطار أحمر حول الصفّ كلّه.
 * - **كل فرع لون خلفية متنافٍ مع أخيه** ولا يوجد صنف أساس غير مشروط لنفس
 *   الخاصية: صنفان يضبطان `background-color` يحسمهما ترتيب الملف المولَّد لا
 *   النيّة (جذر B-373).
 *
 * ترتيب الأعمدة يتبع `dir` تلقائياً في CSS Grid، فلا تحتاج المصفوفة شرطاً واحداً
 * للـRTL.
 */
export type TierMatrixTier<T extends string> = {
  value: T;
  /** لصيقة الرأس — قصيرة عمداً (تعمل على 375px). */
  shortLabel: string;
  /** الاسم الكامل: `aria-label` و`title`. */
  label: string;
  /** عمود يرفع حاجزاً أمنياً أو ينفّذ فعلاً لا رجعة فيه. */
  danger?: boolean;
};

export type TierMatrixRow<K extends string> = {
  key: K;
  label: string;
};

type TierMatrixProps<K extends string, T extends string> = {
  tiers: readonly TierMatrixTier<T>[];
  rows: readonly TierMatrixRow<K>[];
  value: Record<K, T>;
  onChange: (row: K, tier: T) => void;
  /** يعيد سبب المنع نصّاً، أو `null` إن كانت الخلية متاحة. */
  blockedReason?: (row: K, tier: T) => string | null;
  /** لصيقة عمود الأسماء لقارئ الشاشة (عمود بلا رأس مرئي). */
  rowHeaderLabel: string;
  className?: string;
};

export default function TierMatrix<K extends string, T extends string>({
  tiers,
  rows,
  value,
  onChange,
  blockedReason,
  rowHeaderLabel,
  className,
}: TierMatrixProps<K, T>) {
  const grid = 'grid items-center gap-1';
  const gridStyle = {
    gridTemplateColumns: `minmax(4.5rem,1fr) repeat(${tiers.length}, minmax(0,1fr))`,
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {/* رؤوس الأعمدة بصرية فقط — اسم الخيار يصل قارئ الشاشة من `aria-label` الخلية. */}
      <div className={cn(grid, 'pb-0.5')} style={gridStyle} aria-hidden="true">
        <span aria-label={rowHeaderLabel} />
        {tiers.map((tier) => (
          <span
            key={tier.value}
            className="px-1 text-center text-[13px] leading-tight text-muted-foreground"
          >
            {tier.shortLabel}
          </span>
        ))}
      </div>

      {rows.map((row) => {
        const active = value[row.key];
        const activeIndex = tiers.findIndex((tier) => tier.value === active);

        return (
          <div
            key={row.key}
            role="radiogroup"
            aria-label={row.label}
            className={grid}
            style={gridStyle}
          >
            <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
            {tiers.map((tier, index) => {
              const isActive = index === activeIndex;
              // «مشمولة تراكمياً»: أدنى من المحدَّد وليست العمود الصفري.
              const isIncluded = index > 0 && index < activeIndex;
              const blocked = blockedReason?.(row.key, tier.value) ?? null;

              return (
                <button
                  key={tier.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  aria-label={tier.label}
                  // roving tabindex: صفٌّ واحد = محطة تبويب واحدة.
                  tabIndex={isActive ? 0 : -1}
                  disabled={Boolean(blocked)}
                  title={blocked ?? tier.label}
                  onClick={() => onChange(row.key, tier.value)}
                  className={cn(
                    'flex min-h-[2.25rem] items-center justify-center rounded-md',
                    'text-[13px] font-medium leading-tight transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'focus-visible:ring-offset-1 focus-visible:ring-offset-card',
                    isActive && tier.danger && 'bg-destructive text-danger-foreground',
                    isActive && !tier.danger && 'bg-primary text-primary-foreground',
                    !isActive && isIncluded && 'bg-primary/15 text-foreground',
                    !isActive && !isIncluded && 'bg-muted text-muted-foreground hover:text-foreground',
                    blocked && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {isActive && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
