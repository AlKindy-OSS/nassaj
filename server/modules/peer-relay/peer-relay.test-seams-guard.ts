/**
 * ADR-219 P2 §8 (ش-4): imported by server/index.js as a SIDE-EFFECT import right
 * after load-env (`import './modules/peer-relay/peer-relay.test-seams-guard.js'`),
 * so import ordering tools cannot move it below a database-opening import. With
 * NASSAJ_PEER_RELAY_TEST_SEAMS=1 and an unfenced DATABASE_PATH it throws at
 * import: the server never starts and never opens that database. Imports nothing
 * that touches the database.
 */

import { assertPeerRelayTestSeamsAllowed } from './peer-relay.test-seams.js';

const enabled: boolean = assertPeerRelayTestSeamsAllowed();

/** Whether the fenced dispatcher test seam may be mounted (decided at import). */
export function peerRelayTestSeamsEnabled(): boolean {
  return enabled;
}
