import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import type { SettingsTone } from './SettingsSection';

/**
 * شارة حالة/عدّاد موحّدة.
 *
 * وُجدت لأن الفكرة نفسها كانت منفَّذة بخمس صيغ: `Badge` المشترك، وشارة «يُحفظ
 * فوراً» منسوخة حرفياً في ملفين، ونقطة لونية، وpill يدوي، ونصّ عائم بلا وعاء.
 *
 * **النبرات الأربع صارت متاحة** بعد أن دخلت الرموز `--success`/`--warning`/
 * `--danger` إلى `src/index.css` (‏B-399). كانت الشارة محصورة في نبرتين لأن
 * الرموز لم تكن موجودة، فكانت كل نبرة ثالثة تعني لوناً خاماً غير محروس. لم يعد
 * ذلك قائماً.
 *
 * وكل شارة مُنبَّرة تحمل **نقطةً دالّة** فلا يقع التمييز على اللون وحده
 * (‏WCAG 1.4.1).
 */
type StatusBadgeProps = {
  children: ReactNode;
  /** `neutral` سطح محايد بلا نقطة. ما عداه: نبرة رمزية + نقطة. */
  tone?: 'neutral' | Exclude<SettingsTone, 'default'>;
  className?: string;
};

const BADGE_TONE: Record<Exclude<SettingsTone, 'default'>, string> = {
  info: 'bg-primary/10 font-medium text-primary',
  success: 'bg-success/10 font-medium text-success',
  warning: 'bg-warning/10 font-medium text-warning',
  danger: 'bg-danger/10 font-medium text-danger',
};

export default function StatusBadge({ children, tone = 'neutral', className }: StatusBadgeProps) {
  const isNeutral = tone === 'neutral';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] leading-none',
        isNeutral ? 'bg-muted text-muted-foreground' : BADGE_TONE[tone],
        className,
      )}
    >
      {!isNeutral && (
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}
