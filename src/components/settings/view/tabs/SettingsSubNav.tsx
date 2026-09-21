import { cn } from '../../../../lib/utils';

/**
 * تنقّلٌ فرعي داخل تبويب إعدادات — **شكلٌ واحد لفكرةٍ واحدة**.
 *
 * كان لنفس الفكرة شكلان مقيسان على اللقطات: «الوكلاء» شريطُ تبويبات بخطٍّ سفلي
 * (Account/Engines/Permissions/MCP/Skills)، و«الملف الشخصي» مجموعةُ أقراص
 * مملوءة (Identity/Security). وكلاهما يفعل الشيء نفسه حرفياً: يبدّل أيّ لوحٍ
 * يُعرض. فبقاؤهما شكلين كان يعلّم المستخدم أن الشكل لا يدلّ على شيء.
 *
 * **ولماذا الخطّ السفلي هو الباقي، لا الأقراص:**
 *
 *  1. الأقراص المملوءة نبرةُ `SegmentedControl` نفسها (خيارٌ نشط يرتفع بسطح).
 *     وذاك يختار **قيمة إعدادٍ داخل صفّ**، لا يبدّل لوحاً. إبقاء التعبئة حكراً
 *     على منتقي القيم يجعل الشكل يقول أيّهما هو، بلا لصيقة.
 *  2. ‏§2.4 تسقّف `SegmentedControl` بأربعة خيارات؛ وتنقّل «الوكلاء» ستة. فلو
 *     وُحّدا على الأقراص لخالف الموحَّدُ قاعدته في أوسع استعمالٍ له.
 *  3. الشريط بخطٍّ سفلي يتمدّد على عرض اللوح ويحتمل التمرير الأفقي على الجوّال
 *     بلا أن يصير كتلةَ لونٍ ثقيلة كما تصير ستّة أقراص مملوءة.
 *
 * الأيقونات سقطت من أقراص «الملف الشخصي» عمداً: `UserRound` و`KeyRound` لم
 * تكونا تضيفان إلى «Identity» و«Security» شيئاً لا يقوله النصّ، وكانتا الفرق
 * الثالث بين الشكلين.
 */
export type SettingsSubNavItem<T extends string> = {
  value: T;
  label: string;
  /** معرّف زرّ التبويب — يُمرَّر مع `panelId` أو لا يُمرَّران. */
  id?: string;
  /** معرّف اللوح الذي يحكمه (`aria-controls`). */
  panelId?: string;
};

type SettingsSubNavProps<T extends string> = {
  items: readonly SettingsSubNavItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** لصيقة المجموعة لقارئ الشاشة. */
  label: string;
  /** أصناف على الشريط الحامل للخطّ السفلي. */
  className?: string;
  /** أصناف على صفّ الأزرار — للإزاحة الأفقية في التبويبات الممتدّة للحافّة. */
  listClassName?: string;
};

export default function SettingsSubNav<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
  listClassName,
}: SettingsSubNavProps<T>) {
  return (
    // الخطّ السفلي على الحامل لا على الأزرار: هو خطّ الأساس الذي يقف عليه
    // `border-b-2` للتبويب النشط، ويمتدّ عرض اللوح كاملاً ولو كانت الأزرار مُزاحة.
    <div className={cn('border-b border-border', className)}>
      <div role="tablist" aria-label={label} className={cn('flex overflow-x-auto', listClassName)}>
        {items.map((item) => {
          const isActive = item.value === value;

          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={item.id}
              aria-selected={isActive}
              aria-controls={item.panelId}
              onClick={() => onChange(item.value)}
              className={cn(
                'whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium touch-manipulation',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // فرعان متنافيان لنفس الخاصّيتين: صنفٌ غير مشروط يضبط `border-color`
                // كان يبتلع المشروط بترتيب الملف المولَّد لا بالنيّة (جذر B-373).
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
