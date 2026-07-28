import type {
  AgentProvider,
  AuthStatus,
  AgentCategory,
  ClaudePermissionsState,
  CursorPermissionsState,
  CodexPermissionMode,
  GeminiPermissionMode,
  SettingsProject,
} from '../../../types/types';

export type AgentContext = {
  authStatus: AuthStatus;
  onLogin: () => void;
};

export type AgentContextByProvider = Record<AgentProvider, AgentContext>;
export type ProviderAuthStatusByProvider = Record<AgentProvider, AuthStatus>;

export type AgentsSettingsTabProps = {
  providerAuthStatus: ProviderAuthStatusByProvider;
  onProviderLogin: (provider: AgentProvider) => void;
  /** Re-probes a provider's `/auth/status` (used after a vendor key change). */
  onRefreshAuthStatus: (provider: AgentProvider) => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  geminiPermissionMode: GeminiPermissionMode;
  onGeminiPermissionModeChange: (value: GeminiPermissionMode) => void;
  projects: SettingsProject[];
  /** B-256: deep-link initial agent selection (from ProviderSelectionEmptyState CTA). */
  initialAgent?: AgentProvider;
  /** B-256: deep-link initial category selection. */
  initialCategory?: AgentCategory;
};

export type AgentCategoryTabsSectionProps = {
  /** The ordered list of categories to render as tabs — computed by the parent. */
  categories: AgentCategory[];
  selectedCategory: AgentCategory;
  onSelectCategory: (category: AgentCategory) => void;
  selectedAgent: AgentProvider;
};

export type AgentSelectorSectionProps = {
  agents: AgentProvider[];
  selectedAgent: AgentProvider;
  onSelectAgent: (agent: AgentProvider) => void;
  agentContextById: AgentContextByProvider;
};

export type AgentCategoryContentSectionProps = {
  selectedAgent: AgentProvider;
  selectedCategory: AgentCategory;
  agentContextById: AgentContextByProvider;
  /** Bound to the selected agent; refreshes its `/auth/status` after a key change. */
  onRefreshAuthStatus?: () => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  geminiPermissionMode: GeminiPermissionMode;
  onGeminiPermissionModeChange: (value: GeminiPermissionMode) => void;
  projects: SettingsProject[];
};
