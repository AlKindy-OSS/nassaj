#!/usr/bin/env node
// upgrade-path-probe.mjs — one leg of the upgrade-path gate (B-1584).
//
// This file is run by scripts/lib/upgrade-path-gate.mjs as a child process whose
// working directory is ONE installed release tree (the previous tag or the
// candidate), under `node --import tsx`. It imports that tree's OWN modules by
// absolute path, so the code under test is the release's real code, never this
// checkout's. It only imports node builtins itself, so it runs unchanged against
// any tree.
//
// Roles (spec.role):
//   write     — the tree's real durable worker (createSourceUpdateWorker: claim,
//               lease, fence, receipts, effect registry, candidate sealing) runs
//               one job through the tree's real createSourceUpdater, with release
//               discovery by the tree's git-tag discovery. Git runs for real over
//               the node's core.sshCommand (a local transport shim). The candidate
//               build is spawned through the updater's real runner, re-pointed at
//               upgrade-path-candidate-build.mjs, which runs the RESOLVED builder's
//               buildSourceUpdateCandidate with npm and the two builders faked.
//               Only the restart-queue insert is emulated: server/index.js owns
//               that wiring and cannot be imported without booting the server.
//   read      — the tree's real findSourceUpdateActivation resolves the queued
//               safe-restart row (what executeActionRow runs before the restart).
//   bootstrap — the tree's boot-time action read (readBootstrapActivationAction,
//               used by completeBootstrappedSourceUpdate) and validateCandidate,
//               as the replacement process runs them.
//
// The result is written as JSON to spec.resultFile; the exit code is 0 whenever
// a result was written (the verdict is in the JSON), 2 when the probe crashed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER_ID = 1;

/** Import a module of the tree under test by its repository-relative path. */
function importFromTree(treeRoot, relative) {
    return import(pathToFileURL(path.join(treeRoot, relative)).href);
}

/** sha-256 hex of a string or buffer. */
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/** Initialise (and migrate) the sandbox database with the tree's own code. */
async function openDatabase(treeRoot) {
    const connection = await importFromTree(treeRoot, 'server/modules/database/connection.js');
    const { initializeDatabase } = await importFromTree(treeRoot, 'server/modules/database/init-db.js');
    connection.closeConnection();
    await initializeDatabase();
    const db = await importFromTree(treeRoot, 'server/modules/database/index.js');
    return { getConnection: connection.getConnection, ...db };
}

/** Make sure the owner principal the job is bound to exists (foreign keys). */
function ensureOwner(getConnection) {
    const db = getConnection();
    if (db.prepare('SELECT id FROM users WHERE id = ?').get(OWNER_ID)) return;
    const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    const values = { id: OWNER_ID, username: 'upgrade-gate-owner', password_hash: 'x', role: 'owner' };
    const names = Object.keys(values).filter((name) => columns.has(name));
    db.prepare(`INSERT INTO users (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        .run(...names.map((name) => values[name]));
}

/** Create the durable job the owner's update request creates (state `accepted`). */
function createJob(dbModule, version) {
    const { sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint } = dbModule;
    const jobId = crypto.randomUUID();
    const strategy = 'git-checkout-v2';
    sourceUpdateJobsDb.createOrReuse({
        id: jobId, ownerId: OWNER_ID, expectedVersion: version, strategy, autoActivate: true,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(jobId),
        requestFingerprint: sourceUpdateRequestFingerprint(OWNER_ID, version, strategy, true),
    });
    return jobId;
}

/** The tree's real runner; the candidate builder spawn is re-pointed at the gate's wrapper. */
function commandRunnerFor(runFile, wrapper, record) {
    return (command, args, options = {}) => {
        if (command === process.execPath && args.length === 3 && args[1] === '--plan') {
            record.candidateBuilds += 1;
            record.builder = path.basename(args[0]);
            return runFile(command, [wrapper, ...args], options);
        }
        return runFile(command, args, options);
    };
}

/** Insert the bound safe-restart row as server/index.js queueSourceUpdateRestart does. */
function queueRestartRow(dbModule, state) {
    return async (request) => {
        state.rowId = crypto.randomUUID();
        return dbModule.pendingServerActionsDb.insert({
            id: state.rowId, actionType: 'safe-restart', expectedServerBuildId: request.expectedServerBuildId,
            sourceUpdateJobId: request.sourceUpdateJobId, sourceUpdateTransactionId: request.transactionId,
            activationIdentitySha256: request.activationIdentitySha256, releaseCommit: request.releaseCommit,
        }) === 1;
    };
}

/** The gate control root the tree's maintenance gate uses for this node. */
async function controlRoot(spec) {
    const { createUpdateMaintenanceGate } = await importFromTree(spec.treeRoot, 'server/services/update-maintenance-gate.js');
    return createUpdateMaintenanceGate({ projectPath: spec.nodeRoot }).paths.controlRoot;
}

/** Build the tree's worker exactly as server/index.js wires it for git-checkout-v2. */
async function createWorker(spec, dbModule, record, state) {
    const { createSourceUpdater, runFile } = await importFromTree(spec.treeRoot, 'server/services/source-updater.js');
    const { createSourceUpdateWorker } = await importFromTree(spec.treeRoot, 'server/services/source-update-worker.js');
    const { createGitTagReleaseDiscovery } = await importFromTree(spec.treeRoot, 'server/services/git-tag-release-discovery.js');
    const loadedRuntimeCommit = () => spec.loadedRuntimeCommit;
    const updateSource = createSourceUpdater({
        appRoot: spec.nodeRoot, activeSessionCount: () => 0, env: process.env,
        commandRunner: commandRunnerFor(runFile, spec.candidateBuildWrapper, record),
        queueRestartAction: queueRestartRow(dbModule, state), removeRestartAction: async () => true,
        loadedRuntimeCommit,
    });
    return createSourceUpdateWorker({
        resolveRelease: createGitTagReleaseDiscovery({ appRoot: spec.nodeRoot, env: process.env }),
        receiptRoot: path.join(await controlRoot(spec), 'job-receipts'), loadedRuntimeCommit,
        runUpdate: (job, _release, context) => updateSource(job.expected_version, { jobId: job.id, ...context }),
    });
}

/** Role `write`: one owner job through the tree's real worker and updater. */
async function writeRole(spec) {
    const { getConnection, ...dbModule } = await openDatabase(spec.treeRoot);
    ensureOwner(getConnection);
    const jobId = createJob(dbModule, spec.targetVersion);
    const record = { candidateBuilds: 0, builder: null };
    const state = { rowId: null };
    const worker = await createWorker(spec, dbModule, record, state);
    await worker.processOne();
    const job = dbModule.sourceUpdateJobsDb.getById(jobId);
    if (job?.state !== 'restart_queued') {
        return { ok: false, code: job?.error_code || `upgrade_gate_job_${job?.state ?? 'missing'}`,
            detail: String(job?.error_message || '').slice(0, 400) };
    }
    const effects = getConnection().prepare('SELECT COUNT(*) AS n FROM source_update_effects WHERE job_id = ?')
        .get(jobId)?.n ?? null;
    const actionFile = path.join(await controlRoot(spec), 'candidates', job.transaction_id, 'activation-action.json');
    const actionBytes = fs.readFileSync(actionFile, 'utf8');
    return {
        ok: true, jobId, rowId: state.rowId, transactionId: job.transaction_id, commit: job.release_commit,
        actionKeys: Object.keys(JSON.parse(actionBytes)).sort(), actionSha256: sha256(actionBytes.trim()),
        candidateBuilds: record.candidateBuilds, builder: record.builder, registeredEffects: effects,
    };
}

/** Role `read`: resolve the queued row through the tree's real command-board reader. */
async function readRole(spec) {
    const { pendingServerActionsDb } = await openDatabase(spec.treeRoot);
    const { findSourceUpdateActivation } = await importFromTree(spec.treeRoot, 'server/routes/system.js');
    const row = pendingServerActionsDb.getById(spec.rowId);
    if (!row) return { ok: false, code: 'upgrade_gate_row_missing' };
    const resolved = findSourceUpdateActivation(row, spec.nodeRoot);
    if (!resolved) return { ok: false, code: 'source_update_action_missing' };
    if (resolved.action?.targetCommit !== spec.expectedCommit) return { ok: false, code: 'upgrade_gate_target_mismatch' };
    return { ok: true, actionKeys: Object.keys(resolved.action).filter((key) => key !== 'candidateRoot').sort() };
}

/** Role `bootstrap`: the replacement process's boot-time read, then candidate validation. */
async function bootstrapRole(spec) {
    const activation = await importFromTree(spec.treeRoot, 'scripts/lib/source-update-activation.mjs');
    const { readBootstrapActivationAction, validateCandidate } = activation;
    if (typeof readBootstrapActivationAction !== 'function') return { ok: false, code: 'upgrade_gate_bootstrap_reader_missing' };
    const candidateRoot = path.join(await controlRoot(spec), 'candidates', spec.transactionId);
    const action = readBootstrapActivationAction(candidateRoot, spec.transactionId);
    if (action.targetCommit !== spec.expectedCommit) return { ok: false, code: 'upgrade_gate_target_mismatch' };
    validateCandidate({
        projectRoot: spec.nodeRoot, candidateRoot, transactionId: action.transactionId,
        releaseCommit: action.targetCommit, version: action.version,
        manifestPath: action.manifestPath, manifestSha256: action.manifestSha256,
    });
    return { ok: true, actionKeys: Object.keys(action).sort() };
}

/** A bounded error code for the report: never a path or free text. */
function errorCode(error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : error?.message;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'upgrade_gate_probe_error';
}

const ROLES = Object.freeze({ write: writeRole, read: readRole, bootstrap: bootstrapRole });

async function main() {
    const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    let result;
    try {
        if (!Object.hasOwn(ROLES, spec.role)) throw new Error('upgrade_gate_role_invalid');
        result = await ROLES[spec.role](spec);
    } catch (error) {
        result = { ok: false, code: errorCode(error), detail: String(error?.message || error).slice(0, 400) };
    }
    fs.writeFileSync(spec.resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

main().then(() => process.exit(0), (error) => {
    process.stderr.write(`upgrade-path-probe: ${error?.stack || error}\n`);
    process.exit(2);
});
