import type {
  ScheduledMessage,
  ScheduledMessageOptions,
  ScheduledMessageStatus,
} from '@/modules/database/index.js';

import { runLocalUpdateBackground, withLocalUpdateWriterLease } from '../../services/update-writer-lease.js';

export const MAX_SCHEDULED_CONTENT_BYTES = 32 * 1024;
export const MAX_OPEN_SCHEDULED_PER_USER = 50;
export const MIN_SCHEDULE_DELAY_MS = 60_000;
export const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const MAX_CLAIMS_PER_TICK = 10;
/** Scheduled deliveries/turns this process runs at once, across all users. */
export const MAX_CONCURRENT_SCHEDULED = 4;
/** Scheduled deliveries/turns one user may have running at once. */
export const MAX_CONCURRENT_SCHEDULED_PER_USER = 2;
/** How long a delivery may wait for the provider to show it accepted the turn. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 5 * 60_000;
const SETTLE_RETRY_DELAY_MS = 250;
/** Retry delay for a delivery refused by a transient update-maintenance window. */
export const MAINTENANCE_RETRY_DELAY_MS = 60_000;
/**
 * How long after `scheduled_for` a maintenance refusal still gives its attempt
 * back. The gate also refuses in long states (e.g. MANUAL, possibly days), so
 * past this window a refusal counts as a normal attempt and `max_attempts`
 * eventually ends the retries.
 */
export const MAINTENANCE_REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The code a scheduled turn refused by update maintenance reports (parity with interactive turns). */
export const UPDATE_MAINTENANCE_ACTIVE = 'update_maintenance_active';

type SettleOutcome = {
  success: boolean; retryable: boolean; errorCode?: string; retryAt?: string; refundAttempt?: boolean;
};

type Repository = {
  create(input: { userId: number; sessionId: string; content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage;
  getOwned(id: string, userId: number): ScheduledMessage | null;
  listOwned(userId: number, filters?: { sessionId?: string; status?: ScheduledMessageStatus }): ScheduledMessage[];
  listAccessibleOwned(userId: number, filters: {
    sessionId?: string; status?: ScheduledMessageStatus; limit: number; offset: number;
  }): { messages: ScheduledMessage[]; total: number };
  countAccessibleActionable(userId: number): { pending: number; running: number; failed: number };
  countOpenForUser(userId: number): number;
  nextDueWithin(nowIso: string, untilIso: string): { count: number; earliestAt: string | null };
  failExpiredExhausted(nowIso: string): ScheduledMessage[];
  updateOwned(id: string, userId: number, input: { content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage | null;
  cancelOwned(id: string, userId: number): 'cancelled' | 'not_found' | 'conflict';
  claimDue(
    nowIso: string, leaseMs: number, excludeSessionIds?: readonly string[], excludeUserIds?: readonly number[],
  ): ScheduledMessage | null;
  renewLease(id: string, leaseToken: string, leaseExpiresAt: string): boolean;
  settle(id: string, leaseToken: string, outcome: SettleOutcome): boolean;
};

type ActiveUser = { id: number; role: string; authorization_generation: number };
/**
 * `refundAttempt`: the refusal happened before any provider effect and is
 * transient (update maintenance), so the claim's attempt is given back.
 */
export type ScheduledDispatchResult = {
  success: boolean; retryable: boolean; errorCode?: string; refundAttempt?: boolean;
};
/** How an accepted turn ended. Carries a bounded error code only, never content. */
export type ScheduledTurnOutcome = { success: boolean; errorCode?: string };
/**
 * Delivery verdict returned once the provider ACCEPTED the turn (or refused it
 * before acceptance). `completion` settles when the accepted turn ends; the
 * queue keeps that session busy until then so same-session order is preserved.
 */
export type ScheduledDispatchAcceptance = ScheduledDispatchResult & {
  completion?: Promise<ScheduledTurnOutcome | void>;
};
type AuditAction = 'scheduled_message_created' | 'scheduled_message_updated' | 'scheduled_message_cancelled'
  | 'scheduled_message_dispatched' | 'scheduled_message_failed' | 'scheduled_message_turn_failed';

/**
 * Audit/`last_error_code` marker for a delivery whose acceptance was never
 * observed. See `awaitAcceptance` for why such a row is settled `sent`, not retried.
 */
export const ACCEPTANCE_UNOBSERVED = 'acceptance_unobserved';

export class ScheduledMessageError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'ScheduledMessageError';
  }
}

export type ScheduledMessagesService = ReturnType<typeof createScheduledMessagesService>;

export function normalizeScheduledOptions(value: unknown): ScheduledMessageOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledMessageError('invalid_options', 400);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['model', 'effort', 'permissionMode', 'mode', 'coordinationLevel']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ScheduledMessageError('unsupported_option', 400);
  }
  const output: Record<string, string> = {};
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 128) {
      throw new ScheduledMessageError('invalid_model', 400);
    }
    output.model = input.model.trim();
  }
  const enums: Record<string, readonly string[]> = {
    effort: ['low', 'medium', 'high', 'max'],
    permissionMode: ['default', 'acceptEdits', 'plan'],
    mode: ['chat', 'agent'],
    coordinationLevel: ['direct', 'delegate', 'delegate_review'],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !values.includes(input[key])) {
        throw new ScheduledMessageError(`invalid_${key}`, 400);
      }
      output[key] = input[key];
    }
  }
  return Object.freeze(output) as ScheduledMessageOptions;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScheduledMessageError('content_required', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SCHEDULED_CONTENT_BYTES) {
    throw new ScheduledMessageError('content_too_large', 413);
  }
  return value;
}

function normalizeScheduledFor(value: unknown, nowMs: number): string {
  if (typeof value !== 'string') throw new ScheduledMessageError('scheduled_for_required', 400);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new ScheduledMessageError('invalid_scheduled_for', 400);
  if (timestamp < nowMs + MIN_SCHEDULE_DELAY_MS) throw new ScheduledMessageError('scheduled_for_too_soon', 400);
  if (timestamp > nowMs + MAX_SCHEDULE_DELAY_MS) throw new ScheduledMessageError('scheduled_for_too_far', 400);
  return new Date(timestamp).toISOString();
}

export function toPublicScheduledMessage(row: ScheduledMessage) {
  return {
    id: row.id, sessionId: row.sessionId, content: row.content, options: row.options,
    scheduledFor: row.scheduledFor, status: row.status, attempts: row.attempts,
    maxAttempts: row.maxAttempts, lastErrorCode: row.lastErrorCode, sentAt: row.sentAt,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function createScheduledMessagesService(deps: {
  repository: Repository;
  getActiveUser(userId: number): ActiveUser | undefined;
  sessionExists(sessionId: string): boolean;
  canWriteSession(sessionId: string, userId: number): boolean;
  dispatch(message: ScheduledMessage, user: ActiveUser): Promise<ScheduledDispatchAcceptance>;
  audit(action: AuditAction, metadata: Record<string, unknown>, userId: number): void;
  now?: () => number;
  leaseMs?: number;
  pollMs?: number;
  acceptanceTimeoutMs?: number;
  logger?: Pick<Console, 'error'>;
}) {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const acceptanceTimeoutMs = deps.acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  const logger = deps.logger ?? console;
  let timer: NodeJS.Timeout | null = null;
  let paused = false;
  // B-1390: the claim phase is serialized; deliveries are not. A session stays
  // in `busySessions` (session -> owning user) from claim until its accepted
  // turn completes, and every pre-acceptance delivery is tracked in `inflight`
  // so stop() can drain it. Both are in-process state only.
  let claiming: Promise<Array<Promise<void>> | null> | null = null;
  const busySessions = new Map<string, number>();
  const inflight = new Set<Promise<void>>();

  /** Users already running their per-user share of scheduled turns. */
  const saturatedUsers = (): number[] => {
    const load = new Map<number, number>();
    for (const userId of busySessions.values()) load.set(userId, (load.get(userId) ?? 0) + 1);
    return [...load].filter(([, count]) => count >= MAX_CONCURRENT_SCHEDULED_PER_USER).map(([userId]) => userId);
  };

  const isWritableSession = (sessionId: unknown, userId: number): boolean => {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return false;
    const normalized = sessionId.trim();
    return deps.sessionExists(normalized) && deps.canWriteSession(normalized, userId);
  };

  const assertWritable = (sessionId: unknown, userId: number): string => {
    if (!isWritableSession(sessionId, userId)) {
      throw new ScheduledMessageError('session_not_found', 404);
    }
    return (sessionId as string).trim();
  };

  const startLeaseHeartbeat = (message: ScheduledMessage): (() => void) => {
    const heartbeat = setInterval(() => {
      try {
        deps.repository.renewLease(message.id, message.leaseToken!, new Date(now() + leaseMs).toISOString());
      } catch (error) {
        logger.error('[scheduled-messages] lease renewal failed', {
          scheduledMessageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    return () => clearInterval(heartbeat);
  };

  /**
   * Waits for the provider's acceptance verdict, but never beyond
   * `acceptanceTimeoutMs`. Supervised hosted/CLI paths may emit their text and
   * `complete` only when the turn ends, and a turn can hang before any frame;
   * without a bound, such a delivery would renew its claim and hold the shared
   * update lease indefinitely.
   *
   * On expiry the row is settled `sent` with the ACCEPTANCE_UNOBSERVED marker
   * and is NOT retried: the turn may already be running, and a second attempt
   * could duplicate a provider effect. This deliberately differs from the
   * interactive Claude path (chat-websocket.service.ts, ingress markStarted),
   * which treats only raw trusted model frames as acceptance and keeps the
   * browser attached for the whole turn; a scheduled turn has no one attached,
   * so "not proven started" must end in a bounded, non-duplicating verdict.
   *
   * Decision (B-1390 review): the session's concurrency slot stays held until
   * the late turn actually ends. A turn hung before any frame therefore keeps
   * its slot until restart, and MAX_CONCURRENT_SCHEDULED such turns stop all
   * scheduled delivery. We do NOT auto-abort (aborting a turn that may be
   * running risks a half-applied provider effect); instead the expiry logs one
   * error naming the ids so the stall is visible to operators.
   */
  const awaitAcceptance = async (
    message: ScheduledMessage,
    dispatched: Promise<ScheduledDispatchAcceptance>,
  ): Promise<ScheduledDispatchAcceptance> => {
    let expiry: NodeJS.Timeout | undefined;
    const timedOut = new Promise<ScheduledDispatchAcceptance>((resolve) => {
      expiry = setTimeout(() => {
        logger.error('[scheduled-messages] acceptance not observed; concurrency slot stays held until the turn ends', {
          scheduledMessageId: message.id,
          sessionId: message.sessionId,
        });
        resolve({
          success: true,
          retryable: false,
          errorCode: ACCEPTANCE_UNOBSERVED,
          completion: dispatched.then((late) => late.completion, () => undefined),
        });
      }, acceptanceTimeoutMs);
    });
    try {
      return await Promise.race([
        dispatched.catch((): ScheduledDispatchAcceptance => (
          { success: false, retryable: true, errorCode: 'dispatch_unavailable' }
        )),
        timedOut,
      ]);
    } finally {
      clearTimeout(expiry);
    }
  };

  /** Re-authorizes at due time, then waits only until the provider accepts the turn. */
  const acceptOne = async (message: ScheduledMessage): Promise<ScheduledDispatchAcceptance> => {
    const user = deps.getActiveUser(message.userId);
    if (!user) return { success: false, retryable: false, errorCode: 'actor_revoked' };
    if (!deps.canWriteSession(message.sessionId, message.userId)) {
      return { success: false, retryable: false, errorCode: 'session_write_revoked' };
    }
    const stopHeartbeat = startLeaseHeartbeat(message);
    try {
      let dispatched: Promise<ScheduledDispatchAcceptance>;
      try {
        dispatched = Promise.resolve(deps.dispatch(message, user));
      } catch {
        return { success: false, retryable: true, errorCode: 'dispatch_unavailable' };
      }
      return await awaitAcceptance(message, dispatched);
    } finally {
      stopHeartbeat();
    }
  };

  /** Persists the verdict, retrying once so a transient DB error does not strand the row. */
  const persistSettle = async (message: ScheduledMessage, outcome: SettleOutcome) => {
    try {
      return deps.repository.settle(message.id, message.leaseToken!, outcome);
    } catch (error) {
      logger.error('[scheduled-messages] settle failed; retrying once', {
        scheduledMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => { setTimeout(resolve, SETTLE_RETRY_DELAY_MS); });
      return deps.repository.settle(message.id, message.leaseToken!, outcome);
    }
  };

  /** A refund is honoured only within MAINTENANCE_REFUND_WINDOW_MS of the due time. */
  const boundRefund = (message: ScheduledMessage, outcome: ScheduledDispatchResult): ScheduledDispatchResult => {
    if (!outcome.refundAttempt) return outcome;
    const overdueMs = now() - Date.parse(message.scheduledFor);
    if (!(overdueMs > MAINTENANCE_REFUND_WINDOW_MS)) return outcome;
    const { refundAttempt: _expired, ...counted } = outcome;
    return counted;
  };

  /**
   * A refunded maintenance refusal repeating an already-recorded one is not
   * audited again: the gate may refuse every poll for hours, and one audit row
   * per poll would be a storm. Only the transition into the refusal is audited;
   * a counted attempt is always audited (bounded by `max_attempts`).
   */
  const isRepeatedRefusal = (message: ScheduledMessage, outcome: ScheduledDispatchResult): boolean => (
    outcome.refundAttempt === true
    && outcome.errorCode === UPDATE_MAINTENANCE_ACTIVE
    && message.lastErrorCode === UPDATE_MAINTENANCE_ACTIVE
  );

  const settleOutcome = async (message: ScheduledMessage, verdict: ScheduledDispatchResult): Promise<boolean> => {
    const outcome = boundRefund(message, verdict);
    const retryDelayMs = verdict.refundAttempt
      ? MAINTENANCE_RETRY_DELAY_MS
      : Math.min(30_000 * (2 ** Math.max(0, message.attempts - 1)), 15 * 60_000);
    const settledOutcome = !outcome.success && outcome.retryable
      ? { ...outcome, retryAt: new Date(now() + retryDelayMs).toISOString() }
      : outcome;
    const repeated = isRepeatedRefusal(message, outcome);
    if (!await persistSettle(message, settledOutcome)) return false;
    if (repeated) return true;
    deps.audit(outcome.success ? 'scheduled_message_dispatched' : 'scheduled_message_failed', {
      scheduledMessageId: message.id,
      sessionId: message.sessionId,
      attempt: message.attempts,
      ...(outcome.success
        ? (outcome.errorCode ? { marker: outcome.errorCode } : {})
        : { errorCode: outcome.errorCode ?? 'unknown', retryable: outcome.retryable }),
    }, message.userId);
    return true;
  };

  /** Records a failure of an already-accepted turn: bounded code only, no content. */
  const auditTurnEnd = (message: ScheduledMessage, result: ScheduledTurnOutcome | void): void => {
    if (!result || result.success) return;
    try {
      deps.audit('scheduled_message_turn_failed', {
        scheduledMessageId: message.id,
        sessionId: message.sessionId,
        attempt: message.attempts,
        errorCode: (result.errorCode ?? 'unknown').slice(0, 128),
      }, message.userId);
    } catch (error) {
      logger.error('[scheduled-messages] turn failure audit failed', {
        scheduledMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Delivers one claimed row. The writer lease is retained only up to settle
   * (acceptance or its timeout), never for the accepted turn; the session is
   * released when the turn itself completes.
   */
  const deliver = async (message: ScheduledMessage): Promise<void> => {
    let completion: Promise<ScheduledTurnOutcome | void> | undefined;
    let accepted = false;
    try {
      await withLocalUpdateWriterLease('scheduled-message-delivery', async () => {
        const { completion: turn, ...outcome } = await acceptOne(message);
        completion = turn;
        accepted = await settleOutcome(message, outcome) && outcome.success;
      });
    } catch (error) {
      // An unsettled row keeps its lease until expiry and is then recovered by
      // claimDue; the ingress clientMsgId prevents a second provider effect.
      logger.error('[scheduled-messages] delivery settle failed', {
        scheduledMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const release = () => { busySessions.delete(message.sessionId); };
    if (!completion) { release(); return; }
    void completion
      .then((result) => { if (accepted) auditTurnEnd(message, result); }, () => undefined)
      .finally(release);
  };

  const claimAndLaunch = async (): Promise<Array<Promise<void>>> => {
    const tickNow = new Date(now()).toISOString();
    for (const message of deps.repository.failExpiredExhausted(tickNow)) {
      deps.audit('scheduled_message_failed', {
        scheduledMessageId: message.id,
        sessionId: message.sessionId,
        attempt: message.attempts,
        errorCode: 'lease_expired',
        retryable: false,
      }, message.userId);
    }
    const launched: Array<Promise<void>> = [];
    for (let processed = 0; processed < MAX_CLAIMS_PER_TICK; processed += 1) {
      // Global cap first: each launched delivery may spawn a CLI agent.
      if (paused || busySessions.size >= MAX_CONCURRENT_SCHEDULED) break;
      const message = deps.repository.claimDue(
        new Date(now()).toISOString(), leaseMs, [...busySessions.keys()], saturatedUsers(),
      );
      if (!message?.leaseToken) break;
      busySessions.set(message.sessionId, message.userId);
      const task: Promise<void> = deliver(message).finally(() => { inflight.delete(task); });
      inflight.add(task);
      launched.push(task);
    }
    return launched;
  };

  /**
   * One poll: claim due rows (serialized across overlapping calls), launch each
   * delivery independently, and resolve once this poll's deliveries settle.
   * It never waits for an accepted provider turn to finish (B-1390).
   */
  const tick = async (): Promise<void> => {
    if (paused) return;
    if (!claiming) {
      claiming = runLocalUpdateBackground('scheduled-message', claimAndLaunch)
        .catch((error: unknown) => {
          // A transient queue/database failure must not become an unhandled timer
          // rejection that takes down the whole server. The next poll retries from
          // durable state; prompt content is deliberately excluded from this log.
          logger.error('[scheduled-messages] queue tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        })
        .finally(() => { claiming = null; });
    }
    const launched = await claiming;
    if (launched) await Promise.all(launched);
  };

  /**
   * Stops claiming new rows (a shutdown drain calls this before it waits).
   * Deliveries and turns already launched continue untouched.
   */
  const pause = (): void => {
    paused = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    list(userId: number, filters: {
      sessionId?: string; status?: ScheduledMessageStatus; limit?: number; offset?: number;
    }) {
      const limit = filters.limit ?? 200;
      const offset = filters.offset ?? 0;
      // A session filter that targets a conversation not yet persisted (still
      // being processed, so no `sessions` row exists) or one the user can no
      // longer write is an EMPTY list, never a load error. Cross-user rows stay
      // hidden regardless: listAccessibleOwned filters by user_id and re-applies
      // the writable-session SQL gate, so the requester only ever sees own rows.
      if (filters.sessionId !== undefined && !isWritableSession(filters.sessionId, userId)) {
        return { messages: [], total: 0, limit, offset, hasMore: false, nextOffset: null };
      }
      const page = deps.repository.listAccessibleOwned(userId, { ...filters, limit, offset });
      return {
        messages: page.messages.map(toPublicScheduledMessage),
        total: page.total,
        limit,
        offset,
        hasMore: offset + page.messages.length < page.total,
        nextOffset: offset + page.messages.length < page.total ? offset + page.messages.length : null,
      };
    },
    /**
     * T-1912: node-wide metadata of scheduled messages due within `windowMs`
     * (overdue and in-flight pre-acceptance included), for the update
     * activator's soft deferral. Count and earliest due time only; never
     * content or owners, since it spans every user's rows.
     */
    upcomingDue(windowMs: number): { count: number; earliestAt: string | null } {
      if (!Number.isFinite(windowMs) || windowMs <= 0) return { count: 0, earliestAt: null };
      const nowMs = now();
      return deps.repository.nextDueWithin(
        new Date(nowMs).toISOString(), new Date(nowMs + windowMs).toISOString(),
      );
    },
    summary(userId: number) {
      return { counts: deps.repository.countAccessibleActionable(userId) };
    },
    create(userId: number, input: Record<string, unknown>) {
      if (deps.repository.countOpenForUser(userId) >= MAX_OPEN_SCHEDULED_PER_USER) {
        throw new ScheduledMessageError('scheduled_message_limit_reached', 409);
      }
      const row = deps.repository.create({
        userId,
        sessionId: assertWritable(input.sessionId, userId),
        content: normalizeContent(input.content),
        options: normalizeScheduledOptions(input.options),
        scheduledFor: normalizeScheduledFor(input.scheduledFor, now()),
      });
      deps.audit('scheduled_message_created', { scheduledMessageId: row.id, sessionId: row.sessionId }, userId);
      return toPublicScheduledMessage(row);
    },
    update(userId: number, id: string, input: Record<string, unknown>) {
      const existing = deps.repository.getOwned(id, userId);
      if (!existing) throw new ScheduledMessageError('scheduled_message_not_found', 404);
      if (existing.status !== 'pending' && existing.status !== 'failed') {
        throw new ScheduledMessageError('scheduled_message_state_conflict', 409);
      }
      assertWritable(existing.sessionId, userId);
      const row = deps.repository.updateOwned(id, userId, {
        content: input.content === undefined ? existing.content : normalizeContent(input.content),
        options: input.options === undefined ? existing.options : normalizeScheduledOptions(input.options),
        scheduledFor: input.scheduledFor === undefined
          ? existing.scheduledFor
          : normalizeScheduledFor(input.scheduledFor, now()),
      });
      if (!row) throw new ScheduledMessageError('scheduled_message_state_conflict', 409);
      deps.audit('scheduled_message_updated', { scheduledMessageId: row.id, sessionId: row.sessionId }, userId);
      return toPublicScheduledMessage(row);
    },
    cancel(userId: number, id: string) {
      const existing = deps.repository.getOwned(id, userId);
      if (!existing) throw new ScheduledMessageError('scheduled_message_not_found', 404);
      assertWritable(existing.sessionId, userId);
      const result = deps.repository.cancelOwned(id, userId);
      if (result === 'not_found') throw new ScheduledMessageError('scheduled_message_not_found', 404);
      if (result === 'conflict') throw new ScheduledMessageError('scheduled_message_state_conflict', 409);
      deps.audit('scheduled_message_cancelled', { scheduledMessageId: id }, userId);
    },
    tick,
    start() {
      paused = false;
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref();
    },
    pause,
    /** Pauses, then waits for the claim phase and every pre-acceptance delivery. */
    async stop() {
      pause();
      await claiming;
      await Promise.allSettled([...inflight]);
    },
  };
}
