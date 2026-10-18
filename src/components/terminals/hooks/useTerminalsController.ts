import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';
import type {
  TerminalActionError,
  TerminalCreateInput,
  TerminalErrorResponse,
  TerminalListResponse,
  TerminalMutationResponse,
  TerminalSummary,
} from '../types/types';

const TERMINALS_ENDPOINT = '/api/terminals';

// Maps a server error `code` to a localized, user-facing message. Falls back to
// a generic message so an unrecognized code never surfaces a raw string.
function resolveActionErrorMessage(
  code: string | undefined,
  fallbackKey: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (code) {
    case 'terminal_limit_reached':
      return t('errors.limitReached');
    case 'invalid_title':
      return t('errors.invalidTitle');
    case 'invalid_cwd':
      return t('errors.invalidCwd');
    case 'invalid_initial_command':
      return t('errors.invalidInitialCommand');
    case 'invalid_terminal_mode':
      return t('errors.invalidInitialCommand');
    default:
      return t(fallbackKey);
  }
}

async function readErrorEnvelope(response: Response): Promise<TerminalErrorResponse> {
  try {
    const payload = (await response.json()) as TerminalErrorResponse;
    if (payload && typeof payload === 'object') {
      return payload;
    }
  } catch {
    // ignore malformed / empty body
  }
  return { error: 'unknown' };
}

export type UseTerminalsControllerResult = {
  terminals: TerminalSummary[];
  isLoading: boolean;
  error: string | null;
  /** Last create/limit error, surfaced inline near the create action. */
  createError: TerminalActionError | null;
  clearCreateError: () => void;
  refresh: () => Promise<void>;
  /** Resolves to the created terminal, or null when the request failed. */
  createTerminal: (input?: TerminalCreateInput) => Promise<TerminalSummary | null>;
  renameTerminal: (id: string, title: string) => Promise<boolean>;
  deleteTerminal: (id: string) => Promise<boolean>;
};

export type UseTerminalsControllerOptions = {
  /**
   * B-1669: false for a user who may not use terminals (see canUseTerminals).
   * Nothing is requested, the state is cleared, and mutations are no-ops.
   */
  enabled?: boolean;
};

/**
 * Owns the standalone-terminals list plus CRUD (T-939). Single source of truth:
 * one instance is mounted high in the tree (AppContent) and shared by the
 * sidebar terminals section and the terminals panel. Per the contract the list
 * is refetched after every mutation and on `exited` (the connection hook calls
 * `refresh`); there are no WS list broadcasts.
 */
export function useTerminalsController(
  { enabled = true }: UseTerminalsControllerOptions = {},
): UseTerminalsControllerResult {
  const { t } = useTranslation('terminals');
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<TerminalActionError | null>(null);
  // Read after each await so a list that lands after disabling is dropped.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Keep the latest list length available to createTerminal without adding it to
  // the callback deps (which would rebuild the memoized handler on every list
  // change and re-render every consumer).
  const terminalsCountRef = useRef(0);
  useEffect(() => {
    terminalsCountRef.current = terminals.length;
  }, [terminals]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await authenticatedFetch(TERMINALS_ENDPOINT);
      if (!enabledRef.current) return;
      if (response.status === 403) {
        // The role changed mid-session: the server gate answered, not a fault.
        setTerminals([]);
        setError(t('errors.loadFailed'));
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to load terminals: ${response.status}`);
      }
      const payload = (await response.json()) as TerminalListResponse;
      if (!enabledRef.current) return;
      setTerminals(Array.isArray(payload.terminals) ? payload.terminals : []);
      setError(null);
    } catch (caught) {
      console.error('[Terminals] Failed to load list:', caught);
      setError(t('errors.loadFailed'));
    } finally {
      if (enabledRef.current) setIsLoading(false);
    }
  }, [enabled, t]);

  useEffect(() => {
    if (enabled) {
      setIsLoading(true);
      void refresh();
      return;
    }
    // A user who lost access (sign-out, account switch) never sees the last list.
    setTerminals([]);
    setError(null);
    setCreateError(null);
    setIsLoading(false);
  }, [enabled, refresh]);

  const clearCreateError = useCallback(() => setCreateError(null), []);

  const createTerminal = useCallback(
    async (input?: TerminalCreateInput): Promise<TerminalSummary | null> => {
      if (!enabled) return null;
      setCreateError(null);

      // Localized default title so the server's English fallback is never shown.
      const nextNumber = terminalsCountRef.current + 1;
      const body: TerminalCreateInput = {
        title: input?.title ?? t('defaults.title', { number: nextNumber }),
        ...(input?.cwd ? { cwd: input.cwd } : {}),
        ...(input?.initialCommand ? { initialCommand: input.initialCommand } : {}),
        ...(input?.mode ? { mode: input.mode } : {}),
        ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
      };

      try {
        const response = await authenticatedFetch(TERMINALS_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const envelope = await readErrorEnvelope(response);
          setCreateError({
            code: envelope.code ?? 'create_failed',
            message: resolveActionErrorMessage(envelope.code, 'errors.createFailed', t),
          });
          return null;
        }

        const payload = (await response.json()) as TerminalMutationResponse;
        await refresh();
        return payload.terminal ?? null;
      } catch (caught) {
        console.error('[Terminals] Failed to create terminal:', caught);
        setCreateError({ code: 'create_failed', message: t('errors.createFailed') });
        return null;
      }
    },
    [enabled, refresh, t],
  );

  const renameTerminal = useCallback(
    async (id: string, title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!enabled || !trimmed) {
        return false;
      }

      try {
        const response = await authenticatedFetch(`${TERMINALS_ENDPOINT}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: trimmed }),
        });
        if (!response.ok) {
          const envelope = await readErrorEnvelope(response);
          setError(resolveActionErrorMessage(envelope.code, 'errors.renameFailed', t));
          return false;
        }
        await refresh();
        return true;
      } catch (caught) {
        console.error('[Terminals] Failed to rename terminal:', caught);
        setError(t('errors.renameFailed'));
        return false;
      }
    },
    [enabled, refresh, t],
  );

  const deleteTerminal = useCallback(
    async (id: string): Promise<boolean> => {
      if (!enabled) return false;
      try {
        const response = await authenticatedFetch(`${TERMINALS_ENDPOINT}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const envelope = await readErrorEnvelope(response);
          setError(resolveActionErrorMessage(envelope.code, 'errors.deleteFailed', t));
          return false;
        }
        await refresh();
        return true;
      } catch (caught) {
        console.error('[Terminals] Failed to delete terminal:', caught);
        setError(t('errors.deleteFailed'));
        return false;
      }
    },
    [enabled, refresh, t],
  );

  return {
    terminals,
    isLoading,
    error,
    createError,
    clearCreateError,
    refresh,
    createTerminal,
    renameTerminal,
    deleteTerminal,
  };
}
