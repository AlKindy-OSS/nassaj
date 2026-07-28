import { useEffect, useMemo, useState } from 'react';

import { filterDisabledProviders } from '../../../../../../shared/disabledProviders';
import { bodyHasEngineAxis } from '../../../../../../shared/bodyEngineMatrix';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  onRefreshAuthStatus,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  projects,
  initialAgent,
  initialCategory,
}: AgentsSettingsTabProps) {
  // B-256: honour deep-link destination from ProviderSelectionEmptyState CTA.
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>(initialAgent ?? 'claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>(initialCategory ?? 'account');

  // Providers with a dedicated skill management tab.
  const SKILLS_CAPABLE_PROVIDERS: AgentProvider[] = ['claude', 'codex', 'cursor', 'gemini', 'opencode'];
  // Providers that expose a vendor API-key setup step.
  const API_ONLY_PROVIDERS: AgentProvider[] = ['deepseek', 'glm', 'sakana'];

  const visibleCategories = useMemo<AgentCategory[]>(() => {
    const isApiOnly = API_ONLY_PROVIDERS.includes(selectedAgent);
    const hasSkills = SKILLS_CAPABLE_PROVIDERS.includes(selectedAgent);

    const base: AgentCategory[] = isApiOnly
      ? ['account', 'setup', 'permissions', 'mcp']
      : ['account', 'permissions', 'mcp'];

    // ADR-073: the engine axis, folded into the body it describes. Placed right
    // after `account` because it answers the same kind of question — what this
    // agent is authorized to run on — and it is shown only for bodies that have
    // a row in the matrix, so a body with no engine axis grows no empty tab.
    if (bodyHasEngineAxis(selectedAgent)) {
      base.splice(base.indexOf('account') + 1, 0, 'engines');
    }

    if (hasSkills) {
      base.push('skills');
    }

    return base;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent]);

  // Keep the selected category in sync when the visible set changes (e.g.
  // switching from a provider with a skills tab to one without).
  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    // Globally disabled providers (T-864) are dropped from the settings agent
    // bar (Account/Permissions/MCP); the full list stays for upstream sync.
    return filterDisabledProviders([
      'claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode',
      'kimi', 'deepseek', 'glm', 'hermes', 'sakana',
    ]);
  }, []);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    gemini: {
      authStatus: providerAuthStatus.gemini,
      onLogin: () => onProviderLogin('gemini'),
    },
    // `onLogin` is wired but `AccountContent` for antigravity does not surface
    // a login button — agy uses Google OAuth from its CLI and the panel only
    // shows status plus instructions to run `agy -p hello`.
    antigravity: {
      authStatus: providerAuthStatus.antigravity,
      onLogin: () => onProviderLogin('antigravity'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
    },
    // kimi has BOTH paths (ADR-062): the API-key panel and — because it ships
    // the native @moonshot-ai/kimi-code CLI — a real device-code login modal, so
    // `onLogin` is live here. deepseek/glm have no CLI: their `onLogin` never
    // reaches a CTA because AccountContent lists them as pure-API providers.
    kimi: {
      authStatus: providerAuthStatus.kimi,
      onLogin: () => onProviderLogin('kimi'),
    },
    deepseek: {
      authStatus: providerAuthStatus.deepseek,
      onLogin: () => onProviderLogin('deepseek'),
    },
    glm: {
      authStatus: providerAuthStatus.glm,
      onLogin: () => onProviderLogin('glm'),
    },
    hermes: {
      authStatus: providerAuthStatus.hermes,
      onLogin: () => onProviderLogin('hermes'),
    },
    sakana: {
      authStatus: providerAuthStatus.sakana,
      onLogin: () => onProviderLogin('sakana'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.gemini,
    providerAuthStatus.antigravity,
    providerAuthStatus.opencode,
    providerAuthStatus.kimi,
    providerAuthStatus.deepseek,
    providerAuthStatus.glm,
    providerAuthStatus.hermes,
    providerAuthStatus.sakana,
  ]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          selectedAgent={selectedAgent}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          onRefreshAuthStatus={() => onRefreshAuthStatus(selectedAgent)}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          geminiPermissionMode={geminiPermissionMode}
          onGeminiPermissionModeChange={onGeminiPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
