/** Recent-auth sessions are kept this long after expiry or revocation, for audit correlation. */
export const OWNER_AUTH_SESSION_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Runs one guarded mutation; production passes the connector runtime fence executor. */
export type ConnectorRetentionWriteExecutor = <T>(effect: () => T) => T;

const runDirectly: ConnectorRetentionWriteExecutor = effect => effect();

/**
 * Default-off-independent retention maintenance for inert connector candidates
 * and old recent-auth sessions. Both tables are guarded by the M2 runtime
 * fence, so every delete runs through `executeWrite` (the fence executor in
 * production); a direct delete on a fenced database aborts with
 * connector_runtime_fence_required.
 */
export const createConnectorCredentialRetentionService = (repository: Readonly<{
  purgeExpiredCredentialCandidates(limit: number): number;
  purgeExpiredOwnerAuthSessions(cutoffMs: number, limit: number): number;
}>, options: Readonly<{ now?: () => number; executeWrite?: ConnectorRetentionWriteExecutor }> = {}) => {
  const executeWrite = options.executeWrite ?? runDirectly;
  return Object.freeze({
    /** Bounded maintenance tick; it performs no provider or network I/O. */
    runOnce(limit = 25): Readonly<{ removedCandidates: number; removedOwnerSessions: number }> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('connector_credential_cleanup_limit_invalid');
      }
      const removedCandidates = executeWrite(() => repository.purgeExpiredCredentialCandidates(limit));
      const cutoffMs = (options.now?.() ?? Date.now()) - OWNER_AUTH_SESSION_RETENTION_MS;
      const removedOwnerSessions = executeWrite(() => repository.purgeExpiredOwnerAuthSessions(cutoffMs, 100));
      return Object.freeze({ removedCandidates, removedOwnerSessions });
    },
  });
};

/** A log-safe code for a maintenance failure: fixed error codes pass, anything else is generic. */
export const connectorRetentionFailureCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_:]{1,120}$/u.test(message) ? message : 'connector_retention_failed';
};
