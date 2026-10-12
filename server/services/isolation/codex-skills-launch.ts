/**
 * codex-skills-launch — picks the skill source for one Codex launch (ADR-203
 * "Switching flow", Codex): the owner of the CODEX_HOME being launched gets
 * their private store in effective private mode, otherwise nassaj's shared
 * portable skills. Derived on every launch; nothing pending is stored.
 *
 * The owner is read from the CODEX_HOME path (`~/.nassaj-users/<id>/.codex`), not
 * from the requester: under a credential grant the launch runs in the grantor's
 * home, and that home must keep the grantor's own skill set.
 */

import { materializeSharedSkills } from './codex-shared-skills.js';
import { userIdFromUserHome } from './claude-skills-link.js';
import { tryWithHarnessFilesLockSync } from './harness-files-lock.js';
import { resolveHarnessFilesMode } from './harness-files-mode.js';
import {
  readPrivateSkillSources,
  seedPrivateSkillsStore,
} from './private-skills-store.js';

type MaterializeResult = ReturnType<typeof materializeSharedSkills>;

function materializeForOwner(codexHome: string, owner: number): MaterializeResult {
  if (resolveHarnessFilesMode(owner) !== 'private') return materializeSharedSkills(codexHome);
  try {
    seedPrivateSkillsStore(owner, 'codex');
    const { files, skipped } = readPrivateSkillSources(owner, 'codex');
    if (skipped.length > 0) {
      console.warn('[Codex] private skills: entries skipped (symlink or unsafe name)', {
        userId: owner,
        skipped: skipped.slice(0, 20),
      });
    }
    return materializeSharedSkills(codexHome, { privateFiles: files });
  } catch (err) {
    console.warn('[Codex] private skills unavailable — keeping the current copy', {
      userId: owner,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'private_source_unavailable', written: 0, removed: 0, skipped: false };
  }
}

/**
 * Materializes the effective skill set into `codexHome` for a launch. Never
 * throws; under a busy per-user lock the current copy is kept (`deferred_locked`).
 *
 * @param codexHome the launch's effective CODEX_HOME
 */
export function materializeCodexSkillsForLaunch(codexHome: string): MaterializeResult {
  const owner = userIdFromUserHome(codexHome, '.codex');
  if (owner === null) return materializeSharedSkills(codexHome);
  const result = tryWithHarnessFilesLockSync(owner, () => materializeForOwner(codexHome, owner));
  if (result.ran) return result.value;
  return { ok: true, reason: 'deferred_locked', written: 0, removed: 0, skipped: true };
}
