/**
 * accountTabLayout.test.tsx — تخطيط تبويب الحساب الموحَّد وتبويب التحديث.
 *
 * (2026-10-04) الترتيب: الاتصال ← حدود الاستخدام ← مشاركة الاعتماد، لكل وكيل؛
 * ولا رأسَ مكرَّر (شعار/اسم/وصف) تحت شريط الوكلاء؛ وتحديث الأداة تبويبٌ مستقل
 * في آخر الشريط لكل وكيل ظاهر.
 *
 * RUNNER: vitest (jsdom). `NODE_ENV=test`.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sections/content/AccountContent', () => ({ default: () => <div data-testid="s-connection" /> }));
vi.mock('./sections/content/ClaudeConnectionSection', () => ({ default: () => <div data-testid="s-connection" /> }));
vi.mock('./sections/content/AgyConnectionSection', () => ({ default: () => <div data-testid="s-connection" /> }));
vi.mock('./sections/content/AgentUsageSection', () => ({ default: () => <div data-testid="s-usage" /> }));
vi.mock('./sections/content/CredentialGrantsSection', () => ({ default: () => <div data-testid="s-grants" /> }));
vi.mock('./sections/HarnessVersionSection', () => ({ default: () => <div data-testid="s-update" /> }));
vi.mock('../../../../mcp', () => ({ McpServers: () => null }));
vi.mock('../../../../skills', () => ({ ProviderSkills: () => null }));

import type { AgentProvider } from '../../../types/types';

import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import { visibleCategoriesFor } from './agentCategories';
import type { AgentContext } from './types';
import { visibleSettingsAgents } from './visibleAgents';

afterEach(cleanup);

const ctx = {
  authStatus: { installed: true, authenticated: false, loading: false },
  onLogin: () => {},
} as unknown as AgentContext;
const agentContextById = new Proxy({}, { get: () => ctx }) as Record<AgentProvider, AgentContext>;

function mount(agent: AgentProvider, category: 'account' | 'update') {
  return render(
    <AgentCategoryContentSection
      selectedAgent={agent}
      selectedCategory={category}
      agentContextById={agentContextById}
      claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false, allowVendorDelegation: false }}
      onClaudePermissionsChange={() => {}}
      codexPermissionMode="default"
      onCodexPermissionModeChange={() => {}}
      projects={[]}
    />,
  );
}

describe('account tab section order', () => {
  it.each(visibleSettingsAgents())('%s: connection, then usage limits, then credential sharing', (agent) => {
    const { getAllByTestId, queryByTestId } = mount(agent, 'account');
    const order = ['s-connection', 's-usage', 's-grants']
      .map((id) => getAllByTestId(id)[0])
      .map((node) => Array.from(node.parentElement!.children).indexOf(node));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(3);
    expect(queryByTestId('s-update')).toBeNull();
  });
});

describe('update tab', () => {
  it.each(visibleSettingsAgents())('%s: the update category is the last tab', (agent) => {
    const categories = visibleCategoriesFor(agent);
    expect(categories[categories.length - 1]).toBe('update');
  });

  it('renders the harness version section and nothing else of the account tab', () => {
    const { getByTestId, queryByTestId } = mount('codex', 'update');
    expect(getByTestId('s-update')).toBeTruthy();
    expect(queryByTestId('s-usage')).toBeNull();
    expect(queryByTestId('s-grants')).toBeNull();
  });
});
