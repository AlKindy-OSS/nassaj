/**
 * Audit log repository.
 *
 * Append-only store of security-relevant auth events (login success/failure,
 * invite created/accepted/revoked, bootstrap, user disabled, etc.).
 *
 * IMPORTANT: never pass passwords, JWTs, or raw PII into `metadata`. Callers
 * must sanitize before recording. `metadata` is stored as a JSON string.
 */

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type AuditAction =
  | 'local_models_settings_updated'
  | 'local_model_server_changed'
  | 'document_share_created'
  | 'document_share_updated'
  | 'document_share_revoked'
  | 'session_permanently_deleted'
  | 'project_permanently_deleted'
  | 'project_manually_readded'
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'auth_rejected'
  | 'token_refresh'
  | 'bootstrap_owner'
  | 'invite_created'
  | 'invite_accepted'
  | 'invite_revoked'
  | 'invite_rejected'
  | 'user_disabled'
  | 'user_enabled'
  | 'user_deleted'
  | 'role_changed'
  | 'insufficient_role'
  | 'participants_backfilled'
  | 'user_dirs_provisioned'
  | 'password_changed'
  | 'username_changed'
  | 'password_reset'
  | 'avatar_updated'
  | 'admin_provider_sharing_update'
  // T-1675: user-to-user credential delegation. A grant lets another member
  // spend the owner's subscription, so both ends of its life are recorded —
  // who offered it to whom, and who ended it. Metadata carries ids only.
  | 'credential_grant_created'
  | 'credential_grant_revoked'
  | 'credential_grant_declined'
  | 'credential_grant_accepted'
  | 'system_restart_triggered'
  | 'server_action_requested'
  | 'server_action_dismiss'
  // ADR-156 WI-2 (ت-2): an update job was refused a restart row because one on
  // the same build fingerprint belongs to someone else. The boolean the
  // updater sees cannot say WHICH conflict it was, and "restart_queue_failed"
  // with no further detail is what made B-1056 take manual forensics; the
  // distinct code lives here. Metadata carries ids only.
  | 'server_action_queue_refused'
  | 'command_board_config_updated'
  | 'command_board_custom_updated'
  | 'command_board_raw_exec'
  | 'passkey_registered'
  | 'passkey_removed'
  // ADR-098 (T-1228): external platform connectors. A connector's key is
  // nassaj-wide, so the questions asked afterwards are "who added this
  // platform" and "when was the key last rotated" — rotation being the only
  // effective revocation. Metadata carries the connector id and service only,
  // never key material.
  | 'connector_created'
  | 'connector_key_set'
  | 'connector_removed'
  | 'connector_reconcile_requested'
  // ADR-098 rev3: an OAuth connector linked through the browser. Recorded
  // because the grant is a standing permission on the member's own platform
  // account — "when did I authorise nassaj" is the question a member asks when
  // they see it listed in Canva's connected-apps screen. Metadata carries the
  // connector id only; the tokens never come near this log.
  | 'connector_oauth_linked'
  // ADR-102 (T-1242): the owner opening or closing programmatic access
  // (`POST /api/agent`). That surface runs an agent with bypassPermissions
  // behind a permanent key, so the flip itself is a security event — metadata
  // carries the new boolean only, never a key.
  | 'external_api_toggled'
  // ADR-093 §4 (T-1197): ربط محرّك بمادة حوكمة نسّاج من الواجهة. كتابةٌ على
  // مادةٍ يقرؤها حارس الإطلاق الحاجب، فتُسجَّل بمن فعلها وأي مزوّد وأي نطاق.
  | 'governance_link'
  | 'reference_material_create_intent'
  | 'reference_material_update_intent'
  | 'reference_material_created'
  | 'reference_material_updated'
  // Owner decision 2026-08-08: the per-engine governance switch. `granted` is
  // the security event proper — an owner/admin removed nassaj's instructions
  // from one member's engine home, so that member's turns now run in the
  // vendor's default posture, and the deleted material leaves NO trace on disk
  // by design. Without this row the change is unreconstructable. `revoked` is
  // recorded too, and not for symmetry: it is what proves an engine was put
  // BACK under governance at a given moment, which is the question asked after
  // an incident ("was this session governed when it ran?"). Metadata carries
  // the engine id, the affected member, the actor's role and the material paths
  // touched — never file content.
  | 'governance_exemption_granted'
  | 'governance_exemption_revoked'
  // ADR-088 engine-pin decisions (B-258): a deliberate widening of this table
  // beyond auth events — routing a user's payload to a provider they did not
  // choose IS security-relevant. Metadata carries session id, stored/client
  // engine ids and the decision only; NEVER a key, token, or base URL.
  | 'engine_pin_decision'
  // MCP registrations (T-1177): a definition is executable, and members may now
  // register one on a per-user provider. Metadata carries provider/scope/name and
  // the command+args that make it security-relevant — never `env` or `headers`,
  // which hold tokens.
  | 'mcp_server_upsert'
  | 'mcp_server_remove'
  // B-421: a resume replayed a transcript block whose id the Anthropic API
  // rejects, written by a vendor engine using ITS id convention. The repair is
  // silent by design (fail-open), so WITHOUT this row a second occurrence under
  // a different field would again be discovered only by a user's dead session.
  // Metadata carries the engine id, block types and tool names — never content.
  | 'transcript_block_repaired'
  // ADR-099/T-1237: the session owner re-stamped the engine mid-conversation.
  // This row is the ONLY durable proof that the export acknowledgement was given
  // before a vendor-pinned history was replayed to a different company — the
  // decision to allow the switch at all rests on that consent, so a consent that
  // leaves no trace would leave the decision unauditable. Metadata carries the
  // from/to engine ids, the turn count exported and the ack flag — never content.
  | 'engine_restamped'
  // ADR-101/T-1374: personal Qwen Coding Plan execution gate. Metadata records
  // only the execution class, owner bindings, gesture age and decision; never
  // the gesture token, API key, prompt, response or environment.
  | 'qwen_execution_allowed'
  | 'qwen_execution_rejected'
  | 'qwen_credential_set'
  | 'qwen_credential_deleted'
  // Cross-home Codex continuation: records parent/child lineage and bounded
  // context counts only; conversation content is never written to the audit log.
  | 'codex_session_branch'
  // ADR-103/T-1246: accurate voice transcription (Whisper) behind the operator's
  // own key. Three security-relevant facts and nothing else: who moved the
  // install-wide switch or endpoint, whose key was stored/removed and at which
  // SCOPE (system = every member spends it), and that a transcription happened.
  // Metadata NEVER carries the key, the audio, or the transcribed text.
  | 'voice_transcription_settings_updated'
  | 'voice_transcription_key_set'
  | 'voice_transcription_key_removed'
  | 'voice_transcription_used'
  // OIDC Relying Party flow (P-IDP-3, ADR-046).
  | 'oidc_login'
  | 'oidc_backchannel_logout'
  | 'oidc_identity_linked'
  | 'oidc_identity_unlinked'
  // Local role changed by an external attestation (ADR-069 mapper). Metadata is
  // { provider, from, to } only — never the subject or the raw claim.
  | 'external_role_synced'
  | 'scheduled_message_created'
  | 'scheduled_message_updated'
  | 'scheduled_message_cancelled'
  | 'scheduled_message_dispatched'
  | 'scheduled_message_failed';

/**
 * Hard cap on the stored User-Agent string (T-182). UA headers can be long and
 * are attacker-controlled, so we truncate to bound the row size; the prefix is
 * sufficient for forensic correlation.
 */
const MAX_USER_AGENT_LEN = 512;

type AuditLogRow = {
  id: number;
  user_id: number | null;
  action: string;
  metadata: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

type AuditOptions = {
  userId?: number | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const insertAuditEvent = (action: AuditAction, options: AuditOptions, db: Database.Database = getConnection()): void => {
  const metadataJson = options.metadata === undefined ? null : JSON.stringify(options.metadata);
  const userAgent = typeof options.userAgent === 'string'
    ? options.userAgent.slice(0, MAX_USER_AGENT_LEN)
    : null;
  db.prepare(
    'INSERT INTO audit_log (user_id, action, metadata, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(options.userId ?? null, action, metadataJson, options.ipAddress ?? null, userAgent);
};

export const auditLogDb = {
  /**
   * Records an audit event. Never throws — auditing must not break the request
   * path. `metadata` is JSON-stringified; pass only non-sensitive fields.
   */
  record(
    action: AuditAction,
    options: AuditOptions = {}
  ): void {
    try {
      insertAuditEvent(action, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to write audit log', { action, error: message });
    }
  },

  /**
   * Security-sensitive pre-commit audit. Unlike `record`, a storage failure is
   * propagated so the caller can refuse the filesystem mutation. Use only when
   * an unaudited successful write is worse than a failed request.
   */
  recordStrict(action: AuditAction, options: AuditOptions = {}): void {
    insertAuditEvent(action, options);
  },

  /** Returns the most recent audit entries (newest first), capped by limit. */
  recent(limit = 100): AuditLogRow[] {
    const db = getConnection();
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    return db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as AuditLogRow[];
  },
};

/** Strict audit on the caller's exact synchronous transaction; never opens another connection. */
export function recordStrictAuditOnConnection(db: Database.Database, action: AuditAction, options: AuditOptions = {}): void {
  if (!db.inTransaction) throw new Error('AUDIT_TRANSACTION_REQUIRED');
  insertAuditEvent(action,options,db);
}
