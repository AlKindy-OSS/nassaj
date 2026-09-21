/** Re-observe scoped retirement under root authority. This verifier performs no stop, save, mask or database open. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { observePinnedPm2Runtime } from './pm2-readonly-observer.mjs';
import { forwardValueSha256, inspectForwardChildIdentity } from './release-runtime-forward-child-protocol.mjs';
import { INSTALLED_HOST_CONFIG_PATH, readInstalledHostConfiguration } from './release-runtime-installed-config.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(ok, reason) { if (!ok) throw Error(`forward_retirement_${reason}`); }
/** Read only a root-private regular record with an exact opened identity. */
export function readForwardRootRecord(file) {
    if (file === INSTALLED_HOST_CONFIG_PATH) return readInstalledHostConfiguration().value;
    const before = fs.lstatSync(file);
    requireValue(fs.realpathSync(file) === file && before.isFile() && !before.isSymbolicLink() && before.uid === 0
        && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= 262144, 'record_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd); requireValue(['dev', 'ino', 'uid', 'mode', 'size'].every(key => before[key] === opened[key]), 'record_changed');
        return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}
function fileDigest(file) {
    const before = fs.lstatSync(file);
    requireValue(fs.realpathSync(file) === file && before.isFile() && !before.isSymbolicLink() && before.size <= 16 * 1024 * 1024, 'source_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd); requireValue(before.dev === opened.dev && before.ino === opened.ino && before.size === opened.size, 'source_changed');
        return { bytes: fs.readFileSync(fd), info: opened }; } finally { fs.closeSync(fd); }
}
function pinnedCommand(binary, args, env, deps) {
    const value = fileDigest(binary.path);
    requireValue(value.info.uid === 0 && !(value.info.mode & 0o022) && sha(value.bytes) === binary.sha256, 'executable_mismatch');
    return (deps.execFile || execFileSync)(binary.path, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 262144, env });
}
function parseEntries(bytes, format) {
    const value = JSON.parse(bytes);
    const entries = format === 'pm2-dump-json' ? value : format === 'pm2-ecosystem-json' ? value.apps : null;
    requireValue(Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)), 'source_format_unknown');
    return entries;
}
function assertAbsent(entries, slot) {
    requireValue(entries.every(entry => typeof (entry.name ?? entry.pm2_env?.name) === 'string'), 'entry_unknown');
    requireValue(!entries.some(entry => (entry.name ?? entry.pm2_env?.name) === slot.name), 'old_target_present');
}
/** Observe a supported saved definition; no caller boolean can establish target absence. */
export function observeForwardSavedDefinition(file, format, slot) {
    const current = fileDigest(file); const entries = parseEntries(current.bytes, format); assertAbsent(entries, slot);
    return { sha256: sha(current.bytes), unaffectedEntriesSha256: forwardValueSha256(entries), oldTargetAbsent: true };
}
function inspectSources(plan, receipt) {
    requireValue(Array.isArray(plan.sources) && plan.sources.length > 0 && plan.sources.length === receipt.sources?.length, 'source_inventory_incomplete');
    const result = []; let previous = '';
    for (const source of plan.sources) {
        requireValue(typeof source.sourceId === 'string' && source.sourceId > previous, 'source_inventory_duplicate'); previous = source.sourceId;
        const recorded = receipt.sources.find(item => item.sourceId === source.sourceId);
        requireValue(recorded?.path === source.path && recorded.format === source.format, 'source_identity_mismatch');
        let current;
        try { current = fileDigest(source.path); } catch (error) {
            if (error.code !== 'ENOENT' || !source.optional || recorded.afterSha256 !== null) throw error;
            requireValue(fs.realpathSync(path.dirname(source.path)) === path.dirname(source.path), 'absent_parent_unsafe');
            result.push({ sourceId: source.sourceId, sha256: null }); continue;
        }
        const entries = parseEntries(current.bytes, source.format); assertAbsent(entries, plan.slot);
        requireValue(sha(current.bytes) === recorded.afterSha256 && forwardValueSha256(entries) === recorded.unaffectedEntriesSha256
            && recorded.oldTargetAbsent === true && recorded.durable === true, 'source_receipt_changed');
        result.push({ sourceId: source.sourceId, sha256: sha(current.bytes) });
    }
    return result;
}
function inspectInhibitors(plan, receipt, deps) {
    requireValue(Array.isArray(plan.sources) && plan.sources.length > 0 && (!receipt || plan.sources.length === receipt.inhibitors?.length), 'inhibitor_inventory_incomplete');
    const result = []; let previous = '';
    for (const source of plan.sources) {
        requireValue(typeof source.sourceId === 'string' && source.sourceId > previous && /^[A-Za-z0-9_.@-]+\.(service|timer)$/.test(source.unit)
            && ['system', 'user'].includes(source.scope) && !source.unit.startsWith('pm2-') && !source.unit.includes('cloudflared'), 'inhibitor_plan_invalid'); previous = source.sourceId;
        const prefix = source.scope === 'user' ? ['--user', `--machine=${source.user}@.host`] : [];
        requireValue(source.scope !== 'user' || /^[a-z_][a-z0-9_-]{0,31}$/.test(source.user || ''), 'user_invalid');
        const raw = pinnedCommand(plan.systemctl, [...prefix, 'show', source.unit, '--property=Id,LoadState,ActiveState,UnitFileState,ControlGroup', '--no-pager'],
            { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' }, deps);
        const values = Object.fromEntries(raw.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        const absent = values.LoadState === 'not-found';
        requireValue(values.Id === source.unit && values.ActiveState === 'inactive' && (absent
            ? source.optional === true && values.UnitFileState === '' && values.ControlGroup === ''
                && Array.isArray(source.creationSourceIds) && source.creationSourceIds.length > 0
            : values.LoadState === 'masked' && values.UnitFileState === 'masked'), 'inhibitor_not_effective');
        const proofSha256 = forwardValueSha256({ sourceId: source.sourceId, scope: source.scope, user: source.user ?? null, values });
        if (receipt) requireValue(receipt.inhibitors.find(item => item.sourceId === source.sourceId)?.proofSha256 === proofSha256, 'inhibitor_changed');
        result.push({ sourceId: source.sourceId, proofSha256, ...(absent ? { absent: true, creationSourceIds: source.creationSourceIds } : {}) });
    }
    for (const item of result.filter(value => value.absent)) for (const id of item.creationSourceIds) {
        const source = plan.sources.find(value => value.sourceId === id);
        requireValue(source && source.optional !== true && result.some(value => value.sourceId === id && !value.absent), 'absent_creator_unfenced');
    }
    return result;
}
export function inspectForwardInventory(plan) {
    requireValue(Array.isArray(plan.inventory) && plan.inventory.length > 0, 'launch_inventory_missing');
    for (const entry of plan.inventory) {
        if (entry.kind === 'file') requireValue(sha(fileDigest(entry.path).bytes) === entry.sha256, 'launch_source_changed');
        else if (entry.kind === 'directory') requireValue(fs.realpathSync(entry.path) === entry.path
            && forwardValueSha256(fs.readdirSync(entry.path).sort()) === entry.entriesSha256, 'launch_inventory_changed');
        else throw Error('forward_retirement_launch_inventory_unknown');
    }
}
/** Validate durable retirement against current runtime, every saved source, inhibitors and the old process. */
export async function verifyForwardRetirement(config, journal, deps = {}) {
    requireValue((deps.effectiveUid || (() => process.geteuid?.()))() === 0, 'root_required');
    const activation = config.forwardActivation; const receipt = journal.forwardRetirement;
    requireValue(activation && receipt?.schema === 'nassaj-forward-retirement/v1' && receipt.transactionId === journal.transactionId
        && receipt.supervisorPlanSha256 === forwardValueSha256(activation.supervisorPlan)
        && receipt.mutatorPlanSha256 === forwardValueSha256(activation.mutatorPlan)
        && receipt.supervisorPlanSha256 === config.expected?.supervisorPlanSha256
        && receipt.mutatorPlanSha256 === config.expected?.mutatorPlanSha256, 'plan_mismatch');
    const { factsSha256, ...facts } = receipt; requireValue(forwardValueSha256(facts) === factsSha256, 'receipt_hash_mismatch');
    inspectForwardInventory(activation.mutatorPlan);
    const inhibitors = inspectInhibitors(activation.mutatorPlan, receipt, deps);
    const sources = inspectSources(activation.supervisorPlan, receipt);
    const slot = activation.supervisorPlan.slot; const pm2 = activation.supervisorPlan.pm2;
    const observed = await (deps.observeRuntime || observePinnedPm2Runtime)(pm2.observer, deps.observer);
    requireValue(observed.entries.every(entry => entry.name !== slot.name || entry.namespace !== slot.namespace), 'old_target_present');
    requireValue(observed.observationSha256 === receipt.runtime.namespaceSha256, 'runtime_changed');
    (deps.verifyNoHolders || verifyNoForwardDatabaseHolders)(config.databaseFile);
    const old = receipt.retiredProcess;
    try { const current = (deps.inspectProcess || inspectForwardChildIdentity)(old.pid);
        requireValue(current.bootId !== old.bootId || current.startTicks !== old.startTicks, 'old_process_alive');
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    return { factsSha256, inhibitors, sources };
}

/** Stable PM2 identity fields; counters and uptime are observations, not launch definitions. */
export function forwardRuntimeEntries(entries) {
    return entries.map(entry => ({ pm2Id: entry.pm_id, name: entry.name ?? entry.pm2_env?.name,
        namespace: entry.pm2_env?.namespace, executable: entry.pm2_env?.pm_exec_path, cwd: entry.pm2_env?.pm_cwd,
        interpreter: entry.pm2_env?.exec_interpreter, status: entry.pm2_env?.status, pid: entry.pid })).sort((a, b) => a.pm2Id - b.pm2Id);
}
/** Include all process groups; unreadable observations cannot become a zero-writer claim. */
export function verifyNoForwardDatabaseHolders(databaseFile) {
    const files = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].flatMap(file => {
        try { return [fs.statSync(file, { bigint: true })]; } catch (error) { if (error.code === 'ENOENT' && file !== databaseFile) return []; throw error; }
    });
    for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
        let descriptors;
        try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch (error) {
            if (error.code === 'ENOENT' && !fs.existsSync(`/proc/${pid}`)) continue; throw error;
        }
        for (const fd of descriptors) {
            let current;
            try { current = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            requireValue(!files.some(file => file.dev === current.dev && file.ino === current.ino), 'database_holder_present');
        }
    }
}

/** Observe the actual scoped inhibitor states before recording their durable proof. */
export function observeForwardInhibitors(plan, deps = {}) { return inspectInhibitors(plan, null, deps); }
