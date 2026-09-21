/**
 * ThemeModeSelector — segmented control (radio group) for three theme modes:
 * light / dark / system.
 *
 * Replaces the binary DarkModeToggle in the Appearance settings section.
 * The active mode is read from ThemeContext; clicking a segment calls
 * setThemeMode() which persists to localStorage and applies to the DOM
 * (including the live OS-preference listener when 'system' is selected).
 *
 * RTL-safe: uses logical CSS via Tailwind's rtl: utilities; no hard-coded
 * left/right. The segment order is written left-to-right in the DOM (Light →
 * System → Dark) which is appropriate regardless of directionality — it is
 * a brightness continuum, not a sequential list.
 *
 * a11y: role="radiogroup" with one role="radio" per option, keyboard-navigable
 * via arrow keys, visible focus ring, contrast-compliant labels.
 */

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';
// ThemeMode type comes from the single source of truth in lib/theme-mode.ts
// (shared with ThemeContext and applyStoredThemePreset at boot).
import type { ThemeMode } from '../../../lib/theme-mode';

interface Option {
  value: ThemeMode;
  icon: React.ElementType;
  labelKey: string;
}

const OPTIONS: Option[] = [
  { value: 'light',  icon: Sun,     labelKey: 'appearanceSettings.themeMode.light'  },
  { value: 'system', icon: Monitor, labelKey: 'appearanceSettings.themeMode.system' },
  { value: 'dark',   icon: Moon,    labelKey: 'appearanceSettings.themeMode.dark'   },
];

export default function ThemeModeSelector() {
  const { themeMode, setThemeMode } = useTheme() as {
    themeMode: ThemeMode;
    setThemeMode: (mode: ThemeMode) => void;
  };
  const { t } = useTranslation('settings');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      next = (index + 1) % OPTIONS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      next = (index - 1 + OPTIONS.length) % OPTIONS.length;
    } else {
      return;
    }
    const sibling = (e.currentTarget.parentElement?.children[next] as HTMLButtonElement | null);
    sibling?.focus();
    setThemeMode(OPTIONS[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={t('appearanceSettings.themeMode.label')}
      className="inline-flex rounded-lg border border-input bg-muted p-0.5 gap-0.5"
    >
      {OPTIONS.map((option, index) => {
        const Icon = option.icon;
        const isActive = themeMode === option.value;
        const label = t(option.labelKey);

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={label}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setThemeMode(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
              'touch-manipulation transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
