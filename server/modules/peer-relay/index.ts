/**
 * Public barrel — the cross-session relay (ADR-219 S1, T-2072).
 *
 * claude-sdk.js arms the hook, stamps and escapes the prompt and reads the
 * delivery descriptor; server/index.js wires the runtime (dispatcher, turn
 * runner and the intake's external seams). The `peer-message` frame is the
 * contract of the UI bubble; P2a-min adds the `peer-hold` frame and the
 * /api/peer-relay hold routes (the hold card's contract).
 */
export {
  createPeerHookDependencies, listPeerMessageViews, observePeerRunMessage, readActiveMemberCount, recordPeerPromptDecision,
  recordSessionMode,
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
export { PEER_HOLD_FRAME, PEER_MESSAGE_FRAME, toPeerMessageView } from './peer-events.js';
export type { PeerHoldFrame, PeerHoldView, PeerMessageFrame, PeerMessageView } from './peer-events.js';
export { createPeerHoldsRouter } from './peer-holds.routes.js';
export { assertPeerRelayTestSeamsAllowed, createPeerRelayTestSeamsRouter } from './peer-relay.test-seams.js';
export { peerRelayTestSeamsEnabled } from './peer-relay.test-seams-guard.js';
