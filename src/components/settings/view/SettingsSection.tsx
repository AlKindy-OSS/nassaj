import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';

/**
 * نبرة القسم — تلوّن **الأيقونة وحدها**، لا النصّ ولا الخلفية.
 *
 * الأصل (‏upstream claudecodeui) يسبق كل عنوان قسم بأيقونة ملوّنة دلالياً: مثلث
 * تحذير برتقالي فوق «إعدادات الأذونات»، ودرع أخضر فوق «الأدوات المسموحة»، ومثلث
 * خطر أحمر فوق «الأدوات الممنوعة». الأيقونة هنا ليست زينة: هي ما يجعل قسماً في
 * تدفّقٍ طويل قابلاً للتعرّف قبل قراءة عنوانه.
 *
 * الألوان بالرموز حصراً (`--success`/`--warning`/`--danger`)، وهي محروسة بـ
 * `src/lib/themeStatusContrast.test.ts` عند ≥4.5:1 على كل بريست ووضع وسطح.
 */
export type SettingsTone = 'default' | 'info' | 'success' | 'warning' | 'danger';

const ICON_TONE: Record<SettingsTone, string> = {
  default: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

type SettingsSectionProps = {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** أيقونة lucide تسبق العنوان. تُمرَّر كمكوّن لا كعنصر: `icon={ShieldCheck}`. */
  icon?: LucideIcon;
  /** نبرة الأيقونة. `default` رمادية محايدة. */
  tone?: SettingsTone;
  /**
   * `page` لعنوان التبويب نفسه (مرّة واحدة في أعلى كل تبويب)، و`section` لما
   * دونه. المستويان كانا متطابقين حرفياً — `text-base font-semibold` لكليهما —
   * فلم يبقَ ما يقول أيّهما يحتوي الآخر.
   *
   * السلّم الآن بمقاس الأصل: `text-2xl` للصفحة و`text-lg` للقسم. حظر `text-lg`
   * القديم سقط بقرار المالك (2026-08-03) — كان يسوّي العناوين كلها عند
   * `text-base` فتقرأ الشاشة كقائمة مسطّحة بلا تراتب.
   */
  level?: 'page' | 'section';
  /**
   * **حدّ القسم مرسوم لا مُستنتَج.**
   *
   * شكوى المالك (2026-08-03): «العناوين والفراغات تخليك مش فاهم فين الرئيسي وفين
   * الفرعي وإيش اللي قدّامي». وهي دقيقة: أربعة مستويات — صفحة، قسم، مجموعة، صفّ —
   * كان يفرّقها **الفراغ وحده**، والفراغ يقول «هنا انقطاع» ولا يقول «هذا يحتوي
   * ذاك». فقُرئت الشاشة تدفّقاً واحداً عائماً.
   *
   * والبطاقة هنا ليست عودةً إلى «صندوق حول كل صفّ» (تلك أُسقطت لأنها أطّرت
   * عنصراً واحداً فلم تعد تجميعاً). هي **الحدّ الوحيد** الذي يقول أين يبدأ القسم
   * وأين ينتهي — وهذا سببٌ وظيفي لا زخرفة، وهو الاستثناء الذي أذن به المالك
   * صراحةً: «ممكن نستخدمها عند الضرورة لما يكون فيه سبب وظيفي وجمالي».
   *
   * الافتراضي `false` كي لا تنقلب الشاشة صناديق متداخلة: يُرفع على القسم الذي
   * يجمع أكثر من صفّ، لا على قسمٍ محتواه سطر واحد.
   */
  boxed?: boolean;
};

export default function SettingsSection({
  title,
  description,
  children,
  className,
  icon: Icon,
  tone = 'default',
  level = 'section',
  boxed = false,
}: SettingsSectionProps) {
  const isPage = level === 'page';

  return (
    <div className={cn('space-y-3', className)}>
      <div>
        {/* لا `uppercase` ولا `tracking-*`: نمط eyebrow اللاتيني يضع تباعد أحرف على
            نصّ عربي متصل فيقطع الاتصال (خطّ أحمر لغوي، وجذر B-329). هذا الحظر
            باقٍ — الساقط هو حظر المقاس وحده. */}
        <div className="flex items-center gap-2.5">
          {Icon && (
            <Icon
              className={cn('flex-shrink-0', isPage ? 'h-6 w-6' : 'h-5 w-5', ICON_TONE[tone])}
              aria-hidden="true"
            />
          )}
          <h3
            className={cn(
              'min-w-0 font-semibold leading-snug text-foreground',
              isPage ? 'text-2xl' : 'text-lg',
            )}
          >
            {title}
          </h3>
        </div>
        {description && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {boxed ? (
        <div className="rounded-lg border border-border bg-card px-5 py-1.5 shadow-sm">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
