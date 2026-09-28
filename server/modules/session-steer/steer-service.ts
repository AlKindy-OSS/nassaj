/**
 * `session-steer` admission (T-1903 / ADR-190). Checks run in the approved
 * order and every one of them fails closed; only a request that passes all of
 * them is audited, persisted and queued to the run.
 */

import { createHash, randomUUID } from 'node:crypto';

// Namespace import: the realtime tests mock the database barrel partially, and a
// named import of a member such a mock omits fails ESM linking (see chat-websocket.service.ts).
import * as databaseModule from '@/modules/database/index.js';

import type { SessionSteerResult, SteerRejectCode } from '../../../shared/session-steer.contract.js';

import { isSteeringAllowedFor } from './steer-policy.js';
import { getMidTurnInjection } from './steer-registry.js';
import type { SteerRun } from './steer-run.js';
import { buildSteerWrapper, sanitizeSteerText } from './steer-text.js';

export const STEER_RATE_PER_MINUTE = 5;
const RATE_WINDOW_MS = 60_000;
const CLIENT_MSG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TURN_ID = /^[0-9a-f-]{36}$/u;

const STATUS: Record<SteerRejectCode, number> = {
  invalid_request: 400, text_empty: 400, not_writable: 403, steer_disabled: 403, steer_not_consented: 403,
  steer_unsupported: 409, turn_not_active: 409, steer_self: 409, plan_mode: 409, steer_unavailable: 409,
  duplicate: 409, turn_aborted: 409, text_too_long: 413, steer_rate_limited: 429, steer_turn_limit: 429,
  steer_queue_full: 429, internal_error: 500,
};

export type SteerContext = {
  senderUserId: number | null;
  isWritable: (sessionId: string, userId: number) => boolean;
  getSessionProvider: (sessionId: string) => string | null;
  getDisplayName: (userId: number) => string | null;
  now?: () => number;
};

const recent = new Map<string, number[]>();
const RATE_KEYS_MAX = 10_000;

/** Sliding one-minute window per sender per session; counts only persisted injections. */
function rateLimited(key: string, now: number): boolean {
  const kept = (recent.get(key) ?? []).filter(at => now - at < RATE_WINDOW_MS);
  if (kept.length === 0) recent.delete(key); else recent.set(key, kept);
  return kept.length >= STEER_RATE_PER_MINUTE;
}

/**
 * Records one admission. Bounded memory without ever forgetting a LIVE window:
 * at the cap, keys whose timestamps are all stale are evicted first; only if
 * every key is live is the oldest-inserted key dropped.
 */
function recordRate(key: string, now: number): void {
  recent.set(key, [...(recent.get(key) ?? []), now]);
  if (recent.size <= RATE_KEYS_MAX) return;
  for (const [candidate, stamps] of recent) {
    if (stamps.every(at => now - at >= RATE_WINDOW_MS)) recent.delete(candidate);
  }
  for (const candidate of recent.keys()) {
    if (recent.size <= RATE_KEYS_MAX) break;
    if (candidate !== key) recent.delete(candidate);
  }
}

/** Test seam: record one admission for a key. */
export function __recordSteerRateForTests(key: string, now: number): void {
  recordRate(key, now);
}

/** Test seam: number of tracked rate keys. */
export function __steerRateKeysForTests(): number {
  return recent.size;
}

/** Test seam. */
export function __resetSteerRateLimitForTests(): void {
  recent.clear();
}

type Request = { sessionId: string; turnId: string; clientMsgId: string; text: unknown };

function readRequest(data: unknown): Request | null {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof d.sessionId !== 'string' || !d.sessionId || Buffer.byteLength(d.sessionId) > 256
    || typeof d.turnId !== 'string' || !TURN_ID.test(d.turnId)
    || typeof d.clientMsgId !== 'string' || !CLIENT_MSG_ID.test(d.clientMsgId)) return null;
  return { sessionId: d.sessionId, turnId: d.turnId, clientMsgId: d.clientMsgId, text: d.text };
}

function reply(req: Partial<Request>, code: SteerRejectCode | null): SessionSteerResult {
  return {
    type: 'session-steer-result',
    sessionId: typeof req.sessionId === 'string' ? req.sessionId : '',
    turnId: typeof req.turnId === 'string' ? req.turnId : '',
    clientMsgId: typeof req.clientMsgId === 'string' ? req.clientMsgId : '',
    ok: code === null,
    status: code === null ? 202 : STATUS[code],
    ...(code === null ? { deliveryStatus: 'queued' as const } : { code, deliveryStatus: 'rejected' as const }),
  };
}

function audit(req: Request, sender: number, starter: number | null, mode: string | null, text: string | null,
  result: SteerRejectCode | 'queued'): void {
  databaseModule.auditLogDb.recordStrict('session_steer_injection', {
    userId: sender,
    metadata: {
      senderUserId: sender, starterUserId: starter, sessionId: req.sessionId, turnId: req.turnId,
      clientMsgId: req.clientMsgId, permissionMode: mode, result,
      textSha256: text ? createHash('sha256').update(text).digest('hex') : null,
      textLength: text ? text.length : null,
    },
  });
}

/**
 * Admits one steer request. Order: shape → write access → provider capability
 * → live run → sender≠starter → plan mode → hooks armed → policy+consent →
 * turn authority → rate/turn/queue limits → text bounds. Never throws.
 */
export function handleSessionSteer(data: unknown, ctx: SteerContext): SessionSteerResult {
  const req = readRequest(data);
  const sender = ctx.senderUserId;
  if (!req || !Number.isSafeInteger(sender) || (sender as number) <= 0) {
    return reply((data ?? {}) as Partial<Request>, 'invalid_request');
  }
  const senderId = sender as number;
  try {
    if (!ctx.isWritable(req.sessionId, senderId)) return reply(req, 'not_writable');
    const provider = ctx.getSessionProvider(req.sessionId);
    const adapter = getMidTurnInjection(provider);
    if (!adapter) return reply(req, 'steer_unsupported');
    const run = adapter.findRun(req.sessionId);
    if (!run && adapter.hasUnarmedRun?.(req.sessionId)) return reply(req, 'steer_unavailable');
    if (!run || run.isClosed()) return reply(req, 'turn_not_active');
    const starter = run.starterUserId;
    const mode = run.permissionMode();
    const refuse = (code: SteerRejectCode, text: string | null = null) => {
      audit(req, senderId, starter, mode, text, code);
      return reply(req, code);
    };
    if (starter === null || starter === senderId) return refuse('steer_self');
    if (mode === 'plan') return refuse('plan_mode');
    if (!run.hooksArmed()) return refuse('steer_unavailable');
    const allowed = isSteeringAllowedFor(starter);
    if (!allowed.allowed) return refuse(allowed.code);
    if (run.turnId !== req.turnId) return refuse('turn_not_active');
    const now = (ctx.now ?? Date.now)();
    const rateKey = `${senderId}:${req.sessionId}`;
    if (rateLimited(rateKey, now)) return refuse('steer_rate_limited');
    const capacity = run.precheck();
    if (capacity) return refuse(capacity);
    const clean = sanitizeSteerText(req.text);
    if (!clean.ok) return refuse(clean.code);
    const senderName = ctx.getDisplayName(senderId) ?? 'member';
    const wrapped = buildSteerWrapper(senderName, clean.text);
    if (!wrapped) return refuse('text_too_long', clean.text);
    const payloadSha256 = adapter.payloadHash(wrapped);
    if (!payloadSha256) return refuse('text_too_long', clean.text);
    return admit(req, run, { provider: provider as string, senderId, senderName, text: clean.text,
      wrapped, payloadSha256, mode, refuse, onPersisted: () => recordRate(rateKey, now) });
  } catch {
    return reply(req, 'internal_error');
  }
}

type Admission = {
  provider: string; senderId: number; senderName: string; text: string; wrapped: string; payloadSha256: string;
  mode: string | null; refuse: (code: SteerRejectCode, text?: string | null) => SessionSteerResult;
  onPersisted: () => void;
};

/**
 * Ingress row → audit (strict) → queue. One audit record per request: a
 * duplicate is audited as 'duplicate' only; an audit failure after the row is
 * written marks the row rejected and nothing is queued. The rate window counts
 * persisted injections only.
 */
function admit(req: Request, run: SteerRun, a: Admission): SessionSteerResult {
  const uuid = randomUUID();
  const inserted = databaseModule.messageCoordinationDb.insertSteer({
    clientMsgId: req.clientMsgId, userId: a.senderId, provider: a.provider, sessionId: req.sessionId,
    turnId: req.turnId, text: a.text, uuid, payloadSha256: a.payloadSha256,
  });
  if (!inserted) return a.refuse('duplicate', a.text);
  a.onPersisted();
  try {
    audit(req, a.senderId, run.starterUserId, a.mode, a.text, 'queued');
  } catch {
    databaseModule.messageCoordinationDb.updateSteerStatus(req.clientMsgId, a.senderId, 'rejected');
    return reply(req, 'internal_error');
  }
  const queued = run.enqueue({ clientMsgId: req.clientMsgId, senderUserId: a.senderId,
    senderName: a.senderName, text: a.text, wrapped: a.wrapped, uuid });
  if (!queued.ok) {
    databaseModule.messageCoordinationDb.updateSteerStatus(req.clientMsgId, a.senderId, 'rejected');
    return a.refuse(queued.code, a.text);
  }
  return reply(req, null);
}
