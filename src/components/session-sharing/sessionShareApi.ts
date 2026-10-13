import { authenticatedFetch } from '../../utils/api';

/** Client for the session-share management routes (ADR-205). Bearer JWT or device session on the server. */

export type ShareExpiry = '24h' | '7d' | '30d' | '90d';
export const SHARE_EXPIRIES: readonly ShareExpiry[] = ['24h', '7d', '30d', '90d'];

export type ShareMode = 'live' | 'snapshot';

/** A share row as the server lists it. Live rows carry null snapshot-only fields. */
export type ShareSummary = {
  id: string;
  sessionId: string;
  mode: ShareMode;
  createdBy: number;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  sessionTitle: string | null;
  createdByName: string;
  createdBySelf: boolean;
  upToMessageId: string | null;
  messageCount: number | null;
  redactionCounts: Record<string, number> | null;
  revokeReason: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  active: boolean;
};

export type CreateShareInput = { expiry: ShareExpiry };

/** A failed management call; `code` is the server's stable public code. */
export class ShareApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await authenticatedFetch(url, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ShareApiError(0, 'NETWORK');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as
      { error?: { code?: unknown } } | null;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
    throw new ShareApiError(response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const sessionBase = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/shares`;

export const createShare = (sessionId: string, input: CreateShareInput) =>
  call<{ share: ShareSummary; shareUrl: string }>(sessionBase(sessionId), { method: 'POST', body: input });

export const listSessionShares = (sessionId: string) =>
  call<{ shares: ShareSummary[] }>(sessionBase(sessionId));

export const listMyShares = () => call<{ shares: ShareSummary[] }>('/api/session-shares/mine');

export const revokeShare = (shareId: string) =>
  call<void>(`/api/session-shares/${encodeURIComponent(shareId)}/revoke`, { method: 'POST', body: {} });

/** Notifies mounted share notices that a link was created or revoked. */
export const SHARES_CHANGED_EVENT = 'nassaj:session-shares-changed';
export const announceSharesChanged = () => window.dispatchEvent(new Event(SHARES_CHANGED_EVENT));

/** i18n key suffix (under `sessionShare.errors.`) for a failed call; each cause has its own message. */
export function shareErrorKey(error: unknown): string {
  if (!(error instanceof ShareApiError)) return 'generic';
  const byCode: Record<string, string> = {
    AUTH_REQUIRED: 'authRequired',
    AMBIGUOUS_AUTHENTICATION: 'unavailableMode',
    INVALID_INPUT: 'invalidInput',
    OWNER_ONLY: 'ownerOnly',
    ACCESS_DENIED: 'accessDenied',
    SESSION_NOT_FOUND: 'notFound',
    OWNER_UNRESOLVED: 'ownerUnresolved',
    SESSION_PROJECT_UNREGISTERED: 'projectUnregistered',
    SESSION_PROJECT_ARCHIVED: 'projectArchived',
    RATE_LIMITED: 'rateLimited',
    SHARE_LIMIT_REACHED: 'limitReached',
    SHARING_NOT_CONFIGURED: 'notConfigured',
    SHARE_UNAVAILABLE: 'shareGone',
    SNAPSHOT_SHARES_RETIRED: 'snapshotRetired',
  };
  if (byCode[error.code]) return byCode[error.code];
  const byStatus: Record<number, string> = {
    401: 'authRequired', 403: 'accessDenied', 415: 'unsupportedType', 429: 'rateLimited', 0: 'network',
  };
  return byStatus[error.status] ?? 'generic';
}

export type ShareEligibility = { canShare: boolean; canManage: boolean };

export const getShareEligibility = (sessionId: string) =>
  call<ShareEligibility>(`${sessionBase(sessionId)}/eligibility`);

/** Number of live read links currently active on a session the caller can read. */
export const getShareStatus = (sessionId: string) =>
  call<{ activeLiveLinks: number }>(`${sessionBase(sessionId)}/status`);
