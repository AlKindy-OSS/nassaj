import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../llm-logo-provider/SessionProviderLogo', () => ({
  default: ({ provider, className }: { provider: string; className?: string }) => (
    <svg data-testid={`logo-${provider}`} className={className} />
  ),
}));

import AgentSelectorSection from './sections/AgentSelectorSection';
import { visibleSettingsAgents } from './visibleAgents';
import type { AgentContextByProvider } from './types';

const agents = visibleSettingsAgents();

const agentContextById = Object.fromEntries(
  agents.map((agent) => [agent, {
    authStatus: { authenticated: agent === 'codex' },
    onLogin: () => {},
  }]),
) as AgentContextByProvider;

describe('مُنتقي الوكلاء', () => {
  it('يحافظ على شعاراتٍ متوسطة وأسماءٍ ظاهرة ضمن شبكة الجوال', () => {
    const { container } = render(
      <AgentSelectorSection
        agents={agents}
        selectedAgent="codex"
        onSelectAgent={() => {}}
        agentContextById={agentContextById}
      />,
    );

    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('grid-cols-3');
    expect(grid?.className).toContain('sm:grid-cols-5');
    expect(grid?.className).toContain('xl:grid-cols-9');

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(agents.length);
    expect(buttons.every((button) => button.className.includes('min-h-16'))).toBe(true);

    expect(screen.getByTestId('logo-codex').getAttribute('class')).toContain('h-7');
    expect(screen.getByTestId('logo-claude').getAttribute('class')).toContain('h-6');
    expect(screen.getByText('Antigravity')).toBeTruthy();
  });
});
