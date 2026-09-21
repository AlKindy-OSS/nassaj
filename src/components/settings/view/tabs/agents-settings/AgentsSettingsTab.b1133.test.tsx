/**
 * AgentsSettingsTab.b1133.test.tsx
 *
 * Regression tests for B-1133: once the DeepSeek settings page was open,
 * the user could not switch back to any other harness.
 *
 * ROOT CAUSE. When `visibleCategories = []` (all coming-soon providers),
 * the category-sync useEffect always entered its `if` branch because
 * `!([].includes(selectedCategory))` is always true. It computed the fallback
 * `category = 'account'` — the same value as `selectedCategory` — but then
 * unconditionally called `onDestinationChange('deepseek', 'account', { replace: true })`.
 * Because `handleAgentDestinationChange` in Settings.tsx is not wrapped in
 * `useCallback`, every call produced a fresh function reference, which changed
 * the `onDestinationChange` prop, which re-triggered the effect, which called it
 * again — an infinite loop. Each iteration atomically wrote `agentDestination`
 * state in Settings.tsx, so any provider switch the user made was immediately
 * overwritten with `{ agent: 'deepseek', category: 'account' }`.
 *
 * FIX. Added `if (category !== selectedCategory)` guard before the call
 * (AgentsSettingsTab.tsx, category-sync useEffect). For deepseek the fallback
 * always equals the current category after the first render, so the guard
 * short-circuits and the loop never starts.
 *
 * TESTS.
 *   1. With deepseek as initial agent, `onDestinationChange` must NOT be called
 *      repeatedly — even when the prop reference changes between renders
 *      (simulates the unmemoised handler in Settings.tsx).
 *   2. After opening deepseek, clicking the Claude tile renders Claude content.
 *   3. Changing `initialAgent` from deepseek to claude via URL re-render
 *      (simulates `?agent=claude`) delivers Claude content.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentsSettingsTab from './AgentsSettingsTab';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('lucide-react', () => ({
  Bot: () => null,
  Check: () => null,
  ChevronRight: () => null,
}));

// Stub heavy child sections so the test focuses on the routing logic inside
// AgentsSettingsTab, not the content of each panel.
vi.mock('./sections/AgentCategoryContentSection', () => ({
  default: ({ selectedAgent }: { selectedAgent: string }) => (
    <div data-testid="content-section" data-agent={selectedAgent}>
      {selectedAgent}-content
    </div>
  ),
}));

vi.mock('./sections/AgentCategoryTabsSection', () => ({
  default: () => null,
}));

// Thin stub for the agent selector — renders a button per agent so tests can
// click tiles without pulling in the full icon tree.
vi.mock('./sections/AgentSelectorSection', () => ({
  default: ({
    agents,
    selectedAgent,
    onSelectAgent,
  }: {
    agents: string[];
    selectedAgent: string;
    onSelectAgent: (a: string) => void;
  }) => (
    <div data-testid="agent-selector">
      {agents.map((a) => (
        <button
          key={a}
          data-testid={`tile-${a}`}
          aria-pressed={a === selectedAgent}
          onClick={() => onSelectAgent(a)}
        >
          {a}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../SettingsSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
import type { AgentsSettingsTabProps } from './types';
import type { ProviderAuthStatus } from '../../../../provider-auth/types';

const NOT_AUTHED: ProviderAuthStatus = {
  authenticated: false,
  installed: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  checkFailed: false,
};

const PROVIDERS = [
  'claude', 'cursor', 'codex', 'gemini', 'antigravity',
  'opencode', 'qwen', 'kimi', 'deepseek', 'glm', 'hermes', 'sakana',
] as const;

function makeStatus() {
  return Object.fromEntries(PROVIDERS.map((p) => [p, NOT_AUTHED])) as AgentsSettingsTabProps['providerAuthStatus'];
}

function makeProps(overrides: Partial<AgentsSettingsTabProps> = {}): AgentsSettingsTabProps {
  return {
    providerAuthStatus: makeStatus(),
    onProviderLogin: vi.fn(),
    onRefreshAuthStatus: vi.fn(),
    claudePermissions: {} as unknown as AgentsSettingsTabProps['claudePermissions'],
    onClaudePermissionsChange: vi.fn(),
    cursorPermissions: {} as unknown as AgentsSettingsTabProps['cursorPermissions'],
    onCursorPermissionsChange: vi.fn(),
    codexPermissionMode: 'default',
    onCodexPermissionModeChange: vi.fn(),
    geminiPermissionMode: 'default',
    onGeminiPermissionModeChange: vi.fn(),
    projects: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B-1133 regression — DeepSeek settings locks out all other agents', () => {
  it('does not call onDestinationChange in a loop when deepseek is the initial agent', async () => {
    // Simulate Settings.tsx: every call to onDestinationChange triggers a
    // parent re-render that produces a NEW function reference, which changes
    // the prop, which risks re-firing the effect. The test counts total calls.
    let callCount = 0;

    function ParentShim() {
      // Deliberately NOT useCallback — mirrors the unmemoised handler in Settings.tsx.
      const handleDestination = (..._args: unknown[]) => {
        callCount += 1;
      };

      return (
        <AgentsSettingsTab
          {...makeProps({ initialAgent: 'deepseek', onDestinationChange: handleDestination as never })}
        />
      );
    }

    render(<ParentShim />);

    // Wait for any async effects that might flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    // With the bug: callCount grows unboundedly (hundreds of calls in 80ms).
    // With the fix: 0 calls — the guard short-circuits because the category
    // did not actually change.
    expect(callCount, 'onDestinationChange must not be called in a render loop').toBe(0);
  });

  it('renders Claude content after the user switches from deepseek to claude', async () => {
    const onDestinationChange = vi.fn();

    render(
      <AgentsSettingsTab
        {...makeProps({ initialAgent: 'deepseek', onDestinationChange })}
      />,
    );

    // Initial state: deepseek content visible.
    expect(screen.getByTestId('content-section').getAttribute('data-agent')).toBe('deepseek');

    // User clicks the Claude tile.
    fireEvent.click(screen.getByTestId('tile-claude'));

    // Claude content must now be rendered.
    await waitFor(() =>
      expect(screen.getByTestId('content-section').getAttribute('data-agent')).toBe('claude'),
    );

    // The destination callback must have been called with claude.
    expect(onDestinationChange).toHaveBeenCalledWith('claude', expect.any(String));
  });

  it('switches to the agent specified in the URL when initialAgent changes (deep-link)', async () => {
    const onDestinationChange = vi.fn();

    const { rerender } = render(
      <AgentsSettingsTab
        {...makeProps({ initialAgent: 'deepseek', onDestinationChange })}
      />,
    );

    expect(screen.getByTestId('content-section').getAttribute('data-agent')).toBe('deepseek');

    // Simulate the URL changing to ?agent=claude (Settings.tsx re-renders with
    // the new initialAgent prop derived from the URL hash/search).
    rerender(
      <AgentsSettingsTab
        {...makeProps({ initialAgent: 'claude', onDestinationChange })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('content-section').getAttribute('data-agent')).toBe('claude'),
    );
  });
});
