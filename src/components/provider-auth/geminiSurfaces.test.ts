import { describe, expect, it } from 'vitest';
import { DISABLED_PROVIDERS } from '../../../shared/disabledProviders';
import { ALL_PROVIDER_META } from '../chat/view/subcomponents/ProviderSelectionEmptyState';
import { providerCards } from '../onboarding/view/subcomponents/AgentConnectionsStep';
import { readSettingsDestination } from '../settings/settingsUrl';
import { SETTINGS_AGENT_ORDER, visibleSettingsAgents } from '../settings/view/tabs/agents-settings/visibleAgents';
import { CLI_PROVIDERS } from './types';

describe('Gemini history-only client fence', () => {
  it('cannot reappear in selectable, onboarding, settings, deep-link, or auth-probe surfaces', () => {
    expect(DISABLED_PROVIDERS).toContain('gemini');
    expect(ALL_PROVIDER_META.map(row => row.id)).not.toContain('gemini');
    expect(providerCards.map(row => row.provider)).not.toContain('gemini');
    expect(SETTINGS_AGENT_ORDER).not.toContain('gemini');
    expect(visibleSettingsAgents()).not.toContain('gemini');
    expect(CLI_PROVIDERS).not.toContain('gemini');
    expect(readSettingsDestination('?settings=agents&settingsAgent=gemini')).toEqual({ tab: 'agents' });
  });
});
