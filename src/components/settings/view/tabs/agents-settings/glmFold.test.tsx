/**
 * glmFold.test.tsx — GLM is a MODEL inside OpenCode, not an agent system
 * (owner decision 2026-07-26).
 *
 * The Agents settings screen lists agent SYSTEMS: bodies with a CLI, tools and
 * sessions. GLM has no body — its governed home is the OpenCode carrier
 * (ADR-062). Its standalone card drove `spawnGlm` (a tool-less raw HTTP client)
 * off a SECOND key store, and showed a "Connected" badge for neither.
 *
 * These tests render the real tab and assert the surface a user actually sees:
 * no GLM pill, while its carrier (OpenCode) and the other systems stay.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// The category CONTENT panes fetch live provider state on mount; this suite is
// about the agent bar, so stub the pane out and keep the test hermetic.
vi.mock('./sections/AgentCategoryContentSection', () => ({
  default: () => null,
}));

import { ThemeProvider } from '../../../../../contexts/ThemeContext';
import { createInitialProviderAuthStatusMap } from '../../../../provider-auth/types';

import AgentsSettingsTab from './AgentsSettingsTab';

afterEach(cleanup);

function renderTab() {
  return render(
    <ThemeProvider>
      <AgentsSettingsTab
        providerAuthStatus={createInitialProviderAuthStatusMap(false)}
        onProviderLogin={() => {}}
        onRefreshAuthStatus={() => {}}
        claudePermissions={{
          allowedTools: [],
          disallowedTools: [],
          skipPermissions: false,
          allowVendorDelegation: false,
        }}
        onClaudePermissionsChange={() => {}}
        cursorPermissions={{
          allowedCommands: [],
          disallowedCommands: [],
          skipPermissions: false,
        }}
        onCursorPermissionsChange={() => {}}
        codexPermissionMode="default"
        onCodexPermissionModeChange={() => {}}
        geminiPermissionMode="default"
        onGeminiPermissionModeChange={() => {}}
        projects={[]}
      />
    </ThemeProvider>,
  );
}

/** The agent bar renders one pill (a button) per selectable agent system. */
const agentPills = (name: string) => screen.queryAllByRole('button', { name });

describe('Agents settings — the GLM fold', () => {
  it('offers no GLM agent card', () => {
    renderTab();
    expect(agentPills('GLM')).toHaveLength(0);
  });

  it('still offers OpenCode — the body that actually carries GLM', () => {
    renderTab();
    expect(agentPills('OpenCode').length).toBeGreaterThan(0);
  });

  it('leaves the other agent systems untouched', () => {
    renderTab();
    for (const agent of ['Claude', 'Cursor', 'Codex', 'Antigravity', 'Kimi', 'Hermes']) {
      expect(agentPills(agent).length, `${agent} pill is still offered`).toBeGreaterThan(0);
    }
  });
});
