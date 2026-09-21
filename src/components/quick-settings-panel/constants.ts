import {
  ArrowDown,
  Brain,
  Eye,
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

/**
 * نفس سطح `SETTING_ROW_CLASS` لكن مرصوصاً عمودياً: تحكّمٌ أعرض من أن يجاور
 * لصيقته في لوحةٍ بعرض `w-64` (منتقٍ ثلاثيّ الخيارات). الرموز واحدة فلا ينزاح
 * الصفّان عن بعضهما مع الأنساق.
 */
export const STACKED_SETTING_ROW_CLASS =
  'flex flex-col gap-2 p-3 rounded-lg bg-secondary transition-colors border border-transparent';

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
    key: 'showToolCalls',
    labelKey: 'quickSettings.showToolCalls',
    icon: Eye,
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

/*
 * ‏T-1319: لم يعد في «إعدادات الإدخال» مفتاحٌ ثنائي. سلوك Enter فضاءٌ ثلاثي
 * (`auto|send|newline`) لا يُمثَّل بمربّع تأشير، وله صفّه الخاص
 * `QuickSettingsEnterBehaviorRow`.
 */
