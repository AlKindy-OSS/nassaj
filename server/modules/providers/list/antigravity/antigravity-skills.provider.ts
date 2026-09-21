import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Skills source list for the Antigravity (agy) CLI.
 *
 * agy does not yet ship a skills/commands directory of its own. We return an empty
 * source list as a stub so the shared discovery loop yields zero skills without
 * scanning unrelated provider folders. When agy adds a real skills location, add
 * its scope/rootDir entry here.
 */
export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() {
    super('antigravity');
  }

  protected async getSkillSources(_workspacePath: string): Promise<ProviderSkillSource[]> {
    return [];
  }
}
