import crypto from 'node:crypto';

import { auditLogDb } from '@/modules/database/index.js';
import { assertSessionAccessible } from '@/modules/providers/services/sessions.service.js';
import { AppError } from '@/shared/utils.js';

export const QWEN_BODY_ID = 'qwen' as const;

/**
 * The body is deliberately registered but unavailable. Flipping this constant
 * is not a release mechanism: the registry, synchronizer, stream and cancel
 * adapters must all exist before a composition root may expose Qwen.
 */
export const QWEN_BODY_AVAILABILITY = 'foreground_interactive' as const;

export const QWEN_ALLOWED_EXECUTION_CLASS = 'foreground_interactive' as const;
export const QWEN_GESTURE_MAX_AGE_MS = 30_000;
export const QWEN_MAX_ACTIVE_GESTURES = 1_024;

export type QwenExecutionClass =
  | typeof QWEN_ALLOWED_EXECUTION_CLASS
  | 'workflow'
  | 'background'
  | 'cron'
  | 'batch';

export type QwenTriggerSource = 'user_chat' | 'workflow' | 'system' | 'scheduler' | 'recovery';

export type QwenExecutionRequest = {
  actorUserId: string | number;
  sessionId: string;
  executionClass: QwenExecutionClass;
  triggerSource: QwenTriggerSource;
  gestureToken: string;
  autoContinue?: boolean;
  autoResume?: boolean;
};

type Gesture = {
  actorUserId: string;
  sessionId: string;
  issuedAt: number;
};

type AuditWriter = {
  record(
    action: 'qwen_execution_allowed' | 'qwen_execution_rejected',
    options: { userId?: number; metadata: Record<string, unknown> },
  ): void;
};

type ContractDependencies = {
  now?: () => number;
  randomToken?: () => string;
  audit?: AuditWriter;
  assertSessionWriteAccess?: (sessionId: string, actorUserId: number) => unknown;
};

const identity = (value: string | number): string => String(value).trim();

const numericUserId = (value: string | number): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
};

/**
 * In-memory, process-local user-gesture gate. Tokens are opaque, short-lived and
 * removed atomically on first authorization attempt, so retry/auto-resume code
 * cannot replay the browser gesture. A server restart invalidates all tokens.
 */
export function createQwenExecutionContract(dependencies: ContractDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const randomToken = dependencies.randomToken ?? (() => crypto.randomBytes(32).toString('base64url'));
  const audit: AuditWriter = dependencies.audit ?? {
    record: (action, options) => auditLogDb.record(action, options),
  };
  const assertSessionWriteAccess = dependencies.assertSessionWriteAccess
    ?? ((sessionId: string, actorUserId: number) => assertSessionAccessible(sessionId, actorUserId, 'write'));
  const gestures = new Map<string, Gesture>();

  const reject = (request: Partial<QwenExecutionRequest>, reason: string): never => {
    audit.record('qwen_execution_rejected', {
      userId: request.actorUserId === undefined ? undefined : numericUserId(request.actorUserId),
      metadata: {
        provider: QWEN_BODY_ID,
        body: QWEN_BODY_ID,
        decision: 'rejected',
        reason,
        executionClass: request.executionClass ?? 'missing',
        triggerSource: request.triggerSource ?? 'missing',
        actorUserId: request.actorUserId === undefined ? null : identity(request.actorUserId),
        credentialOwnerUserId: request.actorUserId === undefined ? null : identity(request.actorUserId),
        sessionId: request.sessionId ?? null,
        autoContinue: request.autoContinue === true,
        autoResume: request.autoResume === true,
      },
    });
    throw new AppError(`Qwen Coding Plan execution rejected: ${reason}.`, {
      code: 'QWEN_EXECUTION_CONTRACT_REJECTED',
      statusCode: 403,
    });
  };

  return {
    /** Mint only after an authenticated, direct user chat action is accepted. */
    issueGesture(input: {
      actorUserId: string | number;
      sessionId: string;
    }): string {
      const actor = identity(input.actorUserId);
      const sessionId = input.sessionId.trim();
      const actorId = numericUserId(input.actorUserId);
      if (!actor || actorId === undefined || !sessionId) {
        throw new AppError('A Qwen gesture requires an authenticated member and a persisted session.', {
          code: 'QWEN_GESTURE_SESSION_REQUIRED',
          statusCode: 400,
        });
      }
      // New conversations mint this only AFTER their session row exists. That
      // ordering is intentional: access cannot be asserted against a client-only
      // provisional id, and no gesture exists before the ownership row does.
      assertSessionWriteAccess(sessionId, actorId);

      const issuedAt = now();
      for (const [existingToken, existing] of gestures) {
        if (
          issuedAt - existing.issuedAt > QWEN_GESTURE_MAX_AGE_MS
          || (existing.actorUserId === actor && existing.sessionId === sessionId)
        ) {
          gestures.delete(existingToken);
        }
      }
      if (gestures.size >= QWEN_MAX_ACTIVE_GESTURES) {
        throw new AppError('Qwen gesture capacity is temporarily exhausted.', {
          code: 'QWEN_GESTURE_CAPACITY_EXHAUSTED',
          statusCode: 429,
        });
      }
      const token = randomToken();
      gestures.set(token, { actorUserId: actor, sessionId, issuedAt });
      return token;
    },

    /**
     * Final server-side gate. A future launcher MUST call this immediately
     * before reading the personal key and spawning the Qwen process.
     */
    authorizeSpawn(request: QwenExecutionRequest): {
      body: typeof QWEN_BODY_ID;
      executionClass: typeof QWEN_ALLOWED_EXECUTION_CLASS;
      gestureAgeMs: number;
    } {
      // Consume on the FIRST authorization attempt, before inspecting any other
      // field. A rejected workflow/owner/automatic attempt must not leave a
      // still-valid gesture that can be replayed with corrected metadata.
      const gesture = gestures.get(request.gestureToken);
      gestures.delete(request.gestureToken);

      if (request.executionClass !== QWEN_ALLOWED_EXECUTION_CLASS) {
        reject(request, 'execution_class_forbidden');
      }
      if (request.triggerSource !== 'user_chat') {
        reject(request, 'trigger_source_forbidden');
      }
      if (request.autoContinue === true || request.autoResume === true) {
        reject(request, 'automatic_continuation_forbidden');
      }

      const actor = identity(request.actorUserId);
      const actorId = numericUserId(request.actorUserId);
      if (!actor || actorId === undefined) {
        return reject(request, 'actor_identity_invalid');
      }
      // Re-check at use time: access may have been revoked after issuance.
      try {
        assertSessionWriteAccess(request.sessionId, actorId);
      } catch {
        return reject(request, 'session_access_denied');
      }

      if (!gesture) {
        return reject(request, 'gesture_missing_or_consumed');
      }
      const age = now() - gesture.issuedAt;
      if (
        age < 0
        || age > QWEN_GESTURE_MAX_AGE_MS
        || gesture.actorUserId !== actor
        || gesture.sessionId !== request.sessionId
      ) {
        reject(request, age > QWEN_GESTURE_MAX_AGE_MS ? 'gesture_expired' : 'gesture_binding_mismatch');
      }

      audit.record('qwen_execution_allowed', {
        userId: numericUserId(request.actorUserId),
        metadata: {
          provider: QWEN_BODY_ID,
          body: QWEN_BODY_ID,
          decision: 'allowed',
          executionClass: QWEN_ALLOWED_EXECUTION_CLASS,
          triggerSource: request.triggerSource,
          actorUserId: actor,
          // The future secret read is structurally keyed by this authenticated
          // actor; there is no request field capable of naming another owner.
          credentialOwnerUserId: actor,
          sessionId: request.sessionId,
          gestureAgeMs: age,
          autoContinue: false,
          autoResume: false,
        },
      });
      return { body: QWEN_BODY_ID, executionClass: QWEN_ALLOWED_EXECUTION_CLASS, gestureAgeMs: age };
    },
  };
}

export const qwenExecutionContract = createQwenExecutionContract();
