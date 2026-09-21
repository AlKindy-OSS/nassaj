import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgentCategory, AgentProvider } from '../../../types/types';
import SettingsSection from '../../SettingsSection';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';
import { visibleCategoriesFor } from './agentCategories';
import { visibleSettingsAgents } from './visibleAgents';

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
  onDestinationChange,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  // B-256: honour deep-link destination from ProviderSelectionEmptyState CTA.
  // T-1205 — الرابط العميق صار يحمل **وكيلاً** بعد أن كان يحمل تبويب
  // «المورّدين». ولا يُصفّى بقائمة الشريط عمداً: مزوّدٌ معطَّل عالمياً (‏`glm`)
  // بلا بلاطة في الشريط تبقى صفحته قابلة للفتح بالرابط، وفيها اعتماد Z.AI —
  // وحجبُه كان سيحوّل زرّ «أضِف مفتاحاً» في منتقي النماذج إلى طريق مسدود.
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>(initialAgent ?? 'claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>(initialCategory ?? 'account');
  const appliedInitialDestinationRef = useRef<string | null>(null);

  // ‏B-414 — الحساب انتقل إلى `agentCategories.ts`: الفئة تظهر ⟺ لها لوحٌ يُصيَّر،
  // والحارس الآلي يسأل نفس الدالّة. كان هنا نسخةٌ يدوية تضع «الأذونات» لكل وكيل
  // بلا استثناء بينما اللوح يقبل خمسة معرّفات، وفئةَ «الإعداد» لثلاثة مزوّدين لا
  // بلاطةَ لأيٍّ منهم في الشريط.
  const visibleCategories = useMemo<AgentCategory[]>(
    () => visibleCategoriesFor(selectedAgent),
    [selectedAgent],
  );

  // Keep the selected category in sync when the visible set changes (e.g.
  // switching from a provider with a skills tab to one without).
  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      const category = visibleCategories[0] ?? 'account';
      setSelectedCategory(category);
      // A category may be syntactically valid yet unavailable to this agent
      // (for example `permissions` on Kimi). Canonicalize the shared URL.
      //
      // B-1133 guard: only call onDestinationChange when the category
      // actually changes. For coming-soon providers (visibleCategories=[]) the
      // fallback is always 'account', which equals selectedCategory after the
      // first canonicalization. Calling it on every render would create an
      // infinite loop: the unmemoised handleAgentDestinationChange in
      // Settings.tsx produces a new function reference on every re-render,
      // which re-triggers this effect, which calls it again — preventing the
      // user from switching back to any other agent.
      if (category !== selectedCategory) {
        onDestinationChange?.(selectedAgent, category, { replace: true });
      }
    }
  }, [onDestinationChange, selectedAgent, selectedCategory, visibleCategories]);

  // A shared URL may be opened while this modal is already mounted (for
  // example after following an in-app account link). Keep the visible panels
  // aligned with that explicit destination.
  useEffect(() => {
    if (!initialAgent && !initialCategory) return;
    const destinationKey = `${initialAgent ?? ''}:${initialCategory ?? ''}`;
    if (appliedInitialDestinationRef.current === destinationKey) return;
    appliedInitialDestinationRef.current = destinationKey;
    const agent = initialAgent ?? selectedAgent;
    const categories = visibleCategoriesFor(agent);
    const requested = initialCategory ?? selectedCategory;
    const category = categories.includes(requested) ? requested : categories[0] ?? 'account';
    setSelectedAgent(agent);
    setSelectedCategory(category);
    if (requested !== category) onDestinationChange?.(agent, category, { replace: true });
  }, [initialAgent, initialCategory, onDestinationChange, selectedAgent, selectedCategory]);

  const selectAgent = (agent: AgentProvider) => {
    setSelectedAgent(agent);
    const category = visibleCategoriesFor(agent).includes(selectedCategory)
      ? selectedCategory
      : visibleCategoriesFor(agent)[0] ?? 'account';
    setSelectedCategory(category);
    onDestinationChange?.(agent, category);
  };

  const selectCategory = (category: AgentCategory) => {
    setSelectedCategory(category);
    onDestinationChange?.(selectedAgent, category);
  };

  // القائمة ومبرّرات ترتيبها انتقلت إلى `visibleAgents.ts` (T-1205): الحارس
  // الآلي الذي يمنع «شركة يتيمة» بعد حذف تبويب المورّدين يسأل نفس المصدر.
  const visibleAgents = useMemo<AgentProvider[]>(() => visibleSettingsAgents(), []);

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
    qwen: {
      authStatus: providerAuthStatus.qwen,
      onLogin: () => onProviderLogin('qwen'),
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
    providerAuthStatus.qwen,
    providerAuthStatus.kimi,
    providerAuthStatus.deepseek,
    providerAuthStatus.glm,
    providerAuthStatus.hermes,
    providerAuthStatus.sakana,
  ]);

  return (
    // T-1173 — one column again. The side-by-side layout put a second vertical
    // nav strip beside the settings sidebar and took 176 px out of the content,
    // which is what pushed the category tabs into a horizontal scroll.
    // ‏B-398/م4 — كان هذا التبويب وحده يهرب من قشرة الإعدادات بهوامش سالبة
    // (`-mx-4 -mb-4 -mt-2`) تُثبِّت قيم القشرة في ابنها، ثم يعيد الحشو، ويفتح
    // سكرولاً ثانياً داخل سكرول القشرة مع `min-h-[500px]` — فيبقى ~450px فراغاً
    // ميتاً أسفل اللوح حين يقصر المحتوى. الآن يعيش داخل حشو القشرة كبقيّته،
    // وسكرول واحد للصفحة كلها.
    <div className="flex min-w-0 flex-col">
      {/* عنوان الصفحة — التبويب الوحيد الذي كان بلا عنوانٍ أعلى إطلاقاً، فكان
          شريط الفئات (Account/Engines/…) يبدو أعلى ما في الشاشة بلا شيء يقول
          ما الذي يحتويه. `level="page"` يضعه فوق عناوين الأقسام داخل كل لوح. */}
      <div className="flex-shrink-0 pb-3">
        <SettingsSection
          level="page"
          // الأيقونة دلالية لا زخرفية: هذا التبويب عن **الوكلاء** — الأجساد
          // التي يُطلقها نسّاج — فالرمز جسمٌ لا ترسٌ ولا مفتاح.
          icon={Bot}
          title={t('mainTabs.agents')}
          description={t('agents.pageDescription')}
        >
          <AgentSelectorSection
            agents={visibleAgents}
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            agentContextById={agentContextById}
          />
        </SettingsSection>
      </div>

      <div className="flex min-w-0 flex-col">
        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedCategory={selectedCategory}
          onSelectCategory={selectCategory}
          selectedAgent={selectedAgent}
        />

        {/* T-1219 — لا `onOpenCredentials` بعد اليوم: لوحُ المحرّكات كان يقفز
            إلى حساب الوكيل المالك للمفتاح، ولم يعد للمفتاح حسابٌ يُقفز إليه —
            منزلُه تبويب «المورّدون والاعتمادات»، وتبديلُ تبويبٍ رئيسي ليس ملكَ
            هذه الشاشة. فاللوح يسمّي المكان نصّاً بلا زرٍّ لا يصل. */}
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
