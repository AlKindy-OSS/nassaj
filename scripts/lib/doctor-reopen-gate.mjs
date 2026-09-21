/**
 * ADR-156 ب.6 / WI-14 (T-1729) — the ONE writer action `scripts/doctor.mjs` has.
 *
 * On 2026-09-11 the gate was reopened by hand, with a throwaway script editing
 * `journal.json` (`gate-open-20260911.mjs`). That is what this replaces: the
 * same ب.5 exit path the server takes automatically, reachable from the command
 * line when the server cannot boot — and nothing else.
 *
 * The writes live HERE, not in doctor.mjs, so that file keeps its structural
 * READ-ONLY contract: every writer primitive is in this module, behind an
 * explicit `confirmed` flag, and behind a journal copy taken before anything is
 * touched. Without `confirmed` this module reads and plans only.
 */
import fs from 'node:fs';
import path from 'node:path';

const WAIT_MS = 30_000;

/**
 * Copy the maintenance journal into `.artifacts/` before the gate is touched.
 * A reopen is a production write on a node that is already sick; the operator
 * must be able to see exactly what the journal said beforehand.
 */
export function backupJournal(journalPath, artifactsRoot, stamp = new Date().toISOString()) {
    const bytes = fs.readFileSync(journalPath);
    fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
    const file = path.join(artifactsRoot, `reopen-gate-${stamp.replace(/[:.]/g, '-')}-journal.json`);
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return file;
}

/**
 * Plan, and only on an explicit confirmation apply, the ب.5 reopen — or, with
 * `completeSourceRollback`, the exit path a degraded reopen names: returning
 * the source tree to its original commit (qa-critic H3). Both are the same
 * governed write action under the same consent rules; only the gate operation
 * differs, and both run under the gate's own write contract.
 *
 * @param {object} options
 * @param {string} options.appRoot        The install to act on.
 * @param {boolean} options.confirmed     `--yes`: the explicit permission to write.
 * @param {string} options.artifactsRoot  Where the pre-touch journal copy lands.
 * @param {boolean} [options.completeSourceRollback] Finish the source rollback of a degraded gate.
 * @param {object} [options.gateModule]   Injected for tests; the real gate otherwise.
 * @returns {Promise<{applied: boolean, plan: object, backupPath: string|null, result: object|null}>}
 */
export async function runReopenGate({
    appRoot, confirmed = false, artifactsRoot, gateModule = null, waitMs = WAIT_MS, completeSourceRollback = false,
}) {
    const module = gateModule || await import('../../server/services/update-maintenance-gate.js');
    const gate = module.createUpdateMaintenanceGate({ projectPath: appRoot });
    const operation = completeSourceRollback
        ? (options) => gate.completeSourceRollback(options)
        : (options) => gate.reopenOnPreviousGeneration(options);
    // The plan is always produced first, and always from the same code path that
    // would apply it — a plan derived from a second implementation would be a
    // description of something else.
    const plan = await operation({ waitMs });
    if (!confirmed || !plan.to) return { applied: false, plan, backupPath: null, result: null };
    const backupPath = backupJournal(gate.paths.journal, artifactsRoot);
    const result = await operation({ waitMs, dryRun: false });
    return { applied: result.applied === true, plan, backupPath, result };
}
