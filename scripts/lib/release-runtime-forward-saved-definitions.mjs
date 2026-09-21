/** Narrow saved-definition retirement. No PM2 commands, arbitrary JS evaluation or DB files are supported. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { forwardValueSha256 } from './release-runtime-forward-child-protocol.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Compute an exact target removal while preserving every unrelated definition. */
export function planForwardDefinitionRetirement(bytes, format, slot) {
    const value = JSON.parse(bytes); const entries = format === 'pm2-dump-json' ? value : format === 'pm2-ecosystem-json' ? value.apps : null;
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string')) throw Error('forward_definition_format_unsupported');
    const matching = entries.filter(entry => entry.name === slot.name);
    if (matching.length > 1 || matching.some(entry => (entry.namespace ?? entry.pm2_env?.namespace ?? 'default') !== slot.namespace)) throw Error('forward_definition_ambiguous');
    const unaffected = entries.filter(entry => entry.name !== slot.name);
    const replacement = format === 'pm2-dump-json' ? unaffected : { ...value, apps: unaffected };
    return { bytes: Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`), beforeSha256: sha(bytes),
        unaffectedEntriesSha256: forwardValueSha256(unaffected), removed: matching.length };
}
/** Write an independently planned JSON removal, preserving owner/mode and fsyncing file and parent. */
export function retireForwardSavedDefinition(source, slot) {
    return writeForwardSavedDefinition(source, slot, null);
}
/** Persist the already verified target independently into each reviewed restore source. */
export function installForwardSavedDefinition(source, slot, target) {
    return writeForwardSavedDefinition(source, slot, target);
}
function writeForwardSavedDefinition(source, slot, target) {
    const before = fs.lstatSync(source.path);
    if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(source.path) !== source.path
        || before.size > 16 * 1024 * 1024 || !['pm2-dump-json', 'pm2-ecosystem-json'].includes(source.format)) throw Error('forward_definition_unsafe');
    const fd = fs.openSync(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let planned;
    try {
        const opened = fs.fstatSync(fd);
        if (['dev', 'ino', 'uid', 'gid', 'mode', 'size'].some(key => opened[key] !== before[key])) throw Error('forward_definition_changed');
        const bytes = fs.readFileSync(fd);
        if (sha(bytes) !== source.beforeSha256) throw Error('forward_definition_pin_changed');
        planned = target ? planForwardDefinitionInstallation(bytes, source.format, slot, target) : planForwardDefinitionRetirement(bytes, source.format, slot);
    } finally { fs.closeSync(fd); }
    const temporary = `${source.path}.forward-${randomUUID()}`;
    const output = fs.openSync(temporary, 'wx', before.mode & 0o777);
    try {
        fs.writeFileSync(output, planned.bytes); fs.fchmodSync(output, before.mode & 0o777);
        const created = fs.fstatSync(output);
        if (created.uid !== before.uid || created.gid !== before.gid) fs.fchownSync(output, before.uid, before.gid);
        fs.fsyncSync(output);
    } finally { fs.closeSync(output); }
    const current = fs.lstatSync(source.path);
    if (current.dev !== before.dev || current.ino !== before.ino || sha(fs.readFileSync(source.path)) !== source.beforeSha256) throw Error('forward_definition_raced');
    fs.renameSync(temporary, source.path);
    const directory = fs.openSync(path.dirname(source.path), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return { sourceId: source.sourceId, path: source.path, format: source.format, beforeSha256: planned.beforeSha256,
        afterSha256: sha(planned.bytes), ...(target ? { targetInstalled: true, targetDefinitionSha256: planned.targetDefinitionSha256 } : { oldTargetAbsent: true }), unaffectedEntriesSha256: planned.unaffectedEntriesSha256, durable: true };
}

/** Mirror the installed PM2 save projection without invoking its CLI or replacing a sibling's data. */
export function planForwardDefinitionInstallation(bytes, format, slot, target) {
    const retired = planForwardDefinitionRetirement(bytes, format, slot);
    if (retired.removed !== 0 || target.name !== slot.name || target.namespace !== slot.namespace
        || target.status !== 'online' || target.pmx !== false || target.vizion !== false || target.wait_ready !== false)
        throw Error('forward_definition_target_invalid');
    const saved = structuredClone(target);
    // Installed PM2 API/Startup.js save projection. Each source keeps its own sibling list.
    delete saved.instances; delete saved.pm_id; delete saved.prev_restart_delay;
    const value = JSON.parse(bytes); const entries = format === 'pm2-dump-json' ? value : value.apps;
    const next = [...entries, saved];
    return { ...retired, bytes: Buffer.from(`${JSON.stringify(format === 'pm2-dump-json' ? next : { ...value, apps: next }, null, 2)}\n`),
        targetDefinitionSha256: forwardValueSha256(saved) };
}
