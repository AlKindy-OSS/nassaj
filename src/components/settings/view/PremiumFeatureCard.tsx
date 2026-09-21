import { ExternalLink, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

import { SOURCE_REPO_URL } from '../../../constants/sourceRepo';

const NASSAJ_URL = SOURCE_REPO_URL;

type PremiumFeatureCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  ctaText?: string;
};

export default function PremiumFeatureCard({
  icon,
  title,
  description,
  ctaText = 'متاح في نسّاج',
}: PremiumFeatureCardProps) {
  return (
    // الحدّ المتقطّع هو الإشارة الدالّة على «غير مُفعَّل» — وهو يبقى. الساقط معه:
    // `rounded-xl` (قيمة ثابتة لا تُشتقّ من `--radius`)، وثلاثة ألفاءات على أسطح
    // ورموز (`border-border/60`, `bg-muted/20`, `bg-muted/60`)، و`text-xs` وهو دون
    // حدّ الـ13px في STYLE_LOCK §1.
    <div className="rounded-lg border border-dashed border-border bg-muted p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold leading-snug text-foreground">{title}</h4>
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
          <a
            href={NASSAJ_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-primary transition-colors duration-150 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ctaText}
            <ExternalLink className="h-3 w-3 rtl:-scale-x-100" />
          </a>
        </div>
      </div>
    </div>
  );
}
