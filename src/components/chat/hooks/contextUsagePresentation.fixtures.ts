/** Native snapshot fixture for display provenance and boundary tests. */
export const nativeSnapshot = (overrides: Record<string, unknown> = {}) => ({
  version: 1, provider: 'codex', sessionId: 's1', modelId: 'm1',
  usedTokens: 120_000, windowTokens: 240_000, usageKind: 'native_reported_context',
  source: 'native.control', observedAt: '2026-09-13T12:00:00Z',
  nativeCompactTokens: 200_000, proposedCompactTokens: 120_000, newSessionTokens: null,
  ...overrides,
});
