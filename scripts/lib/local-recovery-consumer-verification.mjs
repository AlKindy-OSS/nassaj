/** Read-only systemd/process/bundle authority for the bounded offline consumer transition. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readLocalBuildProfile, LOCAL_BUILD_PROFILE } from './local-build-profile.mjs';
import { readLocalUpdatePolicy, LOCAL_UPDATE_POLICY_FILE, verifyLocalUpdatePolicyCapability } from './local-update-policy.mjs';
import { hashTree } from './source-update-tree-identity.mjs';
import * as recoveryOperator from '../local-source-recovery-operator.mjs';
import { pinnedFile, readPacket, assertProcess, assertDatabase, assertDatabaseFiles } from '../local-source-recovery-operator.mjs';
import { readClientPublicationPolicy } from './client-publication-policy.mjs';
import { readClientPublicationBlockers } from './client-publication-control.mjs';
import { readLocalUpdate } from './local-update-control.mjs';
import { assertNoNonterminalOidTransaction } from '../oid-control-journal.mjs';
import { verifyClientPublicationConsumerBundle, verifyRetainedClientPublicationConsumerBundle } from '../client-publication-consumer-launcher.mjs';

const UNIT = 'nassaj-preview-oid-consumer.service', sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`local_consumer_verification_${code}`); };
const require = createRequire(import.meta.url);

function systemctl(args) {
    const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) fail(`systemctl_${args[0]}_failed`);
    return result.stdout.trim();
}
function assertPolicy(root, expectedHash) {
    const file = path.join(root, '.git/nassaj-client-publication-policy-v1.json');
    const current = fs.existsSync(file) ? sha(fs.readFileSync(file)) : 'absent';
    if (current !== expectedHash || readClientPublicationPolicy(root).mode !== 'button-only') fail('policy_changed');
    const blockers = readClientPublicationBlockers(root), request = readLocalUpdate(root);
    if (blockers.publications.length || blockers.fullUpdates.length
        || request && !['activated','rolled_back','failed','superseded','cancelled'].includes(request.phase)) fail('pending_request');
    if (fs.existsSync(path.join(root, '.git/nassaj-preview-oid-control-request-v1.json'))) fail('pending_oid_request');
    assertNoNonterminalOidTransaction(root);
}
async function assertCompletedRecovery(root, original, manifest, registrationSha256) {
    const response = await fetch(original.privateHealthUrl, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) fail('health_unavailable');
    const health = await response.json();
    if (health.status !== 'ok' || health.updateMode !== 'local-main' || !health.normalAdmissionReady
        || health.serverLoadedOid !== manifest.releaseCommit || health.serverLoadedBuildId !== manifest.serverBuildId
        || health.clientBuildIdServed !== manifest.clientBuildId) fail('runtime_not_completed');
    const current = { ...original, operationBinding: { ...original.operationBinding, previousRuntime: { pid: health.pid, startTicks: health.serverProcessStartTicks } } };
    assertProcess(root, current.operationBinding.previousRuntime); assertDatabase(current); assertDatabaseFiles(current.database);
    const identity = original.database, stat = fs.lstatSync(identity.path);
    if (!stat.isFile() || fs.realpathSync(identity.path) !== identity.path || stat.uid !== process.getuid()
        || stat.dev !== identity.dev || stat.ino !== identity.ino || (stat.mode & 0o777) !== 0o600) fail('database_changed');
    const Database = require('better-sqlite3'), db = new Database(identity.path, { readonly: true, fileMustExist: true });
    try {
        const b = original.operationBinding, job = db.prepare('SELECT * FROM source_update_jobs WHERE id=?').get(b.jobId);
        if (job?.state !== 'activated' || job.owner_id !== b.ownerId || job.strategy !== 'git-checkout-v2' || job.transaction_id !== b.transactionId || job.release_commit !== manifest.releaseCommit
            || job.expected_server_build_id !== manifest.serverBuildId || job.expected_client_build_id !== manifest.clientBuildId) fail('source_job_unsettled');
        const first = db.prepare('SELECT facts_json,facts_sha256 FROM source_update_receipts WHERE job_id=? AND sequence=1').get(b.jobId);
        if (!first || sha(first.facts_json) !== first.facts_sha256) fail('registration_receipt');
        const facts = JSON.parse(first.facts_json);
        if (facts.operationPacketSha256 !== registrationSha256 || facts.manifestSha256 !== original.manifestSha256
            || facts.actionId !== b.actionId || facts.activationIdentitySha256 !== job.activation_identity_sha256) fail('registration_receipt');
        const done = db.prepare("SELECT * FROM source_update_receipts WHERE job_id=? AND phase='runtime_verifying' AND kind='done' ORDER BY sequence DESC LIMIT 1").get(b.jobId);
        if (!done || sha(done.facts_json) !== done.facts_sha256) fail('completion_receipt');
        const receipt = { schemaVersion: 2, jobId: b.jobId, sequence: done.sequence, workerFence: done.worker_fence,
            phase: done.phase, kind: done.kind, factsJson: done.facts_json, factsSha256: done.facts_sha256 };
        const file = path.join(root, '.git/nassaj-source-update/job-receipts', `${b.jobId}.${String(done.sequence).padStart(8, '0')}.json`);
        pinnedFile(file, sha(`${JSON.stringify(receipt)}\n`));
    } finally { db.close(); }
    pinnedFile(path.join(root, '.env'), original.operationBinding.modeTransition.proposalEnvSha256);
}

/** Validate the separately approved packet and the already completed source recovery before touching the unit. */
export async function inspectOfflineConsumerInputs(options) {
    const root = path.resolve(options.root), packetPath = path.resolve(options.packetPath);
    if (fs.realpathSync(root) !== root || !packetPath.startsWith(`${root}/.git/nassaj-source-update/`)) fail('packet_path');
    const packet = JSON.parse(pinnedFile(packetPath, options.packetSha256));
    if (!['nassaj-local-recovery-consumer/v1', 'nassaj-local-recovery-consumer/v2'].includes(packet.schema) || packet.operation !== 'offline-client-server-transition'
        || packet.root !== root || packet.serviceUid !== process.getuid() || packet.nodeIdentity !== os.hostname()
        || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/.test(packet.approvalReference || '')) fail('packet_scope');
    if (packet.schema === 'nassaj-local-recovery-consumer/v2') return inspectBootstrapConsumer(root, packet, options.packetSha256);
    const { packet: original } = readPacket({ root, packetPath: packet.registrationPacketPath, packetSha256: packet.registrationPacketSha256 });
    const binding = original.operationBinding, candidate = path.join(root, '.git/nassaj-source-update/candidates', binding.transactionId);
    const manifest = JSON.parse(pinnedFile(path.join(candidate, 'candidate-manifest.json'), original.manifestSha256));
    if (JSON.stringify(manifest.operationBinding) !== JSON.stringify(binding)) fail('manifest_binding');
    await assertCompletedRecovery(root, original, manifest, packet.registrationPacketSha256); assertPolicy(root, packet.policySha256);
    const installed = verifyApprovedConsumerBundle(root, manifest);
    const { unit, dropIn } = reviewedUnitPaths(root, packet, manifest);
    const databaseDirectory = path.dirname(original.database.path);
    if (/\s/.test(databaseDirectory)) fail('database_directory');
    const proposed = `[Service]\nEnvironment=NASSAJ_PREVIEW_OID_ENFORCEMENT=1\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client,server\nReadWritePaths=${databaseDirectory}\n`;
    return { root, unit, dropIn, proposed, packetSha256: options.packetSha256, unitSha256: packet.unitSha256,
        originalDropInSha256: packet.originalDropInSha256, transactionId: binding.transactionId, jobId: binding.jobId,
        actionId: binding.actionId, approvalReference: packet.approvalReference, runtimeBuildId: installed.buildId,
        databaseDirectory, intent: path.join(candidate, 'consumer-transition.json'), run: systemctl };
}

function reviewedUnitPaths(root, packet, manifest) {
    const home = os.homedir(), unit = path.join(home, '.config/systemd/user', UNIT), dropIn = `${unit}.d/enforcement.conf`;
    for (const directory of [path.dirname(unit), path.dirname(dropIn)]) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid() || stat.mode & 0o022) fail('unit_directory');
    }
    if (![packet.unitSha256, packet.originalDropInSha256].every(value => /^[a-f0-9]{64}$/.test(value || ''))) fail('configuration_identity');
    const reviewedUnit = execFileSync('git', ['show', `${manifest.releaseCommit}:scripts/systemd/${UNIT}`], { cwd: root });
    if (sha(reviewedUnit) !== packet.unitSha256) fail('unit_not_reviewed_source');
    return { unit, dropIn };
}

async function inspectBootstrapConsumer(root, packet, packetSha256) {
    if (packet.profile !== 'bootstrap-offline-v2' || ['registrationPacketPath', 'registrationPacketSha256', 'database', 'jobId']
        .some(key => Object.hasOwn(packet, key))) fail('bootstrap_profile');
    const completed = await recoveryOperator.inspectCompletedBootstrap(root, packet);
    const { manifest, health, transactionId } = completed;
    assertPolicy(root, packet.policySha256); assertDisabledFullPolicy(root, packet.fullPolicySha256);
    verifyLocalUpdatePolicyCapability(root, health);
    const installed = verifyApprovedConsumerBundle(root, manifest); assertFullBuilder(installed);
    const launcher = installed.records.find(record => record.path === 'scripts/client-publication-consumer-launcher.mjs');
    pinnedFile(path.join(root, launcher.path), launcher.sha256, false);
    const buildProfile = assertBuildProfile(root, manifest.releaseCommit, packet.buildProfileSha256);
    const appDataGuard = assertAppDataGuard(root, packet, completed.appDataGuard, buildProfile);
    const { unit, dropIn } = reviewedUnitPaths(root, packet, manifest);
    if (/\s/.test(root) || !/^[a-f0-9]{64}$/.test(packet.bootstrapCompletion?.transactionNonce || '')) fail('bootstrap_identity');
    if (typeof packet.originalDropIn !== 'string' || sha(packet.originalDropIn) !== packet.originalDropInSha256) fail('original_drop_in');
    const proposed = `${packet.originalDropIn}\n[Service]\nEnvironment=NASSAJ_PREVIEW_OID_ENFORCEMENT=1\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client,server\nReadWritePaths=\nReadWritePaths=${root}\nInaccessiblePaths=${appDataGuard.directory}\n`;
    return { root, unit, dropIn, proposed, packetSha256, profile: packet.profile, transactionId, appDataGuard,
        requiredInaccessiblePaths: [...inaccessibleRestrictions(packet.originalDropIn), appDataGuard.directory],
        unitSha256: packet.unitSha256, originalDropInSha256: packet.originalDropInSha256,
        actionId: packet.bootstrapCompletion.actionId, bootstrap: packet.bootstrapCompletion,
        approvalReference: packet.approvalReference, runtimeBuildId: installed.buildId,
        policySha256: packet.policySha256, fullPolicySha256: packet.fullPolicySha256,
        buildProfileSha256: packet.buildProfileSha256, releaseCommit: manifest.releaseCommit,
        intent: path.join(root, '.git/nassaj-source-update', `consumer-transition-${packet.bootstrapCompletion.transactionNonce}.json`), run: systemctl };
}

/** Bind the self-consistent bundle to the exact sealed server generation that completed recovery. */
export function verifyApprovedConsumerBundle(root, manifest) {
    const installed = verifyClientPublicationConsumerBundle(root), artifact = path.join(root, 'dist-server');
    const control = JSON.parse(fs.readFileSync(path.join(artifact, 'OID_CONTROL_MANIFEST.json'), 'utf8'));
    const provenance = JSON.parse(fs.readFileSync(path.join(artifact, 'BUILD_PROVENANCE.json'), 'utf8'));
    const inputs = JSON.parse(fs.readFileSync(path.join(artifact, 'SERVER_INPUT_MANIFEST.json'), 'utf8'));
    if (control.serverBuildId !== manifest.serverBuildId || provenance.buildId !== manifest.serverBuildId
        || inputs.buildId !== manifest.serverBuildId || provenance.artifact !== 'server' || provenance.dirty !== false
        || provenance.commit !== manifest.releaseCommit || provenance.baseCommit !== manifest.releaseCommit) fail('installed_generation_changed');
    const actual = hashTree(artifact);
    if (actual.sha256 !== manifest.trees?.server?.sha256 || actual.files !== manifest.trees?.server?.files) fail('installed_generation_changed');
    return installed;
}

function words(value) { return String(value || '').split(/\s+/).filter(Boolean).sort(); }
function equalWords(value, expected) { return JSON.stringify(words(value)) === JSON.stringify([...expected].sort()); }

function assertDisabledFullPolicy(root, expectedHash) {
    const file = path.join(root, '.git', LOCAL_UPDATE_POLICY_FILE);
    const current = fs.existsSync(file) ? sha(fs.readFileSync(file)) : 'absent';
    if (current !== expectedHash || readLocalUpdatePolicy(root).mode !== 'disabled') fail('full_policy_changed');
}

function assertBuildProfile(root, oid, expectedHash) {
    pinnedFile(path.join(root, '.git', LOCAL_BUILD_PROFILE), expectedHash);
    const profile = readLocalBuildProfile(root, oid);
    for (const directory of [profile.cachePath, profile.headersPath]) {
        if (/\s/.test(directory) || fs.statfsSync(directory).type === 0x01021994) fail('build_storage');
    }
    return profile;
}

function inaccessibleRestrictions(text) {
    let service = false;
    const result = [];
    for (const line of text.split('\n').map(value => value.trim())) {
        if (line.startsWith('[')) { service = line === '[Service]'; continue; }
        if (line.endsWith('\\')) fail('original_drop_in_continuation');
        if (!service || !line.startsWith('InaccessiblePaths=')) continue;
        const paths = words(line.slice('InaccessiblePaths='.length));
        if (paths.some(value => !/^-?\/[A-Za-z0-9_./-]+$/.test(value))) fail('original_drop_in_paths');
        if (!paths.length) result.length = 0;
        result.push(...paths);
    }
    return result;
}

function assertAppDataGuard(root, packet, attested, buildProfile) {
    const guard = packet.appDataGuard;
    const keys = ['directory', 'dev', 'ino', 'dedicated', 'attestationSha256'];
    if (!guard || !attested || Object.keys(guard).sort().join() !== [...keys].sort().join()
        || keys.some(key => guard[key] !== attested[key]) || guard.dedicated !== true
        || guard.attestationSha256 !== packet.bootstrapCompletion.qualificationSha256
        || typeof guard.directory !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(guard.directory)
        || path.resolve(guard.directory) !== guard.directory || guard.directory === '/') fail('appdata_attestation');
    const directory = guard.directory, stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid() || stat.mode & 0o022
        || String(stat.dev) !== guard.dev || String(stat.ino) !== guard.ino) fail('appdata_identity');
    if ([root, buildProfile.cachePath, buildProfile.headersPath].some(required => required === directory || required.startsWith(`${directory}/`))) fail('appdata_shared');
    return guard;
}

function assertAppDataExclusion(plan, row) {
    const directory = plan.appDataGuard.directory;
    if (plan.requiredInaccessiblePaths.some(value => !words(row.InaccessiblePaths).includes(value))) fail('appdata_not_inaccessible');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory
        || String(stat.dev) !== plan.appDataGuard.dev || String(stat.ino) !== plan.appDataGuard.ino) fail('appdata_identity');
    for (const word of words(row.ReadWritePaths)) {
        const resolved = fs.realpathSync(word.replace(/^-/, ''));
        if (resolved === directory || resolved.startsWith(`${directory}/`)) fail('appdata_writable');
    }
    // No bind mounts are declared by this reviewed profile. Refuse aliases and wider bind exposure,
    // including an ancestor bound somewhere else; read-only binds can still reveal database bytes.
    if (words(row.BindPaths).length || words(row.BindReadOnlyPaths).length || row.RootDirectory || row.RootImage
        || words(row.TemporaryFileSystem).length) fail('appdata_mount_override');
}

function assertFullBuilder(installed) {
    const entries = ['scripts/oid-update-candidate.mjs', 'scripts/client-publication-consumer-launcher.mjs'];
    const files = [...entries, 'scripts/lib/local-build-profile.mjs', 'scripts/lib/local-update-policy.mjs'];
    if (entries.some(entry => !installed.manifest.entries.includes(entry))
        || files.some(file => !installed.records.some(record => record.path === file))) fail('full_builder_missing');
}

function assertOfflineUnit(plan, row) {
    if (!equalWords(row.IPAddressAllow, ['127.0.0.0/8', '::1/128'])
        || !equalWords(row.IPAddressDeny, ['0.0.0.0/0', '::/0'])
        || !equalWords(row.RestrictAddressFamilies, ['AF_UNIX', 'AF_INET', 'AF_INET6'])
        || row.NoNewPrivileges !== 'yes' || row.PrivateTmp !== 'yes' || row.PrivateDevices !== 'yes'
        || row.CapabilityBoundingSet !== '' || row.MemoryHigh !== '2147483648' || row.MemoryMax !== '3221225472'
        || row.CPUQuotaPerSecUSec !== '1.500000s' || row.TasksMax !== '256' || row.UMask !== '0077') fail('offline_sandbox');
    const readOnly = ['src', 'public', 'docs', 'shared', 'server', 'scripts', 'node_modules', 'package.json', 'package-lock.json']
        .map(name => `-${path.join(plan.root, name)}`);
    if (readOnly.some(value => !words(row.ReadOnlyPaths).includes(value))) fail('offline_sandbox');
    assertAppDataExclusion(plan, row);
    const environment = ['NODE_ENV=production', 'TMPDIR=/var/tmp', 'NASSAJ_PREVIEW_OID_ENFORCEMENT=1', 'NASSAJ_PREVIEW_OID_DOMAINS=client,server'];
    if (!equalWords(row.Environment, environment)) fail('offline_environment');
    pinnedFile(plan.dropIn, sha(plan.proposed));
    assertPolicy(plan.root, plan.policySha256);
    assertDisabledFullPolicy(plan.root, plan.fullPolicySha256);
    assertBuildProfile(plan.root, plan.releaseCommit, plan.buildProfileSha256);
}

function cgroupPids(group) {
    if (!group) return [];
    if (!/^\/[A-Za-z0-9/_.:@-]+$/.test(group) || path.posix.normalize(group) !== group) fail('cgroup_path');
    const base = path.join('/sys/fs/cgroup', group), pids = new Set();
    const walk = directory => {
        for (const pid of fs.readFileSync(path.join(directory, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean)) pids.add(Number(pid));
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) walk(path.join(directory, entry.name));
    };
    if (!fs.existsSync(base)) return [];
    walk(base);
    return [...pids].sort((a, b) => a - b);
}
function processIdentity(pid) {
    const file = `/proc/${pid}`, stat = fs.readFileSync(`${file}/stat`, 'utf8');
    return { startTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
        cwd: fs.realpathSync(`${file}/cwd`), uid: fs.statSync(file).uid, exe: fs.realpathSync(`${file}/exe`),
        argv: fs.readFileSync(`${file}/cmdline`, 'utf8').split('\0').filter(Boolean) };
}

function nodeEntry(identity, root, entry, args = []) {
    return identity.exe === fs.realpathSync(process.execPath) && identity.cwd === root
        && identity.argv.length === args.length + 2 && path.resolve(identity.cwd, identity.argv[1]) === entry
        && JSON.stringify(identity.argv.slice(2)) === JSON.stringify(args);
}

/** Observe the existing unit without assuming inactive means an empty cgroup or no pending start job. */
export function observeConsumer(plan) {
    const keys = ['ActiveState','SubState','MainPID','LoadState','UnitFileState','ControlGroup','InvocationID','NRestarts','Environment','DropInPaths','ReadWritePaths','ProtectHome','ProtectSystem',
        'IPAddressAllow','IPAddressDeny','RestrictAddressFamilies','ReadOnlyPaths','NoNewPrivileges','PrivateTmp','PrivateDevices',
        'CapabilityBoundingSet','MemoryHigh','MemoryMax','CPUQuotaPerSecUSec','TasksMax','UMask',
        'InaccessiblePaths','BindPaths','BindReadOnlyPaths','RootDirectory','RootImage','TemporaryFileSystem'];
    const lines = plan.run(['show', UNIT, ...keys.map(key => `--property=${key}`)]).split('\n');
    const value = Object.fromEntries(lines.map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
    const allJobs = JSON.parse(plan.run(['list-jobs', '--output=json']));
    const legacy = 'nassaj-client-build-watch.service';
    const legacyState = plan.run(['show', legacy, '--property=ActiveState', '--value']);
    if (!['inactive', 'failed'].includes(legacyState) || allJobs.some(job => job.unit === legacy)) fail('legacy_not_offline');
    const jobs = allJobs.filter(job => job.unit === UNIT);
    return { ...value, jobs, pids: cgroupPids(value.ControlGroup) };
}

/** Check the loaded v2 configuration before start. This is not evidence of kernel enforcement. */
export function verifyConsumerConfiguration(plan) {
    if (plan.profile !== 'bootstrap-offline-v2') return;
    const row = observeConsumer(plan);
    if (row.DropInPaths !== plan.dropIn || row.ProtectHome !== 'read-only' || row.ProtectSystem !== 'strict'
        || !equalWords(row.ReadWritePaths, [plan.root])) fail('offline_configuration');
    assertOfflineUnit(plan, row);
}

/** Prove only slot/process/retained-bundle startup, never wait for a claim while event EX is held. */
export async function verifyConsumerReadiness(plan) {
    const end = Date.now() + 10_000;
    let firstActive = null;
    while (Date.now() < end) {
        const row = observeConsumer(plan);
        if (row.ActiveState === 'active' && Number(row.MainPID) > 1) {
            const owner = processIdentity(Number(row.MainPID));
            const incarnation = JSON.stringify([row.InvocationID, row.NRestarts, row.MainPID, owner.startTicks, row.ControlGroup]);
            if (firstActive !== null && firstActive !== incarnation) fail('startup_incarnation_changed');
            firstActive = incarnation;
            const folder = path.join(plan.root, '.nassaj-local-preview/client-consumer-runtimes', plan.runtimeBuildId);
            const entry = path.join(folder, 'UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs');
            const children = row.pids.filter(pid => pid !== Number(row.MainPID)).map(pid => ({ pid, ...processIdentity(pid) })).filter(item => item.argv.includes(entry));
            if (children.length > 1) fail('duplicate_retained_process');
            const child = children[0];
            if (child) {
                if (owner.uid !== process.getuid() || owner.cwd !== plan.root || child.uid !== owner.uid || child.cwd !== plan.root
                    || !nodeEntry(owner, plan.root, path.join(plan.root, 'scripts/client-publication-consumer-launcher.mjs'))
                    || !nodeEntry(child, plan.root, entry, ['--repo', plan.root]) || row.UnitFileState !== 'enabled'
                    || row.DropInPaths !== plan.dropIn || !row.Environment.split(/\s+/).includes('NASSAJ_PREVIEW_OID_DOMAINS=client,server')
                    || !row.Environment.split(/\s+/).includes('NASSAJ_PREVIEW_OID_ENFORCEMENT=1') || row.jobs.length
                    || row.ProtectHome !== 'read-only' || row.ProtectSystem !== 'strict'
                    || JSON.stringify(row.ReadWritePaths.split(/\s+/).sort()) !== JSON.stringify((plan.profile === 'bootstrap-offline-v2' ? [plan.root] : [plan.root, plan.databaseDirectory]).sort())
                    || !/^[a-f0-9]{32}$/.test(row.InvocationID) || !/^\d+$/.test(row.NRestarts)) fail('startup_identity');
                verifyRetainedClientPublicationConsumerBundle(folder, plan.runtimeBuildId);
                if (plan.profile === 'bootstrap-offline-v2') {
                    if (row.pids.length !== 2 || !row.pids.includes(Number(row.MainPID))) fail('offline_processes');
                    assertOfflineUnit(plan, row);
                    const retained = verifyRetainedClientPublicationConsumerBundle(folder, plan.runtimeBuildId);
                    assertFullBuilder(retained);
                    const launcher = retained.records.find(record => record.path === 'scripts/client-publication-consumer-launcher.mjs');
                    pinnedFile(path.join(plan.root, launcher.path), launcher.sha256, false);
                }
                return Object.fromEntries(Object.entries({ InvocationID: row.InvocationID, NRestarts: row.NRestarts, MainPID: row.MainPID,
                    startTicks: owner.startTicks, ControlGroup: row.ControlGroup, retainedBuildId: plan.runtimeBuildId,
                    childPid: child.pid, childStartTicks: child.startTicks }));
            }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail('startup_unresolved');
}
