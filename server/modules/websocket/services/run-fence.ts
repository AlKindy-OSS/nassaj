/**
 * T-1854 / ADR-172 amendment: authority per RUN, not per connection.
 *
 * One chat socket carries many runs in many projects, so project-membership
 * revocation cannot be a property of the socket writer. Each admitted provider
 * run gets a fence: an outermost writer wrapper holding one entry of the
 * fenced-run registry (project-access.ts). A post-commit sweep that proves
 * `!canAccessProject` flips that entry to `revoked` synchronously; from then on
 * the fence:
 *   - drops every provider frame (no primary send, no mirror fan-out, no inner
 *     side effect — the fence wraps every other layer), except a sanitized
 *     `process_state` so mirrors and the busy badge settle (qa M2);
 *   - sends exactly ONE contentless terminal frame, only with an explicit
 *     sessionId (qa M3);
 *   - asks the provider to abort, and keeps asking on every later dropped frame
 *     until the abort bridge confirms it (qa H1a): a provider may register its
 *     process after the first frame that names the session.
 * The registry entry is released deterministically (qa M4/M5): after a
 * confirmed abort, or once the dispatch returned AND the provider process
 * reported idle, whichever is later.
 */

// Leaf import, same reason as chat-websocket.service: tests module-mock the
// database barrel with partial named exports, which a static import would break.
/* eslint-disable boundaries/dependencies -- dependency-light leaf seam. */
import {
  armFencedRun,
  canAccessProject,
  releaseFencedRun,
  type FencedRun,
  type FencedRunRevokeReason,
} from '@/modules/database/repositories/project-access.js';
/* eslint-enable boundaries/dependencies */
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import { toNumericUserId, transparentWriterWith } from '@/modules/websocket/services/writer-proxy.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * qa M5 / invariant I9: a `complete` frame whose value under this field is a
 * positive number does NOT end the run — Claude reports background workflows
 * still running after the turn. Such a run stays registered (and revocable)
 * until its provider process reports idle.
 */
export const CONTINUING_COMPLETE_FIELD = 'pendingWorkflows';

/**
 * qa M-B: `isRunOutputRevoked` is called per output line by several providers.
 * The sweep flips `revoked` immediately; the database re-check (R5, for a
 * mutation that skipped the sweep) is read at most once per this window.
 */
export const OUTPUT_ACCESS_RECHECK_MS = 1000;

/** A writer that may carry a run fence; providers read `runFenceRevoked` pre-spawn. */
export type FencedWriter = WebSocketWriter & { readonly runFenceRevoked?: boolean };

/**
 * Asks the provider to abort the run registered under `sessionId`, only if the
 * fenced writer owns that registration. true / `{ aborted: true }` (or a
 * promise of either) confirms the abort; anything else means "retry later".
 */
export type RunFenceAbort = (writer: FencedWriter, sessionId: string) => unknown;

export type RunFence = {
  /** The outermost writer: every provider frame for this run crosses it. */
  writer: FencedWriter;
  /** Admits the run into the registry; false = refused (no access now). */
  arm(projectId: string, userId: number): boolean;
  /** Dispatch returned (or threw). Called from a finally block. */
  finish(): void;
};

type RunFenceInput = {
  inner: WebSocketWriter;
  provider: LLMProvider;
  /** The resumed session id, when the turn continues a known session. */
  knownSessionId: string | null;
  /** clientMsgId echo for the terminal frame. */
  echo: Record<string, string>;
  abortRun: RunFenceAbort;
  /** qa #6: the session's process registration now belongs to another writer. */
  sessionOwnedElsewhere?: (writer: FencedWriter, sessionId: string) => boolean;
  /** Test seam for the recheck window. */
  now?: () => number;
};

type Frame = Record<string, unknown>;

const isFrame = (payload: unknown): payload is Frame => (
  payload !== null && typeof payload === 'object' && !Array.isArray(payload)
);

const nonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value !== '' ? value : null
);

const isProcessStateFrame = (frame: Frame): boolean => (
  frame.kind === 'status' && frame.text === 'process_state'
);

const isThenable = (value: unknown): value is PromiseLike<unknown> => (
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && typeof (value as { then?: unknown }).then === 'function'
);

const isAbortConfirmed = (value: unknown): boolean => (
  value === true || (isFrame(value) && value.aborted === true)
);

/** qa M2: the only fields a revoked run may still publish — its idle/busy state. */
function sanitizeProcessState(frame: Frame, provider: LLMProvider): Frame | null {
  const sessionId = nonEmptyString(frame.sessionId);
  if (!sessionId) return null;
  return createNormalizedMessage({
    kind: 'status',
    text: 'process_state',
    processState: frame.processState,
    sessionId,
    provider: (nonEmptyString(frame.provider) as LLMProvider | null) ?? provider,
  });
}

/** Per-run state machine behind the fenced writer proxy (one instance per dispatch). */
class RunFenceController {
  run: FencedRun | null = null;
  fenced: FencedWriter | null = null;
  private sessionId: string | null;
  private reason: FencedRunRevokeReason | null = null;
  private terminalSent = false;
  private abortPending = false;
  private abortInFlight = false;
  /** qa M-A: the exact socket that lost the project; muted only while current. */
  private suppressedSocket: RealtimeClientConnection | null = null;
  private outputCheckedAt = Number.NEGATIVE_INFINITY;
  private outputDenied = false;
  private dispatchFinished = false;
  private continuing = false;
  private readonly activeProcesses = new Set<string>();

  constructor(private readonly input: RunFenceInput) {
    this.sessionId = input.knownSessionId;
  }

  get revoked(): boolean {
    return this.run?.revoked === true;
  }

  arm(projectId: string, userId: number): boolean {
    if (this.run) return !this.revoked;
    this.run = armFencedRun({
      projectId,
      userId,
      onRevoke: (reason) => this.onRevoke(reason),
      primarySocketUserId: () => toNumericUserId((this.input.inner.ws as { userId?: unknown } | undefined)?.userId),
      onForeignSocketRevoked: () => { this.suppressedSocket = this.input.inner.ws; },
    });
    return this.run !== null;
  }

  finish(): void {
    this.dispatchFinished = true;
    if (this.revoked) this.flushTerminalFallback();
    this.maybeRelease();
  }

  send(payload: unknown): void {
    const frame = isFrame(payload) ? payload : null;
    if (frame) {
      this.captureSessionId(frame);
      this.trackRunLifetime(frame);
    }
    if (this.revoked) {
      this.flushTerminal();
      this.tryAbort();
      const state = frame && isProcessStateFrame(frame) ? sanitizeProcessState(frame, this.input.provider) : null;
      if (state) this.emit(state);
    } else {
      this.emit(payload);
    }
    this.maybeRelease();
  }

  setSessionId(sessionId: string): void {
    this.input.inner.setSessionId?.(sessionId);
    if (nonEmptyString(sessionId)) this.sessionId = sessionId;
    if (this.revoked) {
      this.flushTerminal();
      this.tryAbort();
    }
  }

  /**
   * Persistence boundary. The sweep answers immediately via `revoked`; the
   * database re-check (R5) runs at most once per OUTPUT_ACCESS_RECHECK_MS and a
   * denial is sticky (qa M-B).
   */
  isRunOutputRevoked(sessionId?: string | null): boolean {
    if (this.input.inner.isRunOutputRevoked?.(sessionId ?? null) === true || this.revoked) return true;
    if (!this.run) return false;
    if (this.outputDenied) return true;
    const now = (this.input.now ?? Date.now)();
    if (now - this.outputCheckedAt < OUTPUT_ACCESS_RECHECK_MS) return false;
    this.outputCheckedAt = now;
    try {
      this.outputDenied = !canAccessProject(this.run.projectId, this.run.userId);
    } catch {
      this.outputDenied = true;
    }
    return this.outputDenied;
  }

  private get primarySuppressed(): boolean {
    return this.suppressedSocket !== null && this.input.inner.ws === this.suppressedSocket;
  }

  private onRevoke(reason: FencedRunRevokeReason): void {
    if (this.reason) return;
    this.reason = reason;
    // Pending first: the terminal flush may find the session owned elsewhere and clear it.
    this.abortPending = true;
    if (this.dispatchFinished) this.flushTerminalFallback();
    else this.flushTerminal();
    this.tryAbort();
    this.maybeRelease();
  }

  private emit(payload: unknown): void {
    const { inner } = this.input;
    const mute = (inner as { sendWithPrimarySuppressed?: (fn: () => void) => void }).sendWithPrimarySuppressed;
    if (this.primarySuppressed && typeof mute === 'function') {
      mute.call(inner, () => inner.send(payload));
      return;
    }
    inner.send(payload);
  }

  private maybeRelease(): void {
    if (!this.run) return;
    const runEnded = this.dispatchFinished && this.activeProcesses.size === 0 && !this.continuing;
    if (runEnded || (this.revoked && this.reason !== null && !this.abortPending)) {
      releaseFencedRun(this.run);
    }
  }

  /**
   * qa M3: never through the writer without an explicit sessionId. qa #6: a
   * session whose registration another writer now holds is not ours to end —
   * no frame, no abort, and the entry is released.
   */
  private flushTerminal(): void {
    if (!this.reason || this.terminalSent || !this.sessionId) return;
    this.terminalSent = true;
    if (this.fenced && this.input.sessionOwnedElsewhere?.(this.fenced, this.sessionId) === true) {
      this.abortPending = false;
      if (this.run) releaseFencedRun(this.run);
      return;
    }
    this.emit(createNormalizedMessage({
      kind: 'complete', provider: this.input.provider, exitCode: 1, success: false,
      aborted: true, code: this.reason, sessionId: this.sessionId, ...this.input.echo,
    }));
  }

  /** Session never became known: tell the launching socket alone, raw. */
  private flushTerminalFallback(): void {
    if (!this.reason || this.terminalSent) return;
    if (this.sessionId) {
      this.flushTerminal();
      return;
    }
    this.terminalSent = true;
    const socket = this.input.inner.ws;
    if (this.primarySuppressed || socket?.readyState !== WS_OPEN_STATE) return;
    try {
      socket.send(JSON.stringify({
        kind: 'complete', provider: this.input.provider, exitCode: 1, success: false, aborted: true,
        notStarted: true, code: this.reason, ...this.input.echo,
      }));
    } catch {
      /* the socket's own close handler owns cleanup */
    }
  }

  /** qa H1a: abort-until-confirmed, re-invoked on every later dropped frame. */
  private tryAbort(): void {
    if (!this.abortPending || this.abortInFlight || !this.sessionId || !this.fenced) return;
    let result: unknown;
    try {
      result = this.input.abortRun(this.fenced, this.sessionId);
    } catch {
      result = false;
    }
    if (isThenable(result)) {
      this.abortInFlight = true;
      Promise.resolve(result).then((value) => this.settleAbort(value), () => this.settleAbort(false));
      return;
    }
    this.settleAbort(result);
  }

  private settleAbort(value: unknown): void {
    this.abortInFlight = false;
    if (!isAbortConfirmed(value)) return;
    this.abortPending = false;
    this.maybeRelease();
  }

  private captureSessionId(frame: Frame): void {
    const created = frame.kind === 'session_created' || nonEmptyString(frame.newSessionId) !== null;
    const next = nonEmptyString(frame.newSessionId) ?? nonEmptyString(frame.sessionId);
    if (next && (created || !this.sessionId)) this.sessionId = next;
  }

  private trackRunLifetime(frame: Frame): void {
    if (isProcessStateFrame(frame)) {
      const key = nonEmptyString(frame.sessionId);
      if (!key) return;
      if (frame.processState === 'idle') {
        this.activeProcesses.delete(key);
        this.continuing = false;
      } else {
        this.activeProcesses.add(key);
      }
      return;
    }
    if (frame.kind === 'complete' && Number(frame[CONTINUING_COMPLETE_FIELD]) > 0) {
      this.continuing = true;
    }
  }
}

/**
 * Wraps `inner` in a run fence. Pass-through until `arm` admits the run; the
 * caller only creates a fence while PROJECT_MEMBERSHIP_ENFORCE is on (I6).
 */
export function createRunFence(input: RunFenceInput): RunFence {
  const controller = new RunFenceController(input);
  const fenced: FencedWriter = transparentWriterWith(input.inner, {
    send: (payload: unknown) => controller.send(payload),
    setSessionId: (sessionId: string) => controller.setSessionId(sessionId),
    isRunOutputRevoked: (sessionId?: string | null) => controller.isRunOutputRevoked(sessionId),
    get runFenceRevoked(): boolean { return controller.revoked; },
  });
  controller.fenced = fenced;
  return {
    writer: fenced,
    arm: (projectId, userId) => controller.arm(projectId, userId),
    finish: () => controller.finish(),
  };
}
