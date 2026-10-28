/**
 * Public barrel — the cross-session relay (ADR-219 S1, T-2072).
 *
 * claude-sdk.js arms the hook, stamps and escapes the prompt and reads the
 * delivery descriptor; server/index.js wires the runtime (dispatcher, turn
 * runner and the intake's external seams). The `peer-message` frame is the
 * contract of the UI bubble.
 */
export {
  createPeerHookDependencies, listPeerMessageViews, observePeerRunMessage, readActiveMemberCount, recordSessionMode,
  resetPeerRelayForTests, senderName,
} from './peer-relay.service.js';
export { buildPeerRelayHookMatcher, PEER_HOOK_MATCHER } from './peer-hook.js';
export { createPeerRunState, PEER_DELIVERY_TURN, readPeerDeliveryTurn, settlePeerRunMode } from './peer-run.js';
export {
  computeRelayMode, relayCliPolicy, relayModeNow, relaySdkSettings, relaySdkSpawnOptions,
} from './peer-spawn-policy.js';
export type { PeerDeliveryTurn, PeerRunState, RelayMode } from './peer-run.js';
export { escapePeerWrapperTags, readPeerProofRef } from './peer-wire.js';
export { projectPeerDeliveryMarkers } from './peer-history.js';
export { createPeerRelayRuntime } from './peer-relay.runtime.js';
export type { PeerRelayRuntimeInput } from './peer-relay.runtime.js';
export { PEER_MESSAGE_FRAME, toPeerMessageView } from './peer-events.js';
export type { PeerMessageFrame, PeerMessageView } from './peer-events.js';
