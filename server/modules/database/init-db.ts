import { getConnection } from "@/modules/database/connection.js";
import {
    pruneAuditLog,
    pruneOrphanSessionRefs,
    runMigrations,
} from "@/modules/database/migrations.js";
import { startReconcileScheduler } from "@/modules/database/project-reconcile.service.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);

        // One-shot audit_log retention prune (T-182): drop rows older than the
        // 90-day window. Best-effort — a failure here must not block boot.
        pruneAuditLog(db);

        // One-shot orphan prune (B-149): drop message_authors / starred_sessions
        // rows whose session is long gone so those FK-less tables cannot grow
        // unbounded. Best-effort — a failure here must not block boot.
        pruneOrphanSessionRefs(db);

        // Start the project-reconcile scheduler after migrations complete so
        // the boot pass sees a fully migrated schema. (B-38.)
        startReconcileScheduler();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
