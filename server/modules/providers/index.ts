export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { participantsService } from './services/participants.service.js';

// ج1: composition-root seam for the read-only session-activity route. The app
// entry injects the provider liveness probes it already owns; nothing else in
// the module may set them.
export { setSessionLivenessProbes } from './services/session-activity.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// ADR-037: per-spawn vendor-delegate MCP builder. Re-exported from the module
// barrel so cross-module consumers (e.g. the isolation seam tests) depend on the
// public entry point rather than reaching into module internals.
export { buildVendorDelegateMcp } from './shared/vendor/vendor-delegate-mcp.js';

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
