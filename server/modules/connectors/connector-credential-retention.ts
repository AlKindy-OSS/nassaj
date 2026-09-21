/** Default-off-independent retention maintenance for inert connector candidates. */
export const createConnectorCredentialRetentionService = (repository: Readonly<{
  purgeExpiredCredentialCandidates(limit: number): number;
}>) => Object.freeze({
  /** Bounded maintenance tick; it performs no provider or network I/O. */
  runOnce(limit = 25): Readonly<{ removedCandidates: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('connector_credential_cleanup_limit_invalid');
    }
    return Object.freeze({ removedCandidates: repository.purgeExpiredCredentialCandidates(limit) });
  },
});
