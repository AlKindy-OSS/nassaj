import type { ActiveBodyProvider } from '../../../../../types/app';
import type {
  AgentProvider,
  AuthStatus,
  AgentCategory,
  ClaudePermissionsState,
  CodexPermissionMode,
  SettingsProject,
} from '../../../types/types';

export type AgentContext = {
  authStatus: AuthStatus;
  onLogin: () => void;
};

// T-1953: keyed by ActiveBodyProvider, not the wider AgentProvider — a retired
// body (cursor/hermes/qwen/kimi) has no auth-status row and no login command
// left to key by. `AgentProvider` stays the type used for a settings TILE
// (SETTINGS_AGENT_ORDER already drops the four, so no tile ever asks for one).
export type AgentContextByProvider = Record<ActiveBodyProvider, AgentContext>;
export type ProviderAuthStatusByProvider = Record<ActiveBodyProvider, AuthStatus>;

export type AgentsSettingsTabProps = {
  providerAuthStatus: ProviderAuthStatusByProvider;
  onProviderLogin: (provider: ActiveBodyProvider) => void;
  /** Re-probes a provider's `/auth/status` (used after a vendor key change). */
  onRefreshAuthStatus: (provider: ActiveBodyProvider) => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
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
  /**
   * T-1866: opens the owner-only «النظام» tab from HarnessVersionSection's
   * pointer to where auto-update is now configured. Absent (e.g. no owner
   * role) ⇒ the pointer renders as plain text instead of a link.
   */
  onOpenSystemTab?: () => void;
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
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  projects: SettingsProject[];
  /** T-1866: see AgentsSettingsTabProps. */
  onOpenSystemTab?: () => void;
};
