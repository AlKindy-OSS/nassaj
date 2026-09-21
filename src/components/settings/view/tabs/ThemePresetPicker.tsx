import { Pipette, SwatchBook } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import {
  HIDDEN_PRESETS,
  PRESET_ORDER,
  presetSwatches,
  hexToHslString,
  hslStringToHex,
} from '../../../../lib/theme-presets';
import type { CustomColors, ThemePresetId } from '../../../../lib/theme-presets';
import { cn } from '../../../../lib/utils';
import SettingsSection from '../SettingsSection';

const CUSTOM_FIELDS: Array<{ key: keyof CustomColors; i18nKey: string }> = [
  { key: 'accent', i18nKey: 'accent' },
  { key: 'background', i18nKey: 'background' },
  { key: 'foreground', i18nKey: 'foreground' },
];

/**
 * شبكة اختيار بصري — الاستثناء الوحيد الذي يبقى فيه حدٌّ حول كل خيار.
 *
 * وسببه أن الخيار هنا **صورة لا نصّ**: أربع مساحات لون لا تُميَّز عن جارتها إلا
 * بحدٍّ يرسم حدود البطاقة الواحدة، وهو حدّ تحكّمٍ (‏WCAG 1.4.11) لا طبقةَ تجميع.
 *
 * والساقط ثلاثةٌ كانت تكرّر زوج (حدّ + سطح) ثلاث طبقات فوق بعضها: بطاقة القسم
 * الحاوية، وسطح `bg-card` تحت كل خيار (وهو سطح البطاقة نفسه فلم يكن يفصل شيئاً)،
 * وحدّ حول كل مربّع لون. مربّعات اللون الآن شريطٌ واحد متّصل: حوافّه من الشريط
 * نفسه، فلا يحتاج حدوداً أربعة ليُقرأ.
 *
 * **لا شيء من هوية الألوان تغيّر**: `presetSwatches` و`deriveTokens` وأسماء
 * البريستات كما هي حرفاً بحرف.
 */
export default function ThemePresetPicker() {
  const { t } = useTranslation('settings');
  const {
    isDarkMode,
    themePreset,
    customThemeColors,
    setThemePreset,
    setCustomThemeColors,
  } = useTheme();

  // البريستات المخفيّة (‏`custom` و`default` و`gemini`) غائبة عن الشبكة، لكن من
  // كان على واحدة منها محفوظةً يظلّ يراها — هو وحده — حتى ينتقل إلى غيرها. بلا
  // هذا يبقى على ثيمٍ لا يجد له خانةً في المنتقي، فلا يعرف ما المُطبَّق عليه.
  const visiblePresets: ThemePresetId[] = HIDDEN_PRESETS.includes(themePreset)
    ? [...PRESET_ORDER, themePreset]
    : PRESET_ORDER;

  return (
    <SettingsSection
      boxed
      icon={SwatchBook}
      // «مجموعة الألوان» لا «Theme»: كان القسم يحمل اسم صفٍّ آخر في التبويب
      // نفسه (وضع السمة فاتح/داكن)، فيقرأ الاثنان الشيء نفسه وهما شيئان.
      title={t('appearanceSettings.colorPreset.title')}
      description={t('appearanceSettings.themePresets.description')}
    >
      {/* لوحٌ داخلي: شبكةُ البريستات ثم لوحُ الألوان المخصّصة ابنان متجاوران،
          وبطاقة القسم لا تباعد بين أبنائها. */}
      <div className="space-y-4 py-2">
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
                'touch-manipulation rounded-md border p-3 text-start transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // فرعان متنافيان لنفس الخاصّيتين — لا صنف أساس يبتلع المشروط.
                isActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50',
              )}
            >
              <div className="mb-2 text-sm font-medium text-foreground">
                {t(`appearanceSettings.themePresets.presets.${id}`)}
              </div>
              {/* شريط لونٍ واحد بدل أربعة مربّعات مؤطَّرة: `overflow-hidden`
                  يقصّ الأطراف على استدارة الشريط، فتُرسم الحافّة مرّةً لا أربعاً. */}
              <div aria-hidden="true" className="flex h-6 overflow-hidden rounded-sm">
                {presetSwatches(id, customThemeColors, isDarkMode).map((hex, i) => (
                  <span key={i} className="flex-1" style={{ background: hex }} />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {themePreset === 'custom' && (
        /* بلا سطحٍ ولا إطار: اللوح كان يكرّر زوج (حدّ + سطح) البطاقة الحاوية مع
           `p-4` داخل `p-4`. الفصل هنا عنوانُ قسمٍ ومسافة، وحدود حقول اللون وحدها
           تحكّمات (‏WCAG 1.4.11).

           و`h4 text-sm font-medium` سقط: كان رأساً يدوياً بوزن **لصيقة صفّ**
           تماماً، فيقرأ لصيقةً لحقلٍ لا عنواناً لثلاثة حقول تحته. البدائية
           تعطيه مقاسه من السلّم وأيقونته (`Pipette` — التقاط لونٍ بعينه). */
        <SettingsSection
          icon={Pipette}
          title={t('appearanceSettings.themePresets.custom.title')}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {CUSTOM_FIELDS.map(({ key, i18nKey }) => {
              const label = t(`appearanceSettings.themePresets.custom.${i18nKey}`);
              return (
                <label key={key} className="flex flex-col gap-1.5">
                  <span className="text-[13px] leading-relaxed text-muted-foreground">{label}</span>
                  <input
                    type="color"
                    value={hslStringToHex(customThemeColors[key])}
                    aria-label={label}
                    onChange={(event) =>
                      setCustomThemeColors({ [key]: hexToHslString(event.target.value) })
                    }
                    className="h-9 w-full cursor-pointer rounded-md border border-input bg-background p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              );
            })}
          </div>
        </SettingsSection>
      )}
      </div>
    </SettingsSection>
  );
}
