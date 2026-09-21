/** One-time bootstrap scope inside the reviewed operational packet; event control remains the sole step record. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitControlPath } from '../git-control-root.mjs';
import { resolveNodeUpdateMode } from './node-update-mode.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw new Error(`bootstrap_publication_${reason}`); };
const KEYS = ['schema', 'root', 'nodeIdentity', 'serviceUid', 'oid', 'sequence', 'group', 'clientBuildId', 'serverBuildId',
    'oldPid', 'oldStartTicks', 'healthOrigin', 'oldLoadedBuildId', 'oldCapsuleSha256', 'oldSafeRestartSha256', 'configBindingSha256', 'approvalReference', 'reservationReference'];
const hashes = ['clientBuildId', 'serverBuildId', 'oldLoadedBuildId', 'oldCapsuleSha256', 'oldSafeRestartSha256', 'configBindingSha256'];
const pin = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.ctimeMs];
function privateFile(file, privateOnly = true) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (privateOnly ? (before.mode & 0o777) !== 0o600 : Boolean(before.mode & 0o022))
            || before.size > (privateOnly ? 64 * 1024 : 4 * 1024 * 1024)) fail('packet_file_unsafe');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (JSON.stringify(pin(before)) !== JSON.stringify(pin(after))
            || JSON.stringify(pin(after)) !== JSON.stringify(pin(fs.lstatSync(file)))) fail('packet_changed');
        return bytes;
    } finally { fs.closeSync(fd); }
}
function packetDirectory(root, file) {
    if (path.dirname(file) === root || fs.realpathSync(root) !== root || !file.startsWith(`${root}${path.sep}`) || fs.realpathSync(file) !== file) fail('packet_path');
    let current = path.dirname(file), first = true;
    while (current !== root) {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
            || (first ? (stat.mode & 0o777) !== 0o700 : Boolean(stat.mode & 0o022))) fail('packet_parent_unsafe');
        first = false; current = path.dirname(current);
    }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o022) fail('root_unsafe');
}
/** Validate immutable packet bytes and the exact final main commit before granting a bounded operation. */
export function readBootstrapPublicationPacket(root, filename) {
    root = path.resolve(root);
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('packet_required');
    packetDirectory(root, filename);
    if (resolveNodeUpdateMode(root) !== 'release') fail('release_mode_required');
    const bytes = privateFile(filename);
    let packet; try { packet = JSON.parse(bytes); } catch { fail('packet_json_invalid'); }
    const scope = packet.bootstrapPublication;
    if (packet.schema !== 'nassaj-bootstrap-operation-packet/v1' || !scope || scope.schema !== 'nassaj-bootstrap-publication/v1'
        || Object.keys(scope).sort().join(',') !== [...KEYS].sort().join(',')) fail('packet_schema');
    if (scope.root !== root || scope.serviceUid !== process.getuid() || scope.nodeIdentity !== os.hostname()
        || !Number.isSafeInteger(scope.oldPid) || scope.oldPid < 2 || !/^[1-9][0-9]*$/.test(scope.oldStartTicks || '')
        || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(scope.healthOrigin || '') || Number(scope.healthOrigin.split(':').at(-1)) > 65535 || !/^[a-f0-9]{40}$/.test(scope.oid || '')
        || !Number.isSafeInteger(scope.sequence) || scope.sequence < 1 || scope.group !== `event-${String(scope.sequence).padStart(16, '0')}`
        || hashes.some(key => !/^[a-f0-9]{64}$/.test(scope[key] || ''))
        || ['nodeIdentity', 'approvalReference', 'reservationReference'].some(key => !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/.test(scope[key] || ''))) fail('packet_identity');
    if (packet.configBinding?.schema !== 'nassaj-bootstrap-config-binding/v1'
        || packet.configBinding.root !== root || packet.configBinding.oid !== scope.oid
        || packet.configBinding.approvalReference !== scope.approvalReference
        || packet.configBinding.reservationReference !== scope.reservationReference
        || sha(Buffer.from(JSON.stringify(packet.configBinding))) !== scope.configBindingSha256) fail('config_binding');
    const main = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim();
    if (main !== scope.oid) fail('main_changed');
    return { file: filename, sha256: sha(bytes), scope, database: packet.configBinding.database };
}
/** Recheck packet and exact operation arguments, rejecting mutable caller overrides. */
export function assertBootstrapPublicationContext(root, binding, expected) {
    const current = readBootstrapPublicationPacket(root, binding.file);
    if (current.sha256 !== binding.sha256) fail('packet_changed');
    for (const [key, value] of Object.entries(expected)) if (current.scope[key] !== value) fail(`context_${key}`);
    return current;
}
const eventPath = (root, sequence) => gitControlPath(root, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`);
/** Read the bootstrap section of the existing event control; never infer authorization from its absence. */
export function readBootstrapPublicationState(root, binding) {
    const file = eventPath(root, binding.scope.sequence);
    const control = readEventControl(root, file);
    if (control.localUpdate || (control.oid && control.oid !== binding.scope.oid)
        || (control.sequence && control.sequence !== binding.scope.sequence)) fail('event_context');
    const state = control.bootstrapPublication;
    if (state && (state.packetSha256 !== binding.sha256 || state.configBindingSha256 !== binding.scope.configBindingSha256)) fail('event_binding');
    if (state?.terminal || ['loaded', 'rolled_back'].includes(control.phase)) fail('terminal');
    return state || null;
}
/** Persist one bounded step in existing event control; caller must hold its existing event mutation lock. */
export function recordBootstrapPublicationState(root, binding, changes) {
    assertBootstrapPublicationContext(root, binding, {});
    const previous = readBootstrapPublicationState(root, binding) || {};
    const file = eventPath(root, binding.scope.sequence);
    const control = readEventControl(root, file);
    const original = fs.existsSync(file) ? privateFile(file) : null;
    const originalIdentity = original ? pin(fs.lstatSync(file)) : null;
    const next = `${file}.bootstrap-${process.pid}.tmp`, value = { ...control,
        schema: 'nassaj-oid-control-event/v1', sequence: binding.scope.sequence, oid: binding.scope.oid,
        bootstrapPublication: { ...previous, packetSha256: binding.sha256, configBindingSha256: binding.scope.configBindingSha256, ...changes } };
    const fd = fs.openSync(next, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const current = fs.existsSync(file) ? privateFile(file) : null;
    if (original ? !current?.equals(original) || JSON.stringify(pin(fs.lstatSync(file))) !== JSON.stringify(originalIdentity) : current !== null) { fs.unlinkSync(next); fail('event_changed'); }
    fs.renameSync(next, file);
    const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return value.bootstrapPublication;
}

function readEventControl(root, file) {
    const parent = path.dirname(file), stat = fs.lstatSync(parent);
    if (fs.realpathSync(parent) !== parent || !stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o002) fail('event_parent_unsafe');
    if (stat.mode & 0o020) {
        const passwd = execFileSync('getent', ['passwd'], { encoding: 'utf8' }).trim().split('\n').map(row => row.split(':'));
        const group = execFileSync('getent', ['group', String(stat.gid)], { encoding: 'utf8' }).trim().split(':');
        const members = new Set((group[3] || '').split(',').filter(Boolean));
        if (passwd.some(row => (Number(row[3]) === stat.gid || members.has(row[0])) && Number(row[2]) !== process.getuid())
            || [...members].some(name => !passwd.some(row => row[0] === name && Number(row[2]) === process.getuid()))) fail('event_group_writers');
    }
    if (!parent.startsWith(`${root}${path.sep}`)) fail('event_parent_outside_root');
    try { return JSON.parse(privateFile(file)); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/** Revalidate the still-loaded old service and its actual on-disk executor before a bootstrap effect. */
export async function assertBootstrapLoadedRuntime(root, binding) {
    const current = assertBootstrapPublicationContext(root, binding, {});
    verifyBootstrapDatabase(root, current.scope, current.database);
    const scope = binding.scope, proc = `/proc/${scope.oldPid}`;
    const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (ticks !== scope.oldStartTicks || fs.statSync(proc).uid !== scope.serviceUid || fs.realpathSync(`${proc}/cwd`) !== root) fail('runtime_process_changed');
    const live = path.join(root, 'dist-server');
    if (fs.realpathSync(live) !== live || fs.realpathSync(path.join(live, 'scripts')) !== path.join(live, 'scripts')) fail('runtime_artifact_path');
    const manifest = JSON.parse(privateFile(path.join(live, 'OID_CONTROL_MANIFEST.json'), false));
    const provenance = JSON.parse(privateFile(path.join(live, 'BUILD_PROVENANCE.json'), false));
    if (provenance.buildId !== scope.oldLoadedBuildId || manifest.serverBuildId !== scope.oldLoadedBuildId
        || manifest.capsuleSha256 !== scope.oldCapsuleSha256 || manifest.safeRestartSha256 !== scope.oldSafeRestartSha256
        || sha(privateFile(path.join(live, 'OID_CONTROL_CAPSULE.mjs'), false)) !== scope.oldCapsuleSha256
        || sha(privateFile(path.join(live, 'scripts/safe-restart.sh'), false)) !== scope.oldSafeRestartSha256) fail('runtime_executor_changed');
    const response = await fetch(`${scope.healthOrigin}/health`, { signal: AbortSignal.timeout(3000), headers: { 'Cache-Control': 'no-cache' }, redirect: 'error' });
    if (!response.ok) fail('runtime_health_unavailable');
    const health = await response.json();
    if (health.status !== 'ok' || health.pid !== scope.oldPid || health.serverProcessStartTicks !== scope.oldStartTicks
        || health.serverLoadedBuildId !== scope.oldLoadedBuildId) fail('runtime_loaded_changed');
    const after = fs.readFileSync(`${proc}/stat`, 'utf8');
    if (after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== ticks) fail('runtime_process_changed');
    assertBootstrapPublicationContext(root, binding, {});
}

function databaseAuthorityChain(directory) {
    const names = ['/']; let current = '/', privateBoundary = false;
    for (const name of directory.split('/').filter(Boolean)) { current = path.join(current, name); names.push(current); }
    return names.map(name => {
        const stat = fs.lstatSync(name);
        if (!stat.isDirectory() || fs.realpathSync(name) !== name || ![0, process.getuid()].includes(stat.uid)
            || (!privateBoundary && stat.mode & 0o022)) fail('database_parent_unsafe');
        if (stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700) privateBoundary = true;
        return [name, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode];
    });
}

function corroborateBootstrapDatabase(root, scope, identity) {
    const proc = `/proc/${scope.oldPid}`;
    const verifyProcess = () => {
        const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== scope.oldStartTicks
            || fs.statSync(proc).uid !== scope.serviceUid || fs.realpathSync(`${proc}/cwd`) !== root) fail('runtime_process_changed');
    };
    verifyProcess(); let found = false;
    for (const name of fs.readdirSync(`${proc}/fd`)) {
        const descriptor = `${proc}/fd/${name}`;
        try {
            if (fs.readlinkSync(descriptor) !== identity.path) continue;
            const stat = fs.statSync(descriptor);
            if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === identity.uid) found = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    verifyProcess(); if (!found) fail('database_not_loaded');
}

function verifyBootstrapDatabase(root, scope, identity) {
    if (!identity || typeof identity.path !== 'string' || !path.isAbsolute(identity.path) || path.resolve(identity.path) !== identity.path
        || fs.realpathSync(identity.path) !== identity.path || fs.realpathSync(path.dirname(identity.path)) !== path.dirname(identity.path)) fail('database_identity');
    const chain = databaseAuthorityChain(path.dirname(identity.path)), stat = fs.lstatSync(identity.path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== identity.dev || stat.ino !== identity.ino
        || stat.uid !== identity.uid || stat.uid !== process.getuid() || stat.mode & 0o022
        || chain.at(-1)[3] !== process.getuid()) fail('database_identity');
    for (const suffix of ['-wal', '-shm', '-journal']) {
        let side; try { side = fs.lstatSync(`${identity.path}${suffix}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!side.isFile() || side.nlink !== 1 || side.uid !== stat.uid || side.mode & 0o022) fail('database_sidecar');
    }
    corroborateBootstrapDatabase(root, scope, identity);
    return chain;
}

/** Read only the existing exact pending action with the installed native driver; no app initialization or writes. */
export function inspectBootstrapServerAction(root, binding, actionId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,100}$/.test(actionId || '')) fail('action_identity');
    const packetBytes = privateFile(binding.file);
    if (sha(packetBytes) !== binding.sha256) fail('packet_changed');
    const packet = JSON.parse(packetBytes);
    const identity = packet.configBinding.database;
    const authority = verifyBootstrapDatabase(root, binding.scope, identity);
    const script = `import {createRequire} from 'node:module';import path from 'node:path';const require=createRequire(path.join(process.cwd(),'package.json'));const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});try{const row=db.prepare('SELECT id, action_type AS actionType, expected_server_build_id AS expectedBuildId, status FROM pending_server_actions WHERE id = ?').get(process.argv[2]);process.stdout.write(JSON.stringify(row||null));}finally{db.close();}`;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script, identity.path, actionId], {
        cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    if (JSON.stringify(verifyBootstrapDatabase(root, binding.scope, identity)) !== JSON.stringify(authority)) fail('database_parent_changed');
    const row = JSON.parse(raw);
    if (row?.id !== actionId || row.actionType !== 'safe-restart' || row.expectedBuildId !== binding.scope.serverBuildId
        || !['pending', 'failed'].includes(row.status)) fail('action_evidence_changed');
    return row;
}

/** Recheck the retained candidate's canonical provenance and exact manifest on a read-only replay. */
export function verifyBootstrapServerCandidate(root, binding, expectedManifestSha256) {
    const scope = binding.scope, directory = path.join(root, '.nassaj-local-preview/server-candidates', scope.serverBuildId);
    if (fs.realpathSync(directory) !== directory) fail('candidate_changed');
    const provenance = JSON.parse(privateFile(path.join(directory, 'BUILD_PROVENANCE.json'), false));
    const bytes = privateFile(path.join(directory, 'OID_CONTROL_MANIFEST.json'), false), manifest = JSON.parse(bytes);
    if (provenance.artifact !== 'server' || provenance.buildId !== scope.serverBuildId || provenance.commit !== scope.oid
        || provenance.baseCommit !== scope.oid || provenance.dirty !== false || manifest.serverBuildId !== scope.serverBuildId
        || sha(bytes) !== expectedManifestSha256) fail('candidate_changed');
}
