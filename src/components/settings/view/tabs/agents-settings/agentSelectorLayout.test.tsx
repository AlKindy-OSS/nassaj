import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const LOCAL_MODELS_LABEL = 'النماذج المحلية';

afterEach(cleanup);

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

    // بلا localModelsLabel/onSelectLocalModels لا تظهر البطاقة الإضافية.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(agents.length);
    expect(buttons.every((button) => button.className.includes('min-h-16'))).toBe(true);

    expect(screen.getByTestId('logo-codex').getAttribute('class')).toContain('h-7');
    expect(screen.getByTestId('logo-claude').getAttribute('class')).toContain('h-6');
    expect(screen.getByText('Antigravity')).toBeTruthy();
  });

  it('يضيف بطاقة النماذج المحلية في نهاية الشبكة عند تمرير localModelsLabel', () => {
    render(
      <AgentSelectorSection
        agents={agents}
        selectedAgent="codex"
        onSelectAgent={() => {}}
        agentContextById={agentContextById}
        localModelsLabel={LOCAL_MODELS_LABEL}
        localModelsSelected={false}
        onSelectLocalModels={() => {}}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(agents.length + 1);
    expect(screen.getByText(LOCAL_MODELS_LABEL)).toBeTruthy();
    // البطاقة الأخيرة هي النماذج المحلية وتحمل aria-pressed=false.
    const lastButton = buttons[buttons.length - 1];
    expect(lastButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('يضع aria-pressed=true على بطاقة النماذج المحلية عند تفعيلها', () => {
    render(
      <AgentSelectorSection
        agents={agents}
        selectedAgent="codex"
        onSelectAgent={() => {}}
        agentContextById={agentContextById}
        localModelsLabel={LOCAL_MODELS_LABEL}
        localModelsSelected={true}
        onSelectLocalModels={() => {}}
      />,
    );

    const buttons = screen.getAllByRole('button');
    const lastButton = buttons[buttons.length - 1];
    expect(lastButton.getAttribute('aria-pressed')).toBe('true');
    // وكيل codex لا يحمل aria-pressed=true لأن البطاقة المحلية هي المحدَّدة.
    const codexButton = screen.getByRole('button', { name: 'Codex' });
    expect(codexButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('selected tile carries the same highlight classes for every agent and the local-models card', () => {
    const selectedClasses = (selected: (typeof agents)[number] | null) => {
      cleanup();
      render(
        <AgentSelectorSection
          agents={agents}
          selectedAgent={selected ?? agents[0]}
          onSelectAgent={() => {}}
          agentContextById={agentContextById}
          localModelsLabel={LOCAL_MODELS_LABEL}
          localModelsSelected={selected === null}
          onSelectLocalModels={() => {}}
        />,
      );
      const pressed = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(pressed).toHaveLength(1);
      return pressed[0].className.split(/\s+/).filter((c) => c.startsWith('bg-') || c.startsWith('ring-'));
    };
    const reference = selectedClasses(null);
    expect(reference).toContain('bg-muted');
    for (const agent of agents) expect(selectedClasses(agent)).toEqual(reference);
  });
});
