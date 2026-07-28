import { useTranslation } from 'react-i18next';

import { DarkModeToggle, ThemeModeSelector } from '../../../../shared/view/ui';
import LanguageSelector from '../../../../shared/view/ui/LanguageSelector';
import type { CodeHighlightScope } from '../../../../syntax/codeHighlightScope';
import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

import BrandingSettingsSection from './BrandingSettingsSection';
import ThemePresetPicker from './ThemePresetPicker';
import UiFontPicker from './UiFontPicker';

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
  codeHighlightScope,
  onCodeHighlightScopeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      {/* Server identity — owner-only; component renders null for non-owners */}
      <BrandingSettingsSection />

      <SettingsSection title={t('appearanceSettings.themeMode.sectionTitle')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.themeMode.label')}
            description={t('appearanceSettings.themeMode.description')}
          >
            <ThemeModeSelector />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <ThemePresetPicker />

      <UiFontPicker />

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.sidebar.title')}>
        <SettingsCard>
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
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.theme.label')}
            description={t('appearanceSettings.codeEditor.theme.description')}
          >
            <DarkModeToggle
              checked={codeEditorSettings.theme === 'dark'}
              onToggle={(enabled) => onCodeEditorThemeChange(enabled ? 'dark' : 'light')}
              ariaLabel={t('appearanceSettings.codeEditor.theme.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
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
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
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
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
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
        </SettingsCard>
      </SettingsSection>

      {/*
        نطاق تلوين الشيفرة — إعداد أداء بواجهة مقروءة: الخيار يذكر عدد اللغات
        لأنه المقايضة الحقيقية (تغطية مقابل حجم تنزيل)، والوصف يقول صراحةً إن
        الافتراضي وحده ما يُحمَّل مع الصفحة. `dir="ltr"` غير مطلوب هنا: النص
        كله عربي والأرقام تتبع اتجاه الفقرة.
      */}
      <SettingsSection title={t('appearanceSettings.codeHighlighting.title')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.codeHighlighting.label')}
            description={t('appearanceSettings.codeHighlighting.description')}
          >
            <select
              value={codeHighlightScope}
              onChange={(event) =>
                onCodeHighlightScopeChange(event.target.value as CodeHighlightScope)
              }
              aria-label={t('appearanceSettings.codeHighlighting.label')}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-48"
            >
              <option value="core">{t('appearanceSettings.codeHighlighting.core')}</option>
              <option value="extended">{t('appearanceSettings.codeHighlighting.extended')}</option>
              <option value="full">{t('appearanceSettings.codeHighlighting.full')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
