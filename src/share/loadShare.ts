import { parseTranscript, type ShareTranscriptData } from './types';

const ID_PATTERN = /^\/s\/([A-Za-z0-9_-]{8,64})\/?$/;

export interface ShareCredentials {
  id: string;
  token: string;
}

/**
 * Result of one load attempt. `unavailable` is deliberately a single outcome: the
 * server answers 404 for unknown, expired, revoked and wrong-token alike, and the
 * viewer must not reintroduce a distinction.
 */
export type LoadResult =
  | { kind: 'ready'; transcript: ShareTranscriptData }
  | { kind: 'unavailable' }
  | { kind: 'rate-limited' }
  | { kind: 'network' };

/**
 * Reads id (path) and bearer token (fragment). The fragment is kept so a reload keeps
 * working; it is never sent to a server by the browser and never placed in a query,
 * cookie or storage. Returns null when either is missing.
 */
export function readCredentials(location: Pick<Location, 'pathname' | 'hash'>): ShareCredentials | null {
  const match = ID_PATTERN.exec(location.pathname);
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!match) return null;
  return token ? { id: match[1], token } : null;
}

async function readTranscript(response: Response): Promise<LoadResult> {
  try {
    const transcript = parseTranscript(await response.json());
    return transcript ? { kind: 'ready', transcript } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** One cross-origin read of the snapshot; never throws. */
export async function loadShare(
  credentials: ShareCredentials,
  base: string = window.location.href,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadResult> {
  let response: Response;
  try {
    const url = new URL(`/api/session-shares/${credentials.id}`, base);
    response = await fetchImpl(url, {
      headers: { 'X-Share-Token': credentials.token },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { kind: 'network' };
  }
  if (response.ok) return readTranscript(response);
  if (response.status === 429) return { kind: 'rate-limited' };
  return response.status >= 500 ? { kind: 'network' } : { kind: 'unavailable' };
}
