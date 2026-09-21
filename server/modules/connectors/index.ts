/**
 * Connectors module barrel (ADR-098).
 *
 * External platforms reached by one nassaj-wide API key. Everything outside this
 * module imports from here, so the split between the registry row (safe to
 * serve) and the encrypted secret (never served) stays an internal detail.
 */
export {
  connectorsService,
  isConnectorCredentialConfigured,
} from './connectors.service.js';
export type { ConnectorStatus, DistributionResult } from './connectors.service.js';
export {
  buildConnectorPlacementInput,
  mcpServerNameFor,
} from './connector-placement-definition.js';
export type {
  NonSecretConnectorPlacementMaterial,
} from './connector-placement-definition.js';
export {
  CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION,
  CONNECTOR_PLACEMENT_HMAC_PREVIOUS_VERSION,
  fingerprintConnectorPlacementAbsence,
  fingerprintConnectorPlacementMaterial,
  verifyConnectorPlacementFingerprint,
} from './connector-placement-material.js';
export type {
  ConnectorPlacementFingerprint,
  ConnectorPlacementFingerprintVerification,
  ConnectorPlacementHmacVersion,
  ConnectorPlacementMaterial,
} from './connector-placement-material.js';
export {
  CONNECTOR_RECONCILER_WRITE_FLAG,
  isConnectorPlacementWriterEnabled,
  runConnectorPlacementWriter,
} from './connector-placement-writer.js';
export type {
  ConnectorPlacementTargetAdapter,
  ConnectorPlacementWriterDeps,
  ConnectorPlacementWriterErrorCode,
  ConnectorPlacementWriterLedger,
  ConnectorPlacementWriterPlan,
  ConnectorPlacementWriterResult,
} from './connector-placement-writer.js';
export { default as connectorsRoutes } from './connectors.routes.js';
export { connectorsOAuthCallbackRoutes } from './connectors.routes.js';
export {
  CONNECTOR_RECONCILER_DRY_RUN_FLAG,
  isConnectorPlacementDryRunEnabled,
  nextPlacementFence,
  runConnectorPlacementDryRun,
  validatePlacementFence,
} from './connector-placement-reconciler.js';
export type {
  ConnectorPlacementDryRunResult,
  PlacementFence,
  PlacementFenceErrorCode,
} from './connector-placement-reconciler.js';
export {
  clearOAuthTokens,
  connectorAuthDir,
  ensureConnectorAuthDir,
  hasOAuthTokens,
} from './connector-oauth.js';

export { safeFetchLocalModelJson, validateLocalModelUrl } from './connector-auth-safe-fetch.js';
