#!/usr/bin/env node
/** Fixed root-authorized client for the existing safe-restart script; no caller-supplied pins. */
import { validateLocalPreparedArtifact } from './lib/local-reviewed-build-identity.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DESCRIPTOR = '/etc/nassaj/startup-admission-client.json';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'safe-restart.sh');
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deny = code => { throw Error(`managed_restart_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');

/** Parse the bounded operation locator once; managed mode has no force/injection/recovery options. */
export function parseManagedRestartArguments(argv) {
    let operationId; let execute = false; let json = false; let child = false;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--managed-operation' && operationId === undefined) operationId = argv[++index];
        else if (arg === '--exec' && !execute) execute = true;
        else if (arg === '--json' && !json) json = true;
        else if (arg === '--managed-child' && !child) child = true;
        else deny('arguments_invalid');
    }
    if (!ID.test(operationId || '')) deny('operation_invalid');
    return { operationId, execute, json, child };
}
function rootBytes(file, executable = false) {
    if (!path.isAbsolute(file || '') || fs.realpathSync(file) !== file) deny('path_unsafe');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) deny('ancestor_unsafe');
        if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o022)
        || before.size < 1 || before.size > (executable ? 256 * 1024 * 1024 : 256 * 1024)
        || (executable && !(before.mode & 0o111))) deny('file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd);
        if (['dev', 'ino', 'mode', 'uid', 'size'].some(key => before[key] !== opened[key])) deny('file_changed');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
function descriptor(deps) {
    const read = deps.readRootBytes || rootBytes;
    const bytes = read(DESCRIPTOR); const value = JSON.parse(bytes);
    const local=value.schema==='nassaj-startup-admission-client/v2';
    if (local) {
        if (!exact(value,'schema,nodeInstanceId,profileId,dispatcher,sudo,node,artifact,startupClosureSha256,databaseContractSha256,databasePath,databaseDev,databaseIno')) deny('descriptor_invalid');
        const {build,...artifact}=value.artifact || {}; validateLocalPreparedArtifact(artifact,build);
        if (artifact.startupClosureSha256!==value.startupClosureSha256 || artifact.databaseContractSha256!==value.databaseContractSha256) deny('descriptor_invalid');
        value.release={generationId:`local-forward-${artifact.archiveSha256}`};
    }
    if ((!local && value.schema !== 'nassaj-startup-admission-client/v1') || !['local-forward-349/v1', 'local-forward-349/v2'].includes(value.profileId)
        || !value.release || typeof value.release.generationId !== 'string') deny('descriptor_invalid');
    for (const name of ['node', 'sudo', 'dispatcher']) {
        const item = value[name];
        if (!exact(item, 'path,sha256') || !HEX.test(item.sha256 || '') || sha(read(item.path, true)) !== item.sha256) deny('executable_mismatch');
    }
    if ((deps.realpath || fs.realpathSync)(process.execPath) !== value.node.path) deny('interpreter_mismatch');
    return { value, bytes };
}
function callRoot(action, operationId, pinned, deps) {
    const run = deps.run || spawnSync;
    const result = run(pinned.value.sudo.path, ['-n', '--', pinned.value.dispatcher.path, action], {
        input: JSON.stringify({ schema: 'nassaj-managed-restart-request/v1', operationId }),
        encoding: 'utf8', timeout: action === 'restartCommittedGeneration' ? 300_000 : 15_000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin' },
    });
    if (result.status !== 0) deny('root_denied');
    if (!(deps.readRootBytes || rootBytes)(DESCRIPTOR).equals(pinned.bytes)) deny('descriptor_changed');
    return JSON.parse(result.stdout);
}
function safeAbsolute(value) { return typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x20\x7f]/.test(value); }
function validatePreparation(value, operationId, pinned, deps) {
    if (!exact(value, 'schema,operationId,generationId,releaseIdentitySha256,commitReceiptSha256,processName,pm2Home,workflowBase,nodeExecutable,nodeAbi,safeRestartSha256,expectedPm2Cwd,generationRoot,phase,home,pm2Executable,pm2Sha256,privateHealthUrl,managedClientSha256,pm2Id,pm2Namespace,attemptId,serverPid')
        || value.schema !== 'nassaj-managed-restart-preparation/v1' || value.operationId !== operationId || value.phase !== 'prepared'
        || value.generationId !== pinned.value.release.generationId
        || ![value.releaseIdentitySha256, value.commitReceiptSha256, value.safeRestartSha256, value.pm2Sha256, value.managedClientSha256].every(hash => HEX.test(hash || ''))
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.processName || '')
        || !HEX.test(value.attemptId || '') || !Number.isSafeInteger(value.serverPid) || value.serverPid <= 0
        || !Number.isSafeInteger(value.pm2Id) || value.pm2Id < 0
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pm2Namespace || '')
        || ![value.pm2Home, value.workflowBase, value.nodeExecutable, value.expectedPm2Cwd, value.generationRoot, value.home, value.pm2Executable].every(safeAbsolute)
        || value.nodeExecutable !== pinned.value.node.path || String(value.nodeAbi) !== process.versions.modules) deny('preparation_invalid');
    const url = new URL(value.privateHealthUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash
        || url.pathname !== '/health' || url.search) deny('private_url_invalid');
    const real = deps.realpath || fs.realpathSync; const read = deps.readFile || fs.readFileSync;
    if ([value.expectedPm2Cwd, value.generationRoot, value.pm2Home, value.workflowBase, value.home].some(file => real(file) !== file)
        || real(path.dirname(path.dirname(SCRIPT))) !== real(value.generationRoot)
        || sha(read(SCRIPT)) !== value.safeRestartSha256
        || sha(read(fileURLToPath(import.meta.url))) !== value.managedClientSha256
        || sha((deps.readRootBytes || rootBytes)(value.pm2Executable, true)) !== value.pm2Sha256) deny('preparation_pin_mismatch');
    return value;
}
/** The only script environment is derived from freshly verified root preparation. */
export function managedRestartEnvironment(proof) {
    return { PATH: '/usr/bin:/bin', HOME: proof.home, PM2_HOME: proof.pm2Home, WF_BASE: proof.workflowBase,
        PROC_NAME: proof.processName, MANAGED_ATTEMPT_ID: proof.attemptId, MANAGED_SERVER_PID: String(proof.serverPid), MANAGED_PM2_ID: String(proof.pm2Id), MANAGED_PM2_NAMESPACE: proof.pm2Namespace, HEALTH_URL: proof.privateHealthUrl,
        MANAGED_NODE: proof.nodeExecutable, MANAGED_PM2: proof.pm2Executable,
        MANAGED_EXPECTED_PM2_CWD: proof.expectedPm2Cwd, MANAGED_GENERATION_ROOT: proof.generationRoot,
        POST_RESTART_HEALTH_ATTEMPTS: '30', POST_RESTART_HEALTH_INTERVAL_S: '2' };
}
/** Inspect before the script, claim exactly once before restart, or verify private readiness without opening ingress. */
export function managedRestartAction(action, operationId, deps = {}) {
    if (!ID.test(operationId || '') || !['inspect', 'claim', 'ready', 'restartCommittedGeneration'].includes(action)) deny('request_invalid');
    const pinned = descriptor(deps);
    if (action === 'restartCommittedGeneration') {
        const value=callRoot(action,operationId,pinned,deps);
        const committed=exact(value,'schema,operationId,decision')&&value.decision==='committed';
        const deferred=exact(value,'schema,operationId,decision,reason')&&value.decision==='deferred'&&value.reason==='live_work';
        if(value.schema!=='nassaj-managed-restart-result/v1'||value.operationId!==operationId||(!committed&&!deferred))deny('operation_result_invalid');
        return value;
    }
    if (action === 'inspect') return validatePreparation(callRoot('inspectManagedRestart', operationId, pinned, deps), operationId, pinned, deps);
    const value = callRoot(action === 'claim' ? 'claimManagedRestartExecution' : 'verifyManagedRestartPrivateReady', operationId, pinned, deps);
    if (action === 'claim') {
        if (!exact(value, 'schema,operationId,decision,revision') || value.schema !== 'nassaj-managed-restart-execution/v1'
            || value.operationId !== operationId || value.decision !== 'claimed' || !Number.isSafeInteger(value.revision) || value.revision < 1) deny('execution_denied');
    } else if (exact(value, 'schema,operationId,decision') && value.schema === 'nassaj-managed-restart-private-ready/v1'
        && value.operationId === operationId && value.decision === 'pending') return value;
    else if (!exact(value, 'schema,operationId,decision,claimId,generationEpoch,pid,startTicks,bootId')
        || value.schema !== 'nassaj-managed-restart-private-ready/v1' || value.operationId !== operationId || value.decision !== 'ready'
        || typeof value.claimId !== 'string' || !ID.test(value.claimId) || !Number.isSafeInteger(value.generationEpoch) || value.generationEpoch < 1
        || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[1-9][0-9]*$/.test(value.startTicks || '')
        || !/^[a-f0-9-]{36}$/.test(value.bootId || '')) deny('private_ready_denied');
    return value;
}
/** Run the existing script only after proof, with a fixed executable environment and no ambient overrides. */
export function runManagedRestart(argv, deps = {}) {
    const args = parseManagedRestartArguments(argv); const proof = managedRestartAction('inspect', args.operationId, deps);
    const env = managedRestartEnvironment(proof);
    if (args.child) {
        const actual = deps.environment || process.env;
        for (const [key, value] of Object.entries(env)) if (actual[key] !== value) deny('environment_mismatch');
        const allowed = new Set([...Object.keys(env), 'PWD', 'SHLVL', '_']);
        if (Object.keys(actual).some(key => !allowed.has(key))) deny('ambient_environment');
        return 0;
    }
    const result = (deps.spawnScript || spawnSync)('/bin/bash', [SCRIPT, '--managed-operation', args.operationId, '--managed-child',
        ...(args.execute ? ['--exec'] : []), ...(args.json ? ['--json'] : [])], { env, stdio: 'inherit', cwd: proof.generationRoot });
    return result.status ?? 7;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const argv = process.argv.slice(2);
        if (argv[0] === 'claim' || argv[0] === 'ready' || argv[0] === 'restartCommittedGeneration') {
            if (argv.length !== 2) deny('arguments_invalid');
            const result = managedRestartAction(argv[0], argv[1]);
            if (result.decision === 'pending' || result.decision === 'deferred') process.exitCode = 75;
            if(argv[0]==='restartCommittedGeneration')process.stdout.write(JSON.stringify(result)+'\n');
        } else process.exitCode = runManagedRestart(argv);
    } catch (error) { console.error(error.message); process.exitCode = 7; }
}
