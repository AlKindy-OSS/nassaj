/**
 * الوكيل الافتراضي في تبويب «الوكلاء»: يُفتح عليه التبويب، والرابط العميق
 * يغلبه، والمعطَّل أو المجهول يُتجاهَل فيعود السلوك السابق (`claude`).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const disabled = new Set<string>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../../shared/disabledProviders', () => ({
  filterDisabledProviders: (list: string[]) => list,
  isProviderGloballyDisabled: (provider: string) => disabled.has(provider),
}));

vi.mock('../../../../../shared/bodyEngineMatrix', () => ({
  bodyHasEngineAxis: () => false,
}));

vi.mock('./sections/AgentSelectorSection', () => ({
  default: ({ selectedAgent, defaultAgent }: { selectedAgent: string; defaultAgent?: string | null }) => (
    <div data-testid="agent-selector" data-agent={selectedAgent} data-default={defaultAgent ?? ''} />
  ),
}));

vi.mock('./sections/AgentCategoryTabsSection', () => ({
  default: () => <div data-testid="category-tabs" />,
}));

vi.mock('./sections/AgentCategoryContentSection', () => ({
  default: () => <div data-testid="category-content" />,
}));

import { __resetUiPreferencesStoreForTests } from '../../../../../hooks/useUiPreferences';

import AgentsSettingsTab from './AgentsSettingsTab';
import DelegationModeSection from './sections/content/DelegationModeSection';
import type { AgentsSettingsTabProps } from './types';
import { resolveInitialSettingsAgent } from './visibleAgents';

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
  codexPermissionMode: 'default',
  onCodexPermissionModeChange: vi.fn(),
  projects: [],
};

const storeDefaultAgent = (agent: string) => {
  localStorage.setItem('uiPreferences', JSON.stringify({ defaultSettingsAgent: agent }));
};

const selectedAgent = () => screen.getByTestId('agent-selector').dataset.agent;

beforeEach(() => {
  localStorage.clear();
  disabled.clear();
  __resetUiPreferencesStoreForTests();
});

afterEach(cleanup);

describe('resolveInitialSettingsAgent', () => {
  it('الرابط العميق يغلب الافتراضي المخزَّن', () => {
    expect(resolveInitialSettingsAgent('codex', 'opencode')).toBe('codex');
  });

  it('الافتراضي الصالح يُختار، والفارغ أو المجهول يعود إلى claude', () => {
    expect(resolveInitialSettingsAgent(undefined, 'opencode')).toBe('opencode');
    expect(resolveInitialSettingsAgent(undefined, '')).toBe('claude');
    expect(resolveInitialSettingsAgent(undefined, 'cursor')).toBe('claude');
  });

  it('الافتراضي المعطَّل عالمياً يُتجاهَل', () => {
    disabled.add('glm');
    expect(resolveInitialSettingsAgent(undefined, 'glm')).toBe('claude');
  });
});

describe('AgentsSettingsTab — الوكيل الافتراضي', () => {
  it('يُفتح التبويب على الوكيل الافتراضي المخزَّن ويُعلَّم في الشريط', () => {
    storeDefaultAgent('codex');
    render(<AgentsSettingsTab {...baseProps} />);
    expect(selectedAgent()).toBe('codex');
    expect(screen.getByTestId('agent-selector').dataset.default).toBe('codex');
  });

  it('الرابط العميق ?settingsAgent يغلب الافتراضي المخزَّن', () => {
    storeDefaultAgent('codex');
    render(<AgentsSettingsTab {...baseProps} initialAgent="opencode" />);
    expect(selectedAgent()).toBe('opencode');
  });

  it('افتراضي معطَّل عالمياً يعود إلى السلوك السابق ولا يُعلَّم', () => {
    disabled.add('glm');
    storeDefaultAgent('glm');
    render(<AgentsSettingsTab {...baseProps} />);
    expect(selectedAgent()).toBe('claude');
    expect(screen.getByTestId('agent-selector').dataset.default).toBe('');
  });

  it('زرّ «جعله الافتراضي» يحفظ الوكيل المفتوح ثم يظهر حالياً معطَّلاً', () => {
    render(<AgentsSettingsTab {...baseProps} initialAgent="codex" />);
    const button = screen.getByRole('button', { name: 'agents.defaults.agent.makeDefault' });
    act(() => { fireEvent.click(button); });

    const stored = JSON.parse(localStorage.getItem('uiPreferences') ?? '{}');
    expect(stored.defaultSettingsAgent).toBe('codex');
    const current = screen.getByRole('button', { name: 'agents.defaults.agent.current' });
    expect((current as HTMLButtonElement).disabled).toBe(true);
  });

  it('وضع التفويض لم يعد أعلى الصفحة', () => {
    render(<AgentsSettingsTab {...baseProps} />);
    expect(screen.queryByRole('radio', { name: 'chat:coordinationLevel.levels.direct.full' })).toBeNull();
  });
});

describe('DelegationModeSection — وضع التفويض داخل «التعليمات»', () => {
  it('منتقي وضع التفويض يحفظ الافتراضي الجديد عامّاً', () => {
    render(<DelegationModeSection />);
    const direct = screen.getByRole('radio', { name: 'chat:coordinationLevel.levels.direct.full' });
    act(() => { fireEvent.click(direct); });
    const stored = JSON.parse(localStorage.getItem('uiPreferences') ?? '{}');
    expect(stored.defaultCoordinationLevel).toBe('direct');
  });
});
