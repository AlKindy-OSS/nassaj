/** Verify a pinned local recovery packet before repository registration; never restart or edit configuration. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readPreparedLocalRecoveryCandidate } from './local-source-recovery-candidate.mjs';
import { hashTree } from './lib/source-update-tree-identity.mjs';
import { readBootstrapPrivateFile, readBootstrapPinnedFile, verifyBootstrapJournalBinding } from './lib/local-source-bootstrap-ticket.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`local_recovery_operator_${code}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const require = createRequire(import.meta.url);

function bootstrapCompletionFiles(root, packet) {
    const binding = packet.bootstrapCompletion;
    if (!binding || Object.keys(binding).sort().join(',') !== ['sequence','transactionNonce','targetDigest','actionId',
        'receiptSha256','claimSha256','ticketSha256','qualificationSha256','executorCodeClosureSha256','manifestSha256'].sort().join(',')
        || !Number.isSafeInteger(binding.sequence) || binding.sequence < 1
        || !/^[a-f0-9-]{36}$/.test(binding.actionId || '')
        || ['transactionNonce','targetDigest','receiptSha256','claimSha256','ticketSha256','qualificationSha256',
            'executorCodeClosureSha256','manifestSha256'].some(key => !/^[a-f0-9]{64}$/.test(binding[key] || ''))) fail('bootstrap_completion_binding');
    const commonGit = fs.realpathSync(execFileSync('git', ['rev-parse','--path-format=absolute','--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim());
    const journalFile = path.join(commonGit, `nassaj-oid-control-transaction-${binding.sequence}-${binding.transactionNonce}.json`);
    const journal = JSON.parse(readBootstrapPrivateFile(journalFile));
    const receiptFile = path.join(commonGit, `nassaj-oid-pair-serving-${binding.transactionNonce}.json`);
    const receiptBytes = readBootstrapPinnedFile(receiptFile, binding.receiptSha256);
    return { binding, commonGit, journal, receiptBytes };
}

async function inspectBootstrapCompletionHealth(root, packet, manifest, receipt) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/health$/.test(packet.privateHealthUrl || '')) fail('bootstrap_health_url');
    const response = await fetch(packet.privateHealthUrl, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) fail('bootstrap_health_unavailable');
    const health = await response.json();
    if (health.status !== 'ok' || health.updateMode !== 'local-main' || health.normalAdmissionReady !== true
        || health.pid !== receipt.pid || String(health.serverProcessStartTicks) !== receipt.startTime
        || health.serverLoadedOid !== manifest.releaseCommit || health.serverLoadedBuildId !== receipt.serverBuildId
        || health.clientBuildIdServed !== receipt.clientBuildId || health.serverTransactionNonce !== receipt.transactionNonce
        || health.oidPairTransactionNonce !== receipt.transactionNonce || health.oidPairTargetDigest !== receipt.targetDigest
        || health.oidNodeModulesTreeSha256 !== receipt.nodeModulesTreeSha256) fail('bootstrap_health_changed');
    assertProcess(root, { pid: receipt.pid, startTicks: receipt.startTime });
    return health;
}

async function inspectRetainedBootstrapQualification(record, retained) {
    const { ticket, previousMaterial, qualificationReference, previousControlManifestBase64 } = record.bootstrap;
    if (!previousMaterial || typeof previousControlManifestBase64 !== 'string'
        || Buffer.from(previousControlManifestBase64, 'base64').toString('base64') !== previousControlManifestBase64
        || qualificationReference?.sha256 !== ticket.material.baseline.attestationSha256) fail('bootstrap_qualification_binding');
    const manifestBytes = Buffer.from(previousControlManifestBase64, 'base64');
    if (sha(manifestBytes) !== previousMaterial.controlManifestSha256) fail('bootstrap_previous_manifest');
    for (const key of ['clientBuildId','serverBuildId','controlManifestSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256']) {
        if (previousMaterial[key] !== ticket.material.previous[key]) fail('bootstrap_previous_material');
    }
    const capsule = await import(`data:text/javascript;base64,${retained.bytes['capsule.mjs'].toString('base64')}`);
    if (typeof capsule.inspectBootstrapQualification !== 'function') fail('bootstrap_verifier_missing');
    const qualified = capsule.inspectBootstrapQualification({ installation: ticket.material.installation, actualPrevious: previousMaterial,
        liveManifest: JSON.parse(manifestBytes), executorCodeClosureSha256: retained.descriptor.codeClosure.sha256,
        verifierClosureSha256: retained.descriptor.files.find(file => file.name === 'capsule.mjs').sha256, qualificationReference });
    if (qualified.reportSha256 !== ticket.material.baseline.rehearsalSha256
        || qualified.databasePath !== ticket.material.database.path
        || qualified.appDataGuard.directory !== path.dirname(ticket.material.database.path)) fail('bootstrap_appdata_binding');
    const database = fs.lstatSync(ticket.material.database.path);
    if (String(database.dev) !== ticket.material.database.dev || String(database.ino) !== ticket.material.database.ino) fail('bootstrap_database_identity');
    return { qualified, capsule };
}

/** Inspect a completed retained bootstrap and live serving proof without opening any database. */
export async function inspectCompletedBootstrap(root, packet) {
    if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || packet.root !== root
        || packet.serviceUid !== process.getuid() || packet.nodeIdentity !== os.hostname()) fail('bootstrap_installation');
    const { binding, commonGit, journal, receiptBytes } = bootstrapCompletionFiles(root, packet);
    const { readOidTripleRetainedExecutor } = await import('./preview-oid-capsule-launcher.mjs');
    const retained = readOidTripleRetainedExecutor(root, { ...journal.recoveryReference, transactionNonce: binding.transactionNonce,
        actionId: binding.actionId, targetDigest: binding.targetDigest });
    const record = JSON.parse(retained.bytes['record.json']), ticket = record.bootstrap?.ticket;
    if (!ticket || !/^[a-f0-9]{64}$/.test(ticket.nonce || '')
        || retained.descriptor.codeClosure?.descriptor?.schema !== 'nassaj-bootstrap-executable-closure/v1'
        || ticket.material?.installation?.commonGit !== commonGit || ticket.material.installation.root !== root
        || ticket.material.installation.hostname !== os.hostname()
        || ticket.material.installation.serviceUid !== process.getuid()) fail('bootstrap_not_completed');
    const claimFile = path.join(commonGit, 'nassaj-oid-recovery', binding.transactionNonce, `bootstrap-claim-${ticket.nonce}.json`);
    const claimBytes = readBootstrapPinnedFile(claimFile, binding.claimSha256);
    const verified = verifyBootstrapJournalBinding(journal, record, claimBytes, retained.descriptor.codeClosure.sha256);
    for (const key of ['ticketSha256','claimSha256','qualificationSha256','executorCodeClosureSha256','manifestSha256']) {
        if (verified.binding[key] !== binding[key]) fail('bootstrap_completion_changed');
    }
    const { qualified: qualification, capsule } = await inspectRetainedBootstrapQualification(record, retained);
    const receipt = capsule.readOidPairServingReceipt(root, binding);
    if (!same(receipt, JSON.parse(receiptBytes))) fail('bootstrap_receipt_changed');
    const manifest = JSON.parse(readBootstrapPinnedFile(packet.manifestPath, binding.manifestSha256));
    if (manifest.releaseCommit !== ticket.material.event.oid || manifest.serverBuildId !== receipt.serverBuildId
        || manifest.clientBuildId !== receipt.clientBuildId || journal.pair.databaseState !== 'TARGET_VERIFIED'
        || journal.pair.activationNotClaimed !== false || !journal.oldStoppedAt
        || journal.persistence?.online?.state !== 'verified') fail('bootstrap_target_changed');
    const env = readBootstrapPinnedFile(path.join(root, '.env'), ticket.material.mode.proposalEnvSha256).toString('utf8');
    const modes = env.split('\n').filter(line => /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE(?:\s|=|$)/.test(line));
    if (modes.length !== 1 || !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=\s*(?:local-main|"local-main"|'local-main')\s*$/.test(modes[0])) fail('bootstrap_config_mode');
    const health = await inspectBootstrapCompletionHealth(root, packet, manifest, receipt);
    return { manifest, runtime: { pid: receipt.pid, startTicks: receipt.startTime }, transactionId: binding.transactionNonce,
        receipt, bootstrap: verified.binding, health, appDataGuard: qualification.appDataGuard };
}

function pinnedFile(file, expectedSha256, privateMode = true) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || fs.realpathSync(file) !== file
        || stat.size > 4 * 1024 * 1024
        || (privateMode ? (stat.mode & 0o777) !== 0o600 : Boolean(stat.mode & 0o022))) fail('unsafe_file');
    const bytes = fs.readFileSync(file);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || sha(bytes) !== expectedSha256) fail('file_changed');
    return bytes;
}

function readPacket(options) {
    const root = path.resolve(options.root), file = path.resolve(options.packetPath);
    if (fs.realpathSync(root) !== root || !file.startsWith(`${root}/.git/nassaj-source-update/`)) fail('packet_path');
    const packet = JSON.parse(pinnedFile(file, options.packetSha256));
    if (packet.schema !== 'nassaj-local-source-recovery-packet/v1' || packet.root !== root
        || packet.nodeIdentity !== os.hostname() || packet.serviceUid !== process.getuid()
        || packet.operation !== 'register-prepared-recovery' || !packet.operationBinding
        || packet.operationBinding.root !== root || packet.operationBinding.nodeIdentity !== packet.nodeIdentity) fail('packet_scope');
    return { root, file, packet, packetSha256: options.packetSha256 };
}

function assertProcess(root, runtime) {
    const proc = `/proc/${runtime.pid}`, stat = fs.readFileSync(`${proc}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (ticks !== runtime.startTicks || fs.statSync(proc).uid !== process.getuid()
        || fs.realpathSync(`${proc}/cwd`) !== root) fail('process_changed');
}

function assertDatabase(packet) {
    const identity = packet.database, runtime = packet.operationBinding.previousRuntime;
    if (!identity || !path.isAbsolute(identity.path) || fs.realpathSync(identity.path) !== identity.path) fail('database_identity');
    const stat = fs.lstatSync(identity.path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
        || ['dev', 'ino', 'uid'].some(key => stat[key] !== identity[key])) fail('database_changed');
    const held = fs.readdirSync(`/proc/${runtime.pid}/fd`).some(name => {
        try { const fd = fs.statSync(`/proc/${runtime.pid}/fd/${name}`); return fd.dev === stat.dev && fd.ino === stat.ino; } catch { return false; }
    });
    if (!held) fail('database_not_held_by_runtime');
}

function assertDatabaseFiles(identity) {
    if (!identity || !path.isAbsolute(identity.path) || fs.realpathSync(identity.path) !== identity.path) fail('database_identity');
    for (const suffix of ['', '-wal', '-shm']) {
        const file = `${identity.path}${suffix}`;
        if (suffix && !fs.existsSync(file)) continue;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || fs.realpathSync(file) !== file || stat.dev !== identity.dev
            || (!suffix && (stat.ino !== identity.ino || stat.uid !== identity.uid))) fail('database_file_changed');
    }
}

/** Hash only the pre-existing registration substrate, including its indexes and triggers. */
export function recoveryDatabaseSchemaSha256(db) {
    const tables = ['users', 'source_update_jobs', 'source_update_receipts', 'source_update_effects', 'source_update_control', 'pending_server_actions'];
    const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${tables.map(() => '?').join(',')}) ORDER BY type,name`).all(...tables);
    if (tables.some(table => !rows.some(row => row.type === 'table' && row.name === table))) fail('database_schema_missing');
    return sha(JSON.stringify(rows));
}

/** Open an existing, inode-bound database without initialization, migration, chmod or journal conversion. */
export function openVerifiedRecoveryDatabase(identity) {
    assertDatabaseFiles(identity);
    const Database = require('better-sqlite3');
    const db = new Database(identity.path, { fileMustExist: true, timeout: 5000 });
    try {
        db.pragma('foreign_keys = ON');
        if (recoveryDatabaseSchemaSha256(db) !== identity.schemaSha256) fail('database_schema_changed');
        assertDatabaseFiles(identity);
        return db;
    } catch (error) { db.close(); throw error; }
}

function assertConfig(root, packet) {
    const binding = packet.operationBinding, mode = binding.modeTransition;
    const candidateRoot = path.join(root, '.git/nassaj-source-update/candidates', binding.transactionId);
    const original = pinnedFile(path.join(root, '.env'), mode.originalEnvSha256).toString('utf8');
    if (packet.proposalEnvPath !== path.join(candidateRoot, 'local-recovery-proposal.env')
        || packet.configReceiptPath !== path.join(candidateRoot, 'local-recovery-config.json')) fail('proposal_path');
    const proposal = pinnedFile(packet.proposalEnvPath, mode.proposalEnvSha256).toString('utf8');
    const line = /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=.*$/gm;
    const oldLines = original.match(line) || [], newLines = proposal.match(line) || [];
    if (oldLines.length > 1 || (oldLines.length && !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=\s*(?:release|"release"|'release')\s*$/.test(oldLines[0]))
        || newLines.length !== 1 || !/^NASSAJ_UPDATE_MODE=local-main$/.test(newLines[0])
        || original.replace(line, '').trimEnd() !== proposal.replace(line, '').trimEnd()) fail('config_scope');
    const receipt = JSON.parse(pinnedFile(packet.configReceiptPath, mode.configBindingSha256));
    if (receipt.schema !== 'nassaj-local-recovery-config/v1' || receipt.id !== mode.configReceiptId
        || receipt.root !== root || receipt.transactionId !== binding.transactionId || receipt.actionId !== binding.actionId
        || receipt.originalEnvSha256 !== mode.originalEnvSha256 || receipt.proposalEnvSha256 !== mode.proposalEnvSha256
        || receipt.approvalReference !== binding.approvalReference || receipt.reservationReference !== binding.reservationReference) fail('config_receipt');
}

async function assertHealth(packet) {
    const runtime = packet.operationBinding.previousRuntime;
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/health$/.test(packet.privateHealthUrl)
        || !/^https:\/\/[^/?#]+\/health$/.test(packet.publicHealthUrl)) fail('health_url');
    for (const url of [packet.privateHealthUrl, packet.publicHealthUrl]) {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Cache-Control': 'no-cache' } });
        if (!response.ok) fail('health_unavailable');
        const value = await response.json();
        if (value.status !== 'ok' || value.pid !== runtime.pid || value.serverProcessStartTicks !== runtime.startTicks
            || value.serverLoadedOid !== runtime.oid || value.serverLoadedBuildId !== runtime.serverBuildId
            || value.serverBuildIdOnDisk !== runtime.serverBuildId || value.clientBuildIdServed !== runtime.clientBuildId
            || value.normalAdmissionReady !== true || value.updateMode !== 'release') fail('health_changed');
    }
}

/** Derive the original immutable registration tuple without interpreting the currently loaded process. */
export function deriveLocalRecoveryRegistration(context, { existingOnly = false } = {}) {
    const { root, packet } = context, binding = packet.operationBinding;
    const receipt = readPreparedLocalRecoveryCandidate(packet.planPath, { root, existingOnly });
    const manifest = JSON.parse(pinnedFile(receipt.manifestPath, receipt.manifestSha256));
    if (!same(manifest.operationBinding, binding) || receipt.transactionId !== binding.transactionId
        || receipt.manifestSha256 !== packet.manifestSha256) fail('candidate_binding');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (head !== binding.previousSourceOid || head !== receipt.localSource.oid) fail('source_head_changed');
    const action = { schema: 'nassaj-source-update-activation/v1', transactionId: receipt.transactionId,
        originalHead: head, targetCommit: receipt.localSource.oid, version: receipt.version, manifestPath: receipt.manifestPath,
        manifestSha256: receipt.manifestSha256, expectedServerBuildId: receipt.expectedServerBuildId };
    const registration = { jobId: binding.jobId, actionId: binding.actionId, transactionId: binding.transactionId, ownerId: binding.ownerId,
        version: receipt.version, sourceOid: receipt.localSource.oid, sourceTreeSha256: receipt.localSource.inventorySha256,
        manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256, activationIdentitySha256: sha(JSON.stringify(action)),
        operationPacketSha256: context.packetSha256,
        expectedServerBuildId: receipt.expectedServerBuildId, expectedClientBuildId: receipt.expectedClientBuildId, operationBinding: binding };
    return { receipt, manifest, action, registration };
}

/** Inspect real process, config CAS, candidate and current trees from a separately pinned operation packet. */
export async function inspectLocalRecoveryRegistration(options) {
    const context = readPacket(options), { root, packet } = context, binding = packet.operationBinding;
    assertProcess(root, binding.previousRuntime); assertDatabase(packet); assertConfig(root, packet);
    const { receipt, action, registration } = deriveLocalRecoveryRegistration(context), runtime = binding.previousRuntime;
    pinnedFile(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), runtime.controlManifestSha256, false);
    for (const [name, directory] of Object.entries({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' })) {
        if (!same(hashTree(path.join(root, directory)), runtime.actualTrees[name])) fail('previous_tree_changed');
    }
    const helper = path.join(root, 'dist-server/scripts/lib/source-update-activation.mjs');
    pinnedFile(helper, packet.loadedValidatorSha256, false);
    const { validateCandidate } = await import(pathToFileURL(helper).href);
    validateCandidate({ projectRoot: root, candidateRoot: path.dirname(receipt.manifestPath), transactionId: receipt.transactionId,
        releaseCommit: receipt.localSource.oid, version: receipt.version, manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256 });
    await assertHealth(packet); assertProcess(root, runtime); readPacket(options); assertConfig(root, packet); assertDatabase(packet);
    return { registration, action, packetSha256: context.packetSha256, database: packet.database };
}

// Shared authority checks for the separately authorized metadata-only recovery operator.
export { pinnedFile, readPacket, assertProcess, assertDatabase, assertDatabaseFiles, assertConfig, assertHealth };

function persistExact(file, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (fs.existsSync(file)) { pinnedFile(file, sha(bytes)); return; }
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function assertRegistrationCurrent(options, inspected, db) {
    const { root, packet } = readPacket(options);
    assertProcess(root, packet.operationBinding.previousRuntime); assertConfig(root, packet); assertDatabase(packet);
    assertDatabaseFiles(inspected.database);
    if (recoveryDatabaseSchemaSha256(db) !== inspected.database.schemaSha256) fail('database_schema_changed');
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (oid !== inspected.action.originalHead) fail('source_head_changed');
    pinnedFile(inspected.registration.manifestPath, inspected.registration.manifestSha256);
    pinnedFile(path.join(path.dirname(inspected.registration.manifestPath), 'activation-action.json'), sha(`${JSON.stringify(inspected.action)}\n`));
}

/** Durably prepare exact action files, reverify, then register through the candidate's sealed repository on one existing handle. */
export async function registerLocalRecoveryPacket(options) {
    if (options.operation !== 'register-prepared-recovery') fail('explicit_registration_required');
    const inspected = await inspectLocalRecoveryRegistration(options);
    const candidateRoot = path.dirname(inspected.registration.manifestPath);
    persistExact(path.join(candidateRoot, 'activation-action.json'), inspected.action);
    persistExact(path.join(candidateRoot, 'local-source-registration.json'), {
        schema: 'nassaj-local-source-registration/v1', packetSha256: inspected.packetSha256, bootstrapStatus: 'prepared',
        jobId: inspected.registration.jobId, actionId: inspected.registration.actionId,
        transactionId: inspected.registration.transactionId, manifestSha256: inspected.registration.manifestSha256,
        activationIdentitySha256: inspected.registration.activationIdentitySha256,
    });
    const repeated = await inspectLocalRecoveryRegistration(options);
    if (!same(repeated, inspected)) fail('registration_evidence_changed');
    const repositories = path.join(candidateRoot, 'server/server/modules/database/repositories');
    const { registerPreparedRecoveryCandidate } = await import(pathToFileURL(path.join(repositories, 'source-update-recovery.db.js')).href);
    const { SOURCE_UPDATE_ACTIVE_STATES } = await import(pathToFileURL(path.join(repositories, 'source-update-jobs.db.js')).href);
    const db = openVerifiedRecoveryDatabase(inspected.database);
    try {
        return registerPreparedRecoveryCandidate(db, inspected.registration, SOURCE_UPDATE_ACTIVE_STATES,
            () => assertRegistrationCurrent(options, inspected, db));
    } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const options = { root: value('--root'), packetPath: value('--packet'), packetSha256: value('--packet-sha256'),
        operation: args.includes('--reconcile') ? 'reconcile-pre-candidate-rollback' : args.includes('--register') ? 'register-prepared-recovery' : undefined };
    try {
        const result = options.operation === 'reconcile-pre-candidate-rollback'
            ? await (await import('./local-source-recovery-reconcile.mjs')).reconcileLocalRecoveryRollback(options)
            : options.operation ? await registerLocalRecoveryPacket(options) : await inspectLocalRecoveryRegistration(options);
        process.stdout.write(`${JSON.stringify({ ok: true, registered: Boolean(options.operation), reused: result.reused ?? false,
            jobId: result.job?.id ?? result.registration?.jobId })}\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  })();
}
