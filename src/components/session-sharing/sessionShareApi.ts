import { authenticatedFetch } from '../../utils/api';

/** Client for the session-share management routes (ADR-196). Bearer-only on the server. */

export type ShareExpiry = '24h' | '7d' | '30d' | '90d';
export const SHARE_EXPIRIES: readonly ShareExpiry[] = ['24h', '7d', '30d', '90d'];

export type ShareRedactionCategory = 'system' | 'image' | 'secret' | 'path' | 'network';
export type PreviewPart =
  | { t: 'text'; text: string }
  | { t: 'redacted'; cat: ShareRedactionCategory; text?: string };
export type PreviewMessage = {
  role: 'user' | 'assistant';
  author: 'owner' | 'assistant';
  at?: string;
  parts: PreviewPart[];
};
export type ShareCounts = Record<ShareRedactionCategory, number> & {
  toolCount: number;
  thinking: number;
  other: number;
};
export type ShareBlocker = { code: string; count: number };
export type SharePreview = {
  snapshot: { title: string; messages: PreviewMessage[] };
  upToMessageId: string;
  previewSha256: string;
  counts: ShareCounts;
  blockers: ShareBlocker[];
};

export type ShareSummary = {
  id: string;
  sessionId: string;
  createdBy: number;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  sessionTitle: string | null;
  createdByName: string;
  createdBySelf: boolean;
  messageCount: number;
  viewCount: number;
  lastViewedAt: string | null;
  active: boolean;
};

export type CreateShareInput = {
  expiry: ShareExpiry;
  upToMessageId: string;
  previewSha256: string;
  reviewedRedactions: true;
  confirmPossibleSecrets?: true;
  confirmUnattributed?: boolean;
};

/** A failed management call; `code` is the server's stable public code. */
export class ShareApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly blockers: string[];

  constructor(status: number, code: string, blockers: string[] = []) {
    super(code);
    this.status = status;
    this.code = code;
    this.blockers = blockers;
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
      { error?: { code?: unknown; blockers?: unknown } } | null;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
    const blockers = Array.isArray(payload?.error?.blockers)
      ? payload.error.blockers.filter((item): item is string => typeof item === 'string') : [];
    throw new ShareApiError(response.status, code, blockers);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const sessionBase = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/shares`;

export const previewShare = (sessionId: string, confirmUnattributed: boolean) =>
  call<SharePreview>(`${sessionBase(sessionId)}/preview`, {
    method: 'POST', body: confirmUnattributed ? { confirmUnattributed: true } : {},
  });

export const createShare = (sessionId: string, input: CreateShareInput) =>
  call<{ share: ShareSummary; shareUrl: string }>(sessionBase(sessionId), { method: 'POST', body: input });

export const listSessionShares = (sessionId: string) =>
  call<{ shares: ShareSummary[] }>(sessionBase(sessionId));

export const listMyShares = () => call<{ shares: ShareSummary[] }>('/api/session-shares/mine');

export const revokeShare = (shareId: string) =>
  call<void>(`/api/session-shares/${encodeURIComponent(shareId)}/revoke`, { method: 'POST', body: {} });

/** i18n key suffix (under `sessionShare.errors.`) for a failed call. */
export function shareErrorKey(error: unknown): string {
  if (!(error instanceof ShareApiError)) return 'generic';
  const byCode: Record<string, string> = {
    AUTH_REQUIRED: 'authRequired',
    AMBIGUOUS_AUTHENTICATION: 'unavailableMode',
    ACCESS_DENIED: 'accessDenied',
    SESSION_NOT_FOUND: 'notFound',
    OWNER_UNRESOLVED: 'ownerUnresolved',
    SESSION_PROJECT_UNREGISTERED: 'projectUnregistered',
    SESSION_PROJECT_ARCHIVED: 'projectUnregistered',
    AUTHOR_UNVERIFIABLE: 'authorsUnverifiable',
    SNAPSHOT_CHANGED: 'snapshotChanged',
    SHARE_BLOCKED: 'blocked',
    RATE_LIMITED: 'rateLimited',
    SHARE_LIMIT_REACHED: 'limitReached',
    SHARING_NOT_CONFIGURED: 'notConfigured',
    SHARE_UNAVAILABLE: 'shareGone',
  };
  if (byCode[error.code]) return byCode[error.code];
  const byStatus: Record<number, string> = {
    401: 'authRequired', 403: 'accessDenied', 413: 'tooLarge', 429: 'rateLimited', 0: 'network',
  };
  return byStatus[error.status] ?? 'generic';
}

export type ShareEligibility = { canShare: boolean; canManage: boolean };

export const getShareEligibility = (sessionId: string) =>
  call<ShareEligibility>(`${sessionBase(sessionId)}/eligibility`);
