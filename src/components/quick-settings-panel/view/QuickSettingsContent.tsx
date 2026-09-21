import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DarkModeToggle } from '../../../shared/view/ui';
import LanguageSelector from '../../../shared/view/ui/LanguageSelector';
import {
  SETTING_ROW_CLASS,
  TOOL_DISPLAY_TOGGLES,
  VIEW_OPTION_TOGGLES,
} from '../constants';
import type {
  PreferenceToggleItem,
  PreferenceToggleKey,
  QuickSettingsPreferences,
} from '../types';
import type { EnterBehavior } from '../../../lib/enter-behavior';

import ClaudeUsageSection from './ClaudeUsageSection';
import QuickSettingsEnterBehaviorRow from './QuickSettingsEnterBehaviorRow';
import QuickSettingsSection from './QuickSettingsSection';
import QuickSettingsToggleRow from './QuickSettingsToggleRow';
import SubscriptionsSection from './SubscriptionsSection';

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  // Whether the panel is open — gates Claude usage fetching/polling.
  isOpen: boolean;
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
  /** T-5: session provider passthrough for ClaudeUsageSection's cross-provider label. */
  sessionProvider?: string | null;
  /**
   * مفاتيح تفرضها البيئة الآن فلا تقبل التغيير من هنا؛ القيمة هي سبب التعطيل
   * المعروض للمستخدم. وجود المفتاح = معطَّل (T-1319).
   */
  lockedToggles?: Partial<Record<PreferenceToggleKey, string>>;
  /** ‏T-1319: نيّة سلوك Enter المخزَّنة (‏`auto|send|newline`). */
  enterBehavior: EnterBehavior;
  onEnterBehaviorChange: (value: EnterBehavior) => void;
  /** ماذا تعني `'auto'` على هذا الجهاز الآن — محلولةٌ عرضاً لا مخزَّنة. */
  enterAutoSends: boolean;
};

export default function QuickSettingsContent({
  isDarkMode,
  isOpen,
  preferences,
  onPreferenceChange,
  sessionProvider,
  lockedToggles,
  enterBehavior,
  onEnterBehaviorChange,
  enterAutoSends,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => {
      const lockReason = lockedToggles?.[key];
      return (
        <QuickSettingsToggleRow
          key={key}
          label={t(labelKey)}
          icon={icon}
          checked={preferences[key]}
          onCheckedChange={(value) => onPreferenceChange(key, value)}
          disabled={lockReason !== undefined}
          hint={lockReason}
        />
      );
    })
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <ClaudeUsageSection isOpen={isOpen} sessionProvider={sessionProvider} />

      {/* Collapsed by default: it gates its own fetch on being expanded. */}
      <SubscriptionsSection isOpen={isOpen} />

      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={SETTING_ROW_CLASS}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
            {t('quickSettings.darkMode')}
          </span>
          <DarkModeToggle />
        </div>
        <LanguageSelector compact />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.viewOptions')}>
        {renderToggleRows(VIEW_OPTION_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        <QuickSettingsEnterBehaviorRow
          value={enterBehavior}
          onChange={onEnterBehaviorChange}
          autoSends={enterAutoSends}
        />
      </QuickSettingsSection>
    </div>
  );
}
