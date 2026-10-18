import { authenticatedFetch } from '../../utils/api';

export type InternalMember = { userId: string | number; username: string; role: 'owner' | 'member' | 'viewer' };
export type InternalMessage = {
  id: string;
  sequence: number;
  body: string;
  /** Null once the author's account was deleted (ADR-187: messages stay, author is cleared). */
  authorUserId: string | number | null;
  authorName?: string | null;
  createdAt: string;
  editedAt?: string | null;
};
export type InternalRole = InternalMember['role'];
/** `role` is the caller's own room role as projected by the server; only `owner` may manage members. */
export type InternalRoom = {
  members: InternalMember[]; unreadMentionCount: number; lastReadSequence: number; roomVersion?: number; role?: InternalRole;
};
/** A grantable role: the server accepts only these on add (owner is never granted). */
export type InternalGrantRole = Exclude<InternalRole, 'owner'>;
/** A project member offered as a room candidate; the server still decides eligibility. */
export type ProjectMemberOption = { userId: number; displayName: string };

const roomPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/internal-room`;
const membersPath = (sessionId: string) => `${roomPath(sessionId)}/members`;
const messagesPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/internal-messages`;
const json = { 'Content-Type': 'application/json' };

async function bodyOrNull(response: Response): Promise<any> { try { return await response.json(); } catch { return null; } }

export async function getInternalRoom(sessionId: string, signal?: AbortSignal): Promise<InternalRoom | null> {
  const response = await authenticatedFetch(roomPath(sessionId), { signal });
  if (!response.ok) return null;
  return bodyOrNull(response);
}

/** A room re-read that tells lost access (403/404) apart from a transient failure. */
export type InternalRoomRefresh = { kind: 'room'; room: InternalRoom } | { kind: 'gone' } | { kind: 'error' };

/** Re-reads the room; only 403/404 mean the caller lost access, anything else is retryable. */
export async function refreshInternalRoom(sessionId: string, signal?: AbortSignal): Promise<InternalRoomRefresh> {
  const response = await authenticatedFetch(roomPath(sessionId), { signal }).catch(() => null);
  if (!response) return { kind: 'error' };
  if (response.status === 403 || response.status === 404) return { kind: 'gone' };
  const room = response.ok ? await bodyOrNull(response) : null;
  return room ? { kind: 'room', room } : { kind: 'error' };
}

export async function createInternalRoom(sessionId: string, signal?: AbortSignal): Promise<InternalRoom | null> {
  const response = await authenticatedFetch(roomPath(sessionId), { method: 'POST', headers: json, signal });
  if (!response.ok) return null;
  return bodyOrNull(response);
}

export async function getInternalMessages(sessionId: string, signal?: AbortSignal): Promise<InternalMessage[]> {
  const response = await authenticatedFetch(messagesPath(sessionId), { signal });
  if (!response.ok) return [];
  const payload = await bodyOrNull(response);
  return Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
}

/** An abort only stops waiting for the answer; the server may still store the message. */
export async function sendInternalMessage(
  sessionId: string, body: string, mentionUserIds: Array<string | number>, signal?: AbortSignal,
): Promise<InternalMessage | null> {
  const response = await authenticatedFetch(messagesPath(sessionId), {
    method: 'POST', headers: json, signal,
    body: JSON.stringify({ body, mentionUserIds, clientMessageId: crypto.randomUUID() }),
  });
  return response.ok ? bodyOrNull(response) : null;
}

export async function markInternalRead(sessionId: string, sequence: number, signal?: AbortSignal): Promise<boolean> {
  const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/internal-read`, {
    method: 'POST', headers: json, body: JSON.stringify({ sequence }), signal,
  });
  return response.ok;
}

/** Grants (or changes) a member's room role. True only on the server's 2xx. */
export async function addInternalMember(
  sessionId: string, userId: number, role: InternalGrantRole, signal?: AbortSignal,
): Promise<boolean> {
  const response = await authenticatedFetch(membersPath(sessionId), {
    method: 'POST', headers: json, body: JSON.stringify({ userId, role }), signal,
  });
  return response.ok;
}

/** Revokes a member's room access. True only on the server's 2xx. */
export async function removeInternalMember(sessionId: string, userId: number, signal?: AbortSignal): Promise<boolean> {
  const response = await authenticatedFetch(`${membersPath(sessionId)}/${encodeURIComponent(String(userId))}`, {
    method: 'DELETE', signal,
  });
  return response.ok;
}

/**
 * Re-activates a room that needs revalidation (e.g. after a project move) with an
 * explicit member list; the server admits only the session's creator.
 */
export async function revalidateInternalRoom(
  sessionId: string, members: Array<{ userId: number; role: InternalRole }>, signal?: AbortSignal,
): Promise<InternalRoom | null> {
  const response = await authenticatedFetch(`${roomPath(sessionId)}/revalidate`, {
    method: 'POST', headers: json, body: JSON.stringify({ members }), signal,
  });
  return response.ok ? bodyOrNull(response) : null;
}

/** Project members (ADR-172 listing, readable by anyone with project access); null on refusal. */
export async function listProjectMemberOptions(projectId: string, signal?: AbortSignal): Promise<ProjectMemberOption[] | null> {
  const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, { signal });
  if (!response.ok) return null;
  const rows = (await bodyOrNull(response))?.data?.members;
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((row) => Number.isSafeInteger(row?.userId))
    .map((row) => ({ userId: row.userId as number, displayName: typeof row.displayName === 'string' ? row.displayName : String(row.userId) }));
}
