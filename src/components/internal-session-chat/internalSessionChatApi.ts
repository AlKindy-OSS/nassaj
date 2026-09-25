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
export type InternalRoom = { members: InternalMember[]; unreadMentionCount: number; lastReadSequence: number; roomVersion?: number };

const roomPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/internal-room`;
const messagesPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/internal-messages`;
const json = { 'Content-Type': 'application/json' };

async function bodyOrNull(response: Response): Promise<any> { try { return await response.json(); } catch { return null; } }

export async function getInternalRoom(sessionId: string, signal?: AbortSignal): Promise<InternalRoom | null> {
  const response = await authenticatedFetch(roomPath(sessionId), { signal });
  if (!response.ok) return null;
  return bodyOrNull(response);
}

export async function createInternalRoom(sessionId: string): Promise<InternalRoom | null> {
  const response = await authenticatedFetch(roomPath(sessionId), { method: 'POST', headers: json });
  if (!response.ok) return null;
  return bodyOrNull(response);
}

export async function getInternalMessages(sessionId: string, signal?: AbortSignal): Promise<InternalMessage[]> {
  const response = await authenticatedFetch(messagesPath(sessionId), { signal });
  if (!response.ok) return [];
  const payload = await bodyOrNull(response);
  return Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
}

export async function sendInternalMessage(sessionId: string, body: string, mentionUserIds: Array<string | number>): Promise<InternalMessage | null> {
  const response = await authenticatedFetch(messagesPath(sessionId), {
    method: 'POST', headers: json,
    body: JSON.stringify({ body, mentionUserIds, clientMessageId: crypto.randomUUID() }),
  });
  return response.ok ? bodyOrNull(response) : null;
}

export async function markInternalRead(sessionId: string, sequence: number): Promise<boolean> {
  const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/internal-read`, {
    method: 'POST', headers: json, body: JSON.stringify({ sequence }),
  });
  return response.ok;
}
