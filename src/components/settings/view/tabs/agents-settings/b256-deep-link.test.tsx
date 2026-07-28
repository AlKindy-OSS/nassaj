/**
 * B-256: Settings deep link — SettingsDeepLink type carries tab+agent+category,
 * and AgentsSettingsTab accepts initialAgent/initialCategory to pre-select the
 * right agent when arriving via the "Add API key" CTA in the model picker.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { SettingsDeepLink } from '../../../types/types';

afterEach(cleanup);

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../../shared/disabledProviders', () => ({
  filterDisabledProviders: (list: string[]) => list,
}));

vi.mock('../../../../../shared/bodyEngineMatrix', () => ({
  bodyHasEngineAxis: () => false,
}));

vi.mock('./sections/AgentSelectorSection', () => ({
  default: ({ selectedAgent }: { selectedAgent: string }) => (
    <div data-testid="agent-selector" data-agent={selectedAgent} />
  ),
}));

vi.mock('./sections/AgentCategoryTabsSection', () => ({
  default: ({ selectedCategory }: { selectedCategory: string }) => (
    <div data-testid="category-tabs" data-category={selectedCategory} />
  ),
}));

vi.mock('./sections/AgentCategoryContentSection', () => ({
  default: () => <div data-testid="category-content" />,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

import AgentsSettingsTab from './AgentsSettingsTab';
import type { AgentsSettingsTabProps } from './types';

const baseProps: AgentsSettingsTabProps = {
  providerAuthStatus: {} as AgentsSettingsTabProps['providerAuthStatus'],
  onProviderLogin: vi.fn(),
  onRefreshAuthStatus: vi.fn(),
  claudePermissions: {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
    allowVendorDelegation: false,
  },
  onClaudePermissionsChange: vi.fn(),
  cursorPermissions: { allowedCommands: [], disallowedCommands: [], skipPermissions: false },
  onCursorPermissionsChange: vi.fn(),
  codexPermissionMode: 'default',
  onCodexPermissionModeChange: vi.fn(),
  geminiPermissionMode: 'default',
  onGeminiPermissionModeChange: vi.fn(),
  projects: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('B-256 SettingsDeepLink type shape', () => {
  it('carries tab, optional agent and optional category', () => {
    const full: SettingsDeepLink = { tab: 'agents', agent: 'glm', category: 'account' };
    expect(full.tab).toBe('agents');
    expect(full.agent).toBe('glm');
    expect(full.category).toBe('account');
  });

  it('tab is the only required field', () => {
    const minimal: SettingsDeepLink = { tab: 'agents' };
    expect(minimal.tab).toBe('agents');
    expect(minimal.agent).toBeUndefined();
    expect(minimal.category).toBeUndefined();
  });
});

describe('B-256 AgentsSettingsTab initialAgent/initialCategory', () => {
  it('defaults to claude and account when no initial props given', () => {
    render(<AgentsSettingsTab {...baseProps} />);
    expect(screen.getByTestId('agent-selector').dataset.agent).toBe('claude');
    expect(screen.getByTestId('category-tabs').dataset.category).toBe('account');
  });

  it('pre-selects the given initialAgent', () => {
    render(<AgentsSettingsTab {...baseProps} initialAgent="glm" />);
    expect(screen.getByTestId('agent-selector').dataset.agent).toBe('glm');
  });

  it('pre-selects the given initialCategory', () => {
    render(<AgentsSettingsTab {...baseProps} initialAgent="deepseek" initialCategory="account" />);
    expect(screen.getByTestId('category-tabs').dataset.category).toBe('account');
  });
});
