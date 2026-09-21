import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useResolvedTabsMode } from '../../../hooks/useResolvedTabsMode';
import { useTheme } from '../../../contexts/ThemeContext';
import { FINE_POINTER_QUERY, resolveEnterSends, type EnterBehavior } from '../../../lib/enter-behavior';
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
  const { t, i18n } = useTranslation('settings');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDarkMode } = useTheme();
  const { preferences, setPreference } = useUiPreferences();
  const {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  } = useQuickSettingsDrag({ isMobile });

  // ‏T-1319: المربّع يعرض الوضع **المعروض فعلاً** لا القيمة المخزَّنة، وحين
  // تفرض البيئةُ الضمَّ (شاشة دون `lg` أو مؤشّر خشن) يُعطَّل مع سبب.
  //
  // ولمَ التعطيل لا مجرّد عرض المحلول؟ لأنّ المربّع ثنائي والفضاء رباعي: لو
  // بقي فعّالاً لألغى المستخدم التأشير فكتب `full`، ثمّ حلّته البيئةُ إلى
  // `compact` فارتدّ مؤشَّراً أمام عينه. ولو قرأ المخزَّنة لما أحدثت ضغطتُه
  // أثراً مرئياً. التعطيل هو الفرع الوحيد الذي لا يكذب ولا يرتدّ — والزرّ
  // الدوّار في الرأس يبقى المسار الكامل بحالاته الأربع.
  const resolvedTabsMode = useResolvedTabsMode();
  const tabsModeIsForced = resolvedTabsMode !== preferences.tabsDisplayMode;

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    autoExpandTools: preferences.autoExpandTools,
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    showToolCalls: preferences.showToolCalls,
    autoScrollToBottom: preferences.autoScrollToBottom,
    tabsIconOnly: resolvedTabsMode === 'compact',
  }), [
    preferences.autoExpandTools,
    preferences.autoScrollToBottom,
    preferences.showToolCalls,
    preferences.showRawParameters,
    preferences.showThinking,
    resolvedTabsMode,
  ]);

  // ‏T-1319: نتيجة `'auto'` على هذا الجهاز الآن، تُعرض تحت المنتقي. حسابُ عرضٍ
  // بحت — لا يُكتب ولا يُزامَن، وإلّا صعدت نتيجةُ الهاتف إلى الحساب فوق النيّة.
  const hasFinePointer = useMediaQuery(FINE_POINTER_QUERY);
  const enterAutoSends = resolveEnterSends('auto', { hasFinePointer });

  const handleEnterBehaviorChange = useCallback(
    (value: EnterBehavior) => {
      setPreference('enterBehavior', value);
    },
    [setPreference],
  );

  // نصّ السبب بـ`defaultValue` لا بمفتاح ترجمة جديد: ملفّات `src/i18n/locales`
  // تحت تعديل جلسة أخرى الآن، والسابقة قائمة في `MainContentHeader`.
  const lockedToggles = useMemo(
    () => (tabsModeIsForced
      ? {
        tabsIconOnly: t('quickSettings.tabsIconOnlyForced', {
          defaultValue: i18n.language?.startsWith('ar')
            ? 'مفروض على هذه الشاشة — لا تتّسع للنصوص'
            : 'Forced on this screen — no room for labels',
        }),
      }
      : undefined),
    [tabsModeIsForced, t, i18n.language],
  );

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
            lockedToggles={lockedToggles}
            enterBehavior={preferences.enterBehavior}
            onEnterBehaviorChange={handleEnterBehaviorChange}
            enterAutoSends={enterAutoSends}
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
