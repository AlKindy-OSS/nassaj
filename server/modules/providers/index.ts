export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export {
  providerGovernanceService,
  type ProviderGovernanceChannel,
} from './services/provider-governance.service.js';
export { resolveCodexHomeForUser } from './list/codex/codex-home.js';
export { ensureCodexGovernance } from './list/codex/codex-governance.js';
export { CodexSessionsProvider } from './list/codex/codex-sessions.provider.js';
export { codexReceiptPayloadHash } from './list/codex/codex-receipt-proof.js';
export { participantsService } from './services/participants.service.js';
export { providerModelsService } from './services/provider-models.service.js';
export { providerAuthService } from './services/provider-auth.service.js';
export { providerSecretsService } from './services/provider-secrets.service.js';

// ج1: composition-root seam for the read-only session-activity route. The app
// entry injects the provider liveness probes it already owns; nothing else in
// the module may set them.
export { setSessionLivenessProbes } from './services/session-activity.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
export { notifySessionMetadataChanged } from './services/sessions-watcher.service.js';
export { default as providerRoutes } from './provider.routes.js';

// T-1090: branches a session (plus the `/btw` exchange) into a new one. Exported
// through the barrel so the composition root can inject it into the WS layer
// without the chat handler importing the watcher/synchronizer graph directly.
export {
  forkSessionAtMessage,
  forkSessionFromSideQuery,
  SessionForkError,
  type ForkSessionResult,
} from './services/session-fork.service.js';

// ADR-037: per-spawn vendor-delegate MCP builder. Re-exported from the module
// barrel so cross-module consumers (e.g. the isolation seam tests) depend on the
// public entry point rather than reaching into module internals.
export { buildVendorDelegateMcp } from './shared/vendor/vendor-delegate-mcp.js';
export {
  appendVendorTranscriptTurnIdempotent,
  appendVendorTranscriptEventIdempotent,
  vendorTranscriptPath,
  writeVendorTranscriptMeta,
} from './shared/vendor/vendor-transcript.js';
export { VENDOR_RUNTIME } from './shared/vendor/vendor-config.js';
// ADR-098: the connectors module fans one MCP registration across engines, so it
// needs both the target split and the add/remove sweeps.
export { providerMcpService } from './services/mcp.service.js';
export type { ConnectorTargetAdapter } from './services/mcp.service.js';

// ADR-078: the cost surface, for cross-module consumers. The projects module
// prices a PROJECT (/api/projects/:projectId/cost|stats), so it needs the
// ledger, the price date that stamps every amount, and the vendor label map —
// and `boundaries/dependencies` allows a module to be reached only through this
// barrel. Re-exporting the three keeps the pricing engine itself internal:
// consumers get the ledger's answers, never its file walkers or its cache.
//
// `PRICES_AS_OF` is deliberately part of the public surface: every amount this
// module produces is dated, and a consumer that could not read the date could
// not honour that rule.
export {
  costLedgerService,
  startCostLedgerScheduler,
  stopCostLedgerScheduler,
} from './services/cost/cost-ledger.service.js';
export { PRICES_AS_OF } from './services/cost/model-pricing.js';
export { vendorDisplayName, type VendorKey } from './services/cost/model-vendor.js';

// ADR-099: the session authorization predicate, for cross-module callers (and
// the mandate's own test). Exported through the barrel because the three modes
// it arbitrates — read / write / restamp — are a public contract: 'restamp' is
// narrower than 'write' on purpose, and a consumer that reached past the barrel
// could pick the wrong one without the doc that explains why they differ.
export { isSessionAccessibleByUser, assertSessionAccessible } from './services/sessions.service.js';

// ADR-099: the composition root injects the live-run probe the re-stamp route
// consults. Exported here because the root may only reach a module through it.
export {
  isEngineRestampReserved,
  releaseEngineRestamp,
  reserveEngineRestamp,
  setEngineSwitchLivenessProbe,
} from './services/engine-switch-liveness.service.js';
export {
  ENGINE_RESTAMP_MODEL_STORE_LIMITS,
  EngineRestampStoreError,
  withEngineRestampModelStoreBoundary,
  type EngineRestampModelStoreBoundary,
  type EngineRestampModelStoreMutation,
  type EngineRestampStoreOwner,
} from './services/engine-restamp-model-store.service.js';
export { readProjectSkills } from './services/skill-observations.service.js';

// B-894: authenticated complete-payload receipt capability, never raw provider metadata.
export { createVendorReceiptInvocation, readVendorReceiptInvocation } from './shared/vendor/vendor-receipt-identity.js';
