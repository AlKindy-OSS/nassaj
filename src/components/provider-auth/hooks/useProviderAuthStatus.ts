import { useCallback, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { ActiveBodyProvider } from '../../../types/app';
import {
  CLI_PROVIDERS,
  PROVIDER_AUTH_STATUS_ENDPOINTS,
  createInitialProviderAuthStatusMap,
} from '../types';
import type {
  ProviderAuthStatus,
  ProviderAuthStatusMap,
  ProviderGrantor,
} from '../types';

type ProviderAuthStatusPayload = {
  authenticated?: boolean;
  installed?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
  linkExpiry?: { expiresAt: string; daysLeft: number } | null;
  grantedBy?: { userId?: unknown; username?: unknown } | null;
};

/** A well-formed grantor, or null (absent, malformed, or the member's own credential). */
function readGrantor(value: ProviderAuthStatusPayload['grantedBy']): ProviderGrantor | null {
  if (!value || typeof value !== 'object') return null;
  const { userId, username } = value;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return null;
  if (typeof username !== 'string' || !username.trim()) return null;
  return { userId, username: username.trim() };
}

type ProviderAuthStatusApiResponse = {
  success: boolean;
  data: ProviderAuthStatusPayload;
};

const FALLBACK_STATUS_ERROR = 'Failed to check authentication status';
const FALLBACK_UNKNOWN_ERROR = 'Unknown error';

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : FALLBACK_UNKNOWN_ERROR
);

const toProviderAuthStatus = (
  payload: ProviderAuthStatusPayload,
  fallbackError: string | null = null,
): ProviderAuthStatus => {
  const grantedBy = readGrantor(payload.grantedBy);
  return {
    authenticated: Boolean(payload.authenticated),
    // fail-open: if the backend does not return installed, default to true so the
    // provider remains visible rather than being silently hidden.
    installed: payload.installed !== false,
    // ADR-152 A1 §3.9: a grantee never sees another person's email, even if sent.
    email: grantedBy ? null : payload.email ?? null,
    grantedBy,
    method: payload.method ?? null,
    error: payload.error ?? fallbackError,
    loading: false,
    // The request itself succeeded (HTTP 200) — this is a confirmed state, not a
    // failed check. error may still be populated (e.g. "Not installed") but that
    // is a legitimate negative state, not a request failure.
    checkFailed: false,
    linkExpiry: payload.linkExpiry ?? null,
  };
};

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

export function useProviderAuthStatus(
  { initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  const [providerAuthStatus, setProviderAuthStatus] = useState<ProviderAuthStatusMap>(() => (
    createInitialProviderAuthStatusMap(initialLoading)
  ));

  const setProviderLoading = useCallback((provider: ActiveBodyProvider) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: {
        ...previous[provider],
        loading: true,
        error: null,
      },
    }));
  }, []);

  const setProviderStatus = useCallback((provider: ActiveBodyProvider, status: ProviderAuthStatus) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: status,
    }));
  }, []);

  const checkProviderAuthStatus = useCallback(async (provider: ActiveBodyProvider): Promise<ProviderAuthStatus> => {
    setProviderLoading(provider);

    try {
      const response = await authenticatedFetch(PROVIDER_AUTH_STATUS_ENDPOINTS[provider]);

      if (!response.ok) {
        const status: ProviderAuthStatus = {
          authenticated: false,
          installed: true, // fail-open on HTTP error
          email: null,
          method: null,
          loading: false,
          error: FALLBACK_STATUS_ERROR,
          checkFailed: true, // HTTP request did not succeed — use fail-open
        };
        setProviderStatus(provider, status);
        return status;
      }

      const payload = (await response.json()) as ProviderAuthStatusApiResponse;
      const status = toProviderAuthStatus(payload.data);
      setProviderStatus(provider, status);
      return status;
    } catch (caughtError) {
      console.error(`Error checking ${provider} auth status:`, caughtError);
      const status: ProviderAuthStatus = {
        authenticated: false,
        installed: true, // fail-open on network/fetch error
        email: null,
        method: null,
        loading: false,
        error: toErrorMessage(caughtError),
        checkFailed: true, // network/fetch failure — use fail-open
      };
      setProviderStatus(provider, status);
      return status;
    }
  }, [setProviderLoading, setProviderStatus]);

  const refreshProviderAuthStatuses = useCallback(async (providers: ActiveBodyProvider[] = CLI_PROVIDERS) => {
    await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
  }, [checkProviderAuthStatus]);

  return {
    providerAuthStatus,
    setProviderAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  };
}
