export { initializeDatabase } from '@/modules/database/init-db.js';
export {
  reconcileProjects,
  startReconcileScheduler,
  stopReconcileScheduler,
} from '@/modules/database/project-reconcile.service.js';
export type { ReconcileResult } from '@/modules/database/project-reconcile.service.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { auditLogDb } from '@/modules/database/repositories/audit-log.js';
export { invitesDb } from '@/modules/database/repositories/invites.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { hashMessageAuthorContent, messageAuthorsDb } from '@/modules/database/repositories/message-authors.db.js';
export type { MessageAuthorRow } from '@/modules/database/repositories/message-authors.db.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export { pendingServerActionsDb } from '@/modules/database/repositories/pending-server-actions.db.js';
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
export { projectMembersDb } from '@/modules/database/repositories/project-members.db.js';
export type { ProjectMemberRole, ProjectMemberRow } from '@/modules/database/repositories/project-members.db.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { sessionAgentsDb } from '@/modules/database/repositories/session-agents.db.js';
export type { AgentKind, SessionAgentRow } from '@/modules/database/repositories/session-agents.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';
export { starredSessionsDb } from '@/modules/database/repositories/starred-sessions.db.js';
export type { StarredSessionRow } from '@/modules/database/repositories/starred-sessions.db.js';
export { closedSessionsDb } from '@/modules/database/repositories/closed-sessions.db.js';
export type { ClosedSessionRow } from '@/modules/database/repositories/closed-sessions.db.js';
export { uiPreferencesDb } from '@/modules/database/repositories/ui-preferences.js';
export type { UiPreferences } from '@/modules/database/repositories/ui-preferences.js';
export { userDb } from '@/modules/database/repositories/users.js';
export { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
export type { UserIdentityRow } from '@/modules/database/repositories/user-identities.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';
export type {
  WebAuthnCredentialRow,
  WebAuthnCredentialSummary,
} from '@/modules/database/repositories/webauthn-credentials.js';
