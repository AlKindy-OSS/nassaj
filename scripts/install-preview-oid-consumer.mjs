#!/usr/bin/env node
/** Reviewed enforcement transition from mutable-tree watchers to the OID consumer. */
import { accessSync, chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newestPreviewEvent, readConsumerState, withPreviewEventMutationLock } from './preview-oid-consumer.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import { gitControlPath } from './git-control-root.mjs';
import { assertOidSourceSnapshot } from './server-preview-from-oid.mjs';
import { resourcesSafe, verifyServerArtefact } from './server-build-atomic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSUMER = 'nassaj-preview-oid-consumer.service';
const LEGACY = ['nassaj-client-build-watch.service'];

function durableAudit(root, record) {
    const file = path.join(root, '.git', 'nassaj-preview-oid-enforcement-v1.json');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...record }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
}

export function enforcementPlan(root = ROOT) {
    return {
        consumer: CONSUMER,
        legacy: [...LEGACY],
        unitSource: path.join(root, 'scripts', 'systemd', CONSUMER),
        domains: ['client'],
        dropIn: {
            mode: 0o600,
            contents: '[Service]\nEnvironment=NASSAJ_PREVIEW_OID_ENFORCEMENT=1\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client\n',
        },
        transition: [
            'install unit and 0600 enforcement drop-in', 'daemon-reload',
            'enable consumer; disable legacy for next boot',
            'start consumer as one systemd Conflicts transaction',
            'verify consumer active and the client legacy unit inactive',
        ],
    };
}

/** Install immutable unit inputs while reasserting private drop-in permissions on every run. */
export function installEnforcementFiles(root, installation, home = process.env.HOME) {
    const userUnitRoot = path.join(home, '.config', 'systemd', 'user');
    mkdirSync(path.join(userUnitRoot, `${CONSUMER}.d`), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(userUnitRoot, CONSUMER), readFileSync(installation.unitSource), { mode: 0o600 });
    const destination = path.join(userUnitRoot, `${CONSUMER}.d`, 'enforcement.conf');
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, installation.dropIn.contents, {
            mode: installation.dropIn.mode, flag: 'wx',
        });
        chmodSync(temporary, installation.dropIn.mode);
        renameSync(temporary, destination);
    } finally {
        rmSync(temporary, { force: true });
    }
    return destination;
}

/** Execute only from the separately owner-authorized installer invocation. */
export function executeEnforcementTransition(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(options.approvalId || '')) throw new Error('Owner approval id is required.');
    const plan = enforcementPlan(root);
    const run = injected.run || ((args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' }));
    const install = injected.install || ((installation) => installEnforcementFiles(root, installation));
    const checked = (args) => {
        const result = run(args);
        if (result.status !== 0) throw new Error(`systemctl ${args.join(' ')} failed.`);
        return String(result.stdout || '').trim();
    };
    durableAudit(root, { state: 'prepared', approvalId: options.approvalId, plan, updatedAt: new Date().toISOString() });
    install(plan);
    checked(['daemon-reload']);
    checked(['enable', CONSUMER]);
    for (const unit of LEGACY) {
        const result = run(['disable', unit]);
        if (result.status !== 0) {
            const loadState = run(['show', '--property=LoadState', '--value', unit]);
            if (loadState.status !== 0 || String(loadState.stdout || '').trim() !== 'not-found') {
                throw new Error(`systemctl disable ${unit} failed.`);
            }
        }
    }
    // Conflicts= makes stop-old/start-new one systemd transaction. There is no
    // window in which a legacy watcher and the enforcing consumer are active.
    checked(['start', '--job-mode=replace-irreversibly', CONSUMER]);
    if (checked(['is-active', CONSUMER]) !== 'active') throw new Error('OID consumer did not become active.');
    for (const unit of LEGACY) {
        const result = run(['is-active', unit]);
        if (result.status === 0 || String(result.stdout || '').trim() === 'active') throw new Error(`${unit} remained active.`);
    }
    const completed = { state: 'active', approvalId: options.approvalId, plan, updatedAt: new Date().toISOString() };
    durableAudit(root, completed);
    return completed;
}

const SERVER_ACK = 'persistent-server-domain-including-future-events';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function checkedSystemctl(run, args) {
    const result = run(args);
    if (result.status !== 0) throw new Error(`Consumer transition systemctl ${args[0]} failed.`);
    return String(result.stdout || '').trim();
}

function ownedRegularMetadata(file) {
    if (realpathSync(file) !== path.resolve(file)) throw new Error('Transition path has a symbolic ancestor.');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.gid !== process.getgid() || (metadata.mode & 0o022)) {
        throw new Error('Transition input is not a private owned regular file.');
    }
    return metadata;
}

function regularOwnedFile(file) {
    const metadata = ownedRegularMetadata(file);
    return { bytes: readFileSync(file), mode: metadata.mode & 0o777, uid: metadata.uid, gid: metadata.gid };
}

function durableReplace(file, bytes, mode) {
    const temporary = `${file}.server-transition-${process.pid}`;
    let fd;
    try {
        fd = openSync(temporary, 'wx', mode);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        chmodSync(temporary, mode);
        renameSync(temporary, file);
        const directory = openSync(path.dirname(file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) rmSync(temporary);
    }
}

function transitionPaths(options) {
    const root = path.resolve(options.root || ROOT);
    const home = path.resolve(options.home || process.env.HOME);
    const unit = path.join(home, '.config/systemd/user', CONSUMER);
    return { root, home, unit, dropIn: `${unit}.d/enforcement.conf`,
        backup: path.join(root, '.git', 'nassaj-consumer-server-transition-v1.json') };
}

function property(run, name, unit = CONSUMER) {
    return checkedSystemctl(run, ['show', unit, `--property=${name}`, '--value']);
}

function assertEffectiveScope(run, paths, domains) {
    const env = property(run, 'Environment').split(/\s+/);
    if (property(run, 'ActiveState') !== 'active'
        || !env.includes(`NASSAJ_PREVIEW_OID_DOMAINS=${domains}`)
        || !env.includes('NASSAJ_PREVIEW_OID_ENFORCEMENT=1')
        || property(run, 'ProtectHome') !== 'read-only'
        || property(run, 'ProtectSystem') !== 'strict'
        || property(run, 'DropInPaths') !== paths.dropIn) {
        throw new Error('Consumer effective scope or hardening mismatch.');
    }
    const writable = property(run, 'ReadWritePaths').split(/\s+/).filter(Boolean).sort();
    const expected = domains === 'client' ? [paths.root] : [paths.root, paths.databaseDirectory].sort();
    if (JSON.stringify(writable) !== JSON.stringify(expected)) throw new Error('Consumer writable paths mismatch.');
    if (property(run, 'ActiveState', 'nassaj-server-build-watch.service') === 'active') {
        throw new Error('Legacy server watcher is active.');
    }
}

function assertServerEvent(paths, expectedOid, dispositionContext = null) {
    // Propagate this caller's actual disposition context, or remain blocked.
    assertNoNonterminalOidTransaction(paths.root, null, dispositionContext);
    const event = newestPreviewEvent(paths.root, 'server');
    if (!event || event.oid !== expectedOid) throw new Error('Expected OID is not the newest server event.');
    if (existsSync(gitControlPath(paths.root, 'nassaj-preview-oid-control-request-v1.json'))) {
        throw new Error('Existing owner request requires reconciliation before enabling server consumption.');
    }
    const state = readConsumerState(paths.root).server;
    if (state && !['loaded', 'rolled_back'].includes(state.phase)) {
        throw new Error('Partial server preparation requires reconciliation.');
    }
    const snapshot = path.join(paths.root, '.nassaj-local-preview/oid-snapshots', expectedOid);
    if (realpathSync(snapshot) !== snapshot) throw new Error('Snapshot ancestor substitution.');
    assertOidSourceSnapshot(paths.root, snapshot, expectedOid);
    return { sequence: event.sequence, group: event.group, oid: event.oid };
}

async function assertLoadedReadiness(paths) {
    const response = await fetch('http://127.0.0.1:3004/health', {
        headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Loaded runtime health unavailable.');
    const health = await response.json();
    if (health.status !== 'ok' || !/^[a-f0-9]{40}$/.test(health.serverLoadedOid || '')
        || !/^[a-f0-9]{64}$/.test(health.serverLoadedBuildId || '')
        || !/^[a-f0-9]{64}$/.test(health.serverTransactionNonce || '')
        || !/^[a-f0-9]{64}$/.test(health.serverBootNonce || '')
        || health.serverOidControlProtocol !== 1 || health.serverOidLauncherAbi !== 'nassaj-oid-launcher/v1') {
        throw new Error('ADR-136 loaded runtime readiness is not attested; bootstrap cannot use this transition.');
    }
    const live = path.join(paths.root, 'dist-server');
    if (realpathSync(live) !== live) throw new Error('Live artifact ancestor substitution.');
    verifyLoadedTransitionArtifact(live, health, paths.root);
    return { oid: health.serverLoadedOid, buildId: health.serverLoadedBuildId,
        controlManifestSha256: sha256(readFileSync(path.join(live, 'OID_CONTROL_MANIFEST.json'))) };
}

/** Bind validation to the loaded provenance version, never the mutable project's next version. */
export function verifyLoadedTransitionArtifact(live, health, root, verify = verifyServerArtefact) {
    const file = path.join(live, 'BUILD_PROVENANCE.json');
    const before = readFileSync(file);
    const provenance = JSON.parse(before);
    if (provenance.artifact !== 'server' || provenance.dirty !== false
        || provenance.commit !== health.serverLoadedOid || provenance.baseCommit !== provenance.commit
        || provenance.buildId !== health.serverLoadedBuildId || !/^\d+\.\d+\.\d+\.\d+$/.test(provenance.version || '')) {
        throw new Error('Loaded provenance does not match the attested runtime.');
    }
    verify(live, { root, version: provenance.version,
        expectedCommit: health.serverLoadedOid, expectedBuildId: health.serverLoadedBuildId });
    if (!before.equals(readFileSync(file))) throw new Error('Loaded provenance changed during verification.');
}

/** Aggregate simultaneous allocations on actual devices and reject unknown or memory-backed capacity. */
export function assertTransitionStorageCapacity(requirements, fs = { statfsSync, statSync }) {
    const devices = new Map();
    for (const { directory, bytes } of requirements) {
        const space = fs.statfsSync(directory);
        const dev = fs.statSync(directory).dev;
        if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(space.type) || space.type === 0x01021994
            || !Number.isSafeInteger(space.bavail) || space.bavail < 0
            || !Number.isSafeInteger(space.bsize) || space.bsize <= 0
            || !Number.isSafeInteger(bytes) || bytes < 0
            || !Number.isSafeInteger(space.bavail * space.bsize)) {
            throw new Error('Storage capacity is unknown, invalid, or tmpfs.');
        }
        const previous = devices.get(dev) || { required: 0, available: Infinity };
        const required = previous.required + bytes;
        if (!Number.isSafeInteger(required)) throw new Error('Storage allocation estimate overflow.');
        devices.set(dev, { required, available: Math.min(previous.available, space.bavail * space.bsize) });
    }
    for (const { required, available } of devices.values()) {
        if (available < required) throw new Error('Insufficient aggregate usable disk capacity.');
    }
    return [...devices.values()];
}

async function databaseCapacity(paths) {
    await import('../server/load-env.js');
    const database = path.resolve(process.env.DATABASE_PATH || '');
    const directory = path.dirname(database);
    const allowed = path.join(paths.home, '.local/share/nassaj-dev');
    if (directory !== allowed || realpathSync(directory) !== directory || realpathSync(database) !== database) {
        throw new Error('Database is outside the reviewed narrow directory or has symbolic ancestry.');
    }
    ownedRegularMetadata(database);
    accessSync(database, constants.R_OK | constants.W_OK);
    const metadata = statSync(directory);
    if (metadata.uid !== process.getuid() || (metadata.mode & 0o022)) throw new Error('Database directory ownership/mode is unsafe.');
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    const walPath = `${database}-wal`;
    if (existsSync(walPath)) ownedRegularMetadata(walPath);
    const wal = existsSync(walPath) ? statSync(walPath).size : 0;
    const requirements = [
        { directory: paths.root, bytes: 128 * 1024 * 1024 },
        { directory, bytes: 256 * 1024 * 1024 + 2 * statSync(database).size + 2 * wal },
        { directory: '/var/tmp', bytes: 128 * 1024 * 1024 },
    ];
    return { directory, devices: assertTransitionStorageCapacity(requirements) };
}

/** Read-only default: validate the exact event, runtime, configuration and recovery headroom. */
export async function inspectServerDomainTransition(options, injected = {}) {
    if (!/^[a-f0-9]{40}$/.test(options.expectedOid || '')) throw new Error('Full expected OID is required.');
    if (options.persistentAcknowledgment !== SERVER_ACK) throw new Error('Explicit persistent server-domain acknowledgment is required.');
    const paths = transitionPaths(options);
    if (realpathSync(paths.root) !== paths.root || realpathSync(path.join(paths.root, '.git')) !== path.join(paths.root, '.git')) {
        throw new Error('Transition requires the real live root and Git control directory.');
    }
    const run = injected.run || ((args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' }));
    const original = regularOwnedFile(paths.dropIn);
    if (original.mode !== 0o600 || original.bytes.toString() !== enforcementPlan(paths.root).dropIn.contents) {
        throw new Error('Existing enforcement drop-in is not the exact reviewed client-only configuration.');
    }
    const unit = regularOwnedFile(paths.unit);
    if (!unit.bytes.equals(readFileSync(path.join(paths.root, 'scripts/systemd', CONSUMER)))) {
        throw new Error('Installed unit differs from the reviewed source.');
    }
    if (existsSync(paths.backup)) throw new Error('Retained transition evidence requires operator review; refusing overwrite.');
    assertEffectiveScope(run, paths, 'client');
    if (!(injected.resourcesSafe || resourcesSafe)()) throw new Error('CPU or RAM utilization reached 80%.');
    const event = (injected.assertEvent || assertServerEvent)(paths, options.expectedOid, options.disposition || null);
    const readiness = await (injected.readiness || assertLoadedReadiness)(paths);
    const capacity = await (injected.capacity || databaseCapacity)(paths);
    const proposed = `[Service]\nEnvironment=NASSAJ_PREVIEW_OID_ENFORCEMENT=1\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client,server\nReadWritePaths=${capacity.directory}\n`;
    return { paths: { ...paths, databaseDirectory: capacity.directory }, event, readiness, capacity,
        original: { ...original, bytes: original.bytes.toString(), sha256: sha256(original.bytes) },
        unitSha256: sha256(unit.bytes), proposed, proposedSha256: sha256(proposed) };
}

function assertUnchangedConfiguration(plan) {
    if (sha256(regularOwnedFile(plan.paths.dropIn).bytes) !== plan.original.sha256
        || sha256(regularOwnedFile(plan.paths.unit).bytes) !== plan.unitSha256) {
        throw new Error('Configuration changed after preflight.');
    }
}

function writeTransitionEvidence(file, record) {
    durableReplace(file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/** Apply only an explicitly approved persistent scope transition; preserve all runtime/DB evidence. */
export async function executeServerDomainTransition(options, injected = {}) {
    const inspect = injected.inspect || inspectServerDomainTransition;
    const plan = await inspect(options, injected);
    if (options.execute !== true) return { state: 'dry_run', executionBlocked: 'consumer_quiescence_protocol_absent', plan };
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(options.approvalId || '')) throw new Error('Owner approval id is required.');
    const lock = injected.lock || withPreviewEventMutationLock;
    const run = injected.run || ((args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' }));
    // There is no production quiescence protocol today: the OID client builder
    // takes the event lock only during promotion. Never kill a possible build
    // by interpreting that lock or a momentary idle state as a drain receipt.
    // This dependency injection is solely for fake-systemctl transition tests;
    // no CLI flag or environment variable supplies an execution bypass.
    const quiescence = injected.withQuiescence || (() => {
        throw new Error('consumer_quiescence_protocol_absent: execution is unavailable until a reviewed continuous drain exists.');
    });
    return quiescence(() => lock(plan.paths.root, async () => {
        const fresh = await inspect(options, injected);
        if (JSON.stringify(fresh.event) !== JSON.stringify(plan.event)) throw new Error('Server event changed after preflight.');
        assertUnchangedConfiguration(fresh);
        const record = { schemaVersion: 1, approvalId: options.approvalId, state: 'prepared', plan: fresh };
        writeTransitionEvidence(fresh.paths.backup, record);
        try {
            durableReplace(fresh.paths.dropIn, fresh.proposed, 0o600);
            checkedSystemctl(run, ['daemon-reload']);
            checkedSystemctl(run, ['restart', CONSUMER]);
            assertEffectiveScope(run, fresh.paths, 'client,server');
            record.state = 'enabled_pending_preparation';
            writeTransitionEvidence(fresh.paths.backup, record);
            return { state: record.state, evidence: fresh.paths.backup, expectedOid: fresh.event.oid };
        } catch (error) {
            try {
                const current = sha256(regularOwnedFile(fresh.paths.dropIn).bytes);
                if (![fresh.proposedSha256, fresh.original.sha256].includes(current)) throw new Error('Concurrent drop-in change; manual recovery required.');
                durableReplace(fresh.paths.dropIn, fresh.original.bytes, fresh.original.mode);
                checkedSystemctl(run, ['daemon-reload']);
                checkedSystemctl(run, ['restart', CONSUMER]);
                assertEffectiveScope(run, fresh.paths, 'client');
                record.state = 'rolled_back_configuration_only';
            } catch { record.state = 'manual_recovery_required'; }
            writeTransitionEvidence(fresh.paths.backup, record);
            throw new Error(`Consumer scope transition failed: ${record.state}.`, { cause: error });
        }
    }));
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--local-recovery-offline')) {
        const value = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
        const { executeOfflineConsumerTransition } = await import('./lib/local-recovery-consumer-transition.mjs');
        const result = await executeOfflineConsumerTransition({ root: ROOT, execute: argv.includes('--execute'),
            rollback: argv.includes('--rollback'), packetPath: value('--packet'), packetSha256: value('--packet-sha256') });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (argv.includes('--server-domain')) {
        const value = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
        const result = await executeServerDomainTransition({ execute: argv.includes('--execute'),
            expectedOid: value('--expected-oid'), approvalId: value('--approval-id'),
            persistentAcknowledgment: value('--persistent-ack') });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (!argv.includes('--execute')) {
        process.stdout.write(`${JSON.stringify(enforcementPlan(), null, 2)}\n`);
        return;
    }
    const index = argv.indexOf('--approval-id');
    executeEnforcementTransition({ approvalId: index >= 0 ? argv[index + 1] : null });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
