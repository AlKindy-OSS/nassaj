import {
  ArrowDown,
  Brain,
  Eye,
  EyeOff,
  Languages,
  Maximize2,
  PanelTop,
} from 'lucide-react';
import type { PreferenceToggleItem } from './types';

export const HANDLE_POSITION_STORAGE_KEY = 'quickSettingsHandlePosition';

export const DEFAULT_HANDLE_POSITION = 50;
export const HANDLE_POSITION_MIN = 10;
export const HANDLE_POSITION_MAX = 90;
export const DRAG_THRESHOLD_PX = 5;

export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-secondary hover:bg-accent transition-colors border border-transparent hover:border-border';

export const TOGGLE_ROW_CLASS = `${SETTING_ROW_CLASS} cursor-pointer`;

export const CHECKBOX_CLASS =
  'h-4 w-4 rounded border-border bg-card accent-primary focus:ring-2 focus:ring-ring';

export const TOOL_DISPLAY_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'autoExpandTools',
    labelKey: 'quickSettings.autoExpandTools',
    icon: Maximize2,
  },
  {
    key: 'showRawParameters',
    labelKey: 'quickSettings.showRawParameters',
    icon: Eye,
  },
  {
    key: 'showThinking',
    labelKey: 'quickSettings.showThinking',
    icon: Brain,
  },
  {
    key: 'hideToolCalls',
    labelKey: 'quickSettings.hideToolCalls',
    icon: EyeOff,
  },
];

export const VIEW_OPTION_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'autoScrollToBottom',
    labelKey: 'quickSettings.autoScrollToBottom',
    icon: ArrowDown,
  },
  {
    key: 'tabsIconOnly',
    labelKey: 'quickSettings.tabsIconOnly',
    icon: PanelTop,
  },
];

export const INPUT_SETTING_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    icon: Languages,
  },
];
