/**
 * ADR-216 §3.5 — the writer side of `doctor --attach-release-branch` and
 * `doctor --revert-release-attach`, kept out of doctor.mjs like
 * doctor-reopen-gate.mjs so that file keeps its structural read-only contract.
 *
 * Both take the same non-blocking `source-attach.lock` and the same exclusive
 * source-ref lease as the server operation. The database is opened READ-ONLY:
 * an unfinished update job or a prestage slot refuses the action after the
 * lease is held (§3.2). Without `confirmed` nothing is fetched or written.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { resolveDatabaseFilePath } from '../../server/modules/database/database-path.js';
import { resolveReleaseSource } from '../../server/services/release-source-config.js';
import { defaultSourceUpdateControlRoot } from '../../server/services/source-updater.js';
import {
    readPrestageSlotState, releasePolicyRequiresVerification, verifySignedReleasePort,
} from '../../server/services/update-prestager.js';

import {
    ATTACH_RECEIPT_DIR, acquireSourceAttachLock, attachFetchDeadlineMs, createAttachGit, evaluateAttachQuiescence, inspectReleaseCheckout,
    revertReleaseAttachment, runReleaseAttachment,
} from './release-branch-attach.mjs';

/** app_config key of the owner's prestage setting (update-prestage-settings.js PRESTAGE_SETTINGS_KEY). */
export const PRESTAGE_SETTINGS_KEY = 'update_prestage_settings';

/** The unfinished job states (source-update-jobs.db.ts SOURCE_UPDATE_ACTIVE_STATES). */
export const UNFINISHED_JOB_STATES = Object.freeze([
    'awaiting_sessions', 'accepted', 'resolving', 'resolved', 'downloading', 'archive_verified',
    'extracting', 'staging', 'candidate_sealed', 'restart_queued', 'activating',
    'runtime_verifying', 'rollback_pending',
]);

/** `YYYY-MM-DD HH:MM:SS` (UTC), the shape SQLite's CURRENT_TIMESTAMP writes. */
function sqliteTimestamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) throw new Error('timestamp_invalid');
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Run one read against the job table, READ-ONLY. A missing database or table is
 * a node that never ran an update (`fallback`); any other failure is `null`, so
 * the caller fails closed.
 */
function queryJobs(databasePath, sql, params, fallback) {
    return withReadOnlyTable(databasePath, 'source_update_jobs', (db) => Boolean(db.prepare(sql).get(...params)), fallback);
}

/** Run `read` on a READ-ONLY handle; a missing file or table is `fallback`, any failure `null`. */
function withReadOnlyTable(databasePath, table, read, fallback) {
    if (!fs.existsSync(databasePath)) return fallback;
    let db;
    try {
        db = new Database(databasePath, { readonly: true, fileMustExist: true });
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return fallback;
        return read(db);
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* read-only handle */ }
    }
}

/**
 * The owner's stored prestage setting, read READ-ONLY (qa M5), parsed as
 * readStoredPrestageSettings parses it (`update-prestage-settings.js`; that
 * module needs the server's database layer, so it is not imported here).
 * `null` when it cannot be read: the server then also falls back to `null`.
 */
export function readStoredPrestageSettingsReadOnly(databasePath) {
    const raw = withReadOnlyTable(databasePath, 'app_config',
        (db) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(PRESTAGE_SETTINGS_KEY)?.value ?? '', '');
    if (raw === null) return null;
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    const hours = parsed?.prestageQuarantineHours;
    return {
        prestageEnabled: typeof parsed?.prestageEnabled === 'boolean' ? parsed.prestageEnabled : true,
        prestageQuarantineHours: Number.isInteger(hours) && hours >= 0 && hours <= 168 ? hours : 0,
    };
}

/** The `verified` policy for the CLI paths: env over the owner's stored setting, as the server decides it. */
export function cliRequiresVerifiedRelease(env, databasePath) {
    return releasePolicyRequiresVerification(env, readStoredPrestageSettingsReadOnly(databasePath));
}

/** The raw maintenance journal (null when never created), or an unreadable marker. */
function readJournalFile(controlRoot) {
    try { return JSON.parse(fs.readFileSync(path.join(controlRoot, 'journal.json'), 'utf8')); } catch (error) {
        return error?.code === 'ENOENT' ? null : { state: 'UNREADABLE' };
    }
}

/** L7 for the CLI paths (§3.2): journal, unfinished jobs (read-only DB), prestage slot. */
export function createCliQuiescenceReader({ controlRoot, databasePath }) {
    const placeholders = UNFINISHED_JOB_STATES.map(() => '?').join(',');
    return async () => ({
        journal: readJournalFile(controlRoot),
        unfinishedJobs: queryJobs(databasePath,
            `SELECT 1 FROM source_update_jobs WHERE state IN (${placeholders}) LIMIT 1`, UNFINISHED_JOB_STATES, false),
        prestageState: readPrestageSlotState(controlRoot),
    });
}

/** The `jobs` port of revertReleaseAttachment for the CLI. */
export function createCliRevertJobs({ controlRoot, databasePath }) {
    return {
        createdSince: (iso) => queryJobs(databasePath,
            'SELECT 1 FROM source_update_jobs WHERE created_at >= ? LIMIT 1', [sqliteTimestamp(iso)], false),
        prestageSlotExists: () => readPrestageSlotState(controlRoot) !== null,
    };
}

/** The node facts every CLI path needs, resolved once from the service environment. */
export function resolveAttachContext({ appRoot, env = process.env }) {
    const controlRoot = defaultSourceUpdateControlRoot(appRoot);
    return {
        appRoot, env, controlRoot,
        remote: env.NASSAJ_UPDATE_REMOTE || 'origin',
        branch: env.NASSAJ_UPDATE_BRANCH || 'main',
        databasePath: resolveDatabaseFilePath(env),
        git: createAttachGit({ appRoot, env }),
    };
}

/** The gate's lease, constructed lazily so the attach lock is always taken first. */
function leaseAcquirer(appRoot, gateModule) {
    return async (options) => {
        const module = gateModule || await import('../../server/services/update-maintenance-gate.js');
        return module.createUpdateMaintenanceGate({ projectPath: appRoot }).acquireExclusiveSourceRefLease(options);
    };
}

/**
 * `doctor --attach-release-branch [--yes]`. Without `confirmed` it inspects
 * only (no network, no write) and returns the plan.
 * @returns {Promise<{applied: boolean, inspection: object, result: object|null}>}
 */
export async function runDoctorAttach({ appRoot, env = process.env, confirmed = false, gateModule = null }) {
    const context = resolveAttachContext({ appRoot, env });
    const inspection = await inspectReleaseCheckout(context);
    if (!confirmed || !inspection.eligible) return { applied: false, inspection, result: null };
    const source = resolveReleaseSource(env, { lockPath: path.join(appRoot, 'config', 'release-source.lock.json') });
    const result = await runReleaseAttachment({
        ...context,
        configuredRemoteUrl: source.repositoryUrl,
        acquireLease: leaseAcquirer(appRoot, gateModule),
        readQuiescence: createCliQuiescenceReader(context),
        deadlineMs: attachFetchDeadlineMs(env),
        verifySignedRelease: verifySignedReleasePort,
        requireVerified: cliRequiresVerifiedRelease(env, context.databasePath),
    });
    return { applied: result.ok, inspection, result };
}

/**
 * `doctor --revert-release-attach <receipt> --yes`: the inverse of an apply,
 * under the attach lock and the exclusive lease, refused after any update.
 * @returns {Promise<{applied: boolean, code: string|null}>}
 */
export async function runDoctorRevert({ appRoot, env = process.env, receiptPath, confirmed = false, gateModule = null }) {
    if (!confirmed) return { applied: false, code: 'confirmation_required' };
    const context = resolveAttachContext({ appRoot, env });
    let lock;
    try { lock = acquireSourceAttachLock(context.controlRoot); } catch (error) {
        return { applied: false, code: error.code || 'source_attach_lock_unavailable' };
    }
    try {
        let lease;
        try { lease = await leaseAcquirer(appRoot, gateModule)({ kind: 'source-attach-revert' }); } catch (error) {
            const code = ['source_attach_writers_active', 'unsupported_install_mode'].includes(error?.message)
                ? error.message : 'update_maintenance_active';
            return { applied: false, code };
        }
        try {
            const quiet = evaluateAttachQuiescence(await createCliQuiescenceReader(context)());
            if (quiet) return { applied: false, code: quiet };
            const result = await revertReleaseAttachment({
                receiptPath: path.resolve(receiptPath), receiptDir: path.join(context.controlRoot, ATTACH_RECEIPT_DIR),
                git: context.git, lease, jobs: createCliRevertJobs(context),
            });
            return { applied: result.ok, code: result.code, failures: result.failures, receiptWriteFailed: result.receiptWriteFailed === true };
        } finally {
            lease.release();
        }
    } finally {
        lock.release();
    }
}
