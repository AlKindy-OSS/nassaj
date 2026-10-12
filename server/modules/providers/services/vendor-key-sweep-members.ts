/**
 * vendor-key-sweep-members — ADR-200 (B-1575): who the background vendor-key
 * sweeps visit, and where a member's own harness files are, WITHOUT
 * provisioning. The boot and daily sweeps must not create trees or seed
 * operator policy for members: only active accounts whose own tree already
 * exists are visited, and paths are computed, never materialized.
 */

import fs from 'node:fs';
import path from 'node:path';

// Namespace import on purpose (same reason as harness-link-mode.runtime): many
// test files mock the database barrel with a partial export set.
import * as database from '@/modules/database/index.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';

import type { ProjectionHarness } from './vendor-key-migration.inventory.js';

/** The member's own credential file per harness, relative to their tree root (honorGrants: false). */
const OWN_HARNESS_FILES: Record<ProjectionHarness, string> = {
  claude: path.join('.claude', 'settings.json'),
  codex: path.join('.codex', 'auth.json'),
  opencode: path.join('.local', 'share', 'opencode', 'auth.json'),
};

/**
 * The path of a member's own credential file for `harness`, as the writers
 * resolve it with `honorGrants: false`; computed only, nothing is created.
 */
export function ownHarnessFilePath(userId: string | number, harness: ProjectionHarness): string {
  return path.join(userConfigDir(userId, ''), OWN_HARNESS_FILES[harness]);
}

/** Active members whose own tree already exists; a database error yields none. */
export function listSweepMemberIds(): number[] {
  try {
    const ids = database.userDb?.listActiveUserIds?.() ?? [];
    return ids.filter((id) => fs.existsSync(userConfigDir(id, '')));
  } catch {
    return [];
  }
}
