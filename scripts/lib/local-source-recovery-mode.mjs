/** Bound, one-shot MODE handoff for the already promoted local source recovery candidate. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashTree } from './source-update-tree-identity.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`local_recovery_mode_${code}`); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical)}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function read(file, privateFile = true) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 4 * 1024 * 1024
            || fs.realpathSync(file) !== file || (privateFile ? (stat.mode & 0o777) !== 0o600 : Boolean(stat.mode & 0o022))) fail('unsafe_file');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
function json(file) { return JSON.parse(read(file)); }
function durable(file, value, exclusive = false) {
    const target = exclusive ? file : `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!exclusive) fs.renameSync(target, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function processInfo(pid) {
    const proc = `/proc/${pid}`, bytes = fs.readFileSync(`${proc}/stat`, 'utf8');
    const fields = bytes.slice(bytes.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), ticks: fields[19], uid: fs.statSync(proc).uid,
        cwd: fs.realpathSync(`${proc}/cwd`), exe: fs.realpathSync(`${proc}/exe`),
        argv: fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean) };
}
function sameProcess(before) {
    const after = processInfo(before.pid);
    if (canonical(before) !== canonical(after)) fail('caller_changed');
}
function environment(pid) {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
        .map(entry => { const equal = entry.indexOf('='); return [entry.slice(0, equal), entry.slice(equal + 1)]; }));
}

/** Verify the actual direct helper → sealed bash script → old-runtime process chain. */
export function assertLocalRecoveryCaller(binding, processName) {
    const old = processInfo(binding.previousRuntime.pid), shell = processInfo(process.ppid), self = processInfo(process.pid);
    const artifact = path.join(binding.root, 'dist-server'), script = path.join(artifact, 'scripts/safe-restart.sh');
    const helper = path.join(artifact, 'scripts/lib/local-source-recovery-mode.mjs');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(processName || '')) fail('process_name_invalid');
    if (old.ticks !== binding.previousRuntime.startTicks || old.uid !== process.getuid() || old.cwd !== binding.root) fail('old_process_changed');
    if (shell.parent !== old.pid || shell.uid !== old.uid || self.uid !== old.uid || shell.cwd !== binding.root
        || self.cwd !== binding.root || shell.exe !== fs.realpathSync('/bin/bash') || self.exe !== fs.realpathSync(process.execPath)
        || BigInt(shell.ticks) < BigInt(old.ticks) || BigInt(self.ticks) < BigInt(shell.ticks)
        || canonical(shell.argv) !== canonical(['bash', 'dist-server/scripts/safe-restart.sh', '--exec'])
        || self.argv.length !== 6 || self.argv[1] !== helper || !['inspect', 'apply'].includes(self.argv[2])
        || self.argv[3] !== binding.root || self.argv[4] !== artifact || self.argv[5] !== processName) fail('caller_chain_invalid');
    const manifest = JSON.parse(read(path.join(artifact, 'SERVER_INPUT_MANIFEST.json'), false));
    const input = manifest.inputs?.filter(entry => entry.path === 'scripts/safe-restart.sh');
    const control = JSON.parse(read(path.join(artifact, 'OID_CONTROL_MANIFEST.json'), false));
    if (input?.length !== 1 || input[0].sha256 !== sha(read(script, false))
        || control.serverBuildId !== manifest.buildId || control.safeRestartSha256 !== input[0].sha256 || control.safeRestartMode !== 0o555) fail('caller_script_changed');
    const stat = fs.statSync(script), opened = fs.statSync(`/proc/${shell.pid}/fd/255`);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.mode !== stat.mode
        || (stat.mode & 0o777) !== control.safeRestartMode || sha(fs.readFileSync(`/proc/${shell.pid}/fd/255`)) !== input[0].sha256) fail('caller_script_not_open');
    const inherited = environment(old.pid);
    if (Object.hasOwn(inherited, 'NASSAJ_UPDATE_MODE') || process.env.NASSAJ_UPDATE_MODE !== undefined) fail('inherited_mode_override');
    sameProcess(old); sameProcess(shell); sameProcess(self);
    return { old, shell, self, inherited };
}
function assertOldProcess(binding, processName) {
    const caller = assertLocalRecoveryCaller(binding, processName), old = caller.old;
    const database = process.env.DATABASE_PATH;
    if (!database || !path.isAbsolute(database) || fs.realpathSync(database) !== database) fail('database_path');
    const stat = fs.statSync(database);
    const held = fs.readdirSync(`/proc/${old.pid}/fd`).some(name => {
        try { const fd = fs.statSync(`/proc/${old.pid}/fd/${name}`); return fd.dev === stat.dev && fd.ino === stat.ino; } catch { return false; }
    });
    if (!held || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('database_not_held');
    return { database, caller };
}
function interpreter(config) {
    const value = config.exec_interpreter;
    if (typeof value !== 'string' || !value) fail('supervisor_interpreter_invalid');
    if (path.isAbsolute(value)) return fs.realpathSync(value);
    for (const directory of String(config.env?.PATH || '').split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        const target = path.join(directory, value);
        try { fs.accessSync(target, fs.constants.X_OK); return fs.realpathSync(target); } catch { /* Try next saved directory. */ }
    }
    fail('supervisor_interpreter_invalid');
}

/** Bind the exact restart name, PID, entry and interpreter to one current and saved PM2 slot. */
export function assertLocalRecoverySupervisor(binding, processName, caller) {
    const rows = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const matching = rows.filter(row => row.name === processName);
    if (matching.length !== 1 || rows.filter(row => row.pid === caller.old.pid).length !== 1
        || matching[0].pid !== caller.old.pid || matching[0].pm2_env?.pm_cwd !== binding.root) fail('supervisor_changed');
    const row = matching[0], live = row.pm2_env;
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'dump.pm2'), 'utf8'));
    const savedRows = saved.filter(item => item.name === processName);
    if (savedRows.length !== 1 || live.status !== 'online' || savedRows[0].pm_cwd !== binding.root
        || [live, live.env, savedRows[0], savedRows[0].env].some(env => env && Object.hasOwn(env, 'NASSAJ_UPDATE_MODE'))) fail('supervisor_mode_override');
    const stored = savedRows[0], entry = live.pm_exec_path;
    const exactArgv = [caller.old.exe, entry, ...(Array.isArray(live.args) ? live.args : [])];
    if (canonical(caller.old.argv) !== canonical([`node ${entry}`]) && canonical(caller.old.argv) !== canonical(exactArgv)) fail('supervisor_process_title_changed');
    if (!Number.isSafeInteger(row.pm_id) || rows.filter(item => item.pm_id === row.pm_id).length !== 1
        || live.namespace !== stored.namespace || !path.isAbsolute(entry || '') || !entry.startsWith(`${binding.root}/`)
        || fs.realpathSync(entry) !== entry || stored.pm_exec_path !== entry || caller.inherited.pm_exec_path !== entry
        || interpreter(live) !== caller.old.exe || interpreter(stored) !== caller.old.exe
        || canonical(live.args ?? []) !== canonical(stored.args ?? [])
        || canonical(live.node_args ?? []) !== canonical(stored.node_args ?? [])
        || canonical(live.exec_mode) !== canonical(stored.exec_mode)) fail('supervisor_slot_changed');
    sameProcess(caller.old); sameProcess(caller.shell);
}
function authority(binding, actionSha) {
    const processName = process.argv[5];
    const { database, caller } = assertOldProcess(binding, processName);
    assertLocalRecoverySupervisor(binding, processName, caller);
    const Database = createRequire(path.join(binding.root, 'package.json'))('better-sqlite3');
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
        const job = db.prepare('SELECT * FROM source_update_jobs WHERE id = ?').get(binding.jobId);
        const action = db.prepare('SELECT * FROM pending_server_actions WHERE id = ?').get(binding.actionId);
        const owner = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'owner' AND is_active = 1").get(binding.ownerId);
        return { job, action, owner, actionSha };
    } finally { db.close(); }
}
function validateAuthority(binding, manifest, actionSha, evidence) {
    const { job, action, owner } = evidence;
    if (owner?.id !== binding.ownerId || job?.id !== binding.jobId || job.owner_id !== binding.ownerId
        || job.state !== 'runtime_verifying' || job.strategy !== 'git-checkout-v2' || job.transaction_id !== binding.transactionId
        || job.release_commit !== manifest.releaseCommit || job.expected_server_build_id !== manifest.serverBuildId
        || job.activation_identity_sha256 !== actionSha || action?.id !== binding.actionId || action.status !== 'pending'
        || action.action_type !== 'safe-restart' || action.source_update_job_id !== binding.jobId
        || action.source_update_transaction_id !== binding.transactionId || action.activation_identity_sha256 !== actionSha
        || action.expected_server_build_id !== manifest.serverBuildId || action.release_commit !== manifest.releaseCommit) fail('authority_changed');
}
function verifyTrees(root, manifest) {
    for (const [name, directory] of Object.entries({ server: 'dist-server', client: 'dist', nodeModules: 'node_modules' })) {
        const tree = hashTree(path.join(root, directory)), expected = manifest.trees?.[name];
        if (tree.sha256 !== expected?.sha256 || tree.files !== expected.files) fail('runtime_tree_changed');
    }
    const oid = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim();
    if (oid !== manifest.releaseCommit) fail('target_changed');
}

/** Read all authority anew; absence returns null only for a non-local recovery handoff. */
export function inspectLocalRecoveryMode(root, artifactRoot) {
    if (fs.realpathSync(root) !== root || artifactRoot !== path.join(root, 'dist-server')) return null;
    const control = path.join(root, '.git/nassaj-source-update'), handoffFile = path.join(control, 'bootstrap-handoff.json');
    if (!fs.existsSync(handoffFile)) return null;
    const handoff = json(handoffFile);
    if (!ID.test(handoff.transactionId || '')) fail('transaction_invalid');
    const candidate = path.join(control, 'candidates', handoff.transactionId);
    const manifestBytes = read(path.join(candidate, 'candidate-manifest.json')), manifest = JSON.parse(manifestBytes);
    const binding = manifest.operationBinding;
    if (!binding) return null;
    if (binding.schema !== 'nassaj-local-source-recovery-operation/v1' || binding.root !== root
        || binding.nodeIdentity !== os.hostname() || binding.transactionId !== handoff.transactionId
        || !ID.test(binding.actionId || '') || !ID.test(binding.jobId || '') || manifest.txId !== binding.transactionId) fail('binding_invalid');
    const journal = json(path.join(control, 'journal.json')), { checksum, ...payload } = journal;
    if (sha(canonical(payload)) !== checksum || journal.schema !== 'nassaj-source-update-maintenance/v1'
        || journal.gateClosed !== true || journal.owner?.bootId !== fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        || journal.state !== 'UPDATING' || journal.phase !== 'RESTARTING_HANDOFF' || journal.databaseState !== 'UNKNOWN'
        || journal.transactionId !== binding.transactionId || journal.identity?.manifestSha256 !== sha(manifestBytes)
        || journal.identity.targetCommit !== manifest.releaseCommit || journal.identity.originalHead !== binding.previousSourceOid
        || journal.identity.expectedVersion !== manifest.version || journal.owner?.pid !== binding.previousRuntime.pid
        || journal.owner.startTime !== binding.previousRuntime.startTicks || handoff.epoch !== journal.owner.epoch
        || handoff.schema !== 'nassaj-source-update-bootstrap/v1' || handoff.tokenFilePath !== path.join(control, 'token')
        || sha(read(handoff.tokenFilePath).toString().trim()) !== journal.owner.tokenDigest) fail('handoff_changed');
    const actionBytes = read(path.join(candidate, 'activation-action.json')), actionSha = sha(actionBytes.toString().trim());
    const action = JSON.parse(actionBytes);
    if (action.transactionId !== binding.transactionId || action.targetCommit !== manifest.releaseCommit
        || action.manifestSha256 !== sha(manifestBytes) || action.manifestPath !== path.join(candidate, 'candidate-manifest.json')) fail('action_changed');
    validateAuthority(binding, manifest, actionSha, authority(binding, actionSha));
    verifyTrees(root, manifest);
    return inspectConfig({ root, candidate, binding, handoffSha: sha(read(handoffFile)), manifestSha: sha(manifestBytes), actionSha });
}
function inspectConfig(context) {
    const { root, candidate, binding } = context, mode = binding.modeTransition;
    if (mode?.from !== 'release' || mode.to !== 'local-main') fail('mode_scope');
    const configBytes = read(path.join(candidate, 'local-recovery-config.json')), config = JSON.parse(configBytes);
    if (sha(configBytes) !== mode.configBindingSha256 || config.schema !== 'nassaj-local-recovery-config/v1'
        || config.id !== mode.configReceiptId || config.root !== root || config.transactionId !== binding.transactionId
        || config.actionId !== binding.actionId || config.originalEnvSha256 !== mode.originalEnvSha256
        || config.proposalEnvSha256 !== mode.proposalEnvSha256 || config.approvalReference !== binding.approvalReference
        || config.reservationReference !== binding.reservationReference) fail('config_binding_changed');
    const proposal = read(path.join(candidate, 'local-recovery-proposal.env'));
    if (sha(proposal) !== mode.proposalEnvSha256) fail('proposal_changed');
    const env = read(path.join(root, '.env')), currentSha = sha(env);
    const intentFile = path.join(candidate, 'local-recovery-mode-intent.json');
    const identity = { schema: 'nassaj-local-recovery-mode-intent/v1', root, transactionId: binding.transactionId,
        jobId: binding.jobId, actionId: binding.actionId, manifestSha256: context.manifestSha, handoffSha256: context.handoffSha,
        activationIdentitySha256: context.actionSha, configBindingSha256: mode.configBindingSha256 };
    const intent = fs.existsSync(intentFile) ? json(intentFile) : null;
    if (intent && (canonical(intent.identity) !== canonical(identity) || !['prepared', 'config_applied'].includes(intent.state))) fail('manual_recovery_required');
    if (currentSha !== mode.originalEnvSha256 && !(intent && currentSha === mode.proposalEnvSha256)) fail('config_cas_changed');
    const original = currentSha === mode.originalEnvSha256 ? env : read(path.join(candidate, 'local-recovery-original.env'));
    if (sha(original) !== mode.originalEnvSha256) fail('original_changed');
    const line = /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=.*$/gm;
    const before = original.toString(), after = proposal.toString(), oldLines = before.match(line) || [], newLines = after.match(line) || [];
    if (oldLines.length > 1 || (oldLines.length && !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=\s*(?:release|"release"|'release')\s*$/.test(oldLines[0]))
        || newLines.length !== 1 || newLines[0] !== 'NASSAJ_UPDATE_MODE=local-main'
        || before.replace(line, '').trimEnd() !== after.replace(line, '').trimEnd()) fail('config_scope');
    return { ...context, identity, intentFile, intent, proposal, original, currentSha };
}

function withModeLock(candidate, operation) {
    const file = path.join(candidate, 'local-recovery-mode.lock');
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || fs.realpathSync(file) !== file) fail('lock_unsafe');
        // flock belongs to this shared open-file description; our fd retains it
        // after the child exits, and the kernel releases it even after SIGKILL.
        try { execFileSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }); }
        catch { fail('concurrent_transition'); }
        return operation();
    } finally { fs.closeSync(fd); }
}

/** Apply only at the final restart boundary. Ambiguous restart intent is never retried or rolled back automatically. */
export function applyLocalRecoveryMode(root, artifactRoot) {
    const initial = inspectLocalRecoveryMode(root, artifactRoot);
    if (!initial) fail('handoff_required');
    return withModeLock(initial.candidate, () => applyUnderLock(root, artifactRoot));
}
function applyUnderLock(root, artifactRoot) {
    let context = inspectLocalRecoveryMode(root, artifactRoot);
    if (!context) fail('handoff_required');
    const backup = path.join(context.candidate, 'local-recovery-original.env');
    if (!fs.existsSync(backup)) durable(backup, context.original, true);
    if (sha(read(backup)) !== context.binding.modeTransition.originalEnvSha256) fail('backup_changed');
    if (!context.intent) durable(context.intentFile, JSON.stringify({ identity: context.identity, state: 'prepared' }), true);
    context = inspectLocalRecoveryMode(root, artifactRoot);
    if (context.currentSha !== context.binding.modeTransition.proposalEnvSha256) durable(path.join(root, '.env'), context.proposal);
    durable(context.intentFile, JSON.stringify({ identity: context.identity, state: 'config_applied' }));
    context = inspectLocalRecoveryMode(root, artifactRoot);
    durable(context.intentFile, JSON.stringify({ identity: context.identity, state: 'restart_intent' }));
    return { transactionId: context.binding.transactionId, state: 'restart_intent' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const [command, root, artifact, processName] = process.argv.slice(2);
        if (!['inspect', 'apply'].includes(command) || !root || !artifact || !processName || process.argv.length !== 6) fail('arguments');
        const result = command === 'apply' ? applyLocalRecoveryMode(root, artifact) : inspectLocalRecoveryMode(root, artifact);
        process.exitCode = result ? 0 : 10;
    } catch (error) { console.error(error.message?.startsWith('local_recovery_mode_') ? error.message : 'local_recovery_mode_inspection_failed'); process.exitCode = 2; }
}
