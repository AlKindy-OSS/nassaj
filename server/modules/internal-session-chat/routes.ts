/**
 * HTTP transport only; all authorization is enforced by the repository, which
 * re-checks room membership AND the platform session gate on every call.
 * Every refusal is the same 404 so room/session existence is never disclosed.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { auditLogDb } from '@/modules/database/index.js';

import { isInternalChatReady } from './access.js';
import { internalChatRealtime } from './realtime.js';
import {
  internalSessionChatDb, type InternalMemberGrant, type InternalMessageDto, type InternalRole,
} from './repository.js';

const ROLES: readonly InternalRole[] = ['owner', 'member', 'viewer'];
const MAX_BODY = 8000;
const MAX_MENTIONS = 50;

export type InternalSessionChatRouterOptions = {
  /** Applied to every mutating route (room create/revalidate, members, messages). */
  writeLimiter?: RequestHandler;
};

const passThrough: RequestHandler = (_req, _res, next) => next();
const userOf = (req: Request): number | undefined => {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return Number.isInteger(id) ? id as number : undefined;
};
/** Route param as a string; the `sessionId` param handler already validated it. */
const sessionIdOf = (req: Request): string => String(req.params.sessionId);
const absent = (res: Response) => res.status(404).json({ error: 'Not found' });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const isGrant = (value: unknown): value is InternalMemberGrant => {
  const grant = value as InternalMemberGrant | null;
  return Number.isInteger(grant?.userId) && ROLES.includes(grant?.role as InternalRole);
};
const isMentionList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length <= MAX_MENTIONS && value.every(item => Number.isInteger(item));

/** Content-free audit of a room grant change: ids and roles only. */
const audit = (action: Parameters<typeof auditLogDb.record>[0], actor: number, metadata: Record<string, unknown>) =>
  auditLogDb.record(action, { userId: actor, metadata });

/** Publishes the new message, then each recipient's personal mention count. */
function publishCreated(sessionId: string, message: InternalMessageDto, mentions: number[]) {
  internalChatRealtime.publishMessage(sessionId, message);
  for (const mentionedUserId of new Set(mentions)) {
    const room = internalSessionChatDb.roomFor(sessionId, mentionedUserId);
    if (!room) continue;
    internalChatRealtime.publishMentionState(sessionId, mentionedUserId, Number(room.unreadMentionCount), Number(room.version));
  }
}

function createRoom(req: Request, res: Response) {
  const u = userOf(req);
  const result = u && internalSessionChatDb.createRoom(sessionIdOf(req), u);
  if (!u || !result) return absent(res);
  if (result.created) audit('internal_chat_room_created', u, { sessionId: sessionIdOf(req) });
  return res.status(result.created ? 201 : 200).json(result.room);
}

function getRoom(req: Request, res: Response) {
  const u = userOf(req);
  const room = u && internalSessionChatDb.roomFor(sessionIdOf(req), u);
  return room ? res.json(room) : absent(res);
}

function sendMessage(req: Request, res: Response) {
  const u = userOf(req);
  const { body, clientMessageId } = req.body ?? {};
  const mentions = req.body?.mentionUserIds ?? [];
  const bodyValid = typeof body === 'string' && body.trim().length > 0 && body.length <= MAX_BODY;
  if (!u || !bodyValid || !validId(clientMessageId) || !isMentionList(mentions)) return absent(res);
  const result = internalSessionChatDb.send(sessionIdOf(req), u, body.trim(), clientMessageId, mentions);
  if (result.kind === 'missing') return absent(res);
  if (result.kind === 'conflict') return res.status(409).json({ error: 'Idempotency conflict' });
  if (!result.message) return absent(res);
  if (result.kind === 'created') publishCreated(sessionIdOf(req), result.message, mentions);
  return res.status(result.kind === 'created' ? 201 : 200).json(result.message);
}

function listMessages(req: Request, res: Response) {
  const u = userOf(req);
  const before = req.query.beforeSequence === undefined ? undefined : Number(req.query.beforeSequence);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const beforeValid = before === undefined || (Number.isInteger(before) && before >= 1);
  if (!u || !Number.isInteger(limit) || !beforeValid) return absent(res);
  const rows = internalSessionChatDb.list(sessionIdOf(req), u, before, limit);
  return rows ? res.json({ messages: rows }) : absent(res);
}

function revalidate(req: Request, res: Response) {
  const u = userOf(req);
  const members = req.body?.members;
  if (!u || !Array.isArray(members) || members.length < 1 || !members.every(isGrant)) return absent(res);
  const result = internalSessionChatDb.revalidateRoom(sessionIdOf(req), u, members);
  if (!result) return absent(res);
  for (const id of result.revokedUserIds) internalChatRealtime.revoke(sessionIdOf(req), id);
  audit('internal_chat_room_revalidated', u, {
    sessionId: sessionIdOf(req),
    members: members.map(({ userId, role }) => ({ userId, role })),
    revokedUserIds: result.revokedUserIds,
  });
  return res.json(result.room);
}

function addMember(req: Request, res: Response) {
  const u = userOf(req);
  const { userId, role } = req.body ?? {};
  if (!u || !Number.isInteger(userId) || !['member', 'viewer'].includes(role)) return absent(res);
  if (!internalSessionChatDb.addMember(sessionIdOf(req), u, userId, role as InternalRole)) return absent(res);
  audit('internal_chat_member_added', u, { sessionId: sessionIdOf(req), targetUserId: userId, role });
  return res.status(201).json({ ok: true });
}

function removeMember(req: Request, res: Response) {
  const u = userOf(req);
  const target = Number(String(req.params.userId));
  if (!u || !Number.isInteger(target)) return absent(res);
  if (!internalSessionChatDb.removeMember(sessionIdOf(req), u, target)) return absent(res);
  internalChatRealtime.revoke(sessionIdOf(req), target);
  audit('internal_chat_member_removed', u, { sessionId: sessionIdOf(req), targetUserId: target });
  return res.status(204).end();
}

function markRead(req: Request, res: Response) {
  const u = userOf(req);
  const sequence = req.body?.sequence;
  const room = u && Number.isInteger(sequence) && internalSessionChatDb.markRead(sessionIdOf(req), u, sequence);
  return room ? res.json(room) : absent(res);
}

/**
 * Router mounted under `/api/sessions` behind authenticateToken. The readiness
 * gate is per route, never router-wide, because this router shares that mount.
 * The `sessionId` param check runs before the gate; both refuse with the same 404.
 */
export function createInternalSessionChatRouter(options: InternalSessionChatRouterOptions = {}) {
  const router = Router();
  const limit = options.writeLimiter ?? passThrough;
  const gate = (_req: Request, res: Response, next: NextFunction) => (isInternalChatReady() ? next() : absent(res));
  router.param('sessionId', (_req, res, next, id) => (validId(id) ? next() : absent(res)));
  router.post('/:sessionId/internal-room', gate, limit, createRoom);
  router.get('/:sessionId/internal-room', gate, getRoom);
  router.post('/:sessionId/internal-room/revalidate', gate, limit, revalidate);
  router.post('/:sessionId/internal-room/members', gate, limit, addMember);
  router.delete('/:sessionId/internal-room/members/:userId', gate, limit, removeMember);
  router.get('/:sessionId/internal-messages', gate, listMessages);
  router.post('/:sessionId/internal-messages', gate, limit, sendMessage);
  router.post('/:sessionId/internal-read', gate, markRead);
  return router;
}
