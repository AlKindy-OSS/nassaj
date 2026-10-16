import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../contexts/ThemeContext';
import { nextThemeMode } from '../../../lib/theme-mode';
import type { ThemeMode } from '../../../lib/theme-mode';
import { cn } from '../../../lib/utils';

type ModeVisual = {
  icon: LucideIcon;
  track: string;
  thumb: string;
  iconColor: string;
};

// B-373: `translate-x` لا ينعكس مع `dir` — الـtransform يحرّك يميناً في
// الاتجاهين. والزرّ `inline-flex` فالمقبض يبدأ من الحافة الداخلية **اليمنى** تحت
// rtl، فإزاحته يميناً تقذفه خارج المسار. لذا تُكتب كل حالة بمتغيّرَي ltr/rtl ولا
// تُترك أي قيمة أساسية غير مشروطة (صنف غير مشروط لنفس الخاصية يبتلع المشروط).
// المواضع الثلاثة: فاتح في البداية، نظام في المنتصف، داكن في النهاية — نفس ترتيب
// المتحكّم المقطّع في الإعدادات (فاتح ← نظام ← داكن).
const MODE_VISUALS: Record<ThemeMode, ModeVisual> = {
  light: {
    icon: Sun,
    track: 'border-border bg-muted',
    thumb: 'ltr:translate-x-[2px] rtl:-translate-x-[2px] bg-foreground/60 dark:bg-foreground/80',
    iconColor: 'text-background',
  },
  system: {
    icon: Monitor,
    track: 'border-primary bg-muted',
    thumb: 'ltr:translate-x-[12px] rtl:-translate-x-[12px] bg-primary',
    iconColor: 'text-primary-foreground',
  },
  dark: {
    icon: Moon,
    track: 'border-primary bg-primary',
    thumb: 'ltr:translate-x-[22px] rtl:-translate-x-[22px] bg-primary-foreground',
    iconColor: 'text-primary',
  },
};

const MODE_LABEL_KEYS: Record<ThemeMode, string> = {
  light: 'appearanceSettings.themeMode.light',
  dark: 'appearanceSettings.themeMode.dark',
  system: 'appearanceSettings.themeMode.system',
};

/**
 * Quick theme toggle: each press cycles light → dark → system → light.
 * A three-state control, so it is a plain button whose label names the
 * current mode and the one a press switches to.
 */
function DarkModeToggle() {
  const { themeMode, cycleThemeMode } = useTheme() as {
    themeMode: ThemeMode;
    cycleThemeMode: () => void;
  };
  const { t } = useTranslation('settings');
  const visual = MODE_VISUALS[themeMode] ?? MODE_VISUALS.system;
  const Icon = visual.icon;
  const label = t('appearanceSettings.themeMode.cycleLabel', {
    current: t(MODE_LABEL_KEYS[themeMode] ?? MODE_LABEL_KEYS.system),
    next: t(MODE_LABEL_KEYS[nextThemeMode(themeMode)]),
  });

  return (
    <button
      type="button"
      onClick={cycleThemeMode}
      className={cn(
        'relative inline-flex h-7 w-12 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full border-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        visual.track,
      )}
      aria-label={label}
      title={label}
      data-theme-mode={themeMode}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-5 w-5 transform items-center justify-center rounded-full shadow-sm transition-transform duration-200',
          visual.thumb,
        )}
      >
        <Icon className={cn('h-3 w-3', visual.iconColor)} />
      </span>
    </button>
  );
}

export default DarkModeToggle;
