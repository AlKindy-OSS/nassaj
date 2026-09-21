/** Prepare three local generations from an exact main OID; never publish or activate them. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealOidTripleServerDependencies } from './server-build-atomic.mjs';
import { materializePreviewSnapshot } from './preview-oid-pipeline.mjs';
import { readLocalUpdate, verifyLocalCandidate } from './lib/local-update-control.mjs';
import { runOidTripleNativeProbe } from './oid-control-capsule.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import { withPreviewMutationLock, withPreviewEventMutationLock } from './local-preview-ledger.mjs';
import { gitControlPath } from './git-control-root.mjs';
import { readLocalBuildProfile, assertLocalBuildCapacity, createOfflineBuildEnvironment } from './lib/local-build-profile.mjs';
import { dependencyEnvironment, installAndBuildCandidate, buildInstalledCandidateArtifact } from './lib/candidate-build-steps.mjs';
import { inspectCandidateInstallPolicy } from './lib/candidate-install-policy.mjs';
import { hashDependencyTreeV2, sealDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { readOidSourceInventory, copyOidBuildSource, verifyOidSourceInventory } from './lib/oid-candidate-source.mjs';
import { canonicalTripleJson, validateOidTripleTargetDescriptor } from './lib/oid-triple-target.mjs';
import { computeDependencyContractV2, verifyOidDependencyCandidate } from './lib/oid-dependency-candidate.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
    if (result.status !== 0) fail(`local_update_candidate_${path.basename(executable)}_failed`);
    return result;
}

function directory(file) {
    if (!fs.existsSync(file)) fs.mkdirSync(file, { mode: 0o700 });
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)
        || fs.realpathSync(file) !== path.resolve(file)) fail('local_update_unsafe_candidate_directory');
}

function protectedProjectRoot(root) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)
        || fs.realpathSync(root) !== path.resolve(root)) fail('local_update_unsafe_candidate_directory');
}

function assertBuildResources(root) {
    if (fs.realpathSync(root) !== root || fs.statfsSync(root).type === 0x01021994) fail('local_update_disk_required');
    if (os.loadavg()[0] / Math.max(1, os.cpus().length) >= 0.8) fail('local_update_resources_busy');
    const available = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
    if (!available || 1 - Number(available[1]) * 1024 / os.totalmem() >= 0.8) fail('local_update_resources_busy');
}

function prepareScratch(root, oid) {
    protectedProjectRoot(root);
    const nonce = randomBytes(32).toString('hex');
    let base = root;
    for (const part of ['.nassaj-local-preview', 'oid-builds', oid, nonce]) { base = path.join(base, part); directory(base); }
    directory(path.join(base, 'tmp'));
    return { candidateRoot: base, sourceRoot: path.join(base, 'source'), nonce };
}

function durableJson(file, value) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function flushGeneration(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const child of fs.readdirSync(file)) flushGeneration(path.join(file, child));
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function persistGeneration(root, kind, identity, source, expectedTree) {
    const parent = path.join(root, '.nassaj-local-preview', `${kind}-candidates`); directory(parent);
    flushGeneration(source);
    const destination = path.join(parent, identity);
    if (fs.existsSync(destination)) {
        const previous = hashDependencyTreeV2(destination);
        if (previous.sha256 === expectedTree.sha256) return destination;
        if (kind === 'dependency') fail('local_update_candidate_store_conflict');
        const provenance = JSON.parse(fs.readFileSync(path.join(destination, 'BUILD_PROVENANCE.json')));
        if (provenance.artifact !== kind || provenance.buildId !== identity || provenance.dirty !== false
            || !/^[a-f0-9]{40}$/.test(provenance.commit || '') || provenance.baseCommit !== provenance.commit) fail('local_update_candidate_store_conflict');
        run('/usr/bin/mv', ['--exchange', '--no-copy', '-T', source, destination]);
        if (hashDependencyTreeV2(source).sha256 !== previous.sha256
            || hashDependencyTreeV2(destination).sha256 !== expectedTree.sha256) fail('local_update_candidate_store_raced');
    } else {
        fs.renameSync(source, destination);
    }
    if (hashDependencyTreeV2(destination).sha256 !== expectedTree.sha256) fail('local_update_candidate_changed_after_move');
    const fd = fs.openSync(parent, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return destination;
}

function dependencyEvidence(sourceRoot, install, tree, npmList, nativeProbe) {
    const value = { schema: 'nassaj-oid-dependency-candidate/v2', tree, nodeModulesTreeSha256: tree.sha256,
        packageJsonSha256: digest(fs.readFileSync(path.join(sourceRoot, 'package.json'))),
        packageLockSha256: digest(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))),
        installRuntime: install.installRuntime, installPolicy: install.installPolicy,
        installPolicySha256: install.installPolicySha256,
        npmLsSha256: digest(canonicalTripleJson(JSON.parse(npmList.stdout))), nativeProbe };
    return { ...value, dependencyContractSha256: computeDependencyContractV2(value) };
}

async function storePrepared(root, event, outputs, built, evidence) {
    return withPreviewMutationLock(root, gitControlPath(root, 'nassaj-client-build.lock'), () => withPreviewEventMutationLock(root, () => {
        assertNoNonterminalOidTransaction(root);
        const request = readLocalUpdate(root, event.sequence);
        if (request?.phase !== 'preparing' || request.oid !== event.oid) fail('local_update_not_preparing');
        readOidSourceInventory(root, event.oid); // Main must still be the requested immutable target.
        persistGeneration(root, 'client', built.client.buildId, outputs.client, hashDependencyTreeV2(outputs.client));
        persistGeneration(root, 'server', built.server.buildId, outputs.server, hashDependencyTreeV2(outputs.server));
        persistGeneration(root, 'dependency', evidence.nodeModulesTreeSha256, outputs.nodeModules, evidence.tree);
        const evidenceParent = path.join(root, '.nassaj-local-preview', 'dependency-evidence'); directory(evidenceParent);
        const evidenceFile = path.join(evidenceParent, `${evidence.dependencyContractSha256}.json`);
        if (!fs.existsSync(evidenceFile)) durableJson(evidenceFile, evidence);
        const client = verifyLocalCandidate(root, event, 'client', built.client.buildId);
        const server = verifyLocalCandidate(root, event, 'server', built.server.buildId);
        const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
            clientBuildId: built.client.buildId, serverBuildId: built.server.buildId,
            clientTreeSha256: client.treeSha256, serverTreeSha256: server.treeSha256,
            nodeModulesTreeSha256: evidence.nodeModulesTreeSha256, dependencyContractSha256: evidence.dependencyContractSha256,
            packageJsonSha256: evidence.packageJsonSha256, packageLockSha256: evidence.packageLockSha256,
            installPolicySha256: evidence.installPolicySha256, installRuntime: evidence.installRuntime,
            controlManifestSha256: server.controlManifestSha256 };
        validateOidTripleTargetDescriptor(target); verifyOidDependencyCandidate(root, target);
        return target;
    }));
}

function removeCompletedScratch(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory) fail('local_update_unsafe_cleanup');
    function writableParents(file) {
        const item = fs.lstatSync(file);
        if (!item.isDirectory() || item.isSymbolicLink()) return;
        fs.chmodSync(file, 0o700);
        for (const child of fs.readdirSync(file)) writableParents(path.join(file, child));
    }
    writableParents(directory);
    fs.rmSync(directory, { recursive: true, force: false });
}

function readBuildAttempt(file) {
    try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('local_update_build_claim_invalid');
            const claim = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (claim.schema !== 'nassaj-local-update-build-attempt/v1' || !['building', 'completed'].includes(claim.phase)) {
                fail('local_update_build_claim_invalid');
            }
            return claim;
        } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeBuildAttempt(file, value) {
    const temporary = `${file}.tmp-${randomBytes(16).toString('hex')}`;
    durableJson(temporary, value); fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Own the heavy-build lease and refuse crash leftovers until their cleanup is proven. */
export async function buildOidTripleCandidate(input, injected = {}) {
    const { root, event } = input;
    protectedProjectRoot(root);
    return withPreviewMutationLock(root, gitControlPath(root, 'nassaj-local-preview-build.lock'), async () => {
        const file = gitControlPath(root, 'nassaj-local-update-build-attempt-v1.json');
        const previous = readBuildAttempt(file);
        if (previous && previous.phase !== 'completed') fail('local_update_build_recovery_required');
        const request = readLocalUpdate(root, event.sequence);
        if (request?.phase !== 'preparing' || request.oid !== event.oid || request.group !== event.group) fail('local_update_not_preparing');
        const inventory = readOidSourceInventory(root, event.oid);
        assertBuildResources(root);
        const profile = (injected.readBuildProfile || readLocalBuildProfile)(root, event.oid);
        if (profile) assertLocalBuildCapacity(root, profile, 'prepare');
        const claim = { schema: 'nassaj-local-update-build-attempt/v1', phase: 'building',
            attemptId: randomBytes(32).toString('hex'), sequence: event.sequence, oid: event.oid,
            pid: process.pid, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            startTicks: fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[19], startedAt: Date.now() };
        writeBuildAttempt(file, claim);
        // An interrupted attempt intentionally remains nonterminal. A dead parent is not proof that npm descendants exited.
        let settled = false;
        let capacityDeferred = false;
        let target;
        try { target = await buildTripleUnderLease(input, injected, inventory, profile,
            () => { settled = true; }, () => { capacityDeferred = true; }); }
        catch (error) {
            if (capacityDeferred || (settled && ['local_update_target_changed', 'local_update_not_preparing'].includes(error.code))) {
                writeBuildAttempt(file, { ...claim, phase: 'completed', completedAt: Date.now(),
                    outcome: capacityDeferred ? 'capacity_deferred' : 'superseded' });
            }
            throw error;
        }
        writeBuildAttempt(file, { ...claim, phase: 'completed', completedAt: Date.now(),
            orchestrationBuildId: /^[a-f0-9]{64}$/.test(process.env.NASSAJ_LOCAL_BUILD_ORCHESTRATION_ID || '')
                ? process.env.NASSAJ_LOCAL_BUILD_ORCHESTRATION_ID : null, targetDigest: digest(canonicalTripleJson(target)) });
        return target;
    });
}

/** Build private staged dependencies and both artifacts, probe them, then store a complete v2 target. */
async function buildTripleUnderLease({ root, event }, injected, inventory, profile, workSettled, capacityDeferred) {
    directory(path.join(root, '.nassaj-local-preview'));
    directory(path.join(root, '.nassaj-local-preview', 'oid-snapshots'));
    const snapshot = await (injected.materialize || materializePreviewSnapshot)(root, event.oid);
    const scratch = prepareScratch(root, event.oid);
    const capacityCheckpoint = phase => {
        if (!profile) return;
        try { (injected.assertCapacity || assertLocalBuildCapacity)(root, profile, phase); }
        catch (error) {
            if (['local_update_build_capacity_wait', 'local_update_build_capacity_unknown'].includes(error.code)) {
                removeCompletedScratch(scratch.candidateRoot);
                capacityDeferred();
            }
            throw error;
        }
    };
    copyOidBuildSource(snapshot, scratch.sourceRoot, event.oid, inventory);
    const outputs = { client: path.join(scratch.candidateRoot, 'client'), server: path.join(scratch.candidateRoot, 'server'),
        nodeModules: path.join(scratch.candidateRoot, 'node_modules') };
    const executeCommand = injected.run || run;
    const requestedEnv = injected.env || process.env;
    for (const [key, value] of Object.entries(requestedEnv)) {
        if (/^npm_config_(?:allow_scripts|ignore_scripts|dangerously_allow_all_scripts|strict_allow_scripts)$/i.test(key)
            && value && value !== 'false') fail('candidate_install_npm_env_conflict');
    }
    const env = profile ? createOfflineBuildEnvironment(profile, scratch, requestedEnv)
        : dependencyEnvironment({ ...requestedEnv, TMPDIR: path.join(scratch.candidateRoot, 'tmp') });
    const execute = (executable, args, options = {}) => executeCommand(executable, args, {
        ...options, env: profile ? { ...options.env, ...env } : options.env,
    });
    const install = (injected.inspectInstall || inspectCandidateInstallPolicy)(scratch.sourceRoot, execute, env);
    if (profile && (install.installRuntime.nodeBinarySha256 !== profile.runtime.nodeBinarySha256
        || install.installRuntime.npmCliSha256 !== profile.runtime.npmCliSha256)) fail('local_update_build_runtime_changed');
    const version = JSON.parse(fs.readFileSync(path.join(scratch.sourceRoot, 'package.json'))).version;
    const built = await installAndBuildCandidate({ ...scratch, outputs, sourceOid: event.oid, version }, {
        run: execute, env, installArgs: profile ? ['--offline', '--cache', profile.cachePath] : [],
        beforeInstall: () => capacityCheckpoint('install'),
        beforeBuild: () => capacityCheckpoint('build'),
        verifySource: stage => verifyOidSourceInventory(scratch.sourceRoot, event.oid, inventory,
            { allowNodeModules: stage !== 'before-install' }),
        buildClient: injected.buildClient || (options => buildInstalledCandidateArtifact('client', options, execute, env)),
        buildServer: injected.buildServer || (options => buildInstalledCandidateArtifact('server', options, execute, env)),
    });
    const npmList = execute('npm', ['ls', '--all', '--json'], { cwd: scratch.sourceRoot, env });
    const afterInstall = (injected.inspectInstall || inspectCandidateInstallPolicy)(scratch.sourceRoot, execute, env);
    if (canonicalTripleJson(afterInstall) !== canonicalTripleJson(install)) fail('local_update_install_policy_changed');
    fs.renameSync(built.stagedModules, outputs.nodeModules);
    const tree = sealDependencyTreeV2(outputs.nodeModules);
    const nativeProbe = await (injected.nativeProbe || runOidTripleNativeProbe)(root, outputs.nodeModules, {
        transactionNonce: scratch.nonce, nodeModulesTreeSha256: tree.sha256, installRuntime: install.installRuntime });
    if (nativeProbe?.schema !== 'nassaj-oid-native-probe/v2' || nativeProbe.processExited !== true
        || nativeProbe.nodeModulesTreeSha256 !== tree.sha256 || nativeProbe.nodeVersion !== install.installRuntime.nodeVersion
        || nativeProbe.nodeModuleAbi !== install.installRuntime.nodeModuleAbi) fail('local_update_native_probe_unverified');
    if (hashDependencyTreeV2(outputs.nodeModules, { requireSealed: true }).sha256 !== tree.sha256) fail('local_update_dependency_changed_after_probe');
    verifyOidSourceInventory(scratch.sourceRoot, event.oid, inventory);
    const evidence = dependencyEvidence(scratch.sourceRoot, install, tree, npmList, nativeProbe);
    (injected.sealServer || sealOidTripleServerDependencies)(outputs.server, outputs.nodeModules, evidence);
    workSettled();
    capacityCheckpoint('store');
    const target = await storePrepared(root, event, outputs, built, evidence);
    removeCompletedScratch(scratch.candidateRoot);
    return target;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--oid' || args[2] !== '--sequence'
        || !/^[a-f0-9]{40}$/.test(args[1]) || !/^[1-9]\d*$/.test(args[3])) fail('local_update_invalid_candidate_arguments');
    const sequence = Number(args[3]);
    if (!Number.isSafeInteger(sequence)) fail('local_update_invalid_sequence');
    const target = await buildOidTripleCandidate({ root: process.cwd(), event: { sequence, oid: args[1],
        group: `event-${String(sequence).padStart(16, '0')}`, domains: ['client', 'server'] } });
    process.stdout.write(`${JSON.stringify(target)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${JSON.stringify({ event: 'local_update_candidate_failed', code: error.code || 'candidate_failed' })}\n`);
        process.exitCode = 1;
    });
}
