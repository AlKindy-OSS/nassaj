import { Code2, Highlighter, Palette, PanelLeft, SunMoon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { languages } from '../../../../i18n/languages';
import type { ThemeMode } from '../../../../lib/theme-mode';
import { cn } from '../../../../lib/utils';
import type { CodeHighlightScope } from '../../../../syntax/codeHighlightScope';
import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import SegmentedControl from '../SegmentedControl';
import type { SegmentedOption } from '../SegmentedControl';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

import BrandingSettingsSection from './BrandingSettingsSection';
import ThemePresetPicker from './ThemePresetPicker';
import UiFontPicker from './UiFontPicker';

/**
 * أصناف منتقي الإعدادات الموحَّدة.
 *
 * حدّ المنتقي تحكّمٌ لا طبقةَ تجميع: ‏WCAG 1.4.11 توجب تحديد المكوّن، وهو أحد
 * الاستثناءين الوحيدين في §1 من `docs/design/SETTINGS-SURFACE-LANGUAGE.md`.
 * وحلقة التركيز بلا `ring-offset-card`: لم يعد تحت المنتقي سطحُ بطاقة يُزاح عنه.
 *
 * مكرَّرٌ حرفياً في `UiFontPicker`: رفعُه إلى وحدة مشتركة قرارُ بنيةٍ خارج نطاق
 * ترحيلٍ بصري، واستيراده منه هنا يُنشئ دورةً (هذا الملف يستورد المنتقي).
 */
const SELECT_CLASS =
  'w-full touch-manipulation rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorThemeChange: (value: 'dark' | 'light') => void;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
  showSidebarSearch: boolean;
  onShowSidebarSearchChange: (value: boolean) => void;
  showHardwareUsage: boolean;
  onShowHardwareUsageChange: (value: boolean) => void;
  codeHighlightScope: CodeHighlightScope;
  onCodeHighlightScopeChange: (value: CodeHighlightScope) => void;
};

export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorThemeChange,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
  showSidebarSearch,
  onShowSidebarSearchChange,
  showHardwareUsage,
  onShowHardwareUsageChange,
  codeHighlightScope,
  onCodeHighlightScopeChange,
}: AppearanceSettingsTabProps) {
  const { t, i18n } = useTranslation('settings');
  const { themeMode, setThemeMode } = useTheme() as {
    themeMode: ThemeMode;
    setThemeMode: (mode: ThemeMode) => void;
  };

  /**
   * ترتيب الأوضاع متّصلُ سطوعٍ لا قائمةٌ متسلسلة، فيبقى فاتح ← نظام ← داكن في
   * الاتجاهين. والأيقونات سقطت: النصّ داخل الخيار هو ما يُقرأ، والأيقونة كانت
   * تضيّق الخيار حتى يُقتطع نصّه في العربية.
   */
  const THEME_MODE_OPTIONS: SegmentedOption<ThemeMode>[] = [
    { value: 'light', label: t('appearanceSettings.themeMode.light') },
    { value: 'system', label: t('appearanceSettings.themeMode.system') },
    { value: 'dark', label: t('appearanceSettings.themeMode.dark') },
  ];

  const SORT_OPTIONS: SegmentedOption<ProjectSortOrder>[] = [
    { value: 'name', label: t('appearanceSettings.projectSorting.alphabetical') },
    { value: 'date', label: t('appearanceSettings.projectSorting.recentActivity') },
  ];

  const EDITOR_THEME_OPTIONS: SegmentedOption<'light' | 'dark'>[] = [
    { value: 'light', label: t('appearanceSettings.themeMode.light') },
    { value: 'dark', label: t('appearanceSettings.themeMode.dark') },
  ];

  const HIGHLIGHT_OPTIONS: SegmentedOption<CodeHighlightScope>[] = [
    { value: 'core', label: t('appearanceSettings.codeHighlighting.coreShort') },
    { value: 'extended', label: t('appearanceSettings.codeHighlighting.extendedShort') },
    { value: 'full', label: t('appearanceSettings.codeHighlighting.fullShort') },
  ];

  return (
    <SettingsSection
      level="page"
      icon={Palette}
      tone="info"
      title={t('mainTabs.appearance')}
      description={t('appearanceSettings.pageDescription')}
    >
      <div className="space-y-8 pt-1">
        {/* Server identity — owner-only; component renders null for non-owners */}
        <BrandingSettingsSection />

        {/* «السمة واللغة» لا «المظهر»: عنوان القسم كان يكرّر عنوان التبويب حرفياً،
            وصفُّ «Theme» داخله كان يكرّر عنوان قسم البريستات تحته. ثلاثة مواضع
            بثلاث دلالات وثلاثة أسماء متداخلة — كلٌّ منها اسمه الآن.
            و`SunMoon` تقول متّصل السطوع الذي يحكم القسم قبل قراءة عنوانه. */}
        {/*
          **وصفٌ لا يضيف معلومةً يُحذف** (‏T-1221، شكوى المالك 2026-08-04: «كل
          صفحة الإعدادات فيها كمية تكرار مزعجة جداً»).

          كان لكل صفٍّ لصيقةٌ ثم جملةٌ تعيد صياغتها: «السمة» ثم «اختر الوضع
          الفاتح أو الداكن…» فوق ثلاثة أزرارٍ مكتوبٌ عليها نهاري/حسب النظام/ليلي.
          الجملة لا تقول شيئاً لا يقوله الزرّ، لكنها تضاعف ارتفاع الصفّ وتُعلّم
          القارئ **تخطّي كل الأوصاف** — فيتخطّى معها الوصفَ الذي يحمل تحذيراً
          حقيقياً حين يمرّ به.

          والباقي منها ليس نجاةً بالصدفة: كلُّ وصفٍ بقي يحمل معلومةً **لا تُرى في
          التحكّم** — أين يظهر الأثر، أو وحدةَ القياس، أو ما يُحمَّل ومتى — وقُصّ
          إلى تلك المعلومة وحدها.
        */}
        <SettingsSection boxed icon={SunMoon} title={t('appearanceSettings.basics.title')}>
          <SettingsGroup>
            <SettingsRow
              label={t('appearanceSettings.themeMode.label')}
            >
              <SegmentedControl
                options={THEME_MODE_OPTIONS}
                value={themeMode}
                onChange={setThemeMode}
                label={t('appearanceSettings.themeMode.label')}
              />
            </SettingsRow>

            {/*
              لغة الواجهة صفٌّ هنا لا مكوّناً مستقلاً: `LanguageSelector` المشترك
              يحمل حشوه الأفقي ولصيقته بـ`text-xs` وسطح `bg-card`، فكان يكسر إيقاع
              الصفوف حوله. الفعل نفسه لم يتغيّر — نفس القيم ونفس `changeLanguage`.
            */}
            <SettingsRow
              label={t('account.languageLabel')}
            >
              <select
                value={i18n.language}
                onChange={(event) => {
                  void i18n.changeLanguage(event.target.value);
                }}
                aria-label={t('account.languageLabel')}
                className={cn(SELECT_CLASS, 'sm:w-40')}
              >
                {languages.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.nativeName}
                  </option>
                ))}
              </select>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>

        <ThemePresetPicker />

        <UiFontPicker />

        <SettingsSection boxed icon={PanelLeft} title={t('appearanceSettings.sidebar.title')}>
          <SettingsGroup>
            <SettingsRow
              label={t('appearanceSettings.sidebar.showSearchAndArchive.label')}
              description={t('appearanceSettings.sidebar.showSearchAndArchive.description')}
            >
              <SettingsToggle
                checked={showSidebarSearch}
                onChange={onShowSidebarSearchChange}
                ariaLabel={t('appearanceSettings.sidebar.showSearchAndArchive.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.sidebar.showHardwareUsage.label')}
              description={t('appearanceSettings.sidebar.showHardwareUsage.description')}
            >
              <SettingsToggle
                checked={showHardwareUsage}
                onChange={onShowHardwareUsageChange}
                ariaLabel={t('appearanceSettings.sidebar.showHardwareUsage.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.projectSorting.label')}
              description={t('appearanceSettings.projectSorting.description')}
            >
              <SegmentedControl
                options={SORT_OPTIONS}
                value={projectSortOrder}
                onChange={onProjectSortOrderChange}
                label={t('appearanceSettings.projectSorting.label')}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>

        <SettingsSection boxed icon={Code2} title={t('appearanceSettings.codeEditor.title')}>
          <SettingsGroup>
            {/* سمة المحرّر اختيارٌ من قيمتين مسمّاتين لا مفتاح تشغيل: المفتاح كان
                يترك «مفعَّل» تعني «داكن» ضمناً، والخيار المسمّى يقولها. */}
            <SettingsRow
              label={t('appearanceSettings.codeEditor.theme.label')}
            >
              <SegmentedControl
                options={EDITOR_THEME_OPTIONS}
                value={codeEditorSettings.theme}
                onChange={onCodeEditorThemeChange}
                label={t('appearanceSettings.codeEditor.theme.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.codeEditor.wordWrap.label')}
            >
              <SettingsToggle
                checked={codeEditorSettings.wordWrap}
                onChange={onCodeEditorWordWrapChange}
                ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.codeEditor.showMinimap.label')}
              description={t('appearanceSettings.codeEditor.showMinimap.description')}
            >
              <SettingsToggle
                checked={codeEditorSettings.showMinimap}
                onChange={onCodeEditorShowMinimapChange}
                ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            >
              <SettingsToggle
                checked={codeEditorSettings.lineNumbers}
                onChange={onCodeEditorLineNumbersChange}
                ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('appearanceSettings.codeEditor.fontSize.label')}
              description={t('appearanceSettings.codeEditor.fontSize.description')}
            >
              <select
                value={codeEditorSettings.fontSize}
                onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
                aria-label={t('appearanceSettings.codeEditor.fontSize.label')}
                className={cn(SELECT_CLASS, 'sm:w-28')}
              >
                <option value="10">10px</option>
                <option value="11">11px</option>
                <option value="12">12px</option>
                <option value="13">13px</option>
                <option value="14">14px</option>
                <option value="15">15px</option>
                <option value="16">16px</option>
                <option value="18">18px</option>
                <option value="20">20px</option>
              </select>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>

        {/*
          نطاق تلوين الشيفرة — إعداد أداء بواجهة مقروءة. الخيارات ثلاثة فصارت
          منتقياً مجزّأً لا قائمةً منسدلة، ولصائقها القصيرة تذكر عدد اللغات لأنه
          المقايضة الحقيقية (تغطية مقابل حجم تنزيل)، بينما تبقى المقايضة كاملةً في
          وصف الصفّ. والصفّ `stacked`: ثلاثة خيارات نصّية لا تتّسع بجانب لصيقتها.
        */}
        {/* بلا `boxed`: صفٌّ واحد. البطاقة حدُّ **تجميع**، وتأطير عنصرٍ مفرد
            يُفرغها من معناها — وهو الإفراط الذي اعترض عليه المالك أصلاً. */}
        <SettingsSection icon={Highlighter} title={t('appearanceSettings.codeHighlighting.title')}>
          <SettingsGroup>
            <SettingsRow
              stacked
              label={t('appearanceSettings.codeHighlighting.label')}
              description={t('appearanceSettings.codeHighlighting.description')}
            >
              <SegmentedControl
                options={HIGHLIGHT_OPTIONS}
                value={codeHighlightScope}
                onChange={onCodeHighlightScopeChange}
                label={t('appearanceSettings.codeHighlighting.label')}
                className="flex-wrap"
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      </div>
    </SettingsSection>
  );
}
