import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../utils/api';

const NOTICE_URL = '/api/credential-sharing/retirement-notice';

/** The one-time notice after the provider-sharing retirement (ADR-152 A1 §3.10). */
export type RetirementNotice = {
  retiredAt: string;
  /** Isolation keys (e.g. `claude`, `agy`) that were in shared mode. */
  sharedProviders: string[];
  /** Providers that had an install-wide key, or `unknown` when unreadable. */
  orgKeyProviders: string[] | 'unknown';
  members: { userId: number; username: string }[];
  ownersMustLinkOwnAccount: boolean;
};

const strings = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
);

/** A well-formed notice, or null (none pending, or a body this client cannot read). */
export function readRetirementNotice(body: unknown): RetirementNotice | null {
  const notice = (body as { data?: { notice?: unknown } } | null)?.data?.notice;
  if (!notice || typeof notice !== 'object') return null;
  const raw = notice as Record<string, unknown>;
  const members = Array.isArray(raw.members)
    ? raw.members.flatMap((member) => {
      const { userId, username } = (member ?? {}) as { userId?: unknown; username?: unknown };
      return typeof userId === 'number' && typeof username === 'string' && username ? [{ userId, username }] : [];
    })
    : [];
  return {
    retiredAt: typeof raw.retiredAt === 'string' ? raw.retiredAt : '',
    sharedProviders: strings(raw.sharedProviders),
    orgKeyProviders: raw.orgKeyProviders === 'unknown' ? 'unknown' : strings(raw.orgKeyProviders),
    members,
    ownersMustLinkOwnAccount: raw.ownersMustLinkOwnAccount !== false,
  };
}

/**
 * Loads the retirement notice for an owner-role account and acknowledges it.
 * Other roles never ask (the route answers them 404 anyway). Acknowledging is
 * idempotent on the server; the notice hides only once it succeeded.
 */
export function useRetirementNotice(isOwner: boolean) {
  const [notice, setNotice] = useState<RetirementNotice | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackFailed, setAckFailed] = useState(false);

  useEffect(() => {
    if (!isOwner) {
      setNotice(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch(NOTICE_URL);
        if (!response.ok) return;
        const parsed = readRetirementNotice(await response.json());
        if (!cancelled) setNotice(parsed);
      } catch {
        // No notice is better than a broken one; the next load asks again.
      }
    })();
    return () => { cancelled = true; };
  }, [isOwner]);

  const acknowledge = useCallback(async () => {
    setAcknowledging(true);
    setAckFailed(false);
    try {
      const response = await authenticatedFetch(`${NOTICE_URL}/ack`, { method: 'POST' });
      if (response.ok) {
        setNotice(null);
      } else {
        setAckFailed(true);
      }
    } catch {
      setAckFailed(true);
    } finally {
      setAcknowledging(false);
    }
  }, []);

  return { notice, acknowledging, ackFailed, acknowledge };
}
