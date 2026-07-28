import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';

export type PreferenceToggleKey =
  | 'autoExpandTools'
  | 'showRawParameters'
  | 'showThinking'
  | 'hideToolCalls'
  | 'autoScrollToBottom'
  | 'sendByCtrlEnter'
  | 'tabsIconOnly';

export type QuickSettingsPreferences = Record<PreferenceToggleKey, boolean>;

export type PreferenceToggleItem = {
  key: PreferenceToggleKey;
  labelKey: string;
  icon: LucideIcon;
};

export type QuickSettingsHandleStyle = CSSProperties;
