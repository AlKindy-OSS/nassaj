import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveCodexHomeForUser } from '@/modules/providers/list/codex/codex-home.js';
import {
  SAFE_SEGMENT_RE,
  SKILLS_STATE_NAME,
} from '@/services/isolation/codex-shared-skills.js';
import { resolvePrivateSkillSource } from '@/modules/providers/shared/skills/private-skill-source.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

/** Upper bounds on the ownership state so a corrupt file cannot stall a listing. */
const MAX_STATE_BYTES = 256 * 1024;
const MAX_SHARED_SKILLS = 500;

const lstatOrNull = async (target: string) => lstat(target).catch(() => null);

/**
 * Reads the nassaj-owned skill names from `<skillsRoot>/.nassaj-sync-state.json`
 * (written by codex-shared-skills.js / sync-harness-homes, ADR-202). Never follows
 * a symlink: the root, the state file, each skill folder and its SKILL.md must all
 * be real entries; anything else (or an unsafe name) is silently skipped.
 */
export const listNassajSharedSkillFiles = async (skillsRoot: string): Promise<string[]> => {
  const rootStats = await lstatOrNull(skillsRoot);
  if (!rootStats?.isDirectory()) return [];
  const statePath = path.join(skillsRoot, SKILLS_STATE_NAME);
  const stateStats = await lstatOrNull(statePath);
  if (!stateStats?.isFile() || stateStats.size > MAX_STATE_BYTES) return [];

  let names: unknown[] = [];
  try {
    const doc: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    const list = (doc as { skills?: unknown } | null)?.skills;
    names = Array.isArray(list) ? list.slice(0, MAX_SHARED_SKILLS) : [];
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const name of new Set(names)) {
    if (typeof name !== 'string' || !SAFE_SEGMENT_RE.test(name)) continue;
    const skillDir = path.join(skillsRoot, name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    if ((await lstatOrNull(skillDir))?.isDirectory() && (await lstatOrNull(skillPath))?.isFile()) {
      files.push(skillPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

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

    this.addUserSources(sources, seenRootDirs, userId ?? null);
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

  /**
   * User-scope sources. Shared mode: `~/.agents/skills` (writable for owner/admin)
   * and nassaj's portable skills materialized into this user's Codex home
   * (read-only; only names the state file owns, T-2003). Private mode (ADR-203):
   * the user's store first (editable, wins name ties), the operator's
   * `~/.agents/skills` read-only (Codex still reads it; writes go to the store),
   * and the nassaj-shared copy hidden.
   */
  private addUserSources(
    sources: ProviderSkillSource[],
    seenRootDirs: Set<string>,
    userId: string | number | null,
  ): void {
    const privateSource = resolvePrivateSkillSource(userId, 'codex', '$');
    const agentsRoot = path.join(os.homedir(), '.agents', 'skills');
    if (privateSource) {
      addUniqueProviderSkillSource(sources, seenRootDirs, privateSource);
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user', rootDir: agentsRoot, commandPrefix: '$', readOnly: true,
      });
      return;
    }
    addUniqueProviderSkillSource(sources, seenRootDirs, { scope: 'user', rootDir: agentsRoot, commandPrefix: '$' });
    const sharedSkillsRoot = path.join(resolveCodexHomeForUser(userId), 'skills');
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: sharedSkillsRoot,
      commandPrefix: '$',
      readOnly: true,
      origin: 'nassaj-shared',
      listSkillFiles: () => listNassajSharedSkillFiles(sharedSkillsRoot),
    });
  }

  protected async getGlobalSkillSource(userId?: string | number | null): Promise<ProviderSkillSource> {
    return resolvePrivateSkillSource(userId, 'codex', '$') ?? {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '$',
    };
  }
}
