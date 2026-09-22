import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { ProviderAuthStatus } from '../../provider-auth/types';

// ADR-073: there is no top-level `engines` tab. The engine axis is a category of
// each agent (see AgentCategory below) — the two tabs each held half of one fact.
// T-1205: the credential card lives in each agent's Account category — see
// `AgentVendorCredentials` and `companiesForAgent`. T-1206: and `vendors` is
// back beside it as an INDEX and as the home of a company whose agent tile is
// hidden (DeepSeek) — not as a second write surface. `VendorsSettingsTab`.
// ‏`references` (المرجعيّات) تبويبٌ رئيسيٌّ **جديد** لا توسعةٌ لـ`agents`: محورُ
// تبويب الوكلاء هو الجسم، وفئاتُه الستّ كلُّها لجسمٍ بعينه — بينما الذاكرةُ
// وبطاقاتُ الوكلاء مستقلّتان عن المحرّك تماماً (بطاقةُ `qa-critic` واحدةٌ أياً كان
// مَن يشغّلها). والأربع (تعليمات · ذاكرة · بطاقات · مهارات) يتشاركن سؤالاً واحداً
// لا يتشاركه أيُّ تبويبٍ قائم: «ماذا يصل الوكيل قبل أن يبدأ؟».
// 'local-models' was a standalone sidebar tab; removed as a top-level tab and
// merged into the Agents tab as a grid card. Deep links (?settings=local-models)
// are redirected to ?settings=agents&settingsLocalModels=true by settingsUrl.ts.
export type SettingsMainTab = 'profile' | 'agents' | 'references' | 'vendors' | 'appearance' | 'git' | 'api' | 'connectors' | 'notifications' | 'users' | 'command-board' | 'about';
export type AgentProvider = LLMProvider;
// `engines` (ADR-073) is a category of a BODY, not a peer tab: an agent's engines
// belong to the agent the way its permissions do. It replaced the top-level
// Engines tab, which held half of a fact the Agents tab held the other half of.
// `instructions` (ADR-093 §2) هو الآخر فئةُ **جسمٍ** لا تبويبٌ عام: «من أين يأخذ
// هذا الوكيل تعليماته» سؤالٌ عن وكيلٍ بعينه كما هي أذوناته. كان لوحُه مُكدَّساً
// أسفل بطاقة الحساب فيُقرأ ذيلاً لها، وهو جوابٌ قائمٌ بنفسه — وبخلاف `engines`
// و`skills` يُعرَض لكل وكيل بلا استثناء: محرّكٌ بلا آلية له جوابٌ أيضاً («لا قناة
// تعليمات لهذا المحرّك»)، وإخفاء التبويب عنه يجعل الغياب سؤالاً بلا جواب.
// ‏`setup` حُذفت (‏B-414): مُنشئها الوحيد كان `API_ONLY_PROVIDERS` — deepseek/glm
// معطَّلان عالمياً وsakana مُسقَطة من الشريط — ولوحُها `ApiSetupContent` كان يُرجع
// `null` لكل معرّفٍ يبلغه، فهي فئةٌ لا تُعرض ولوحٌ لا يُصيَّر. وبقاؤها في الاتحاد
// كان يُبقي رابطاً عميقاً صالحاً نحو لوحٍ أبيض.
export type AgentCategory = 'account' | 'permissions' | 'engines' | 'instructions' | 'mcp' | 'skills';
export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
export type GeminiPermissionMode = 'default' | 'auto_edit' | 'yolo';

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type AuthStatus = ProviderAuthStatus;

export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  /**
   * Whether a Claude run may delegate a subtask to a hosted vendor model
   * (kimi/deepseek/glm) via the in-process `vendor-delegate` MCP tool (ADR-037,
   * B-DEL-6). Off by default; when on, the composer sets
   * options.allowVendorDelegation so the server registers the per-spawn delegate
   * server keyed to the spawning user.
   */
  allowVendorDelegation: boolean;
};

export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

export type CodeEditorSettingsState = {
  theme: 'dark' | 'light';
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsStoragePayload = {
  claude: ClaudePermissionsState & { projectSortOrder: ProjectSortOrder; lastUpdated: string };
  cursor: CursorPermissionsState & { lastUpdated: string };
  codex: { permissionMode: CodexPermissionMode; lastUpdated: string };
};

export type SettingsDeepLink = {
  tab: SettingsMainTab;
  agent?: AgentProvider;
  category?: AgentCategory;
  /** Company row to focus when opening the sole credential-entry surface. */
  companyId?: string;
  /**
   * When true and tab === 'agents', the agents grid opens with the
   * «النماذج المحلية» card selected instead of a harness card.
   * Produced by settingsUrl.ts when reading ?settings=local-models (legacy)
   * or ?settings=agents&settingsLocalModels=true.
   */
  localModels?: true;
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
  deepLink?: SettingsDeepLink;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
