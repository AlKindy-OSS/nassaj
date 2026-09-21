import os from 'node:os';
import path from 'node:path';

import { resolveCodexHomeForUser } from '@/modules/providers/list/codex/codex-home.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

/**
 * Codex skill discovery (B-153 — the read side of the B-136/B-152 isolation).
 *
 * Codex resolves its skill roots from TWO different bases and only one of them
 * moves per user:
 *   - `~/.agents/skills` is keyed off HOME, and the codex isolation knob sets
 *     CODEX_HOME only (never HOME — see resolve-provider-env.js), so this root
 *     stays the operator's for every user. Shared by construction; not per-user.
 *   - `<CODEX_HOME>/skills/.system` is keyed off CODEX_HOME, so for an isolated
 *     user it lives at ~/.nassaj-users/<userId>/.codex/skills/.system. Reading it
 *     from the hard-coded operator `~/.codex` (the pre-B-153 behavior) showed the
 *     operator's system skills to every isolated user and hid their own.
 * `resolveCodexHomeForUser` is the same central resolver the synchronizer, the
 * watcher and the auth/models providers use, so the sharing policy and the
 * anonymous fallback stay in exactly one place.
 */
export class CodexSkillsProvider extends SkillsProvider {
  constructor() {
    super('codex');
  }

  protected async getSkillSources(
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '$',
    });

    if (repoRoot) {
      // Codex checks repository skills at the launch folder, one folder above it,
      // and the topmost git root; these can collapse to the same directory.
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(path.dirname(workspacePath), '.agents', 'skills'),
        commandPrefix: '$',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '$',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'admin',
      rootDir: path.join('/etc', 'codex', 'skills'),
      commandPrefix: '$',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'system',
      rootDir: path.join(resolveCodexHomeForUser(userId ?? null), 'skills', '.system'),
      commandPrefix: '$',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    };
  }
}
