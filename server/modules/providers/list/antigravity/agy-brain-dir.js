// Single definition of where agy files its brain store for one user.
//
// When agy is isolated for this user (admin policy) the spawn env sets HOME to
// the per-user root, so agy materializes its brain under that user's
// ~/.gemini/antigravity-cli/brain. Brain discovery, transcript paths and the
// session-handover evidence check must all read the SAME directory, so they all
// call this. When agy is shared (default / ADR-016) or there is no
// authenticated user, the operator home is used.

import os from 'os';
import path from 'path';

import { credentialPrincipalId } from '../../../../services/isolation/credential-principal.js';
import { userConfigDir } from '../../../../services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from '../../../../services/provider-sharing.js';

/**
 * Absolute brain directory agy uses for `userId`.
 * @param {string|number|null} [userId]
 * @returns {string}
 */
export function getAgyBrainDir(userId = null) {
    const shouldIsolate =
        userId !== null && userId !== undefined && userId !== '' && isProviderIsolated('agy');
    // T-1675: under a credential grant the brain lives in the OWNER's tree, the
    // same root resolveProviderEnv sets HOME to for this user.
    const homeRoot = shouldIsolate ? userConfigDir(credentialPrincipalId(userId, 'agy'), '') : os.homedir();
    return path.join(homeRoot, '.gemini', 'antigravity-cli', 'brain');
}
