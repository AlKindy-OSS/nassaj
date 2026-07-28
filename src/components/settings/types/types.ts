import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { ProviderAuthStatus } from '../../provider-auth/types';

// ADR-073: there is no top-level `engines` tab. The engine axis is a category of
// each agent (see AgentCategory below) — the two tabs each held half of one fact.
export type SettingsMainTab = 'profile' | 'agents' | 'appearance' | 'git' | 'api' | 'notifications' | 'plugins' | 'users' | 'command-board' | 'about';
export type AgentProvider = LLMProvider;
// `engines` (ADR-073) is a category of a BODY, not a peer tab: an agent's engines
// belong to the agent the way its permissions do. It replaced the top-level
// Engines tab, which held half of a fact the Agents tab held the other half of.
export type AgentCategory = 'account' | 'permissions' | 'engines' | 'mcp' | 'setup' | 'skills';
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
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
  deepLink?: SettingsDeepLink;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
