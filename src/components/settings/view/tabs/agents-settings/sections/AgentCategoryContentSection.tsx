import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import { McpServers } from '../../../../../mcp';
import { ProviderSkills } from '../../../../../skills';
import type { SkillsProject } from '../../../../../skills/types';

import { COMING_SOON_SETTINGS_PROVIDERS } from '../visibleAgents';
import { AGENT_CATEGORY_PANEL_ID } from './AgentCategoryTabsSection';
import AccountContent from './content/AccountContent';
import AgentUsageSection from './content/AgentUsageSection';
import AgyConnectionSection from './content/AgyConnectionSection';
import ClaudeConnectionSection from './content/ClaudeConnectionSection';
import ComingSoonContent from './content/ComingSoonContent';
import CredentialGrantsSection from './content/CredentialGrantsSection';
import EnginesContent from './content/EnginesContent';
import InstructionSourcesContent from './content/InstructionSourcesContent';
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
  // Coming-soon providers (e.g. deepseek T-1760): no categories, no tabs — show
  // the coming-soon panel in place of the entire category content tree.
  if (COMING_SOON_SETTINGS_PROVIDERS.includes(selectedAgent)) {
    return (
      <div id={AGENT_CATEGORY_PANEL_ID} role="region" tabIndex={-1} className="pt-4">
        <ComingSoonContent agent={selectedAgent} />
      </div>
    );
  }

  return (
    // الحشو من القشرة وحدها (‏`Settings.tsx`): كان يُضاف هنا فوق حشو القشرة
    // المُلغى بهوامش سالبة، فكانت صفحة الوكلاء تُقاس بإيقاعين متراكبين.
    //
    // ‏`tabpanel` بمعرّفٍ حقيقي: شريط التبويبات فوقه كان يعلن `role="tab"` بلا
    // `aria-controls` يشير إلى لوحٍ موجود، فكان العقد ناقصاً على قارئ الشاشة.
    <div
      id={AGENT_CATEGORY_PANEL_ID}
      role="tabpanel"
      tabIndex={-1}
      className="pt-4"
    >
      {/*
        **تبويب الحساب: ثلاثة أقسام في تسلسلٍ واحد وفاصلٍ واحد** (‏T-1700، شكوى
        المالك 2026-09-10: «فيها نوع من الفوضى»).

        الترتيب يتبع سؤال القارئ: **أموصولٌ أنا؟** (الاتصال والربط) ← **مع من
        أشارك اعتمادي؟** ← **كم بقي لي؟** (حدود الاستخدام). وكان القسم الأول
        يُصيَّر خارج أي غلافٍ مشترك ثم يُفتَح للقسمين الباقيين غلافٌ ثانٍ
        بـ`mt-8 space-y-8` — أي فاصلان مصدرُهما اثنان لثلاثة أقسام. الآن غلافٌ
        واحد يملك الفاصل كلَّه، فلا يمكن لفجوةٍ أن تختلف عن أختها.

        والقسم الأول يُختار بحسب الوكيل: الوكلاء العازلون للاعتماد (claude،
        antigravity) يمرّون بغلافهم الذي يدمج ربط الاشتراك لكل مستخدم
        (‏Phase-MU) في البطاقة نفسها ويملك مودال الطرفية.

        ‏`CredentialGrantsSection` (‏T-1675) لا تُصيّر شيئاً لوكيلٍ لا اعتماد له
        يُشارَك (sakana، qwen) فلا تُنتج فجوةً فارغة.
      */}
      {selectedCategory === 'account' && (
        <div className="space-y-8">
          {selectedAgent === 'claude' ? (
            <ClaudeConnectionSection
              authStatus={agentContextById.claude.authStatus}
              onLogin={agentContextById.claude.onLogin}
              onRefreshAuthStatus={onRefreshAuthStatus}
            />
          ) : selectedAgent === 'antigravity' ? (
            <AgyConnectionSection
              authStatus={agentContextById.antigravity.authStatus}
              onLogin={agentContextById.antigravity.onLogin}
            />
          ) : (
            <AccountContent
              agent={selectedAgent}
              authStatus={agentContextById[selectedAgent].authStatus}
              onLogin={agentContextById[selectedAgent].onLogin}
              onRefreshAuthStatus={onRefreshAuthStatus}
            />
          )}

          <CredentialGrantsSection agent={selectedAgent} />

          <AgentUsageSection agent={selectedAgent} />
        </div>
      )}

      {/*
        **لا مفاتيح في صفحة الوكيل** (‏T-1223، شكوى المالك 2026-08-04: «فيه
        ازدواجية وتكرار بين تبويبات صفحات الوكلاء وصفحة المزوّدين»).

        كان هنا `AgentVendorCredentials`: بطاقةُ الشركة (‏T-1205)، ثم — بعد أن
        انتقل الحقلُ إلى تبويب المورّدين (‏T-1219) — صفٌّ يقول «Anthropic · لا
        مفتاح مخزَّن». والصفُّ نفسُه يُطبع في تبويب المورّدين ومعه الحقل، فصارت
        نفسُ المعلومة في شاشتين — وهو الازدواج بعينه، أقلَّ حجماً لا أقلَّ عدداً.

        والمبدأ الذي يمنع عودته: **المفتاح محورُ الشركة، والصفحة هنا محورُ
        الوكيل**. فما يخصّ الوكيل يبقى (اتصالُه، تسجيلُ دخوله، أذوناتُه،
        محرّكاتُه، تعليماتُه) وما يخصّ الشركة يعيش في شاشة الشركات وحدها.

        و«كيف يعرف المالكُ أن OpenCode ينقصه مفتاح؟» — من تبويب **المحرّكات** في
        صفحته: يقول «ينقصه اعتماد» ويسمّي أين يُدار. جوابٌ واحد في مكانٍ واحد، لا
        اثنان يتنافسان.
      */}

      {/* ADR-093 §2 (T-1195) — «من أين يأخذ هذا الوكيل تعليماته»، **تبويبٌ قائم
          بذاته** (شكوى المالك 2026-08-03). كان مُكدَّساً أسفل بطاقة الحساب بحجّة
          أنه يجيب سؤالها من الجهة الأخرى، فقُرئ ذيلاً للبطاقة لا جواباً مستقلاً،
          والبطاقةُ فوقه تدفعه خارج أول شاشة. `standalone` يجعله يعلن نفسه ولو لم
          يُجب الخادم بقنوات — تبويبٌ فارغ سؤالٌ بلا جواب. */}
      {selectedCategory === 'instructions' && (
        <InstructionSourcesContent agent={selectedAgent} standalone />
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
