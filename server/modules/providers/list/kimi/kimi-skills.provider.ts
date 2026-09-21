import { VendorSkillsProvider } from '@/modules/providers/shared/vendor/vendor-skills.provider.js';

/**
 * Kimi skills facet: no local skill directory for a remote provider, so the
 * shared vendor base returns no skill sources.
 */
export class KimiSkillsProvider extends VendorSkillsProvider {
  constructor() {
    super('kimi');
  }
}
