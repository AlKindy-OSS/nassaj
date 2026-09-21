import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cleanupEphemeralRoleHome, createEphemeralRoleHome, isolatedCliCageInternals,
  sweepOrphanedRoleHomes,
} from './isolated-cli-cage.js';

describe('isolated CLI role home crash contract', () => {
  it('writes a durable manifest under /var/tmp and cleans only its bound role', async () => {
    const role = await createEphemeralRoleHome();
    assert.ok(role.directory.startsWith(`${isolatedCliCageInternals.ROOT}/role-`));
    assert.ok(role.manifestPath.startsWith(`${isolatedCliCageInternals.MANIFESTS}/`));
    await cleanupEphemeralRoleHome(role);
    await assert.rejects(cleanupEphemeralRoleHome(role));
  });

  it('sweeps a crash orphan only after its recorded owner is confirmed dead', async () => {
    const role = await createEphemeralRoleHome(2_147_483_647);
    const removed = await sweepOrphanedRoleHomes();
    assert.ok(removed.includes(role.id));
    await assert.rejects(cleanupEphemeralRoleHome(role));
  });
});
