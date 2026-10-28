/**
 * ADR-219 S1 — composition of the relay runtime: the dispatcher over the
 * `peer_messages` repository, the shared delivery ledger, the pinned transcript
 * proof scan and the sanctioned turn runner. server/index.js supplies only the
 * seams that live in other modules (run liveness, usage, cost, dispatch).
 */

import { sessionsDb, type PeerMessageRow } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- ADR-219: the relay's own tables as a leaf (see peer-relay.service.ts).
import { peerMessagesDb } from '@/modules/database/repositories/peer-messages.db.js';
import {
  ledgerHasDelivery, readLedger, scanJsonlForProofFrom, transcriptByteSize, writeDeliveryLedgerEntries,
} from '@/modules/workflow-supervisor/index.js';

import { createCliVersionReader } from './peer-cli-version.js';
import {
  createPeerDispatcher, isPeerDeliveryEnabled, type PeerDispatcher, type PeerDispatcherDependencies,
} from './peer-dispatcher.js';
import { quotaPercent } from './peer-policy.js';
import { configurePeerRelay, publishPeerMessage, readSessionMode, senderName } from './peer-relay.service.js';
import { createPeerTurnRunner, type PeerTurnRunnerDependencies } from './peer-turn-runner.js';

type UsageWindow = { utilization: number } | null | undefined;
type TurnWriter = { send(payload: unknown): void };

export type PeerRelayRuntimeInput<W extends TurnWriter> = Omit<PeerTurnRunnerDependencies<W>, 'getSession'> & {
  isSessionRunLive: (sessionId: string) => boolean;
  resolveClaudeBinary: () => string;
  /** Usage windows of the user's own credentials (CLAUDE_CONFIG_DIR). */
  readUsage: (userId: number) => Promise<{ session: UsageWindow; weeklyAllModels: UsageWindow }>;
  /** Measured session total from the cost ledger, null when unavailable. */
  ledgerCostUsd: (sessionId: string, userId: number) => Promise<number | null>;
  canWriteSession: (sessionId: string, userId: number) => boolean;
  notifySession: (sessionId: string, serialized: string) => void;
  activeMemberCount: () => number;
  env?: NodeJS.ProcessEnv;
};

/** Why delivery cannot run on this node now (kill switch or an ignoring dispatch path), or null. */
function deliveryUnavailableReason(env: NodeJS.ProcessEnv, isUnsupportedPath: () => boolean): string | null {
  if (!isPeerDeliveryEnabled(env)) return 'relay delivery is disabled on this node';
  if (isUnsupportedPath()) return 'relay delivery is unavailable while hosted supervision is on for Claude';
  return null;
}

function log(level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, component: 'peer-relay', ...meta });
  if (level === 'error') console.error(line);
  else console.info(line);
}

export type PeerDispatcherSeams = {
  env: NodeJS.ProcessEnv;
  isSessionRunLive: (sessionId: string) => boolean;
  cliVersion: () => Promise<string | null>;
  readUsage: PeerRelayRuntimeInput<TurnWriter>['readUsage'];
  ledgerCostUsd: PeerRelayRuntimeInput<TurnWriter>['ledgerCostUsd'];
  runTurn: PeerDispatcherDependencies['runTurn'];
};

/** The dispatcher over the real repository, ledger and proof scan; external seams injected. */
export function buildPeerDispatcherDependencies(seams: PeerDispatcherSeams): PeerDispatcherDependencies {
  return {
    now: Date.now,
    enabled: () => isPeerDeliveryEnabled(seams.env),
    listDeliverable: (nowMs, limit) => peerMessagesDb.listDeliverable(nowMs, limit),
    listDelivering: () => peerMessagesDb.listDelivering(),
    claim: (id, nowMs, offset) => peerMessagesDb.claim(id, nowMs, offset),
    transition: (id, from, to, change) => peerMessagesDb.transition(id, from, to, change),
    getRow: (id) => peerMessagesDb.get(id),
    isSessionRunLive: seams.isSessionRunLive,
    cliVersion: seams.cliVersion,
    quotaPercent: async (userId) => {
      const usage = await seams.readUsage(userId);
      return quotaPercent([usage.session, usage.weeklyAllModels]);
    },
    sessionMode: readSessionMode,
    senderName,
    transcriptPath: (sessionId) => sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null,
    transcriptSize: transcriptByteSize,
    hasProof: scanJsonlForProofFrom,
    ledgerHas: (sessionId, id) => ledgerHasDelivery(readLedger(seams.env, sessionId), 'peer', id),
    ledgerCommit: (sessionId, row: PeerMessageRow) => writeDeliveryLedgerEntries(seams.env, sessionId,
      [{ kind: 'peer', deliveryId: row.id, ref: row.ref_token, outcome: 'DELIVERED' }]),
    costBaseline: (sessionId) => peerMessagesDb.getCostTotal(sessionId),
    ledgerCostUsd: seams.ledgerCostUsd,
    runTurn: seams.runTurn,
    publish: publishPeerMessage,
    log,
  };
}

/** Builds the dispatcher and configures the intake; nothing runs until `start()`. */
export function createPeerRelayRuntime<W extends TurnWriter>(input: PeerRelayRuntimeInput<W>): PeerDispatcher {
  const runTurn = createPeerTurnRunner<W>({ ...input, getSession: (id) => sessionsDb.getSessionById(id) });
  const env = input.env ?? process.env;
  const dispatcher = createPeerDispatcher(buildPeerDispatcherDependencies({
    env,
    isSessionRunLive: input.isSessionRunLive,
    cliVersion: createCliVersionReader(input.resolveClaudeBinary),
    readUsage: input.readUsage,
    ledgerCostUsd: input.ledgerCostUsd,
    runTurn,
  }));
  configurePeerRelay({
    canWriteSession: input.canWriteSession,
    notifySession: input.notifySession,
    activeMemberCount: input.activeMemberCount,
    deliveryUnavailable: () => deliveryUnavailableReason(env, input.isUnsupportedPath),
    kickDispatcher: () => dispatcher.kick(),
  });
  return dispatcher;
}
