import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import { McpServers } from '../../../../../mcp';
import { ProviderSkills } from '../../../../../skills';
import type { SkillsProject } from '../../../../../skills/types';

import AccountContent from './content/AccountContent';
import AgyConnectionSection from './content/AgyConnectionSection';
import ApiSetupContent from './content/ApiSetupContent';
import ClaudeConnectionSection from './content/ClaudeConnectionSection';
import EnginesContent from './content/EnginesContent';
import PermissionsContent from './content/PermissionsContent';

export default function AgentCategoryContentSection({
  selectedAgent,
  selectedCategory,
  agentContextById,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  onRefreshAuthStatus,
  projects,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-4">
      {/* Account: one unified credential card per agent. Credential-isolating
          agents (claude, antigravity) render through their wrapper, which
          merges the per-user subscription link (Phase-MU) into the same card
          and owns the onboarding terminal modal. */}
      {selectedCategory === 'account' && selectedAgent === 'claude' && (
        <ClaudeConnectionSection
          authStatus={agentContextById.claude.authStatus}
          onLogin={agentContextById.claude.onLogin}
          onRefreshAuthStatus={onRefreshAuthStatus}
        />
      )}

      {selectedCategory === 'account' && selectedAgent === 'antigravity' && (
        <AgyConnectionSection
          authStatus={agentContextById.antigravity.authStatus}
          onLogin={agentContextById.antigravity.onLogin}
        />
      )}

      {selectedCategory === 'account' && selectedAgent !== 'claude' && selectedAgent !== 'antigravity' && (
        <AccountContent
          agent={selectedAgent}
          authStatus={agentContextById[selectedAgent].authStatus}
          onLogin={agentContextById[selectedAgent].onLogin}
          onRefreshAuthStatus={onRefreshAuthStatus}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'claude' && (
        <PermissionsContent
          agent="claude"
          skipPermissions={claudePermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
          }}
          allowedTools={claudePermissions.allowedTools}
          onAllowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
          }}
          disallowedTools={claudePermissions.disallowedTools}
          onDisallowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
          }}
          allowVendorDelegation={claudePermissions.allowVendorDelegation}
          onAllowVendorDelegationChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowVendorDelegation: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'cursor' && (
        <PermissionsContent
          agent="cursor"
          skipPermissions={cursorPermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, skipPermissions: value });
          }}
          allowedCommands={cursorPermissions.allowedCommands}
          onAllowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, allowedCommands: value });
          }}
          disallowedCommands={cursorPermissions.disallowedCommands}
          onDisallowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, disallowedCommands: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'codex' && (
        <PermissionsContent
          agent="codex"
          permissionMode={codexPermissionMode}
          onPermissionModeChange={onCodexPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'gemini' && (
        <PermissionsContent
          agent="gemini"
          permissionMode={geminiPermissionMode}
          onPermissionModeChange={onGeminiPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'antigravity' && (
        <PermissionsContent agent="antigravity" />
      )}

      {/* ADR-073 engine axis, scoped to the open body. Which engines this agent
          can run on, what each one's endpoint is, and — for the ones where a key
          is the remaining barrier — the key entry that used to live in a
          separate top-level tab. */}
      {selectedCategory === 'engines' && (
        <EnginesContent agent={selectedAgent} />
      )}

      {selectedCategory === 'setup' && (
        <ApiSetupContent agent={selectedAgent} />
      )}

      {selectedCategory === 'mcp' && (
        // SettingsProject.name is populated from the DB projectId by
        // normalizeProjectForSettings, so we can map it straight through.
        <McpServers
          selectedProvider={selectedAgent}
          currentProjects={projects.map<McpProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}

      {selectedCategory === 'skills' && (
        <ProviderSkills
          selectedProvider={selectedAgent}
          currentProjects={projects.map<SkillsProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}
    </div>
  );
}
