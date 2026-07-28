import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useTheme } from '../../../contexts/ThemeContext';
import { useQuickSettingsDrag } from '../hooks/useQuickSettingsDrag';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '../types';
import QuickSettingsContent from './QuickSettingsContent';
import QuickSettingsHandle from './QuickSettingsHandle';
import QuickSettingsPanelHeader from './QuickSettingsPanelHeader';

type QuickSettingsPanelViewProps = {
  /** T-5: مزوّد الجلسة المفتوحة حالياً — يُمرَّر إلى ClaudeUsageSection للوسم. */
  sessionProvider?: string | null;
};

export default function QuickSettingsPanelView({ sessionProvider }: QuickSettingsPanelViewProps = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDarkMode } = useTheme();
  const { preferences, setPreference } = useUiPreferences();
  const {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  } = useQuickSettingsDrag({ isMobile });

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    autoExpandTools: preferences.autoExpandTools,
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    hideToolCalls: preferences.hideToolCalls,
    autoScrollToBottom: preferences.autoScrollToBottom,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
    tabsIconOnly: preferences.tabsIconOnly,
  }), [
    preferences.autoExpandTools,
    preferences.autoScrollToBottom,
    preferences.hideToolCalls,
    preferences.sendByCtrlEnter,
    preferences.showRawParameters,
    preferences.showThinking,
    preferences.tabsIconOnly,
  ]);

  const handlePreferenceChange = useCallback(
    (key: PreferenceToggleKey, value: boolean) => {
      setPreference(key, value);
    },
    [setPreference],
  );

  const handleToggleFromHandle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A drag releases a click event as well; this guard prevents accidental toggles.
      if (consumeSuppressedClick()) {
        event.preventDefault();
        return;
      }

      setIsOpen((previous) => !previous);
    },
    [consumeSuppressedClick],
  );

  return (
    <>
      <QuickSettingsHandle
        isOpen={isOpen}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggleFromHandle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />

      <div
        className={`fixed end-0 top-0 z-40 h-full w-64 transform border-s border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'ltr:translate-x-full rtl:-translate-x-full'} ${isMobile ? 'h-screen' : ''}`}
      >
        <div className="flex h-full flex-col">
          <QuickSettingsPanelHeader />
          <QuickSettingsContent
            isDarkMode={isDarkMode}
            isOpen={isOpen}
            preferences={quickSettingsPreferences}
            onPreferenceChange={handlePreferenceChange}
            sessionProvider={sessionProvider}
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
