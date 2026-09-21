import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Skills facet for hosted vendor providers (kimi/deepseek/glm).
 *
 * These remote providers have no local skill directory of their own, so the
 * shared skill discovery returns no sources. Extending the shared `SkillsProvider`
 * (rather than implementing the interface from scratch) keeps the new providers
 * aligned with the Cursor inheritance pattern while honestly reporting an empty
 * skill set.
 */
export class VendorSkillsProvider extends SkillsProvider {
  protected async getSkillSources(): Promise<ProviderSkillSource[]> {
    return [];
  }
}
