import { VendorSkillsProvider } from '@/modules/providers/shared/vendor/vendor-skills.provider.js';

/**
 * DeepSeek skills facet: no local skill directory for a remote provider; returns
 * no skill sources via the shared vendor base.
 */
export class DeepSeekSkillsProvider extends VendorSkillsProvider {
  constructor() {
    super('deepseek');
  }
}
