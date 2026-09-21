import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import StatusBadge from './StatusBadge';

/**
 * رأس بطاقة إعدادات موحَّد.
 *
 * وُجد لسببين قِيسا على الشاشة لا في الكود:
 *
 * 1. **ثلاثة أنماط رأس في تبويب واحد** (`font-medium` هنا و`font-semibold` هناك
 *    ورأس القسم بنمط eyebrow) تجعل البطاقات تبدو من أنظمة تصميم مختلفة، فيضيع
 *    التراتب: أيّها رأس وأيّها مرؤوس؟
 *
 * 2. **نموذجا حفظ متعارضان في شاشة واحدة.** بعض البطاقات تحفظ بضغطة زرّ في
 *    الأسفل، وبعضها يحفظ فور النقر. حين لا يقول شيءٌ أيّهما أيّ، يفترض المستخدم
 *    أن الزرّ الوحيد المرئي يحفظ كل ما يراه — وهو أخطر افتراض في شاشة تحمل
 *    مفتاح «تنفيذ أي أمر». لذا تحمل البطاقة الفورية شارةً تقولها صراحةً.
 */
export type SettingsCardSaveMode = 'immediate' | 'deferred';

type SettingsCardHeaderProps = {
  title: string;
  description?: ReactNode;
  /** يظهر في نهاية السطر: عدّاد، زرّ إضافة… */
  trailing?: ReactNode;
  /** `immediate` يعرض شارة «يُحفظ فوراً». `deferred` صامت — الشريط اللاصق يتكفّل به. */
  saveMode?: SettingsCardSaveMode;
  /** ملاحظة تحذيرية تحت الوصف (نبرة amber). */
  note?: ReactNode;
  className?: string;
};

export default function SettingsCardHeader({
  title,
  description,
  trailing,
  saveMode,
  note,
  className,
}: SettingsCardHeaderProps) {
  const { t } = useTranslation('settings');

  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* `font-semibold` مقابل `font-medium` للصيقة الصفّ: كانا متطابقين في
              المحورين معاً، فكان الإطار وحده هو ما يفرّق الرأس عن مرؤوسه — وهذا
              بعينه ما دفع إلى بناء الإطارات الزائدة أصلاً.
              والمقاس `text-base`: يبقى تحت رأس القسم (`text-lg`) وفوق لصيقة
              الصفّ (`text-[15px]`)، فالسلّم أربع درجات متمايزة لا درجتان. */}
          <p className="text-base font-semibold leading-snug text-foreground">{title}</p>
          {saveMode === 'immediate' && (
            <StatusBadge>
              {t('commandBoardSettings.savesImmediately', { defaultValue: 'يُحفظ فوراً' })}
            </StatusBadge>
          )}
        </div>
        {description && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
        {note && (
          <div className="mt-1.5 text-[13px] leading-relaxed text-warning">
            {note}
          </div>
        )}
      </div>
      {trailing && <div className="flex flex-shrink-0 flex-col items-end gap-1.5">{trailing}</div>}
    </div>
  );
}
