/**
 * private-skill-source — the skill source a provider uses for a user in
 * effective private mode (ADR-203, T-2003 C3): the user's own store, listed as
 * scope `user` and editable, with the condition-4 write guard attached.
 */

import { resolveHarnessFilesMode, type PrivateSkillsHarness } from '@/services/isolation/harness-files-mode.js';
import {
  PrivateStoreError,
  listPrivateSkillFiles,
  privateSkillsStoreRoot,
  resolvePrivateSkillTarget,
} from '@/services/isolation/private-skills-store.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * The private source for `userId`, or null when the user's effective mode is
 * shared (or the id is not a user). The user id comes from the token only.
 */
export function resolvePrivateSkillSource(
  userId: string | number | null | undefined,
  harness: PrivateSkillsHarness,
  commandPrefix: '/' | '$',
): ProviderSkillSource | null {
  if (userId === null || userId === undefined || userId === '') return null;
  if (resolveHarnessFilesMode(userId) !== 'private') return null;
  let rootDir: string;
  try {
    rootDir = privateSkillsStoreRoot(userId, harness);
  } catch {
    return null;
  }
  return {
    scope: 'user',
    rootDir,
    commandPrefix,
    listSkillFiles: async () => listPrivateSkillFiles(userId, harness),
    assertWriteTarget: (directoryName: string) => {
      try {
        resolvePrivateSkillTarget(userId, harness, directoryName);
      } catch (err) {
        if (!(err instanceof PrivateStoreError)) throw err;
        throw new AppError('This skill name or path is not allowed in your private files.', {
          code: 'PROVIDER_SKILL_PRIVATE_PATH_REJECTED', statusCode: 400,
        });
      }
    },
  };
}
