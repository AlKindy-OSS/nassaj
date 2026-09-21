/** Locked, reference-aware retention for immutable update generations. */
import { randomUUID } from 'node:crypto';
import {
    appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REF_KINDS = Object.freeze(['jobs', 'actions', 'attempts', 'journal', 'handoff', 'current', 'previous', 'last-good', 'manual']);
const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_GENERATION_STATES = new Set(['sealed', 'activated', 'rolled_back', 'failed', 'superseded']);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validateManualIdentity(row) {
    if (row.state !== 'manual_recovery_required') return;
    if (!SHA256.test(row.activationIdentitySha256 || '') || !SHA40.test(row.releaseCommit || '')
        || !SHA256.test(row.sourceTreeSha256 || '') || !SHA256.test(row.assetSha256 || '')
        || !SHA256.test(row.archiveSha256 || '') || !SHA256.test(row.serverBuildId || '')
        || !SHA256.test(row.clientBuildId || '') || !/^\d+$/.test(String(row.releaseId || ''))
        || !/^\d+$/.test(String(row.assetId || ''))) {
        const error = new Error('Manual recovery reference is missing its immutable identity.');
        error.code = 'update_runtime_manual_identity_unresolved';
        throw error;
    }
}

function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

function processStartTicks(pid) {
    try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}
function bootId() { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } }
function ownerAlive(owner) {
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.startTicks || !owner.bootId) return null;
    if (bootId() !== owner.bootId) return false;
    const observed = processStartTicks(owner.pid);
    return observed === null ? false : observed === owner.startTicks;
}

export function withUpdateRuntimeLock(controlRoot, operation) {
    const root = realpathSync(controlRoot);
    const lock = path.join(root, '.update-runtime.lock');
    const owner = { pid: process.pid, startTicks: processStartTicks(process.pid), bootId: bootId(), nonce: randomUUID() };
    if (!owner.startTicks || !owner.bootId) throw new Error('Update runtime lock owner identity is unavailable.');
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
        const candidate = path.join(root, `.update-runtime.lock-candidate-${owner.nonce}`);
        mkdirSync(candidate, { mode: 0o700 });
        writeFileSync(path.join(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
        syncDirectory(candidate);
        try { renameSync(candidate, lock); acquired = true; syncDirectory(root); }
        catch (error) {
            rmSync(candidate, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
            let observed;
            try { observed = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
            catch { throw new Error('Update runtime lock owner is unreadable.'); }
            if (ownerAlive(observed) !== false) throw new Error('Update runtime lock is held.');
            const stale = path.join(root, `.update-runtime.lock-stale-${randomUUID()}`);
            try { renameSync(lock, stale); rmSync(stale, { recursive: true, force: false }); syncDirectory(root); }
            catch (staleError) { if (staleError?.code !== 'ENOENT') throw staleError; }
        }
    }
    if (!acquired) throw new Error('Update runtime lock could not be acquired.');
    try { return operation(); } finally {
        const observed = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (observed.nonce !== owner.nonce) throw new Error('Update runtime lock ownership changed.');
        rmSync(lock, { recursive: true, force: false }); syncDirectory(root);
    }
}

function readRef(file, rootDevice) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== rootDevice
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error(`Unsafe update runtime ref: ${path.basename(file)}`);
    const id = readFileSync(file, 'utf8').trim();
    const after = lstatSync(file);
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.uid !== metadata.uid) throw new Error(`Update runtime ref changed while read: ${path.basename(file)}`);
    if (!SAFE_ID.test(id)) throw new Error(`Invalid update runtime ref: ${path.basename(file)}`);
    return id;
}

export function collectRuntimeReferences(controlRoot) {
    const root = realpathSync(controlRoot);
    const rootDevice = statSync(root).dev;
    const references = new Set();
    for (const kind of REF_KINDS) {
        const location = path.join(root, 'refs', kind);
        if (!existsSync(location)) continue;
        const metadata = lstatSync(location);
        if (metadata.isSymbolicLink() || metadata.dev !== rootDevice) throw new Error(`Unsafe update runtime ref location: ${kind}`);
        if (metadata.isFile()) references.add(readRef(location, rootDevice));
        else if (metadata.isDirectory()) {
            for (const entry of readdirSync(location, { withFileTypes: true })) {
                if (!entry.isFile()) throw new Error(`Unsafe update runtime ref entry: ${kind}/${entry.name}`);
                references.add(readRef(path.join(location, entry.name), rootDevice));
            }
        } else throw new Error(`Unsafe update runtime ref location: ${kind}`);
    }
    return references;
}

function generationRecord(generations, entry, rootDevice) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) throw new Error(`Unsafe runtime generation entry: ${entry.name}`);
    const directory = path.join(generations, entry.name);
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || metadata.dev !== rootDevice
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error(`Unsafe runtime generation: ${entry.name}`);
    let record = {};
    const recordFile = path.join(directory, 'runtime-generation.json');
    if (existsSync(recordFile)) {
        const recordMetadata = lstatSync(recordFile);
        if (!recordMetadata.isFile() || recordMetadata.isSymbolicLink()) throw new Error(`Unsafe runtime generation record: ${entry.name}`);
        record = JSON.parse(readFileSync(recordFile, 'utf8'));
    }
    const createdAt = Number.isFinite(Date.parse(record.createdAt)) ? Date.parse(record.createdAt) : metadata.mtimeMs;
    return { id: entry.name, directory, metadata, createdAt, state: record.state || 'sealed' };
}

function appendTombstone(journal, event) {
    appendFileSync(journal, `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    const fd = openSync(journal, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readTombstoneEvents(journal) {
    if (!existsSync(journal)) return [];
    return readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function resumeTombstonesLocked(root, generations, rootDevice, journal, protectedReferences) {
    const events = readTombstoneEvents(journal);
    const completed = new Set(events.filter((event) => event.state === 'done').map((event) => event.tombstone));
    const planned = new Map(events.filter((event) => event.state === 'planned').map((event) => [event.tombstone, event]));
    const resumed = [];
    for (const entry of readdirSync(generations, { withFileTypes: true }).filter((item) => item.name.startsWith('.deleting-'))) {
        const plan = planned.get(entry.name);
        if (!plan || completed.has(entry.name) || !entry.isDirectory()) throw new Error(`Unknown janitor tombstone: ${entry.name}`);
        const target = path.join(generations, entry.name);
        const metadata = lstatSync(target);
        if (metadata.isSymbolicLink() || metadata.dev !== rootDevice || metadata.ino !== plan.identity?.ino
            || metadata.uid !== plan.identity?.uid) throw new Error(`Janitor tombstone identity mismatch: ${entry.name}`);
        let recordedState = null;
        try { recordedState = JSON.parse(readFileSync(path.join(target, 'runtime-generation.json'), 'utf8')).state; } catch {}
        if (protectedReferences.has(plan.generation) || recordedState === 'manual_recovery_required') {
            const restored = path.join(generations, plan.generation);
            if (existsSync(restored)) throw new Error(`Janitor cannot restore referenced tombstone: ${plan.generation}`);
            renameSync(target, restored); syncDirectory(generations);
            appendTombstone(journal, { state: 'restored', generation: plan.generation, tombstone: entry.name,
                identity: plan.identity, reason: recordedState === 'manual_recovery_required' ? 'manual_generation_state' : 'live_reference' });
            continue;
        }
        rmSync(target, { recursive: true, force: false });
        syncDirectory(generations);
        appendTombstone(journal, { state: 'done', generation: plan.generation, tombstone: entry.name, identity: plan.identity, resumed: true });
        resumed.push(plan.generation);
    }
    return resumed;
}

function liveJobReferences(options) {
    const rows = options.loadLiveReferences?.() || [];
    if (!Array.isArray(rows)) throw new Error('Update runtime live references are unavailable.');
    const references = new Set();
    for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('Update runtime live reference is invalid.');
        validateManualIdentity(row);
        const generationId = row.generationId || row.transactionId;
        if (!SAFE_ID.test(generationId || '')) {
            const error = new Error('Update runtime janitor deferred by unresolved nonterminal work.');
            error.code = 'update_runtime_nonterminal_unresolved';
            throw error;
        }
        references.add(generationId);
    }
    return references;
}

function protectedReferences(root, options, journal) {
    const references = collectRuntimeReferences(root);
    const rows = options.loadLiveReferences?.() || [];
    if (!Array.isArray(rows)) throw new Error('Update runtime live references are unavailable.');
    for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('Update runtime live reference is invalid.');
        validateManualIdentity(row);
        const generationId = row.generationId || row.transactionId;
        if (!SAFE_ID.test(generationId || '')) {
            const error = new Error('Update runtime janitor deferred by unresolved nonterminal work.');
            error.code = 'update_runtime_nonterminal_unresolved';
            throw error;
        }
        references.add(generationId);
        if (row.state === 'manual_recovery_required') appendTombstone(journal, {
            state: 'protected-manual', generation: generationId, jobId: row.jobId || null,
        });
    }
    return references;
}

/** Caller must use this function as the only janitor writer; refs are re-read per deletion. */
export function pruneUpdateRuntime(controlRoot, options = {}) {
    const now = options.now ?? Date.now();
    return withUpdateRuntimeLock(controlRoot, () => {
        const root = realpathSync(controlRoot);
        const generations = options.generationsRoot ? realpathSync(options.generationsRoot) : path.join(root, 'generations');
        const generationsMetadata = lstatSync(generations);
        const rootDevice = statSync(root).dev;
        if (!generationsMetadata.isDirectory() || generationsMetadata.isSymbolicLink() || generationsMetadata.dev !== rootDevice) {
            throw new Error('Update runtime generations root is unsafe.');
        }
        const journal = path.join(root, 'janitor-tombstones.jsonl');
        const initialReferences = protectedReferences(root, options, journal);
        resumeTombstonesLocked(root, generations, rootDevice, journal, initialReferences);
        const records = readdirSync(generations, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith('.deleting-'))
            .map((entry) => generationRecord(generations, entry, rootDevice))
            .sort((left, right) => right.createdAt - left.createdAt);
        const keepNewest = new Set(records.filter((entry) => TERMINAL_GENERATION_STATES.has(entry.state)).slice(0, 2).map((entry) => entry.id));
        const removed = [];
        for (const generation of records) {
            const age = now - generation.createdAt;
            if (!TERMINAL_GENERATION_STATES.has(generation.state) || keepNewest.has(generation.id) || age < FOURTEEN_DAYS) continue;
            // Re-read immediately before rename so injected/concurrent refs fail safe.
            options.beforeReferenceCheck?.(generation.id);
            const references = collectRuntimeReferences(root);
            for (const id of initialReferences) references.add(id);
            for (const id of liveJobReferences(options)) references.add(id);
            if (references.has(generation.id)) continue;
            const identity = { dev: generation.metadata.dev, ino: generation.metadata.ino, uid: generation.metadata.uid };
            const tombstone = path.join(generations, `.deleting-${generation.id}-${randomUUID()}`);
            appendTombstone(journal, { state: 'planned', generation: generation.id, tombstone: path.basename(tombstone), identity });
            const current = lstatSync(generation.directory);
            if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid) {
                throw new Error(`Runtime generation identity changed before tombstone: ${generation.id}`);
            }
            renameSync(generation.directory, tombstone);
            syncDirectory(generations);
            options.afterTombstoneRename?.(generation.id, tombstone);
            rmSync(tombstone, { recursive: true, force: false });
            syncDirectory(generations);
            appendTombstone(journal, { state: 'done', generation: generation.id, tombstone: path.basename(tombstone), identity });
            removed.push(generation.id);
        }
        return removed;
    });
}

/** Durable ref creation uses no overwrite; all writers share the janitor lock. */
export function createRuntimeReference(controlRoot, kind, name, generationId) {
    if (!REF_KINDS.includes(kind) || !SAFE_ID.test(name || '') || !SAFE_ID.test(generationId || '')) throw new Error('Runtime reference identity is invalid.');
    return withUpdateRuntimeLock(controlRoot, () => {
        const root = realpathSync(controlRoot);
        const directory = path.join(root, 'refs', kind);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, name);
        writeFileSync(target, `${generationId}\n`, { flag: 'wx', mode: 0o600 });
        const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(directory);
        return target;
    });
}
