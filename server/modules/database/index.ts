export { initializeDatabase } from '@/modules/database/init-db.js';
export { migratePermissionExecution } from '@/modules/database/permission-execution.migration.js';
export { migrateScheduledMessages } from '@/modules/database/migrations.js';
export {
  reconcileProjects,
  startReconcileScheduler,
  stopReconcileScheduler,
} from '@/modules/database/project-reconcile.service.js';
export type { ReconcileResult } from '@/modules/database/project-reconcile.service.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { ApiKeyInputError, apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { auditLogDb } from '@/modules/database/repositories/audit-log.js';
export { invitesDb } from '@/modules/database/repositories/invites.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { connectorsDb } from '@/modules/database/repositories/connectors.db.js';
export {
  connectorPlacementsDb,
  createConnectorPlacementsDb,
} from '@/modules/database/repositories/connector-placements.db.js';
export type {
  ConnectorPlacementKey,
  ConnectorPlacementLease,
  ConnectorPlacementPublicTargetStatus,
  ConnectorPlacementStatus,
} from '@/modules/database/repositories/connector-placements.db.js';
export {
  connectorOAuthPendingDb,
  createConnectorOAuthPendingDb,
} from '@/modules/database/repositories/connector-oauth-pending.db.js';
export type { OAuthPendingEnvelope } from '@/modules/database/repositories/connector-oauth-pending.db.js';
export { migrateConnectorOAuthPending } from '@/modules/database/migrations.js';
export type {
  ConnectorRow,
  ConnectorTransport,
  CreateConnectorInput,
} from '@/modules/database/repositories/connectors.db.js';
export { governanceExemptionsDb } from '@/modules/database/repositories/governance-exemptions.db.js';
export { credentialGrantsDb } from '@/modules/database/repositories/credential-grants.db.js';
export type { CredentialGrantRow } from '@/modules/database/repositories/credential-grants.db.js';
export type { GovernanceExemptionRow } from '@/modules/database/repositories/governance-exemptions.db.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { hashMessageAuthorContent, messageAuthorsDb } from '@/modules/database/repositories/message-authors.db.js';
export type { MessageAuthorRow } from '@/modules/database/repositories/message-authors.db.js';
export { messageCoordinationDb } from '@/modules/database/repositories/message-coordination.db.js';
export type { MessageCoordinationRow, StoredCoordinationLevel } from '@/modules/database/repositories/message-coordination.db.js';
export { responseTurnMetricsDb } from '@/modules/database/repositories/response-turn-metrics.db.js';
export type { ResponseTurnMetric } from '@/modules/database/repositories/response-turn-metrics.db.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export { pendingServerActionsDb, RESTART_DEFERRAL_REASON_CODES } from '@/modules/database/repositories/pending-server-actions.db.js';
export { sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint } from '@/modules/database/repositories/source-update-jobs.db.js';
export type { SourceUpdateState, SourceUpdateStrategy } from '@/modules/database/repositories/source-update-jobs.db.js';
export type {
  InsertPendingServerAction,
  PendingServerActionRow,
  PendingServerActionStatus,
} from '@/modules/database/repositories/pending-server-actions.db.js';
export { participantsDb } from '@/modules/database/repositories/participants.db.js';
export type { ParticipantRole, SessionParticipantRow } from '@/modules/database/repositories/participants.db.js';
export { projectCostLedgerDb } from '@/modules/database/repositories/project-cost-ledger.db.js';
export type {
  LedgerDailyRow,
  LedgerGroupRow,
  LedgerRowInput,
  LedgerSourceWatermark,
  LedgerTokenTotals,
  LedgerTotals,
  ProjectScope,
} from '@/modules/database/repositories/project-cost-ledger.db.js';
export { usageIngestionDb, MAX_USAGE_PARTIAL_TAIL_BYTES } from '@/modules/database/repositories/usage-ingestion.db.js';
export type {
  AdvanceUsageCheckpoint,
  CreateUsageCheckpoint,
  ConversationUsageFact,
  UsageAttributionKind,
  UsageAttributionScope,
  UsageBackfillStatus,
  UsageBackfillGeneration,
  UsageCheckpointStatus,
  UsageDurationEventInput,
  UsageRequestEventInput,
  UsageSourceCheckpoint,
  UsageSourceLinkInput,
} from '@/modules/database/repositories/usage-ingestion.db.js';
export { conversationUsageSnapshotsDb } from '@/modules/database/repositories/conversation-usage-snapshots.db.js';
export type {
  ConversationUsageSnapshot,
  ConversationUsageSnapshotInput,
  ConversationUsageSnapshotKey,
  ConversationUsageSnapshotStatus,
} from '@/modules/database/repositories/conversation-usage-snapshots.db.js';
export { projectMembersDb } from '@/modules/database/repositories/project-members.db.js';
export type { ProjectMemberRole, ProjectMemberRow } from '@/modules/database/repositories/project-members.db.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { providerRunFailuresDb } from '@/modules/database/repositories/provider-run-failures.db.js';
export type { ProviderRunFailureRow } from '@/modules/database/repositories/provider-run-failures.db.js';
export { sessionAgentsDb } from '@/modules/database/repositories/session-agents.db.js';
export type { AgentKind, SessionAgentRow } from '@/modules/database/repositories/session-agents.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scheduledMessagesDb } from '@/modules/database/repositories/scheduled-messages.db.js';
export type { ScheduledMessage, ScheduledMessageOptions, ScheduledMessageStatus } from '@/modules/database/repositories/scheduled-messages.db.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { sessionWorkspaceModesDb } from '@/modules/database/repositories/session-workspace-modes.db.js';
export type { SessionWorkspaceModeRow } from '@/modules/database/repositories/session-workspace-modes.db.js';
export { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';
export { starredSessionsDb } from '@/modules/database/repositories/starred-sessions.db.js';
export type { StarredSessionRow } from '@/modules/database/repositories/starred-sessions.db.js';
export { closedSessionsDb } from '@/modules/database/repositories/closed-sessions.db.js';
export {
  sessionTombstonesDb,
  SessionTombstonedError,
} from '@/modules/database/repositories/session-tombstones.db.js';
export { sessionOutcomesDb } from '@/modules/database/repositories/session-outcomes.db.js';
export type { SessionOutcomeRow } from '@/modules/database/repositories/session-outcomes.db.js';
export type { ClosedSessionRow } from '@/modules/database/repositories/closed-sessions.db.js';
export { uiPreferencesDb } from '@/modules/database/repositories/ui-preferences.js';
export type { UiPreferences } from '@/modules/database/repositories/ui-preferences.js';
export { userDb } from '@/modules/database/repositories/users.js';
export type { UserRole } from '@/modules/database/repositories/users.js';
export {
  blockPermissionGeneration,
  BOOT_ID_UNAVAILABLE,
  claimPermissionLease,
  countPermissionGenerationBlocks,
  createPermissionAdmission,
  digestPermissionWorkspace,
  fencePermissionEffectScopeForDecision,
  finishPermissionTransition,
  listPermissionEffectFences,
  markPermissionEffectStarted,
  permissionUserProviderPurposeKey,
  resolvePermissionEffectScope,
  PermissionStateConflictError,
  preparePermissionTransition,
  readPermissionRolloutState,
  reconcileExpiredPermissionExecutions,
  recordPermissionDenial,
  settlePermissionEffect,
  settlePermissionNotStarted,
} from '@/modules/database/repositories/permission-execution.js';
export type {
  CreatePermissionAdmission,
  PermissionChildIdentity,
  PermissionEffectFenceScope,
  PermissionEffectFootprint,
  PermissionPurpose,
  PermissionReconciliationSummary,
  PermissionRolloutProfile,
  PermissionRolloutState,
  PermissionTerminalOutcome,
} from '@/modules/database/repositories/permission-execution.js';
export { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
export type { UserIdentityRow } from '@/modules/database/repositories/user-identities.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';
export type {
  WebAuthnCredentialRow,
  WebAuthnCredentialSummary,
} from '@/modules/database/repositories/webauthn-credentials.js';

export { localModelServersDb } from './repositories/local-model-servers.js';
export type { LocalModel, LocalModelServer } from './repositories/local-model-servers.js';
