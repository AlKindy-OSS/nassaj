import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../../contexts/ThemeContext';
import {
  PRESET_ORDER,
  presetSwatches,
  hexToHslString,
  hslStringToHex,
} from '../../../../lib/theme-presets';
import type { CustomColors, ThemePresetId } from '../../../../lib/theme-presets';
import { cn } from '../../../../lib/utils';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

const CUSTOM_FIELDS: Array<{ key: keyof CustomColors; i18nKey: string }> = [
  { key: 'accent', i18nKey: 'accent' },
  { key: 'background', i18nKey: 'background' },
  { key: 'foreground', i18nKey: 'foreground' },
];

export default function ThemePresetPicker() {
  const { t } = useTranslation('settings');
  const {
    isDarkMode,
    themePreset,
    customThemeColors,
    setThemePreset,
    setCustomThemeColors,
  } = useTheme();

  // `custom` is hidden from the picker, but a user who already has it saved
  // keeps seeing (and editing) it until they switch to another preset.
  const visiblePresets: ThemePresetId[] =
    themePreset === 'custom' ? [...PRESET_ORDER, 'custom'] : PRESET_ORDER;

  return (
    <SettingsSection
      title={t('appearanceSettings.themePresets.title')}
      description={t('appearanceSettings.themePresets.description')}
    >
      <SettingsCard className="space-y-4 p-4">
        <div
          role="radiogroup"
          aria-label={t('appearanceSettings.themePresets.groupLabel')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {visiblePresets.map((id: ThemePresetId) => {
            const isActive = themePreset === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setThemePreset(id)}
                className={cn(
                  'rounded-lg border p-3 text-start transition-colors touch-manipulation',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                  isActive
                    ? 'border-primary ring-1 ring-primary/40 bg-primary/5'
                    : 'border-border bg-card hover:border-primary/50',
                )}
              >
                <div className="mb-2 text-sm font-medium text-foreground">
                  {t(`appearanceSettings.themePresets.presets.${id}`)}
                </div>
                <div aria-hidden="true" className="flex gap-1">
                  {presetSwatches(id, customThemeColors, isDarkMode).map((hex, i) => (
                    <span
                      key={i}
                      className="h-5 w-5 rounded border border-border"
                      style={{ background: hex }}
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {themePreset === 'custom' && (
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="mb-3 text-sm font-semibold text-foreground">
              {t('appearanceSettings.themePresets.custom.title')}
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {CUSTOM_FIELDS.map(({ key, i18nKey }) => {
                const label = t(`appearanceSettings.themePresets.custom.${i18nKey}`);
                return (
                  <label key={key} className="flex flex-col gap-1.5 text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <input
                      type="color"
                      value={hslStringToHex(customThemeColors[key])}
                      aria-label={label}
                      onChange={(event) =>
                        setCustomThemeColors({ [key]: hexToHslString(event.target.value) })
                      }
                      className="h-9 w-full cursor-pointer rounded-md border border-border bg-card p-0.5"
                    />
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
