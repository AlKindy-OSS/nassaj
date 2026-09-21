import type {
  ScheduledMessage,
  ScheduledMessageOptions,
  ScheduledMessageStatus,
} from '@/modules/database/index.js';

import { runLocalUpdateBackground } from '../../services/update-writer-lease.js';

export const MAX_SCHEDULED_CONTENT_BYTES = 32 * 1024;
export const MAX_OPEN_SCHEDULED_PER_USER = 50;
export const MIN_SCHEDULE_DELAY_MS = 60_000;
export const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 15_000;

type Repository = {
  create(input: { userId: number; sessionId: string; content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage;
  getOwned(id: string, userId: number): ScheduledMessage | null;
  listOwned(userId: number, filters?: { sessionId?: string; status?: ScheduledMessageStatus }): ScheduledMessage[];
  listAccessibleOwned(userId: number, filters: {
    sessionId?: string; status?: ScheduledMessageStatus; limit: number; offset: number;
  }): { messages: ScheduledMessage[]; total: number };
  countAccessibleActionable(userId: number): { pending: number; running: number; failed: number };
  countOpenForUser(userId: number): number;
  failExpiredExhausted(nowIso: string): ScheduledMessage[];
  updateOwned(id: string, userId: number, input: { content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage | null;
  cancelOwned(id: string, userId: number): 'cancelled' | 'not_found' | 'conflict';
  claimDue(nowIso: string, leaseMs: number): ScheduledMessage | null;
  renewLease(id: string, leaseToken: string, leaseExpiresAt: string): boolean;
  settle(id: string, leaseToken: string, outcome: { success: boolean; retryable: boolean; errorCode?: string; retryAt?: string }): boolean;
};

type ActiveUser = { id: number; role: string; authorization_generation: number };
export type ScheduledDispatchResult = { success: boolean; retryable: boolean; errorCode?: string };

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
  dispatch(message: ScheduledMessage, user: ActiveUser): Promise<ScheduledDispatchResult>;
  audit(action: 'scheduled_message_created' | 'scheduled_message_updated' | 'scheduled_message_cancelled' | 'scheduled_message_dispatched' | 'scheduled_message_failed', metadata: Record<string, unknown>, userId: number): void;
  now?: () => number;
  leaseMs?: number;
  pollMs?: number;
  logger?: Pick<Console, 'error'>;
}) {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const logger = deps.logger ?? console;
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;

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

  const tick = async (): Promise<void> => {
    if (ticking) return ticking;
    ticking = runLocalUpdateBackground('scheduled-message', async () => {
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
      for (let processed = 0; processed < 10; processed += 1) {
        const message = deps.repository.claimDue(new Date(now()).toISOString(), leaseMs);
        if (!message?.leaseToken) break;
        let outcome: ScheduledDispatchResult;
        const user = deps.getActiveUser(message.userId);
        if (!user) {
          outcome = { success: false, retryable: false, errorCode: 'actor_revoked' };
        } else if (!deps.canWriteSession(message.sessionId, message.userId)) {
          outcome = { success: false, retryable: false, errorCode: 'session_write_revoked' };
        } else {
          const heartbeat = setInterval(() => {
            try {
              deps.repository.renewLease(
                message.id,
                message.leaseToken!,
                new Date(now() + leaseMs).toISOString(),
              );
            } catch (error) {
              logger.error('[scheduled-messages] lease renewal failed', {
                scheduledMessageId: message.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }, Math.max(1_000, Math.floor(leaseMs / 3)));
          heartbeat.unref();
          try {
            outcome = await deps.dispatch(message, user);
          } catch {
            outcome = { success: false, retryable: true, errorCode: 'dispatch_unavailable' };
          } finally {
            clearInterval(heartbeat);
          }
        }
        const settledOutcome = !outcome.success && outcome.retryable
          ? {
              ...outcome,
              retryAt: new Date(now() + Math.min(
                30_000 * (2 ** Math.max(0, message.attempts - 1)),
                15 * 60_000,
              )).toISOString(),
            }
          : outcome;
        const settled = deps.repository.settle(message.id, message.leaseToken, settledOutcome);
        if (settled) {
          deps.audit(outcome.success ? 'scheduled_message_dispatched' : 'scheduled_message_failed', {
            scheduledMessageId: message.id,
            sessionId: message.sessionId,
            attempt: message.attempts,
            ...(outcome.success ? {} : { errorCode: outcome.errorCode ?? 'unknown', retryable: outcome.retryable }),
          }, message.userId);
        }
      }
    }).catch((error: unknown) => {
      // A transient queue/database failure must not become an unhandled timer
      // rejection that takes down the whole server. The next poll retries from
      // durable state; prompt content is deliberately excluded from this log.
      logger.error('[scheduled-messages] queue tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { ticking = null; });
    return ticking;
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
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await ticking;
    },
  };
}
