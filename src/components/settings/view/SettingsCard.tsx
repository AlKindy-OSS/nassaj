import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import type { SettingsTone } from './SettingsSection';

/**
 * صندوق نبرة — **خلفية خفيفة + حدّ + نصف قطر + حشو، للحالة التي تحمل معلومة**.
 *
 * الأصل يرسم صندوقاً واحداً بارزاً في الشاشة كلها: مربّع «تخطّي طلبات الإذن»
 * بخلفية برتقالية وحدّ برتقالي. ما حوله صفوف عارية. وهذا هو الشرط: الصندوق يقول
 * «هذه المنطقة ليست كبقيّتها»، فإن أُطِّر كل شيء لم يبقَ للإطار ما يقوله — وذلك
 * بعينه ما أسقط النسخة التي أطّرت كل صفّ.
 *
 * لذلك: **`tone="default"` بلا إطار البتّة** (يبقى معبراً شفّافاً)، والإطار
 * للنبرات الأربع وحدها.
 *
 * الألوان بالرموز حصراً. الشفافية `10%` للخلفية و`30%` للحدّ: قِيس أن نصّ النبرة
 * فوق سطحها المخفَّف عند 10% يبقى ≥4.5:1 على `--background` و`--card` في
 * الوضعين، ويهبط دون ذلك عند 15% — فالسقف عشرة.
 */
type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  tone?: SettingsTone;
};

const CARD_TONE: Record<Exclude<SettingsTone, 'default'>, string> = {
  info: 'border-primary/30 bg-primary/10',
  success: 'border-success/30 bg-success/10',
  warning: 'border-warning/30 bg-warning/10',
  danger: 'border-danger/30 bg-danger/10',
};

export default function SettingsCard({ children, className, tone = 'default' }: SettingsCardProps) {
  return (
    <div
      className={cn(
        tone === 'default' ? null : cn('rounded-lg border p-4', CARD_TONE[tone]),
        className,
      )}
    >
      {children}
    </div>
  );
}
