import { VendorSkillsProvider } from '@/modules/providers/shared/vendor/vendor-skills.provider.js';

/**
 * GLM skills facet: no local skill directory for a remote provider; returns no
 * skill sources via the shared vendor base.
 */
export class GlmSkillsProvider extends VendorSkillsProvider {
  constructor() {
    super('glm');
  }
}
