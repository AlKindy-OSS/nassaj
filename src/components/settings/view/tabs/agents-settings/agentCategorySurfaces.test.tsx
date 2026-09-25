/**
 * agentCategorySurfaces.test.tsx — **كل فئةٍ معروضةٍ لكل وكيلٍ ظاهر تُصيّر شيئاً**
 * (‏B-414).
 *
 * ثلاثةٌ من سبعة وكلاء ظاهرين — `opencode` و`kimi` و`hermes` — كانوا يفتحون تبويب
 * «الأذونات» على لوحٍ **أبيض تماماً**: الفئة في قاعدة الفئات لكل وكيل بلا استثناء،
 * واللوح لا يُصيَّر إلا لخمسة معرّفات. وفئة «الإعداد» كانت أسوأ: لوحُها يُرجع
 * `null` لكل معرّفٍ يبلغه. ومع ذلك كان الملفّ يحمل الادّعاء المضاد بالحرف («‏so
 * the Permissions tab is never blank»).
 *
 * والقاعدة التي تمنع ذلك موجودةٌ في الريبو ومطبَّقةٌ في موضعٍ واحد فقط:
 * `bodyHasEngineAxis` تقرأ **نفس** المُرشِّح الذي تُرسم منه اللوحة، وتعلّل ذلك بأن
 * تبويباً يُفتح على فراغ هو نتيجة سؤالين لجوابٍ واحد. هذا الملف يُعمّمها حارساً:
 * السؤال «أيّ فئة تُعرض؟» يُجاب من `visibleCategoriesFor`، والسؤال «ما الذي
 * يُرسم؟» من `AgentCategoryContentSection` — وهنا يُواجَه الجوابان.
 *
 * الحارس **يُصيّر ولا يقرأ قوائم**: نسخةٌ ثانية من قائمة المعرّفات المدعومة كانت
 * ستنجرف مع الشرطيات هناك بلا أن يشعر أحد، وهو الانجراف نفسه الذي شحن العطل.
 *
 * RUNNER: vitest (jsdom). ‏`NODE_ENV=test` إلزامي في هذا الريبو.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      ((opts?.defaultValue as string) ?? key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name])),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

// AgentUsageSection imports directly from the context path (not the barrel).
vi.mock('../../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data: {} }),
  })),
}));

/**
 * ‏`mcp` و`skills` لوحان يملكهما مسارٌ آخر (وكيلٌ آخر يعمل عليهما الآن)، ولهما
 * جلبُ بياناتٍ ومزوّدو سياقٍ خاصّون بهما. فيُستبدلان بعلامةٍ صريحة: ما يفحصه هذا
 * الحارس هو **قرار العرض** — أن كل فئةٍ معروضة تصل إلى لوحٍ يُصيَّر — لا محتوى
 * لوحٍ خارج نطاقه. وحدُّ الحارس مُعلَنٌ هنا بدل أن يُخفى في نجاحٍ زائف.
 */
vi.mock('../../../../mcp', () => ({
  McpServers: () => <div>mcp-panel</div>,
}));
vi.mock('../../../../skills', () => ({
  ProviderSkills: () => <div>skills-panel</div>,
}));

import { ThemeProvider } from '../../../../../contexts/ThemeContext';
import type { AgentProvider } from '../../../types/types';

import type { AgentContext } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import { visibleCategoriesFor } from './agentCategories';
import { COMING_SOON_SETTINGS_PROVIDERS, visibleSettingsAgents } from './visibleAgents';

afterEach(cleanup);

const AUTH_STATUS = {
  installed: true,
  authenticated: false,
  loading: false,
} as unknown as AgentContext['authStatus'];

const agentContextById = Object.fromEntries(
  ([
    'claude', 'codex', 'cursor', 'antigravity', 'opencode',
    'qwen', 'kimi', 'deepseek', 'glm', 'hermes', 'sakana',
  ] as AgentProvider[]).map((agent) => [agent, { authStatus: AUTH_STATUS, onLogin: () => {} }]),
) as Record<AgentProvider, AgentContext>;

const cases = visibleSettingsAgents().flatMap((agent) =>
  visibleCategoriesFor(agent).map((category) => ({ agent, category })),
);

describe('مزوّدات «قريباً» تعرض لوح coming-soon لا فراغاً (T-1760)', () => {
  it.each([...COMING_SOON_SETTINGS_PROVIDERS])(
    '%s يُصيَّر محتوى لوح قريباً',
    async (agent) => {
      const { container } = render(
        <ThemeProvider>
          <AgentCategoryContentSection
            selectedAgent={agent}
            selectedCategory="account"
            agentContextById={agentContextById}
            claudePermissions={{
              allowedTools: [], disallowedTools: [], skipPermissions: false, allowVendorDelegation: false,
            }}
            onClaudePermissionsChange={() => {}}
            cursorPermissions={{ allowedCommands: [], disallowedCommands: [], skipPermissions: false }}
            onCursorPermissionsChange={() => {}}
            codexPermissionMode="default"
            onCodexPermissionModeChange={() => {}}
            projects={[]}
          />
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(
          (container.textContent ?? '').trim().length,
          `لوح «${agent}» قريباً أبيض`,
        ).toBeGreaterThan(0);
      });
    },
  );

  it('visibleCategoriesFor تُعيد [] لكل مزوّد قريباً', () => {
    for (const agent of COMING_SOON_SETTINGS_PROVIDERS) {
      expect(visibleCategoriesFor(agent)).toEqual([]);
    }
  });
});

describe('لا فئةَ تفتح على فراغ (B-414)', () => {
  it('المصفوفة المفحوصة ليست فارغة — اختبارٌ على الحارس نفسه', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)('$agent × $category تُصيّر محتوىً غير فارغ', async ({ agent, category }) => {
    // ‏`ThemeProvider` لأن شعارات المزوّدين داخل بطاقة الحساب تقرأ الوضع منه.
    const { container } = render(
      <ThemeProvider>
      <AgentCategoryContentSection
        selectedAgent={agent}
        selectedCategory={category}
        agentContextById={agentContextById}
        claudePermissions={{
          allowedTools: [], disallowedTools: [], skipPermissions: false, allowVendorDelegation: false,
        }}
        onClaudePermissionsChange={() => {}}
        cursorPermissions={{ allowedCommands: [], disallowedCommands: [], skipPermissions: false }}
        onCursorPermissionsChange={() => {}}
        codexPermissionMode="default"
        onCodexPermissionModeChange={() => {}}
        projects={[]}
      />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(
        (container.textContent ?? '').trim().length,
        `لوح «${agent} × ${category}» أبيض — الفئة معروضة ولا شيء يُرسم فيها`,
      ).toBeGreaterThan(0);
    });
  });
});
