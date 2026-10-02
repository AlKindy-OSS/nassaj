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
 * T-1853/T-1953: a retired provider must never surface as a pickable body —
 * no picker entry, capability row, settings card/order, CLI target or deep
 * link. Two different fates apply beyond that shared floor:
 *
 * `gemini` had its runtime AND its history reader deleted (T-1853): it is gone
 * from every list, including `DISABLED_PROVIDERS` and `SESSION_BUCKET_PROVIDERS`.
 *
 * `cursor`, `hermes`, `qwen` and `kimi` had only their body code retired
 * (T-1953, ADR-192); the deletion plan beyond that stopped by owner decision.
 * Their history stays reachable on purpose: they remain in
 * `SESSION_BUCKET_PROVIDERS` (a missing bucket makes old conversations
 * invisible) and in `DISABLED_PROVIDERS` (removing them there would re-expose
 * them through filters that lean on that list, e.g. `useCredentialGrants.ts`,
 * `settingsUrl.ts`, `providerModelFallbacks.ts`, `vendorProviders.ts`).
 */
describe('retired providers are gone from every client surface', () => {
  for (const retired of RETIRED_PROVIDER_IDS) {
    it(`${retired} appears in no picker, settings, deep link or auth probe`, () => {
      expect(Object.keys(PROVIDER_UI_CAPABILITIES)).not.toContain(retired);
      expect(ALL_PROVIDER_META.map(row => row.id) as string[]).not.toContain(retired);
      expect(providerCards.map(row => row.provider) as string[]).not.toContain(retired);
      expect(SETTINGS_AGENT_ORDER as readonly string[]).not.toContain(retired);
      expect(visibleSettingsAgents() as string[]).not.toContain(retired);
      expect(CLI_PROVIDERS as readonly string[]).not.toContain(retired);
      expect(readSettingsDestination(`?settings=agents&settingsAgent=${retired}`)).toEqual({ tab: 'agents' });
    });
  }

  it('gemini has no runtime left, not even as a disabled or history-only id', () => {
    expect(DISABLED_PROVIDERS as readonly string[]).not.toContain('gemini');
    expect(SESSION_BUCKET_PROVIDERS as readonly string[]).not.toContain('gemini');
  });

  for (const retiredBodyOnly of ['cursor', 'hermes', 'qwen', 'kimi'] as const) {
    it(`${retiredBodyOnly} keeps its session bucket and disabled-list entry so history stays reachable`, () => {
      expect(SESSION_BUCKET_PROVIDERS as readonly string[]).toContain(retiredBodyOnly);
      expect(DISABLED_PROVIDERS as readonly string[]).toContain(retiredBodyOnly);
    });
  }
});
