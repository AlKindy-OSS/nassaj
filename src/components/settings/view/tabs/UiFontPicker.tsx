import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { UI_FONT_ORDER, getUiFontSpec } from '../../../../lib/ui-font';
import type { UiFontId } from '../../../../lib/ui-font';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

/** i18n key suffix per font id (kebab-case ids → camelCase JSON keys). */
const OPTION_KEYS: Record<UiFontId, string> = {
  system: 'system',
  'ibm-plex-sans-arabic': 'ibmPlexSansArabic',
  'noto-sans-arabic': 'notoSansArabic',
  'readex-pro': 'readexPro',
  vazirmatn: 'vazirmatn',
  tajawal: 'tajawal',
};

/**
 * Interface font picker — one font for every language (Arabic and Latin alike).
 *
 * Each option previews itself: the <option> is rendered in the family it names,
 * which is the only honest preview for a type choice. That preview is a
 * best-effort extra — a family whose files have not been downloaded yet (they
 * load lazily, only once selected) simply falls back to the system stack, and
 * some platforms ignore per-option fonts in a native <select> entirely.
 */
export default function UiFontPicker() {
  const { t } = useTranslation('settings');
  const { uiFont, setUiFont } = useTheme();

  return (
    <SettingsSection
      title={t('appearanceSettings.uiFont.title')}
      description={t('appearanceSettings.uiFont.description')}
    >
      <SettingsCard>
        <SettingsRow
          label={t('appearanceSettings.uiFont.label')}
          description={t('appearanceSettings.uiFont.hint')}
        >
          <select
            value={uiFont}
            onChange={(event) => setUiFont(event.target.value as UiFontId)}
            aria-label={t('appearanceSettings.uiFont.label')}
            className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-56"
          >
            {UI_FONT_ORDER.map((id) => (
              <option key={id} value={id} style={{ fontFamily: getUiFontSpec(id).stack }}>
                {t(`appearanceSettings.uiFont.options.${OPTION_KEYS[id]}`)}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
