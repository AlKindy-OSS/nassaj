// Single definition of where agy files its brain store for one user.
//
// For an authenticated user the spawn env sets HOME to that user's root (agy is
// always isolated, ADR-152 A1), so agy materializes its brain under that user's
// ~/.gemini/antigravity-cli/brain. Brain discovery, transcript paths and the
// session-handover evidence check must all read the SAME directory, so they all
// call this. A caller with no member is refused (ADR-152 A1 §3.4): there is
// no "operator brain" answer for anyone.

import path from 'path';

import { AGY_BRAIN_UNDER_HOME } from './agy-brain-layout.js';
import { requireMemberActor } from '../../../../services/isolation/credential-actor.js';
import { credentialPrincipalId } from '../../../../services/isolation/credential-principal.js';
import { userConfigDir } from '../../../../services/isolation/provision-user-dirs.js';

/**
 * Absolute brain directory agy uses for `userId`.
 * @param {string|number|null} [userId]
 * @returns {string}
 */
export function getAgyBrainDir(userId) {
    const member = requireMemberActor(userId);
    // T-1675: under a credential grant the brain lives in the OWNER's tree, the
    // same root resolveProviderEnv sets HOME to for this user.
    return path.join(userConfigDir(credentialPrincipalId(member, 'agy'), ''), AGY_BRAIN_UNDER_HOME);
}
