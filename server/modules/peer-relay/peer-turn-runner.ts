/**
 * ADR-219 S1 — runs one peer delivery as a resume turn through the NORMAL
 * provider dispatch (permission gateway, workspace binding, run fence), under
 * the sanctioned internal-service principal pattern of scheduled messages
 * (B-1390): the target owner's persisted principal with
 * `authenticationKind: 'internal_service'` and a purpose-bound credential id
 * `peer-message:<id>`. No permission layer is bypassed.
 *
 * The delivery descriptor rides under a Symbol key the Claude runner reads; a
 * path that does not consume it (a hosted supervision cell) is refused before
 * dispatch, because there the wrapper would arrive as ordinary text.
 */

import type { PeerMessageRow } from '@/modules/database/index.js';

import type { PeerTurnOutcome } from './peer-dispatcher.js';
import { PEER_DELIVERY_TURN, type PeerDeliveryTurn } from './peer-run.js';

type ActiveUser = { id: number; role: string; authorization_generation: number; status?: string; is_active?: unknown };
type TurnWriter = { send(payload: unknown): void };
type WriterLease = { release(): void };
type TerminalFrame = { kind?: unknown; code?: unknown; notStarted?: unknown };

export type PeerTurnRunnerDependencies<W extends TurnWriter> = {
  getUser: (userId: number) => ActiveUser | undefined;
  getSession: (sessionId: string) => { project_path?: string | null; provider?: string | null } | null | undefined;
  /** A real writer (mirror fan-out) with an inert primary sink. */
  createWriter: (userId: number, sessionId: string) => W;
  dispatchProviderCommand: (messageType: string, data: Record<string, unknown>, writer: W,
    userId: number, principal: unknown) => Promise<void>;
  acquireWriterLease: (kind: string) => Promise<WriterLease>;
  runOutsideWriterContext: <T>(fn: () => Promise<T>) => Promise<T>;
  /** True when a claude chat turn would take a path that ignores the descriptor. */
  isUnsupportedPath: () => boolean;
  /** Hard stop of the target's running turn (the wall-clock cap, qa م-6). */
  abortSession: (sessionId: string) => Promise<unknown> | unknown;
  /** Wall-clock cap of one delivery turn in ms (NASSAJ_PEER_RELAY_TURN_MAX_MS, default 15 min). */
  maxTurnMs?: number;
};

const DEFAULT_MAX_TURN_MS = 15 * 60 * 1000;

/** Not-started codes that retrying cannot fix. */
const PERMANENT_CODES = new Set(['peer_delivery_unavailable', 'mode_mismatch_at_delivery']);

/** The wall-clock cap from the environment (provisional default 15 min). */
export function peerTurnMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.NASSAJ_PEER_RELAY_TURN_MAX_MS ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TURN_MS;
}

const notStarted = (code: string, permanent = false): PeerTurnOutcome => ({ started: false, code, permanent });

function isTerminal(payload: unknown): payload is TerminalFrame {
  const kind = (payload as TerminalFrame | null)?.kind;
  return kind === 'complete' || kind === 'error';
}

/** The principal of the target owner for this delivery, or null when not active. */
function principalFor(user: ActiveUser | undefined, row: PeerMessageRow): Record<string, unknown> | null {
  if (!user || (user.status !== undefined && user.status !== 'active')) return null;
  return {
    ...user,
    authenticationKind: 'internal_service',
    authenticationCredentialId: `peer-message:${row.id}`,
    authorizationGeneration: user.authorization_generation,
  };
}

/** The dispatch payload of a delivery: a resume turn of the target, in the gate's mode. */
function deliveryData(row: PeerMessageRow, turn: PeerDeliveryTurn, projectPath: string, permissionMode: string) {
  return {
    command: turn.wrapped,
    sessionId: row.to_session_id,
    options: {
      sessionId: row.to_session_id,
      cwd: projectPath,
      projectPath,
      permissionMode,
      // Unique per claim (a refunded busy attempt must not replay the earlier verdict).
      clientMsgId: `peer:${row.id}:${row.updated_at}`,
      [PEER_DELIVERY_TURN]: turn,
    },
  };
}

/** Runs `work` under a `provider-turn` lease; true when the update gate refused the lease. */
async function underLease<W extends TurnWriter>(deps: PeerTurnRunnerDependencies<W>, work: () => Promise<void>): Promise<boolean> {
  return deps.runOutsideWriterContext(async () => {
    let lease: WriterLease;
    try {
      lease = await deps.acquireWriterLease('provider-turn');
    } catch {
      return true;
    }
    try {
      await work();
    } finally {
      lease.release();
    }
    return false;
  });
}

/** Creates the `runTurn` the dispatcher calls (`permissionMode` is the gate's single read, qa ح-2). */
export function createPeerTurnRunner<W extends TurnWriter>(deps: PeerTurnRunnerDependencies<W>) {
  const maxTurnMs = deps.maxTurnMs ?? peerTurnMaxMs();
  return async (row: PeerMessageRow, turn: PeerDeliveryTurn, permissionMode: string): Promise<PeerTurnOutcome> => {
    if (row.to_user_id === null) return notStarted('target_owner_unresolved', true);
    if (deps.isUnsupportedPath()) return notStarted('unsupported_dispatch_path', true);
    const session = deps.getSession(row.to_session_id);
    if (!session?.project_path || session.provider !== 'claude') return notStarted('session_unavailable', true);
    const principal = principalFor(deps.getUser(row.to_user_id), row);
    if (!principal) return notStarted('target_owner_inactive', true);
    const writer = deps.createWriter(row.to_user_id, row.to_session_id);
    let terminal: TerminalFrame | null = null;
    const forward = writer.send.bind(writer);
    writer.send = (payload: unknown) => {
      if (isTerminal(payload)) terminal = payload;
      stampDelivery(payload, row.id);
      forward(payload);
    };
    let capped = false;
    const cap = setTimeout(() => { capped = true; void deps.abortSession(row.to_session_id); }, maxTurnMs);
    cap.unref?.();
    const data = deliveryData(row, turn, session.project_path, permissionMode);
    const refused = await underLease(deps, () => deps.dispatchProviderCommand('claude-command', data, writer,
      row.to_user_id as number, principal)).finally(() => clearTimeout(cap));
    if (refused) return notStarted('update_maintenance_active');
    const code = capped ? 'wall_clock_cap' : readCode(terminal);
    if (!turn.consumed) return notStarted(code ?? 'not_started', code !== null && PERMANENT_CODES.has(code));
    return { started: true, code, permanent: false };
  };
}

/**
 * ADR-219 S1 (coordinator 3c): the server marker of a peer-woken turn. Set in
 * place (the replay ring holds the same object) on every normalized frame of
 * the delivery, from the delivery row — never from a client-craftable id.
 */
function stampDelivery(payload: unknown, peerMessageId: string): void {
  if (!payload || typeof payload !== 'object' || Object.isFrozen(payload)) return;
  const frame = payload as { kind?: unknown; peerDeliveryId?: unknown; peerProofRef?: unknown };
  delete frame.peerProofRef; // the proof anchor never leaves the server
  if (typeof frame.kind === 'string') frame.peerDeliveryId = peerMessageId;
}

function readCode(frame: TerminalFrame | null): string | null {
  return typeof frame?.code === 'string' ? frame.code : null;
}
