import * as databaseModule from '@/modules/database/index.js';

import { connectionRevocationRegistry } from './connection-revocation-registry.js';
import {
  revokeUserRealtimeAccess,
  type UserRealtimeRevocation,
  type UserRealtimeRevocationResult,
} from './user-realtime-revocation.js';

/**
 * B-1327: the single entry for an administrative identity change (owner
 * disable/delete/role change, or an SSO role downgrade). Stops live work per
 * `revocation` (typed terminal frames, provider aborts, shells/terminals),
 * then closes the user's realtime sockets and device transports so clients
 * reconnect under the new identity.
 *
 * `deviceSessionIds` must be captured BEFORE a deletion cascades the wallet
 * rows; when omitted they are read now.
 */
export function revokeUserIdentity(
  userId: number,
  revocation: UserRealtimeRevocation,
  deviceSessionIds?: readonly string[],
): UserRealtimeRevocationResult {
  const devices = deviceSessionIds
    ?? databaseModule.deviceAccountSessionsDb?.deviceSessionIdsForUser?.(userId)
    ?? [];
  const result = revokeUserRealtimeAccess(userId, revocation);
  for (const deviceSessionId of devices) {
    connectionRevocationRegistry.revokeDevice(deviceSessionId);
  }
  return result;
}
