import { describe, expect, it } from 'vitest';

import { DISABLED_PROVIDERS } from '../../../shared/disabledProviders';
import { RETIRED_PROVIDER_IDS } from '../../../shared/retiredProviders';
import { SESSION_BUCKET_PROVIDERS } from '../../../shared/sessionBuckets';
import { ALL_PROVIDER_META } from '../chat/view/subcomponents/ProviderSelectionEmptyState';
import { PROVIDER_UI_CAPABILITIES } from '../chat/constants/providerCapabilities';
import { providerCards } from '../onboarding/view/subcomponents/AgentConnectionsStep';
import { readSettingsDestination } from '../settings/settingsUrl';
import { SETTINGS_AGENT_ORDER, visibleSettingsAgents } from '../settings/view/tabs/agents-settings/visibleAgents';

import { CLI_PROVIDERS } from './types';

/**
 * T-1853: a provider whose runtime was deleted must not survive in any client
 * surface — not even as a disabled or history-only id.
 */
describe('retired providers are gone from every client surface', () => {
  for (const retired of RETIRED_PROVIDER_IDS) {
    it(`${retired} appears in no provider list, picker, settings, deep link or auth probe`, () => {
      expect(DISABLED_PROVIDERS as readonly string[]).not.toContain(retired);
      expect(SESSION_BUCKET_PROVIDERS as readonly string[]).not.toContain(retired);
      expect(Object.keys(PROVIDER_UI_CAPABILITIES)).not.toContain(retired);
      expect(ALL_PROVIDER_META.map(row => row.id) as string[]).not.toContain(retired);
      expect(providerCards.map(row => row.provider) as string[]).not.toContain(retired);
      expect(SETTINGS_AGENT_ORDER as readonly string[]).not.toContain(retired);
      expect(visibleSettingsAgents() as string[]).not.toContain(retired);
      expect(CLI_PROVIDERS as readonly string[]).not.toContain(retired);
      expect(readSettingsDestination(`?settings=agents&settingsAgent=${retired}`)).toEqual({ tab: 'agents' });
    });
  }
});
