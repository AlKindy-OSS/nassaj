import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../llm-logo-provider/SessionProviderLogo', () => ({
  default: ({ provider }: { provider: string }) => <svg data-testid={`logo-${provider}`} />,
}));

import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';
import { visibleSettingsAgents } from './visibleAgents';
import type { AgentContextByProvider } from './types';

const agents = visibleSettingsAgents();
const agentContextById = Object.fromEntries(
  agents.map((agent) => [agent, { authStatus: { authenticated: true }, onLogin: () => {} }]),
) as AgentContextByProvider;

const renderSelector = (ids?: ReadonlySet<string>) => render(
  <AgentSelectorSection
    agents={agents}
    selectedAgent="claude"
    onSelectAgent={() => {}}
    agentContextById={agentContextById}
    updateAvailableIds={ids}
  />,
);

const renderTabs = (updateAvailable?: boolean) => render(
  <AgentCategoryTabsSection
    categories={['account', 'update']}
    selectedCategory="account"
    onSelectCategory={() => {}}
    selectedAgent="claude"
    updateAvailable={updateAvailable}
  />,
);

afterEach(cleanup);

describe('مؤشر التحديث في منتقي الوكلاء', () => {
  it('يرسم نقطة على بلاطة الوكيل الذي له تحديث فقط ويسمّيها لقارئ الشاشة', () => {
    renderSelector(new Set(['codex']));
    expect(screen.getAllByTestId('update-indicator')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Codex — Update available' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeTruthy();
  });

  it('لا نقطة حين لا تحديث أو لا معلومة', () => {
    renderSelector(new Set());
    expect(screen.queryByTestId('update-indicator')).toBeNull();
    cleanup();
    renderSelector(undefined);
    expect(screen.queryByTestId('update-indicator')).toBeNull();
  });
});

describe('مؤشر التحديث على تبويب «التحديث»', () => {
  it('يظهر على تبويب التحديث وحده مع نص لقارئ الشاشة', () => {
    renderTabs(true);
    expect(screen.getAllByTestId('tab-indicator')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Update available/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Update available/ }).querySelector('[data-testid="tab-indicator"]')).not.toBeNull();
  });

  it('يختفي حين لا تحديث', () => {
    renderTabs(false);
    expect(screen.queryByTestId('tab-indicator')).toBeNull();
    cleanup();
    renderTabs(undefined);
    expect(screen.queryByTestId('tab-indicator')).toBeNull();
  });
});
