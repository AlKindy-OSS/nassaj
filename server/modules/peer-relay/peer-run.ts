/**
 * ADR-219 D1 + ح-2 — the relay's per-run state.
 *
 * `relayMode` is computed once per spawn (`native` with one member, `relay`
 * with more) and kept for the run's life, with the `crossSessionInbound` it was
 * launched with. `peerHop` is a run property: 0 for a human-started run, the
 * delivered row's hop for a peer-woken resume turn; it never decreases.
 *
 * Also the server-only marker a peer delivery turn carries through the normal
 * dispatch path: a Symbol key cannot arrive over JSON, so no client can set it.
 */

import { PEER_SCHEDULING_TOOLS, PEER_TURN_MAX_BUDGET_USD, modeCategory, type PeerModeCategory } from './peer-policy.js';
import { relayModeNow, type RelayMode } from './peer-spawn-policy.js';

export { computeRelayMode, relaySdkSettings, type RelayMode } from './peer-spawn-policy.js';

/** CLI versions re-run against ADR-219 tests 1–6. */
export const VERIFIED_RELAY_CLI_VERSIONS: ReadonlySet<string> = new Set(['2.1.306']);

export type PeerRunState = {
  readonly relayMode: RelayMode;
  readonly userId: number | null;
  /** Category of the FINAL mode the SDK gets (settled by settlePeerRunMode before query). */
  modeCategory: PeerModeCategory;
  permissionMode: string;
  /** Hop of the row that woke this run; 0 for a human run. */
  readonly peerHop: number;
  /** Chain of the row that woke this run; a send from it continues the chain. */
  readonly chainId: string | null;
  /** Row id that woke this run (parent of its sends). */
  readonly parentId: string | null;
  sessionId: string | null;
  cliVersion: string | null;
};

export type PeerRunInput = {
  activeMemberCount: number;
  userId: number | null;
  sessionId: string | null;
  permissionMode: string | null | undefined;
  delivery?: PeerDeliveryTurn | null;
};

/** Creates the run's relay state at spawn. */
export function createPeerRunState(input: PeerRunInput): PeerRunState {
  const permissionMode = input.permissionMode || 'default';
  return {
    relayMode: relayModeNow(input.activeMemberCount),
    userId: Number.isInteger(input.userId) && (input.userId as number) > 0 ? input.userId as number : null,
    modeCategory: modeCategory(permissionMode),
    permissionMode,
    peerHop: input.delivery ? Math.max(1, input.delivery.hop) : 0,
    chainId: input.delivery?.chainId ?? null,
    parentId: input.delivery?.peerMessageId ?? null,
    sessionId: input.sessionId,
    cliVersion: null,
  };
}

/**
 * qa م-A: re-settles the run's mode to the FINAL one handed to the SDK (after parity
 * and the settings defaultMode), so the sender category is what the CLI really runs.
 */
export function settlePeerRunMode(run: PeerRunState, finalMode: string | null | undefined): void {
  run.permissionMode = finalMode || 'default';
  run.modeCategory = modeCategory(run.permissionMode);
}

/** True when this run's CLI is known and outside the verified set. */
export function isUnverifiedCli(run: PeerRunState): boolean {
  return run.cliVersion !== null && !VERIFIED_RELAY_CLI_VERSIONS.has(run.cliVersion);
}

/** Server-only key of the delivery descriptor on dispatch options (never JSON-reachable). */
export const PEER_DELIVERY_TURN = Symbol.for('nassaj.peer-relay.delivery-turn');

export type PeerTurnResult = { subtype: string | null; totalCostUsd: number | null; isError: boolean };

/** What a peer delivery turn asks of the Claude runner. */
export type PeerDeliveryTurn = {
  peerMessageId: string;
  chainId: string;
  hop: number;
  ref: string;
  /** The row's `from_mode`: the final mode of the delivery turn must be in this category (qa ح-A). */
  fromMode: string;
  /** The exact wrapper text, sent as an `isSynthetic` SDK user message. */
  wrapped: string;
  maxBudgetUsd: number;
  disallowedTools: readonly string[];
  /** Set by the runner when it took this descriptor (an unsupported path never sets it). */
  consumed: boolean;
  /** Every top-level `result` of the turn (the last one carries the running total). */
  onResult: (result: PeerTurnResult) => void;
};

/** Builds a delivery descriptor with the S1 budget and scheduling ban. */
export function createPeerDeliveryTurn(input: {
  peerMessageId: string; chainId: string; hop: number; ref: string; fromMode: string; wrapped: string;
  onResult: (result: PeerTurnResult) => void;
}): PeerDeliveryTurn {
  return {
    ...input,
    maxBudgetUsd: PEER_TURN_MAX_BUDGET_USD,
    disallowedTools: [...PEER_SCHEDULING_TOOLS],
    consumed: false,
  };
}

/** Reads the delivery descriptor from dispatch options; null for every normal turn. */
export function readPeerDeliveryTurn(options: unknown): PeerDeliveryTurn | null {
  if (!options || typeof options !== 'object') return null;
  const value = (options as Record<symbol, unknown>)[PEER_DELIVERY_TURN];
  if (!value || typeof value !== 'object') return null;
  const turn = value as PeerDeliveryTurn;
  return typeof turn.wrapped === 'string' && typeof turn.onResult === 'function' ? turn : null;
}

/** Maps an SDK result message to the fields the charge needs. */
export function toPeerTurnResult(message: Record<string, unknown>): PeerTurnResult {
  const total = message.total_cost_usd;
  return {
    subtype: typeof message.subtype === 'string' ? message.subtype : null,
    totalCostUsd: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null,
    isError: message.is_error === true,
  };
}
