import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { UI_FONT_ORDER, getUiFontSpec, markUiFontChosen } from '../../../../lib/ui-font';
import type { UiFontId } from '../../../../lib/ui-font';
import { cn } from '../../../../lib/utils';
import SettingsRow from '../SettingsRow';

/**
 * أصناف منتقي الإعدادات — انظر التعليل في `AppearanceSettingsTab.tsx`. حدّ
 * المنتقي تحكّمٌ توجبه ‏WCAG 1.4.11 لا طبقةَ تجميع، وإزاحة حلقة التركيز سقطت مع
 * سقوط سطح البطاقة الذي كانت تُزاح عنه.
 *
 * `sm:w-52` تطابق عرض منتقي اللغة في نفس صندوق «السمة واللغة» (qa LOW round
 * 2, ثم round 3: `sm:w-40` كان يقصّ «IBM Plex Sans Arabic» على شريط القيمة
 * نفسه فيتراكب سهم `<select>` مع النص — وُسِّع مع `pe-8`. `truncate` أُزيلت
 * (‏T-1868): بلا تأثير فعلي على نصّ القيمة داخل `<select>` الأصيل.
 */
const SELECT_CLASS =
  'w-full touch-manipulation rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** i18n key suffix per font id (kebab-case ids → camelCase JSON keys). */
const OPTION_KEYS: Record<UiFontId, string> = {
  system: 'system',
  'ibm-plex-sans-arabic': 'ibmPlexSansArabic',
  'noto-sans-arabic': 'notoSansArabic',
  'readex-pro': 'readexPro',
  vazirmatn: 'vazirmatn',
  tajawal: 'tajawal',
  'noto-nastaliq-urdu': 'notoNastaliqUrdu',
};

/**
 * Interface font picker — one font for every language (Arabic and Latin alike).
 *
 * Each option previews itself: the <option> is rendered in the family it names,
 * which is the only honest preview for a type choice. That preview is a
 * best-effort extra — a family whose files have not been downloaded yet (they
 * load lazily, only once selected) simply falls back to the system stack, and
 * some platforms ignore per-option fonts in a native <select> entirely.
 *
 * T-1862 round 2 (qa LOW): this used to also wrap itself in its own boxed
 * `SettingsSection` (a `variant` prop chose between the two). Its one real
 * caller (`AppearanceSettingsTab`) always wanted the row-only form — placed
 * inside the existing «السمة واللغة» section — so the standalone-box branch
 * was dead code; removed rather than kept "just in case".
 */
export default function UiFontPicker() {
  const { t } = useTranslation('settings');
  const { uiFont, setUiFont } = useTheme();

  return (
    <SettingsRow
      label={t('appearanceSettings.uiFont.label')}
      description={t('appearanceSettings.uiFont.hint')}
    >
      <select
        value={uiFont}
        onChange={(event) => {
          // This is the only place a human deliberately picks a family.
          // ThemeContext re-saves the current value on every boot, so the
          // stored value alone cannot tell a choice from a default — mark it
          // here so the legacy-`system` migration in ui-font.ts leaves a
          // deliberate pick alone.
          markUiFontChosen();
          setUiFont(event.target.value as UiFontId);
        }}
        aria-label={t('appearanceSettings.uiFont.label')}
        className={cn(SELECT_CLASS, 'pe-8 sm:w-52')}
      >
        {UI_FONT_ORDER.map((id) => (
          <option key={id} value={id} style={{ fontFamily: getUiFontSpec(id).stack }}>
            {t(`appearanceSettings.uiFont.options.${OPTION_KEYS[id]}`)}
          </option>
        ))}
      </select>
    </SettingsRow>
  );
}
