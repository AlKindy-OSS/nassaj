import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  Building2,
  GitBranch,
  Info,
  KeyRound,
  Library,
  Link2,
  Palette,
  SlidersHorizontal,
  Server,
  User,
  Users,
} from 'lucide-react';

import type {
  CodeEditorSettingsState,
  CursorPermissionsState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  /** English display label (CommandPalette item text). */
  label: string;
  /** i18n key in the 'settings' namespace (SettingsSidebar). */
  labelKey: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  /** When set, the item is only shown to users whose role is included. */
  roles?: ReadonlyArray<string>;
};

/**
 * Roles that can reach the Command Board tab in the settings nav.
 *
 * Lives here rather than in SettingsSidebar so the sidebar footer can ask the
 * same question — «would a raw-queue badge on «Settings» lead anywhere?» (B-247)
 * — without a second copy of the list that could drift from the nav it describes.
 *
 * Defined before SETTINGS_MAIN_TABS so it can be referenced in the roles field.
 */
export const COMMAND_BOARD_TAB_ROLES: ReadonlyArray<string> = ['owner'];

/**
 * Single source of truth for all settings tab metadata (B-255).
 *
 * Replaces the previous dual-list situation where SettingsSidebar.NAV_ITEMS
 * (10 entries) and this constant (8 entries) diverged, causing ⌘K to miss
 * the profile and command-board tabs.
 *
 * Consumers:
 *  - SettingsSidebar: renders this list filtered by user role, translates via labelKey.
 *  - CommandPalette: renders this list filtered by user role, uses label for display.
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  {
    id: 'profile',
    label: 'Profile',
    labelKey: 'mainTabs.profile',
    keywords: 'profile account user',
    icon: User,
  },
  // Engines are NOT a peer of Agents (ADR-073): every agent carries its own
  // engines tab, so the axis is read where the body it belongs to is read.
  {
    id: 'agents',
    label: 'Agents',
    labelKey: 'mainTabs.agents',
    keywords: 'agents subagents claude code',
    icon: Bot,
  },
  {
    id: 'local-models',
    label: 'Local models',
    labelKey: 'mainTabs.localModels',
    keywords: 'local models servers ollama lm studio llama vllm نماذج محلية خوادم',
    icon: Server,
  },
  // «الأجسام» ثم «ما تقرؤه الأجسام» ثم «مَن يزوّدها» — فموضعُ المرجعيّات بعد
  // `agents` مباشرةً وقبل `vendors`. وبلا حقل `roles`: القراءة مفتوحةٌ لكل عضو،
  // والتمييز يقع على **التحرير** لا على الرؤية (كتبويب الموصلات حرفياً).
  {
    id: 'references',
    label: 'References',
    labelKey: 'mainTabs.references',
    keywords: 'references instructions memory agent cards skills nassaj governance',
    icon: Library,
  },
  // T-1205 حذف هذا التبويب ونقل بطاقةَ كل شركة إلى تبويب «الحساب» للوكيل الذي
  // يخصّها. وT-1206 أعاده **بدورٍ آخر**: فهرسُ كل المفاتيح في شاشة واحدة،
  // ومنزلُ الشركة التي لا بلاطةَ لوكيلها (DeepSeek) فلا حساب تُعرض فيه. وهو شرط
  // سلامة لا تفضيل: بلا هذا التبويب يصير مفتاحُ DeepSeek غير قابلٍ للإدخال بلا
  // رسالة خطأ في أي مكان — وذلك ما يحرسه `vendors.test.ts` آلياً.
  {
    id: 'vendors',
    label: 'Vendors & credentials',
    labelKey: 'mainTabs.vendors',
    keywords: 'vendors credentials api key anthropic openai moonshot deepseek zai openrouter',
    // `Building2` لا `KeyRound`: المفتاح مأخوذٌ لتبويب مفاتيح واجهة نسّاج،
    // والمورّد **شركة** — وهو التمييز الذي وُجد المحور لأجله (ADR-085).
    icon: Building2,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    labelKey: 'mainTabs.appearance',
    keywords: 'appearance theme dark light language',
    icon: Palette,
  },
  {
    id: 'git',
    label: 'Git',
    labelKey: 'mainTabs.git',
    keywords: 'git github commits',
    icon: GitBranch,
  },
  // T-1219 — «الوصول البرمجي» لا «مفاتيح واجهة نسّاج». الاسمان كانا يقولان
  // «مفاتيح API» في شريطٍ واحد وهما شيئان متعاكسان: هذا توكناتٌ **تدخل** إلى
  // نسّاج لأتمتةٍ خارجية، وذاك مفاتيحُ مزوّدين **تخرج** منه. التبويب باقٍ لأن
  // الوظيفتين مختلفتان؛ الاسم وحده هو ما كان يخلطهما.
  {
    id: 'api',
    label: 'Programmatic access',
    labelKey: 'mainTabs.apiTokens',
    keywords: 'api tokens auth keys nassaj programmatic automation ci webhook',
    icon: KeyRound,
  },
  // ADR-098 — external platforms reached by one nassaj-wide API key. Sits next
  // to «Programmatic access» because both are about keys, and deliberately apart
  // from it because these point OUTWARD (nassaj calling Canva) while that one
  // points INWARD (automation calling nassaj). No `roles` field: reading the
  // list is open to every member, since a connector is usable by every member.
  {
    id: 'connectors',
    label: 'Connectors',
    labelKey: 'mainTabs.connectors',
    keywords: 'connectors platforms canva google api key external integrations موصلات',
    icon: Link2,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    labelKey: 'mainTabs.notifications',
    keywords: 'notifications alerts push',
    icon: Bell,
  },
  {
    id: 'users',
    label: 'Users',
    labelKey: 'mainTabs.users',
    keywords: 'users members invites roles team',
    icon: Users,
    roles: ['owner', 'admin'],
  },
  {
    id: 'command-board',
    label: 'Command Board',
    labelKey: 'mainTabs.commandBoard',
    keywords: 'command board queue settings admin',
    icon: SlidersHorizontal,
    roles: COMMAND_BOARD_TAB_ROLES,
  },
  {
    id: 'about',
    label: 'About',
    labelKey: 'mainTabs.about',
    keywords: 'about version info',
    icon: Info,
  },
];

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
export const DEFAULT_SAVE_STATUS = null;
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  theme: 'dark',
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};

export const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};
