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
  /**
   * When true, open with the «النماذج المحلية» grid card selected instead of a
   * harness card. Set from a legacy ?settings=local-models deep link or from
   * ?settings=agents&settingsLocalModels=true.
   */
  initialLocalModels?: boolean;
  /** Mirrors the active agent surface into the shareable settings URL. */
  onDestinationChange?: (agent: AgentProvider, category: AgentCategory, options?: { replace?: boolean }) => void;
  /** Called when the «النماذج المحلية» grid card is selected; parent writes the URL. */
  onLocalModelsSelect?: (options?: { replace?: boolean }) => void;
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
  /** Whether the «النماذج المحلية» card at the end of the grid is active. */
  localModelsSelected?: boolean;
  /** Label for the local-models card (from i18n). When omitted the card is not rendered. */
  localModelsLabel?: string;
  /** Called when the local-models card is clicked. */
  onSelectLocalModels?: () => void;
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
