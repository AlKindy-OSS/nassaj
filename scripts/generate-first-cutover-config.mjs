#!/usr/bin/env node
/**
 * Generate the release-runtime first-cutover operator inputs from real node state,
 * WITHOUT root and WITHOUT hand-authoring any digest.
 *
 * It derives every value it can prove deterministically from the prepared generation,
 * the release manifest, and the live PM2/`/proc` state, using the SAME `sha`/`canonical`
 * primitives as `lib/release-runtime-cutover.mjs` and `mint-cutover-approval.mjs`.
 *
 * Values that cannot be measured by the unprivileged service user — because they are
 * digests of root-owned system material or of author-declared `liveIdentity` file sets
 * that only exist after the root host-support step materialises them — are NOT invented.
 * They are accepted as explicit flags and, when absent, reported as `missing` and the
 * config is emitted with an `.INCOMPLETE.json` suffix so it can never be pasted as final.
 *
 * Emitted (into --out-dir, mode 0600):
 *   - pm2-snapshot.json                      (schema nassaj-pm2-snapshot/v1, for the prepare block)
 *   - release-runtime-first-cutover.json     (or .INCOMPLETE.json when any expected hash is missing)
 *   - release-runtime-host.template.json     (annotated big-config skeleton; ROOT_REQUIRED markers)
 *   - GENERATION_REPORT.json                 (computed vs missing, with sources)
 */
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFirstForwardConfiguration } from './lib/prepare-first-forward-config.mjs';
import { prepareForwardStartupAuthorityFromFile } from './lib/release-runtime-public-descriptor.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
const CONFIG_SCHEMA = 'nassaj-release-runtime-first-cutover-config/v1';
const HOST_SCHEMA = 'nassaj-release-runtime-host-config/v1';
const PM2_SNAPSHOT_SCHEMA = 'nassaj-pm2-snapshot/v1';
const ROOT_REQUIRED = '<<ROOT_REQUIRED>>';

/** SHA-256 hex — byte-identical to the verifier and mint primitives. */
export function sha(value) { return createHash('sha256').update(value).digest('hex'); }

/** Canonical serialisation — byte-identical to canonical() in lib/release-runtime-cutover.mjs. */
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** ownerApprovalKeySha256 — identical derivation to mint/verifier: SHA-256 of the SPKI DER public key. */
export function ownerApprovalKeySha256FromPublicKeyPem(pem) {
    const publicKey = createPublicKey(pem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('owner_public_key_not_ed25519');
    return sha(publicKey.export({ type: 'spki', format: 'der' }));
}

/** expectedSha256 the approval will carry: sha(canonical(expected)). Only meaningful when expected is complete. */
export function expectedSha256(expected) { return sha(canonical(expected)); }

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }

function procIdentity(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    return { pid, state: fields[0], pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19] };
}

function pm2Entry(jlist, name) {
    const list = JSON.parse(jlist);
    const entry = list.find((item) => item.name === name);
    if (!entry) throw new Error(`pm2_process_not_found:${name}`);
    const env = entry.pm2_env || {};
    return {
        pid: entry.pid, name: entry.name, pmExecPath: env.pm_exec_path, cwd: env.pm_cwd,
        killTimeout: env.kill_timeout, treeKill: env.treekill, status: env.status,
    };
}

function writePrivate(file, bytes) {
    const fd = openSync(file, 'w', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function writeJsonPrivate(file, value) { writePrivate(file, `${JSON.stringify(value, null, 2)}\n`); }

/** Build the derivable expected block plus a report of what is missing and why. */
export function buildExpected(inputs) {
    const { manifest, generationRecord, generationId, nodeInstanceId, pm2SnapshotSha256, ownerPublicKeyPem,
        hostIdentitySha256, migrationIdentitySha256, databaseContractSha256 } = inputs;
    const db = manifest.databaseContract || {};
    const identity = generationRecord.identity || {};
    const derived = {
        nodeInstanceId,
        generationId,
        targetSchemaDigest: db.targetSchemaDigest,
        serverBuildId: manifest.serverBuildId,
        clientBuildId: manifest.clientBuildId,
        releaseIdentitySha256: db.releaseIdentitySha256,
        assetSha256: identity.assetSha256 || identity.archiveSha256,
        pm2SnapshotSha256,
    };
    const supplied = {
        hostIdentitySha256: hostIdentitySha256 || null,
        migrationIdentitySha256: migrationIdentitySha256 || null,
        databaseContractSha256: databaseContractSha256 || null,
        ownerApprovalKeySha256: ownerPublicKeyPem ? ownerApprovalKeySha256FromPublicKeyPem(ownerPublicKeyPem) : null,
    };
    const expected = { ...derived, ...supplied };
    const sources = {
        nodeInstanceId: 'deploy-root/control/node-instance-id',
        generationId: 'deploy-root/current -> releases/<generationId>',
        targetSchemaDigest: 'manifest.databaseContract.targetSchemaDigest',
        serverBuildId: 'manifest.serverBuildId',
        clientBuildId: 'manifest.clientBuildId',
        releaseIdentitySha256: 'manifest.databaseContract.releaseIdentitySha256',
        assetSha256: 'generation runtime-generation.json identity.assetSha256',
        pm2SnapshotSha256: 'sha256(pm2-snapshot.json emitted here)',
        hostIdentitySha256: '--host-identity-sha256 (root: measureIdentity(liveIdentity.host))',
        migrationIdentitySha256: '--migration-identity-sha256 (root: measureIdentity(liveIdentity.migration))',
        databaseContractSha256: '--database-contract-sha256 (root: sha256 of materialised migration contract file)',
        ownerApprovalKeySha256: '--owner-public-key (sha256 of SPKI DER)',
    };
    const missing = Object.entries(expected).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
    // Format sanity for the values we DID derive (mirrors the verifier's validateExpected shape).
    const bad = [];
    if (!INSTANCE.test(expected.nodeInstanceId || '')) bad.push('nodeInstanceId');
    if (!INSTANCE.test(expected.generationId || '')) bad.push('generationId');
    for (const k of ['targetSchemaDigest', 'serverBuildId', 'clientBuildId', 'releaseIdentitySha256', 'assetSha256', 'pm2SnapshotSha256']) {
        if (!HEX64.test(expected[k] || '')) bad.push(k);
    }
    for (const k of ['hostIdentitySha256', 'migrationIdentitySha256', 'databaseContractSha256', 'ownerApprovalKeySha256']) {
        if (expected[k] !== null && !HEX64.test(expected[k])) bad.push(k);
    }
    if (bad.length) throw new Error(`derived_expected_malformed:${bad.join(',')}`);
    return { expected, sources, missing, complete: missing.length === 0 };
}

function hostConfigTemplate(inputs, expected) {
    const { legacyRoot, databaseFile, controlRoot, oldProcess, pmExecPath, runtimeRoot, nodeInstanceIdFile, launcher } = inputs;
    return {
        schema: HOST_SCHEMA,
        expected,
        oldProcess: { pid: oldProcess.pid, pgid: oldProcess.pgid, sid: oldProcess.sid, startTime: oldProcess.startTime,
            killTimeout: oldProcess.killTimeout, treeKill: oldProcess.treeKill },
        controlRoot,
        databaseFile,
        pm2: {
            binary: ROOT_REQUIRED, binarySha256: ROOT_REQUIRED, home: ROOT_REQUIRED,
            launcher, launcherSha256: ROOT_REQUIRED, oldName: 'nassaj-dev', targetName: 'nassaj-dev',
            oldSnapshot: `${controlRoot}/pm2-resurrect.json  (ROOT: real \`pm2 save\` dump; sha256 == expected.pm2SnapshotSha256)`,
            cwd: runtimeRoot, interpreter: pmExecPath ? 'node' : ROOT_REQUIRED,
        },
        migration: {
            node: { file: ROOT_REQUIRED, sha256: ROOT_REQUIRED },
            entry: { file: ROOT_REQUIRED, sha256: ROOT_REQUIRED },
            contractFile: ROOT_REQUIRED, contractSha256: expected.databaseContractSha256 || ROOT_REQUIRED,
            runtimeRoot, nodeModulesRoot: `${runtimeRoot}/node_modules`,
            providerSecretsKeyFile: ROOT_REQUIRED, secretCapabilityFile: ROOT_REQUIRED,
            serviceUid: ROOT_REQUIRED, serviceGid: ROOT_REQUIRED, timeoutMs: 300000,
        },
        maintenance: {
            nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderUnit: 'nassaj-maintenance.service',
            responderPort: 3311,
            cloudflared: { uid: ROOT_REQUIRED, originPort: ROOT_REQUIRED, originHost: '127.0.0.1',
                pid: ROOT_REQUIRED, startTime: ROOT_REQUIRED, executable: '/usr/local/bin/cloudflared',
                executableSha256: ROOT_REQUIRED, configFile: '/etc/cloudflared/config.yml', configSha256: ROOT_REQUIRED,
                unit: 'cloudflared.service', effectiveUnit: ROOT_REQUIRED },
            nft: { binary: ROOT_REQUIRED, sha256: ROOT_REQUIRED },
            conntrack: { binary: ROOT_REQUIRED, sha256: ROOT_REQUIRED },
            responderEffectiveUnit: ROOT_REQUIRED,
        },
        zeroWorkProbe: { file: ROOT_REQUIRED, sha256: ROOT_REQUIRED, args: [], timeoutMs: 30000 },
        health: { privateUrl: 'http://127.0.0.1:3004/health', publicUrl: 'https://nassaj.example.com/health' },
        liveIdentity: {
            nodeInstanceIdFile,
            host: ROOT_REQUIRED, release: ROOT_REQUIRED, migration: ROOT_REQUIRED,
            databaseContract: ROOT_REQUIRED, asset: ROOT_REQUIRED,
        },
        preMigrationBackupFile: `${controlRoot}/pre-migration.sqlite`,
        finalBackupFile: `${controlRoot}/final-backup.sqlite`,
    };
}

export function generate(options) {
    const deployRoot = realpathSync(options.deployRoot);
    const currentLink = path.join(deployRoot, 'current');
    const generationId = path.basename(readlinkSync(currentLink));
    if (!INSTANCE.test(generationId)) throw new Error('generation_id_invalid');
    const generationDir = path.join(deployRoot, 'releases', generationId);
    const manifest = readJson(path.join(generationDir, 'RELEASE_ASSET_MANIFEST.json'));
    const generationRecord = readJson(path.join(generationDir, 'runtime-generation.json'));
    const controlRoot = path.join(deployRoot, 'control');
    const nodeInstanceIdFile = path.join(controlRoot, 'node-instance-id');
    const nodeInstanceId = readFileSync(nodeInstanceIdFile, 'utf8').trim();
    const launcher = path.join(deployRoot, 'launcher', 'nassaj-release-launcher.mjs');

    const jlist = options.pm2JlistFile ? readFileSync(options.pm2JlistFile, 'utf8')
        : execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const pm2 = pm2Entry(jlist, options.pm2Name);
    const proc = procIdentity(pm2.pid);
    const oldProcess = { pid: pm2.pid, pgid: proc.pgid, sid: proc.sid, startTime: proc.startTime,
        killTimeout: pm2.killTimeout, treeKill: pm2.treeKill };

    const legacyHead = options.legacyHead || execFileSync('git', ['-C', options.legacyRoot, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' }).trim();
    if (!HEX40.test(legacyHead)) throw new Error('legacy_head_invalid');

    // PM2 snapshot used by the prepare block (prepare-legacy schema). Its bytes define pm2SnapshotSha256.
    const pm2Snapshot = { schema: PM2_SNAPSHOT_SCHEMA, name: pm2.name, pmExecPath: pm2.pmExecPath,
        killTimeout: pm2.killTimeout };
    const pm2SnapshotBytes = `${JSON.stringify(pm2Snapshot, null, 2)}\n`;
    const pm2SnapshotSha256 = sha(pm2SnapshotBytes);

    const ownerPublicKeyPem = options.ownerPublicKeyFile ? readFileSync(options.ownerPublicKeyFile, 'utf8') : null;

    const { expected, sources, missing, complete } = buildExpected({
        manifest, generationRecord, generationId, nodeInstanceId, pm2SnapshotSha256, ownerPublicKeyPem,
        hostIdentitySha256: options.hostIdentitySha256, migrationIdentitySha256: options.migrationIdentitySha256,
        databaseContractSha256: options.databaseContractSha256,
    });

    const etcControlRoot = options.etcControlRoot || controlRoot; // where the config will live at run time
    const firstCutover = {
        schema: CONFIG_SCHEMA,
        approvalFile: `${etcControlRoot}/owner-cutover-approval.json`,
        controlRoot,
        dispatcher: options.dispatcher,
        dispatcherSha256: options.dispatcherSha256,
        expected,
        ownerApprovalPublicKeyFile: options.ownerApprovalPublicKeyFile || `${options.etcNassaj || '/etc/nassaj'}/owner-approval.pub`,
        prepare: {
            legacyRoot: options.legacyRoot,
            deployRoot,
            releaseIdentitySha256: expected.releaseIdentitySha256,
            legacyHead,
            nodeInstanceId,
            pm2SnapshotFile: `${options.etcNassaj || '/etc/nassaj'}/pm2-snapshot.json`,
            configFiles: options.configFiles || [],
            databaseFile: options.databaseFile,
        },
    };

    const hostTemplate = hostConfigTemplate({
        legacyRoot: options.legacyRoot, databaseFile: options.databaseFile, controlRoot,
        oldProcess, pmExecPath: pm2.pmExecPath, runtimeRoot: generationDir, nodeInstanceIdFile, launcher,
    }, expected);

    const report = {
        schema: 'nassaj-first-cutover-generation-report/v1',
        generatedAt: new Date().toISOString(),
        deployRoot, generationId, legacyHead, complete,
        expected, expectedSources: sources, missingExpectedKeys: missing,
        expectedSha256: complete ? expectedSha256(expected) : null,
        oldProcess, sessionLeader: oldProcess.pid === oldProcess.pgid && oldProcess.pid === oldProcess.sid,
        killTimeoutMeetsContract: oldProcess.killTimeout >= 86_400_000,
        treeKillOk: oldProcess.treeKill === false,
        notes: [
            'validateExpected in the verifier checks FORMAT only; real binding happens at cutover via measureLiveFacts (root).',
            'hostIdentitySha256 / migrationIdentitySha256 / databaseContractSha256 are digests of root-owned/author-declared '
                + 'files that do not exist for the unprivileged user; supply them via flags once the root host-support step '
                + 'materialises them, or this config stays INCOMPLETE.',
            'OWNERSHIP: the reviewed cutover requires the deploy-root, launcher and control to be root-owned (uid 0). The '
                + 'unprivileged prepared layout is ibrahim-owned; the operator must chown it to root (or re-run prepare as root) '
                + 'before running cutover prepare/execute.',
        ],
    };
    return { expected, firstCutover, hostTemplate, report, pm2Snapshot, pm2SnapshotBytes, pm2SnapshotSha256, complete };
}

function writeOutputs(outDir, result) {
    const suffix = result.complete ? '.json' : '.INCOMPLETE.json';
    writePrivate(path.join(outDir, 'pm2-snapshot.json'), result.pm2SnapshotBytes);
    writeJsonPrivate(path.join(outDir, `release-runtime-first-cutover${suffix}`), result.firstCutover);
    writeJsonPrivate(path.join(outDir, 'release-runtime-host.template.json'), result.hostTemplate);
    writeJsonPrivate(path.join(outDir, 'GENERATION_REPORT.json'), result.report);
    return suffix;
}

/** Stage both verified forward files with exact modes even under a restrictive operator umask. */
export function writeForwardStartupOutputs(outDir, prepared) {
    for (const [name, bytes, mode] of [['release-runtime-host.forward.json', prepared.privateConfig, 0o600],
        ['startup-admission-client.json', prepared.publicDescriptor, 0o644]]) {
        const fd = openSync(path.join(outDir, name), 'wx', mode);
        try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const directory = openSync(outDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}

function argument(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }
function argList(argv, flag) { const v = argument(argv, flag); return v ? v.split(',').filter(Boolean) : []; }

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node scripts/generate-first-cutover-config.mjs --deploy-root ABS --database ABS '
            + '--dispatcher ABS --dispatcher-sha256 HEX64 --out-dir ABS [--legacy-root ABS] [--pm2-name NAME] '
            + '[--pm2-jlist-file ABS] [--legacy-head SHA40] [--config-files a,b] [--etc-nassaj ABS] '
            + '[--owner-public-key ABS] [--host-identity-sha256 HEX64] [--migration-identity-sha256 HEX64] '
            + '[--database-contract-sha256 HEX64]\n'
            + 'Forward: node scripts/generate-first-cutover-config.mjs --prepare-forward-config-inputs ABS_PRIVATE_JSON\n');
        return;
    }
    const completeInput=argument(argv,'--prepare-forward-config-inputs');
    if(completeInput){
        if(argv.length!==2 || !path.isAbsolute(completeInput) || realpathSync(completeInput)!==completeInput)throw Error('forward_prepare_arguments');
        const info=lstatSync(completeInput);if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o777)!==0o600)throw Error('forward_prepare_input_file');
        const result=await generateFirstForwardConfiguration(readJson(completeInput));
        process.stdout.write(`${JSON.stringify(result)}\n`);if(!result.complete)process.exitCode=2;return;
    }
    const outDir = argument(argv, '--out-dir');
    if (!outDir || !path.isAbsolute(outDir)) throw new Error('out_dir_absolute_required');
    if (!existsSync(outDir) || !lstatSync(outDir).isDirectory()) throw new Error('out_dir_missing');
    const forwardInput = argument(argv, '--prepare-forward-startup-inputs');
    if (forwardInput) {
        if (realpathSync(outDir) !== outDir) throw new Error('forward_output_path_unsafe');
        for (let directory = outDir; ; directory = path.dirname(directory)) {
            const info = lstatSync(directory);
            if (info.uid !== 0 || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('forward_output_directory_unsafe');
            if (directory === path.dirname(directory)) break;
        }
        const prepared = prepareForwardStartupAuthorityFromFile(forwardInput);
        writeForwardStartupOutputs(outDir, prepared);
        process.stdout.write('Forward startup inputs prepared; no authority installed or admission granted.\n');
        return;
    }
    const result = generate({
        deployRoot: argument(argv, '--deploy-root'),
        legacyRoot: argument(argv, '--legacy-root') || '/opt/nassaj',
        databaseFile: argument(argv, '--database'),
        dispatcher: argument(argv, '--dispatcher'),
        dispatcherSha256: argument(argv, '--dispatcher-sha256'),
        pm2Name: argument(argv, '--pm2-name') || 'nassaj-dev',
        pm2JlistFile: argument(argv, '--pm2-jlist-file'),
        legacyHead: argument(argv, '--legacy-head'),
        configFiles: argList(argv, '--config-files'),
        etcNassaj: argument(argv, '--etc-nassaj') || '/etc/nassaj',
        ownerPublicKeyFile: argument(argv, '--owner-public-key'),
        ownerApprovalPublicKeyFile: argument(argv, '--owner-approval-public-key-file'),
        hostIdentitySha256: argument(argv, '--host-identity-sha256'),
        migrationIdentitySha256: argument(argv, '--migration-identity-sha256'),
        databaseContractSha256: argument(argv, '--database-contract-sha256'),
    });
    const suffix = writeOutputs(outDir, result);
    process.stdout.write(`${JSON.stringify({ complete: result.complete,
        wrote: `release-runtime-first-cutover${suffix}`, missingExpectedKeys: result.report.missingExpectedKeys,
        pm2SnapshotSha256: result.pm2SnapshotSha256, expectedSha256: result.report.expectedSha256,
        sessionLeader: result.report.sessionLeader }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); } catch (error) { process.stderr.write(`[generate-first-cutover-config] ${error.message}\n`); process.exitCode = 1; }
}
