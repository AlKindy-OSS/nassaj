import { parseLivePage, parseMeta, type LivePage, type MetaResponse } from './types';
import type { ShareCredentials } from './loadShare';

/** Failure outcomes of one guest request. `ended` is the single uniform "no longer active" outcome. */
export type LiveFailure =
  | { kind: 'ended' }
  | { kind: 'cursor-stale' }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'temporary'; retryAfterMs: number }
  | { kind: 'attachment-gone' }
  | { kind: 'attachment-too-large' };

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: LiveFailure };

export type PageQuery = { before: string } | { after: string } | Record<string, never>;

export interface AttachmentBlob {
  blob: Blob;
  type: string;
}

export interface LiveClient {
  meta(signal?: AbortSignal): Promise<Outcome<MetaResponse>>;
  messages(query: PageQuery, signal?: AbortSignal): Promise<Outcome<LivePage>>;
  attachment(ref: string, signal?: AbortSignal): Promise<Outcome<AttachmentBlob>>;
}

const DEFAULT_TEMP_MS = 5000;
const DEFAULT_RATE_LIMIT_MS = 30_000;
const MAX_BACKOFF_MS = 120_000;

const clampMs = (ms: number) => Math.min(Math.max(ms, 1000), MAX_BACKOFF_MS);

function retryAfterHeaderMs(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function errorBody(response: Response): Promise<{ code?: string; retryAfterMs?: number }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; retryAfterMs?: unknown } };
    const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    const ms = typeof body?.error?.retryAfterMs === 'number' ? body.error.retryAfterMs : undefined;
    return { code, retryAfterMs: ms };
  } catch {
    return {};
  }
}

/** Map a non-2xx guest response to a failure. 404 never reveals why (uniform "ended"). */
export async function classifyFailure(response: Response): Promise<LiveFailure> {
  const { code, retryAfterMs } = await errorBody(response);
  const header = retryAfterHeaderMs(response);
  const { status } = response;
  if (status === 429) return { kind: 'rate-limited', retryAfterMs: clampMs(header ?? retryAfterMs ?? DEFAULT_RATE_LIMIT_MS) };
  if (status === 413 || code === 'ATTACHMENT_TOO_LARGE') return { kind: 'attachment-too-large' };
  if (status === 404) return code === 'ATTACHMENT_GONE' ? { kind: 'attachment-gone' } : { kind: 'ended' };
  if (status === 409 && code === 'CURSOR_STALE') return { kind: 'cursor-stale' };
  if (status === 401 || status === 403 || status === 410) return { kind: 'ended' };
  // 503 HISTORY_UNAVAILABLE, maintenance 409 and any other 5xx are transient.
  return { kind: 'temporary', retryAfterMs: clampMs(retryAfterMs ?? header ?? DEFAULT_TEMP_MS) };
}

function queryString(query: PageQuery): string {
  const params = new URLSearchParams();
  if ('before' in query) params.set('before', query.before);
  if ('after' in query) {
    params.set('after', query.after);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Guest API client. The token travels only in `X-Share-Token`; requests are GET,
 * credential-less and referrer-less. Never throws: failures are returned as values.
 */
export function createLiveClient(
  credentials: ShareCredentials,
  base: string = window.location.href,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): LiveClient {
  async function get(path: string, signal?: AbortSignal): Promise<Outcome<Response>> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(`/api/share-view/${credentials.id}${path}`, base), {
        method: 'GET',
        headers: { 'X-Share-Token': credentials.token },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      });
    } catch {
      return { ok: false, failure: { kind: 'temporary', retryAfterMs: DEFAULT_TEMP_MS } };
    }
    if (response.ok) return { ok: true, value: response };
    return { ok: false, failure: await classifyFailure(response) };
  }

  async function json<T>(path: string, parse: (value: unknown) => T | null, signal?: AbortSignal): Promise<Outcome<T>> {
    const res = await get(path, signal);
    if (!res.ok) return res;
    try {
      const value = parse(await res.value.json());
      if (value) return { ok: true, value };
    } catch { /* fall through */ }
    return { ok: false, failure: { kind: 'temporary', retryAfterMs: DEFAULT_TEMP_MS } };
  }

  return {
    meta: (signal) => json('/meta', parseMeta, signal),
    messages: (query, signal) => json(`/messages${queryString(query)}`, parseLivePage, signal),
    async attachment(ref, signal) {
      const res = await get(`/attachments/${encodeURIComponent(ref)}`, signal);
      if (!res.ok) return res;
      try {
        const blob = await res.value.blob();
        return { ok: true, value: { blob, type: res.value.headers.get('Content-Type') ?? '' } };
      } catch {
        return { ok: false, failure: { kind: 'temporary', retryAfterMs: DEFAULT_TEMP_MS } };
      }
    },
  };
}
