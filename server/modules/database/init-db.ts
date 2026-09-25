import fs from 'node:fs';


import { getConnection, getDatabasePath } from "@/modules/database/connection.js";
import { initializeUniversalConversationShadowRuntime } from '@/modules/conversations/index.js';
import {
    auditParticipantOwnership,
    migrateScheduledMessages,
    pruneAuditLog,
    pruneOrphanSessionRefs,
    migrateSourceUpdateDeferral,
    runMigrations,
} from "@/modules/database/migrations.js";
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
import { migrateConnectorPolicyV2Substrate } from '@/modules/database/connector-policy-v2.migration.js';
import { migrateConnectorProvisioning } from '@/modules/database/connector-provisioning.migration.js';
import { startReconcileScheduler } from "@/modules/database/project-reconcile.service.js";
/* eslint-disable boundaries/dependencies -- post-migration Substrate-Only lifecycle composition. */
import {
    initializeConnectorPolicyV2SubstrateOnly,
    inspectExistingConnectorPolicyV2Substrate,
    runConnectorPolicyV2GuardedBootstrap,
} from '@/modules/connectors/connector-substrate-only.production.js';
/* eslint-enable boundaries/dependencies */
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";
import { sessionWorkspaceModesDb } from '@/modules/database/repositories/session-workspace-modes.db.js';
import { probeSessionWorkspaceAlias } from '@/modules/session-workspaces/index.js';

// eslint-disable-next-line boundaries/no-unknown -- root-verified bootstrap context is a builtins-only authority leaf outside feature modules.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';

import { migrateDocumentShares } from './document-shares.js';
import { migrateDeviceAccountSessions } from './device-account-sessions.migration.js';
import { inspectExistingSecurityState } from './existing-security-state.js';

/** True when a ledger project path still resolves to a real directory. */
const projectPathResolves = (projectPath: string): boolean => {
    try {
        return fs.statSync(fs.realpathSync(projectPath)).isDirectory();
    } catch {
        return false;
    }
};

/**
 * Performs the small, additive schema catch-up permitted after a forward
 * startup admission.  This deliberately does not call `runMigrations`: that
 * legacy pipeline includes rebuilds and nested transactions, neither of which
 * can safely execute inside the short-lived connector writer lease.
 */
export const initializeAdmittedDatabase = (db: ReturnType<typeof getConnection>, authorityRootPath: string): void => {
    inspectExistingSecurityState(db, process.env);
    // A missing or invalid authority is a fail-closed condition.  Validate it
    // before the additive queue migration so an unauthorised boot has no SQL
    // write effect at all.
    inspectExistingConnectorPolicyV2Substrate(db, authorityRootPath);
    migrateAdmittedScheduledMessages(db);
    migrateDeviceAccountSessions(db);
    migrateDocumentShares(db);
    const result = initializeConnectorPolicyV2SubstrateOnly(db, authorityRootPath);
    if (!result.ready) throw new Error(`existing_security_connector_initialization_failed:${result.reason}`);
};

/** The admitted queue migration is intentionally independent of connector fencing/readiness. */
export const migrateAdmittedScheduledMessages = (db: ReturnType<typeof getConnection>): void => {
    migrateScheduledMessages(db);
};

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        const authorityRootPath = `${getDatabasePath()}.connector-runtime-authority.json`;
        if (requireStartupAdmission()) {
            initializeAdmittedDatabase(db, authorityRootPath);
            return;
        }
        runConnectorPolicyV2GuardedBootstrap(db, authorityRootPath, () => {
            // This observation precedes INIT_SCHEMA_SQL. An upgrade always has
            // its legacy users table; only a genuinely fresh database can gain
            // ADR-162 eligibility when its installation id is first created.
            const freshInstallation = db.prepare(`SELECT 1 FROM sqlite_master
                WHERE type='table' AND name='users'`).get() === undefined;
            db.exec(INIT_SCHEMA_SQL);
            console.log('Database schema applied');
            runMigrations(db);
            migrateDeviceAccountSessions(db);
            migrateDocumentShares(db);
            migrateConnectorAuthSchema(db);
            const existingInstallation = db.prepare(`SELECT installation_id AS installationId
                FROM connector_installations WHERE singleton=1`).get() as { installationId: string } | undefined;
            migrateConnectorPolicyV2Substrate(db);
            const createdInstallation = existingInstallation ? undefined : db.prepare(`SELECT installation_id AS installationId
                FROM connector_installations WHERE singleton=1`).get() as { installationId: string } | undefined;
            migrateConnectorProvisioning(db, { newInstallationId: freshInstallation
                ? createdInstallation?.installationId : undefined });
        });
        // Idempotent; the only place it runs when the fence wrapped runMigrations
        // in a transaction (B-1147).
        migrateSourceUpdateDeferral(db);

        // Before readiness, ratchet every alias node that predates this release
        // to overlay. Invalid nodes are deny-fenced too: deleting corruption
        // later must never resurrect legacy shared-cwd eligibility.
        for (const row of sessionWorkspaceModesDb.listLegacySnapshot()) {
            let aliasState: ReturnType<typeof probeSessionWorkspaceAlias>;
            try {
                aliasState = probeSessionWorkspaceAlias({
                    projectPath: row.projectPath,
                    sessionId: row.sessionId,
                });
            } catch (probeError) {
                // A logical project path that no longer resolves cannot be
                // probed at all: deleted projects, wiped /tmp workspaces and
                // synthetic provider sentinels such as '/__antigravity__' are
                // permanently unresolvable, so failing readiness on them
                // bricks every subsequent boot (B-794). ADR-133 forbids
                // booting with an *unclassified* boundary, not with a fenced
                // one — deny-fence the node instead. Fencing is the strictest
                // outcome available and can never resurrect legacy shared-cwd
                // eligibility, which is the invariant the ADR protects.
                // Any other probe failure stays fail-closed as ADR-133 requires.
                if (projectPathResolves(row.projectPath)) throw probeError;
                sessionWorkspaceModesDb.markOverlay(
                    row.sessionId, row.projectPath, row.provider,
                );
                continue;
            }
            // Any node at the deterministic alias path proves this session
            // crossed (or attempted to cross) the overlay boundary. Fence it
            // permanently even when corrupt.
            if (aliasState !== 'absent') {
                sessionWorkspaceModesDb.markOverlay(
                    row.sessionId, row.projectPath, row.provider,
                );
            }
        }

        // Readiness/lifecycle only. The independent installation authority may
        // be created here; provider credentials and activation remain untouched.
        initializeConnectorPolicyV2SubstrateOnly(
            db,
            authorityRootPath,
        );

        // Universal Conversation Phase 0 is strictly opt-in. With the flag off
        // this returns before acquiring a lock or creating any Foundation table.
        initializeUniversalConversationShadowRuntime(db, {
            lockPath: `${getDatabasePath()}.universal-conversations.lock`,
        });

        // One-shot audit_log retention prune (T-182): drop rows older than the
        // 90-day window. Best-effort — a failure here must not block boot.
        pruneAuditLog(db);

        // One-shot orphan prune (B-149): drop message_authors / starred_sessions
        // rows whose session is long gone so those FK-less tables cannot grow
        // unbounded. Best-effort — a failure here must not block boot.
        pruneOrphanSessionRefs(db);

        // Duplicate-owner audit (T-1266). Observes, never blocks — see its doc.
        auditParticipantOwnership(db);

        // Start the project-reconcile scheduler after migrations complete so
        // the boot pass sees a fully migrated schema. (B-38.)
        if (process.env.NASSAJ_UPDATE_MODE !== 'local-main') startReconcileScheduler();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
