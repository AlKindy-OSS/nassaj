/** Persistent store for ADR-187.  This module intentionally knows no provider APIs. */
import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';

import { canUseSession, type InternalChatAccessMode } from './access.js';

export type InternalRole = 'owner' | 'member' | 'viewer';
export type InternalMemberGrant = { userId: number; role: InternalRole };
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ACTIVE_USER_SQL = `u.is_active = 1 AND u.status = 'active'`;

/** Client-facing message shape: camelCase, author name resolved, no idempotency fingerprint. */
export type InternalMessageDto = {
  id: string;
  sequence: number;
  authorUserId: number | null;
  authorName: string | null;
  body: string;
  clientMessageId: string;
  createdAt: string;
  editedAt: string | null;
};

/** The ONE projection every list, send and broadcast payload is built from. */
const MESSAGE_DTO_SQL = `SELECT x.id, x.sequence, x.author_user_id AS authorUserId, u.username AS authorName,
    x.body, x.client_message_id AS clientMessageId, x.created_at AS createdAt, x.edited_at AS editedAt
  FROM session_internal_messages x LEFT JOIN users u ON u.id = x.author_user_id`;

const messageById = (id: string) => getConnection()
  .prepare(`${MESSAGE_DTO_SQL} WHERE x.id = ?`).get(id) as InternalMessageDto | undefined;

const bumpRoomVersion = (sessionId: string) => getConnection()
  .prepare('UPDATE session_internal_rooms SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE session_id=?')
  .run(sessionId);

/** A grant target must be an active account the platform already admits to the session. */
const isEligibleTarget = (sessionId: string, userId: number) =>
  Number.isInteger(userId) && canUseSession(sessionId, userId, 'read');

/** Validates a full replacement member list; undefined when any entry is unacceptable. */
function validGrantList(sessionId: string, actor: number, members: InternalMemberGrant[]) {
  const unique = [...new Map(members.map(member => [member.userId, member])).values()];
  if (unique.length !== members.length) return undefined;
  if (!unique.some(member => member.userId === actor && member.role === 'owner')) return undefined;
  if (unique.some(member => !isEligibleTarget(sessionId, member.userId))) return undefined;
  return unique;
}

export const internalSessionChatDb = {
  /** Spawn-owner of the session who can still write it (ADR-187 creator predicate). */
  isCreator(sessionId: string, userId: number): boolean {
    const spawnOwner = getConnection().prepare(`SELECT 1 FROM session_participants
      WHERE session_id=? AND user_id=? AND role='owner' AND attribution='spawn'`).get(sessionId, userId);
    return Boolean(spawnOwner) && canUseSession(sessionId, userId, 'write');
  },
  /** Idempotent; `created` is true only for the call that actually inserted the room. */
  createRoom(sessionId: string, userId: number) {
    const db = getConnection();
    return db.transaction(() => {
      if (!this.isCreator(sessionId, userId)) return undefined;
      const created = db.prepare(`INSERT INTO session_internal_rooms(session_id,created_by) VALUES(?,?)
        ON CONFLICT(session_id) DO NOTHING`).run(sessionId, userId).changes > 0;
      db.prepare(`INSERT INTO session_internal_room_members(session_id,user_id,role,added_by)
        VALUES(?,?,'owner',?) ON CONFLICT(session_id,user_id) DO NOTHING`).run(sessionId, userId, userId);
      const room = this.roomFor(sessionId, userId);
      return room ? { room, created } : undefined;
    }).immediate();
  },
  revalidateRoom(sessionId: string, userId: number, members: InternalMemberGrant[]) {
    const db = getConnection();
    return db.transaction(() => {
      if (!this.isCreator(sessionId, userId)) return undefined;
      if (!db.prepare('SELECT 1 FROM session_internal_rooms WHERE session_id=?').get(sessionId)) return undefined;
      const unique = validGrantList(sessionId, userId, members);
      if (!unique) return undefined;
      const old = db.prepare('SELECT user_id userId FROM session_internal_room_members WHERE session_id=?')
        .all(sessionId) as Array<{ userId: number }>;
      db.prepare('DELETE FROM session_internal_room_members WHERE session_id=?').run(sessionId);
      const add = db.prepare('INSERT INTO session_internal_room_members(session_id,user_id,role,added_by) VALUES(?,?,?,?)');
      for (const member of unique) add.run(sessionId, member.userId, member.role, userId);
      db.prepare(`UPDATE session_internal_rooms SET membership_state='active',version=version+1,
        updated_at=CURRENT_TIMESTAMP WHERE session_id=?`).run(sessionId);
      const room = this.roomFor(sessionId, userId);
      const revokedUserIds = old.map(row => row.userId).filter(id => !unique.some(member => member.userId === id));
      return room ? { room, revokedUserIds } : undefined;
    }).immediate();
  },
  roomFor(sessionId: string, userId: number) {
    if (!this.activeMember(sessionId, userId)) return undefined;
    const db = getConnection();
    const room = db.prepare(`SELECT r.session_id sessionId,r.membership_state membershipState,r.version,
      m.role,m.last_read_sequence lastReadSequence,
      (SELECT count(*) FROM session_internal_messages x WHERE x.session_id=r.session_id
        AND x.sequence>m.last_read_sequence AND x.deleted_at IS NULL) unreadCount,
      (SELECT count(*) FROM session_internal_message_mentions z
        JOIN session_internal_messages x ON x.id=z.message_id
        WHERE z.mentioned_user_id=m.user_id AND x.session_id=r.session_id
          AND x.sequence>m.last_read_sequence AND x.deleted_at IS NULL) unreadMentionCount
      FROM session_internal_rooms r JOIN session_internal_room_members m ON m.session_id=r.session_id
      WHERE r.session_id=? AND m.user_id=? AND r.membership_state='active'`)
      .get(sessionId, userId) as Record<string, unknown> | undefined;
    if (!room) return undefined;
    room.members = db.prepare(`SELECT m.user_id userId,u.username,m.role,m.added_at addedAt,
        m.last_read_sequence lastReadSequence
      FROM session_internal_room_members m JOIN users u ON u.id=m.user_id
      WHERE m.session_id=? AND ${ACTIVE_USER_SQL} ORDER BY m.role='owner' DESC,m.added_at`).all(sessionId);
    return room;
  },
  /**
   * Role of an active room member who ALSO passes the platform session gate in
   * `mode`; 'write' additionally excludes viewers and archived sessions.
   */
  activeMember(sessionId: string, userId: number, mode: InternalChatAccessMode = 'read'): InternalRole | undefined {
    const row = getConnection().prepare(`SELECT m.role FROM session_internal_rooms r
      JOIN session_internal_room_members m ON m.session_id=r.session_id
      JOIN sessions s ON s.session_id=r.session_id
      WHERE r.session_id=? AND m.user_id=? AND r.membership_state='active' AND (?=0 OR s.isArchived=0)`)
      .get(sessionId, userId, mode === 'write' ? 1 : 0) as { role: InternalRole } | undefined;
    if (!row || (mode === 'write' && row.role === 'viewer')) return undefined;
    return canUseSession(sessionId, userId, mode) ? row.role : undefined;
  },
  /** Room owner who can still write the session; the only role that manages members. */
  canManage(sessionId: string, actor: number): boolean {
    return this.activeMember(sessionId, actor) === 'owner' && canUseSession(sessionId, actor, 'write');
  },
  addMember(sessionId: string, actor: number, userId: number, role: InternalRole) {
    const db = getConnection();
    return db.transaction(() => {
      if (!this.canManage(sessionId, actor) || !isEligibleTarget(sessionId, userId)) return false;
      db.prepare(`INSERT INTO session_internal_room_members(session_id,user_id,role,added_by) VALUES(?,?,?,?)
        ON CONFLICT(session_id,user_id) DO UPDATE SET role=excluded.role,added_by=excluded.added_by,
        added_at=CURRENT_TIMESTAMP`).run(sessionId, userId, role, actor);
      bumpRoomVersion(sessionId);
      return true;
    }).immediate();
  },
  removeMember(sessionId: string, actor: number, userId: number) {
    const db = getConnection();
    return db.transaction(() => {
      if (actor === userId || !this.canManage(sessionId, actor)) return false;
      const changed = db.prepare('DELETE FROM session_internal_room_members WHERE session_id=? AND user_id=?')
        .run(sessionId, userId).changes;
      if (changed) bumpRoomVersion(sessionId);
      return Boolean(changed);
    }).immediate();
  },
  list(sessionId: string, userId: number, before: number | undefined, limit: number) {
    if (!this.activeMember(sessionId, userId)) return undefined;
    return getConnection().prepare(`${MESSAGE_DTO_SQL} WHERE x.session_id=? AND x.deleted_at IS NULL
        AND x.sequence < COALESCE(?,9223372036854775807) ORDER BY x.sequence DESC LIMIT ?`)
      .all(sessionId, before ?? null, limit) as InternalMessageDto[];
  },
  send(sessionId: string, userId: number, body: string, clientMessageId: string, mentions: number[]) {
    const db = getConnection();
    const fingerprint = hash({ body, mentions: [...mentions].sort((a, b) => a - b) });
    return db.transaction(() => {
      if (!this.activeMember(sessionId, userId, 'write')) return { kind: 'missing' } as const;
      const existing = db.prepare(`SELECT id,request_fingerprint requestFingerprint FROM session_internal_messages
        WHERE session_id=? AND author_user_id=? AND client_message_id=?`)
        .get(sessionId, userId, clientMessageId) as { id: string; requestFingerprint: string } | undefined;
      if (existing) {
        return existing.requestFingerprint === fingerprint
          ? { kind: 'existing', message: messageById(existing.id) } as const
          : { kind: 'conflict' } as const;
      }
      // A mention may only name a member who can currently read the room.
      if (mentions.some(id => !this.activeMember(sessionId, id))) return { kind: 'missing' } as const;
      const room = db.prepare(`UPDATE session_internal_rooms SET next_sequence=next_sequence+1,version=version+1,
          updated_at=CURRENT_TIMESTAMP,last_message_at=CURRENT_TIMESTAMP
        WHERE session_id=? AND membership_state='active' RETURNING next_sequence-1 sequence,version`)
        .get(sessionId) as { sequence: number; version: number } | undefined;
      if (!room) return { kind: 'missing' } as const;
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO session_internal_messages(id,session_id,sequence,author_user_id,body,
        client_message_id,request_fingerprint) VALUES(?,?,?,?,?,?,?)`)
        .run(id, sessionId, room.sequence, userId, body, clientMessageId, fingerprint);
      const mention = db.prepare('INSERT INTO session_internal_message_mentions(message_id,mentioned_user_id) VALUES(?,?)');
      for (const mentionedUserId of new Set(mentions)) mention.run(id, mentionedUserId);
      return { kind: 'created', message: messageById(id), version: room.version } as const;
    }).immediate();
  },
  markRead(sessionId: string, userId: number, sequence: number) {
    const db = getConnection();
    return db.transaction(() => {
      if (!this.activeMember(sessionId, userId)) return undefined;
      const latest = db.prepare('SELECT max(sequence) max FROM session_internal_messages WHERE session_id=?')
        .get(sessionId) as { max: number | null };
      if (sequence < 0 || sequence > (latest.max ?? 0)) return undefined;
      db.prepare(`UPDATE session_internal_room_members SET last_read_sequence=MAX(last_read_sequence,?)
        WHERE session_id=? AND user_id=?`).run(sequence, sessionId, userId);
      return this.roomFor(sessionId, userId);
    }).immediate();
  },
};
