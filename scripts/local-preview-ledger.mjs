#!/usr/bin/env node
/** Atomic, cross-watcher lifecycle ledger for local preview builds. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { listOidControlTransactions, OID_TERMINAL_STATES, assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import { reconcileTerminalOidControl } from './oid-terminal-control-reconcile.mjs';
import { advanceClientServingLineageRecord } from './lib/client-publication-lineage.mjs';
import { resolvePreviewOid, readPreviewState } from './preview-oid-pipeline.mjs';
import { commonGitDir, gitControlPath } from './git-control-root.mjs';

export const PREVIEW_LEDGER_NAME = 'nassaj-local-preview-ledger-v1.json';
export const PREVIEW_LEDGER_LOCK_NAME = 'nassaj-local-preview-ledger.lock';
export const PREVIEW_BUILD_LOCK_NAME = 'nassaj-local-preview-build.lock';
export const PREVIEW_STATES = new Set([
    'observed', 'queued', 'building', 'built', 'promoted', 'served', 'loaded', 'failed', 'superseded',
]);

function emptyLedger() {
    return { schemaVersion: 1, updatedAt: null };
}

export function previewControlPaths(root) {
    const gitDirectory = commonGitDir(root);
    return {
        gitDirectory,
        ledger: path.join(gitDirectory, PREVIEW_LEDGER_NAME),
        ledgerLock: path.join(gitDirectory, PREVIEW_LEDGER_LOCK_NAME),
        buildLock: path.join(gitDirectory, PREVIEW_BUILD_LOCK_NAME),
    };
}

/** Read a missing or valid v1 ledger. Corrupt state fails closed. */
export function readPreviewLedger(root) {
    const { ledger } = previewControlPaths(root);
    if (!existsSync(ledger)) return emptyLedger();
    const parsed = JSON.parse(readFileSync(ledger, 'utf8'));
    if (parsed?.schemaVersion !== 1) throw new Error('Unsupported local preview ledger schema.');
    return { ...emptyLedger(), ...parsed };
}

function normalizeEvent(event) {
    if (!event || !['client', 'server'].includes(event.target) || !PREVIEW_STATES.has(event.state)) {
        throw new Error('Invalid local preview ledger event.');
    }
    if (!Number.isSafeInteger(event.sourceGeneration) || event.sourceGeneration < 0) {
        throw new Error('Invalid local preview source generation.');
    }
    if (event.publisher != null && !['legacy', 'oid'].includes(event.publisher)) {
        throw new Error('Invalid local preview publisher.');
    }
    const hex = (value) => value == null || /^[a-f0-9]{64}$/.test(value);
    for (const key of ['sourceBuildId', 'candidateBuildId', 'promotedBuildId', 'runtimeBuildId']) {
        if (!hex(event[key])) throw new Error(`Invalid local preview ${key}.`);
    }
    return {
        target: event.target,
        publisher: event.publisher === 'oid' ? 'oid' : 'legacy',
        sourceGeneration: event.sourceGeneration,
        state: event.state,
        sourceBuildId: event.sourceBuildId ?? null,
        candidateBuildId: event.candidateBuildId ?? null,
        promotedBuildId: event.promotedBuildId ?? null,
        runtimeBuildId: event.runtimeBuildId ?? null,
        error: event.error ? {
            code: String(event.error.code || 'preview_failed').slice(0, 80),
            message: String(event.error.message || 'Local preview failed.').slice(0, 500),
        } : null,
        observedAt: event.observedAt || new Date().toISOString(),
    };
}

/** Apply one event while preserving the other watcher and last success. */
export function applyPreviewLedgerEvent(root, rawEvent, now = new Date().toISOString()) {
    const event = normalizeEvent(rawEvent);
    const paths = previewControlPaths(root);
    mkdirSync(paths.gitDirectory, { recursive: true });
    const ledger = readPreviewLedger(root);
    const prefix = event.target;
    const title = `${prefix[0].toUpperCase()}${prefix.slice(1)}`;
    const runtimeTitle = event.target === 'client' ? 'Served' : 'Loaded';
    const recordedGeneration = ledger[`${prefix}SourceGeneration`];
    const recordedPublisher = ledger[`${prefix}Publisher`] || 'legacy';
    if (recordedPublisher === 'oid' && event.publisher === 'legacy') {
        return ledger;
    }
    if (recordedPublisher === event.publisher
        && Number.isSafeInteger(recordedGeneration) && event.sourceGeneration < recordedGeneration) {
        return ledger;
    }
    const current = {
        [`${prefix}Publisher`]: event.publisher,
        [`${prefix}SourceGeneration`]: event.sourceGeneration,
        [`${prefix}State`]: event.state,
        [`${prefix}SourceBuildId`]: event.sourceBuildId,
        [`${prefix}CandidateBuildId`]: event.candidateBuildId,
        [`${prefix}PromotedBuildId`]: event.promotedBuildId,
        [`${prefix}${runtimeTitle}BuildId`]: event.runtimeBuildId
            ?? ledger[`${prefix}${runtimeTitle}BuildId`] ?? null,
        [`${prefix}Error`]: event.error,
        [`${prefix}ObservedAt`]: event.observedAt,
        [`${prefix}UpdatedAt`]: now,
    };
    const successfulState = event.target === 'client' ? 'served' : 'loaded';
    const lastSuccessfulKey = `lastSuccessful${title}`;
    const next = {
        ...ledger,
        ...current,
        schemaVersion: 1,
        updatedAt: now,
        [lastSuccessfulKey]: event.state === successfulState ? current : ledger[lastSuccessfulKey] ?? null,
    };
    writeLedgerAtomically(paths, next);
    return next;
}

/** One temp-file-then-rename write of the whole ledger document. */
function writeLedgerAtomically(paths, next) {
    const temporary = `${paths.ledger}.tmp-${process.pid}-${Date.now()}`;
    try {
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, paths.ledger);
        const parent = openSync(path.dirname(paths.ledger), 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
        rmSync(temporary, { force: true });
    }
}

/** Serialize cross-process ledger merges with a kernel lock. */
export function recordPreviewLedgerEvent(root, event) {
    const paths = previewControlPaths(root);
    mkdirSync(paths.gitDirectory, { recursive: true });
    const payload = Buffer.from(JSON.stringify(event), 'utf8').toString('base64url');
    const result = spawnSync('flock', [
        '-x', '-w', '5', '-F', paths.ledgerLock,
        process.execPath, fileURLToPath(import.meta.url), '--apply', root, payload,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`Local preview ledger write failed (${result.status ?? result.signal}).`);
    }
}

export const PUBLISH_BASE_GUARD_RESULTS = new Set(['allowed', 'blocked', 'overridden']);
export const PUBLISH_BASE_GUARD_LOG_LIMIT = 50;
const isOid = (value) => /^[a-f0-9]{40}$/.test(value || '');

/** Validate one base-regression guard decision before it enters the audit log. */
function normalizePublishBaseGuardDecision(decision) {
    if (!decision || typeof decision !== 'object') throw new Error('Invalid publish base guard decision.');
    if (!PUBLISH_BASE_GUARD_RESULTS.has(decision.result)) throw new Error('Invalid publish base guard result.');
    if (decision.liveCommit != null && !isOid(decision.liveCommit)) throw new Error('Invalid publish base guard live commit.');
    if (!isOid(decision.sourceOid)) throw new Error('Invalid publish base guard source OID.');
    if (typeof decision.dirty !== 'boolean') throw new Error('Invalid publish base guard dirty flag.');
    const dropped = decision.dropped ?? [];
    if (!Array.isArray(dropped) || dropped.some((oid) => !isOid(oid))) throw new Error('Invalid publish base guard dropped list.');
    return {
        event: 'publish_base_guard',
        liveCommit: decision.liveCommit ?? null,
        sourceOid: decision.sourceOid,
        result: decision.result,
        dirty: decision.dirty,
        dropped: dropped.slice(0, PUBLISH_BASE_GUARD_LOG_LIMIT),
        observedAt: decision.observedAt || new Date().toISOString(),
    };
}

/** Append one guard decision to the bounded audit log kept inside the preview ledger. */
export function applyPublishBaseGuardDecision(root, rawDecision, now = new Date().toISOString()) {
    const decision = normalizePublishBaseGuardDecision(rawDecision);
    const paths = previewControlPaths(root);
    mkdirSync(paths.gitDirectory, { recursive: true });
    const ledger = readPreviewLedger(root);
    const log = Array.isArray(ledger.publishBaseGuard) ? ledger.publishBaseGuard : [];
    const next = {
        ...ledger, schemaVersion: 1, updatedAt: now,
        publishBaseGuard: [...log, decision].slice(-PUBLISH_BASE_GUARD_LOG_LIMIT),
    };
    writeLedgerAtomically(paths, next);
    return next;
}

/**
 * Serialize guard-decision audit writes with the same kernel lock as lifecycle
 * events. This primitive always throws on a failed write (lock timeout or disk
 * error); whether that failure is fatal is the caller's choice by decision
 * result — an `allowed` exchange downgrades it to a warning, while `blocked` and
 * `overridden` stay fail-closed (see `recordGuardDecision` in client-build-atomic).
 */
export function recordPublishBaseGuardDecision(root, decision) {
    const paths = previewControlPaths(root);
    mkdirSync(paths.gitDirectory, { recursive: true });
    const payload = Buffer.from(JSON.stringify(decision), 'utf8').toString('base64url');
    const result = spawnSync('flock', [
        '-x', '-w', '5', '-F', paths.ledgerLock,
        process.execPath, fileURLToPath(import.meta.url), '--apply-guard', root, payload,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`Publish base guard audit write failed (${result.status ?? result.signal}).`);
    }
}

/** The bounded, append-only publish base guard audit log, newest last. */
export function readPublishBaseGuardLog(root) {
    const log = readPreviewLedger(root).publishBaseGuard;
    return Array.isArray(log) ? log : [];
}

/** Record a commit-addressed client generation only after atomic promotion proved it served. */
export function recordOidClientServed(root, event, buildId) {
    recordPreviewLedgerEvent(root, {
        target: 'client', publisher: 'oid', sourceGeneration: event.sequence, state: 'served',
        sourceBuildId: buildId, candidateBuildId: buildId,
        promotedBuildId: buildId, runtimeBuildId: buildId,
    });
}

/** Repair an interrupted client lifecycle without erasing its last success. */
export function reconcileClientPreviewLedger(root, sourceGeneration, sourceBuildId, servedBuildId) {
    const previous = readPreviewLedger(root);
    if (['building', 'built', 'promoted'].includes(previous.clientState)) {
        const promotedWasServed = previous.clientPromotedBuildId && previous.clientPromotedBuildId === servedBuildId;
        recordPreviewLedgerEvent(root, {
            target: 'client',
            sourceGeneration: previous.clientSourceGeneration,
            state: promotedWasServed ? 'served' : 'failed',
            sourceBuildId: previous.clientSourceBuildId,
            candidateBuildId: previous.clientCandidateBuildId,
            promotedBuildId: previous.clientPromotedBuildId,
            runtimeBuildId: servedBuildId,
            ...(!promotedWasServed && { error: { code: 'watcher_interrupted', message: 'Client preview watcher stopped before serving the candidate.' } }),
        });
    }
    const current = servedBuildId === sourceBuildId ? 'served' : 'observed';
    recordPreviewLedgerEvent(root, {
        target: 'client', sourceGeneration, state: current,
        sourceBuildId, candidateBuildId: servedBuildId,
        promotedBuildId: servedBuildId, runtimeBuildId: servedBuildId,
    });
}

/** Repair interrupted server builds without treating a candidate as promoted. */
export function reconcileServerPreviewLedger(
    root,
    sourceGeneration,
    sourceBuildId,
    candidateBuildId,
    onDiskBuildId,
) {
    const previous = readPreviewLedger(root);
    if (previous.serverState === 'building') {
        recordPreviewLedgerEvent(root, {
            target: 'server', sourceGeneration: previous.serverSourceGeneration,
            state: 'failed', sourceBuildId: previous.serverSourceBuildId,
            candidateBuildId: previous.serverCandidateBuildId,
            promotedBuildId: previous.serverPromotedBuildId,
            runtimeBuildId: previous.serverLoadedBuildId ?? onDiskBuildId,
            error: { code: 'watcher_interrupted', message: 'Server preview watcher stopped before storing its candidate.' },
        });
    }
    // dist-server identifies what has been promoted on disk; it cannot attest
    // what this already-running process loaded at boot. Preserve that runtime
    // identity until readiness from the replacement process proves otherwise.
    const loadedBuildId = previous.serverLoadedBuildId ?? null;
    const visibleCandidateBuildId = candidateBuildId ?? onDiskBuildId;
    // A retained candidate normally remains a valid restart target.  The one
    // exception is an exactly proven, terminal OID rollback: its control
    // remnants must first be durably settled under the event lock, otherwise
    // a watcher boot would re-advertise a restart that can only replay a
    // rejected candidate.  Any ambiguity deliberately follows the old path.
    let rolledBack = false;
    try {
        const transactions = listOidControlTransactions(root);
        const terminal = transactions.filter(({ value }) => value?.state === 'rolled_back'
            && value.sequence === sourceGeneration && value.buildId === sourceBuildId
            && value.buildId === visibleCandidateBuildId && value.previousBuildId === onDiskBuildId
            && /^[a-f0-9]{64}$/.test(value.transactionNonce || ''));
        if (!transactions.some(({ value }) => !OID_TERMINAL_STATES.has(value?.state))
            && terminal.length === 1 && loadedBuildId === onDiskBuildId) {
            const rollbackEvent = {
                target: 'server', publisher: previous.serverPublisher === 'oid' ? 'oid' : 'legacy', sourceGeneration,
                state: 'failed', sourceBuildId, candidateBuildId: visibleCandidateBuildId,
                promotedBuildId: onDiskBuildId, runtimeBuildId: loadedBuildId,
                error: { code: 'oid_candidate_rolled_back', message: 'OID candidate was rolled back and is not an active restart target.' },
            };
            rolledBack = reconcileTerminalOidControl(root, {
                sequence: sourceGeneration, oid: terminal[0].value.oid, buildId: sourceBuildId,
                previousBuildId: onDiskBuildId, nonce: terminal[0].value.transactionNonce, ledgerEvent: rollbackEvent,
            }).settled === true;
        }
    } catch {
        // A corrupt/remapped control remnant is not proof of rollback.  Keep
        // the candidate actionable rather than concealing a required restart.
        rolledBack = false;
    }
    const loadedCurrentSource = loadedBuildId === sourceBuildId;
    if (rolledBack) return;
    recordPreviewLedgerEvent(root, {
        target: 'server', publisher: previous.serverPublisher === 'oid' ? 'oid' : 'legacy', sourceGeneration,
        state: loadedCurrentSource ? 'loaded' : visibleCandidateBuildId === sourceBuildId ? 'built' : 'observed',
        sourceBuildId,
        candidateBuildId: visibleCandidateBuildId,
        promotedBuildId: onDiskBuildId,
        runtimeBuildId: loadedBuildId,
    });
}

/** CAS serving lineage and epoch protection under the existing ledger lock. Never deletes assets. */
export function applyClientServingLineage(root, input) {
    const next = advanceClientServingLineageRecord(readPreviewLedger(root), input);
    writeLedgerAtomically(previewControlPaths(root), next);
    return next.clientPublicationServing;
}

/** Write the lineage using the same cross-process merge lock as legacy ledger writers. */
export function recordClientServingLineage(root, input) {
    const paths = previewControlPaths(root);
    const payload = Buffer.from(JSON.stringify(input)).toString('base64url');
    const result = spawnSync('flock', ['-x', '-w', '5', '-F', paths.ledgerLock,
        process.execPath, fileURLToPath(import.meta.url), '--apply-serving', root, payload], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('client_serving_ledger_failed');
    return readPreviewLedger(root).clientPublicationServing;
}

function main() {
    if (process.argv[2] === '--apply-serving') {
        applyClientServingLineage(path.resolve(process.argv[3]), JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8')));
        return;
    }
    if (process.argv[2] === '--apply-guard') {
        const root = path.resolve(process.argv[3]);
        applyPublishBaseGuardDecision(root, JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8')));
        return;
    }
    if (process.argv[2] !== '--apply') return;
    const root = path.resolve(process.argv[3]);
    const event = JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8'));
    applyPreviewLedgerEvent(root, event);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

const EVENT_ROOT = 'refs/nassaj/previews/v1/events';
const MAX_SEQUENCE = 9_999_999_999_999_999;
const DOMAINS = new Set(['client', 'server']);

/** Run the fixed-argument Git queries shared by preview event readers. */
export function git(root, args, options = {}) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
    if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed: ${String(result.stderr || result.stdout || '').trim()}`);
    }
    return String(result.stdout || '').trim();
}

/** Shared lock serializing event-ref creation with the final pre-promotion check. */
export function previewEventMutationLock(root) {
    return gitControlPath(root, 'nassaj-preview-event-mutation.lock');
}

/** Hold the same advisory lock used by enqueue across an asynchronous runtime mutation. */
export async function withPreviewEventMutationLock(root, operation) {
    return withPreviewMutationLock(root, previewEventMutationLock(root), operation);
}

/** Hold a preview advisory lock until its asynchronous operation completes. */
export async function withPreviewMutationLock(root, lockFile, operation) {
    const holder = spawn('flock', [
        '-x', '-w', '10', lockFile, process.execPath, '-e',
        "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    holder.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        let stdout = '';
        const ready = (chunk) => {
            stdout += chunk;
            if (stdout.includes('locked\n')) {
                holder.stdout.off('data', ready);
                resolve();
            }
        };
        holder.stdout.on('data', ready);
        holder.once('error', reject);
        holder.once('exit', (code) => reject(new Error(`Preview event lock exited before acquisition (${code}): ${stderr}`)));
    });
    try {
        return await operation();
    } finally {
        holder.stdin.end();
        await new Promise((resolve, reject) => {
            holder.once('error', reject);
            holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Preview event lock release failed (${code}): ${stderr}`)));
        });
    }
}

/** Validate and serialize a preview event sequence. */
export function exactSequence(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEQUENCE) {
        throw new Error('Preview event sequence must be a positive safe integer.');
    }
    return String(value).padStart(16, '0');
}

/** Validate and normalize the existing client/server event domains. */
export function normalizeDomains(domains) {
    const selected = [...new Set(domains || [])].sort();
    if (!selected.length || selected.some((domain) => !DOMAINS.has(domain))) {
        throw new Error('Preview event domains must contain client and/or server.');
    }
    return selected;
}

function eventRef(sequence, domain) {
    return `${EVENT_ROOT}/${exactSequence(sequence)}/${domain}`;
}

/** Exact refs that make one preview event visible; callers may include these in a wider Git transaction. */
export function previewEventRefs(sequence, domains) {
    const exact = exactSequence(sequence);
    const selectedDomains = normalizeDomains(domains);
    const group = `event-${exact}`;
    return {
        group,
        refs: [
            `${EVENT_ROOT}/${exact}/event`,
            ...selectedDomains.map((domain) => eventRef(sequence, domain)),
            `refs/nassaj/previews/v1/groups/${group}/desired`,
            ...selectedDomains.map((domain) => `refs/nassaj/previews/v1/groups/${group}/${domain}/desired`),
        ],
    };
}

/** Read queued refs and return globally ordered coherent events. */
export function listPreviewEvents(root) {
    const output = git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `${EVENT_ROOT}/`]);
    const events = new Map();
    for (const line of output ? output.split('\n') : []) {
        const match = line.match(new RegExp(`^${EVENT_ROOT}/(\\d{16})/(client|server|event) ([0-9a-f]{40})$`));
        if (!match) throw new Error('Malformed preview event ref encountered.');
        const sequence = Number(match[1]);
        const domain = match[2];
        const oid = match[3];
        const current = events.get(sequence) || { sequence, oid, domains: [] };
        if (current.oid !== oid) throw new Error(`Preview sequence ${sequence} has incoherent domain OIDs.`);
        if (domain !== 'event') current.domains.push(domain);
        events.set(sequence, current);
    }
    return [...events.values()]
        .map((event) => ({ ...event, domains: normalizeDomains(event.domains), group: `event-${exactSequence(event.sequence)}` }))
        .sort((left, right) => left.sequence - right.sequence);
}

function gitTransaction(root, commands) {
    const result = spawnSync('flock', [
        '-x', previewEventMutationLock(root),
        'git', 'update-ref', '--stdin',
    ], {
        cwd: root, encoding: 'utf8', input: `start\n${commands.join('\n')}\nprepare\ncommit\n`,
    });
    if (result.status !== 0) throw new Error(`Atomic preview event enqueue failed: ${String(result.stderr || '').trim()}`);
}

/** Append one immutable event. Reusing a sequence with different facts fails. */
export function enqueuePreviewEvent(root, input) {
    // Propagate this caller's actual disposition context, or remain blocked.
    assertNoNonterminalOidTransaction(root, null, input.disposition || null);
    const sequence = Number(input.sequence);
    exactSequence(sequence);
    const oid = resolvePreviewOid(root, input.oid);
    if (oid !== input.oid) throw new Error('Preview event requires a full exact commit OID.');
    const domains = normalizeDomains(input.domains);
    const { group, refs } = previewEventRefs(sequence, domains);
    const existing = refs.map((ref) => {
        const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root, encoding: 'utf8' });
        if (result.status === 1) return { ref, oid: null };
        if (result.status !== 0) throw new Error(`Cannot inspect preview event ref ${ref}.`);
        return { ref, oid: result.stdout.trim() };
    });
    if (existing.some((item) => item.oid && item.oid !== oid)) {
        throw new Error(`Preview sequence ${sequence} is already bound to another commit.`);
    }
    const missing = existing.filter((item) => !item.oid);
    if (missing.length && missing.length !== existing.length) {
        throw new Error(`Preview sequence ${sequence} is only partially present; refusing non-atomic repair.`);
    }
    if (missing.length) gitTransaction(root, refs.map((ref) => `create ${ref} ${oid}`));
    return { sequence, oid, domains, group };
}

const STATE_NAME = 'nassaj-preview-oid-consumer-v1.json';
const OID = /^[a-f0-9]{40}$/;
const BUILD_ID = /^[a-f0-9]{64}$/;

/** Resolve the existing consumer state file. */
export function statePath(root) {
    return gitControlPath(root, STATE_NAME);
}

/** Read JSON or return the caller fallback when absent. */
export function readJson(file, fallback) {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
}

/** Read and validate the persisted consumer state. */
export function readConsumerState(root) {
    const state = readJson(statePath(root), {
        schemaVersion: 1, acceptedSequence: 0, acceptedOid: null,
        client: null, server: null, updatedAt: null,
    });
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.acceptedSequence)) {
        throw new Error('Invalid preview consumer state.');
    }
    return state;
}

/** Read a regular, non-symlink control document. */
export function readRegularJson(file, label) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular file.`);
    const descriptor = openSync(file, 'r');
    try { return JSON.parse(readFileSync(descriptor, 'utf8')); } finally { closeSync(descriptor); }
}

/** Resolve the existing owner control request file. */
export function controlPath(root) {
    return gitControlPath(root, 'nassaj-preview-oid-control-request-v1.json');
}

function provenancePath(root, buildId) {
    return path.join(root, '.nassaj-local-preview', 'server-candidates', buildId, 'BUILD_PROVENANCE.json');
}

/** Fail-closed identity check shared by the read-only gate and executor. */
export function inspectOwnerControlRequest(root) {
    const request = readRegularJson(controlPath(root), 'OID owner control request');
    if (request.schemaVersion !== 1 || request.action !== 'promote-and-safe-restart'
        || !Number.isSafeInteger(request.sequence) || request.sequence < 1
        || !OID.test(request.oid || '') || !BUILD_ID.test(request.buildId || '')
        || !BUILD_ID.test(request.controlManifestSha256 || '') || request.snapshotOid !== request.oid
        || request.group !== `event-${String(request.sequence).padStart(16, '0')}`) {
        throw new Error('OID owner control request identity is invalid.');
    }
    const newest = listPreviewEvents(root).filter((event) => event.domains.includes('server')).at(-1);
    const consumer = readConsumerState(root);
    const preview = readPreviewState(root, request.group);
    if (!newest || newest.sequence !== request.sequence || newest.oid !== request.oid
        || consumer.server?.sequence !== request.sequence || consumer.server?.oid !== request.oid
        || consumer.server?.phase !== 'awaiting_owner' || consumer.server?.buildId !== request.buildId
        || consumer.server?.controlManifestSha256 !== request.controlManifestSha256
        || preview.desired !== request.oid || preview.server.desired !== request.oid
        || preview.server.candidate !== request.oid || !preview.coherent) {
        throw new Error('OID owner control request was superseded or is not awaiting this exact candidate.');
    }
    const provenance = readRegularJson(provenancePath(root, request.buildId), 'OID server candidate provenance');
    if (provenance.artifact !== 'server' || provenance.dirty !== false
        || provenance.commit !== request.oid || provenance.baseCommit !== request.oid
        || provenance.buildId !== request.buildId) {
        throw new Error('OID server candidate provenance does not match the owner request.');
    }
    const eventControl = readRegularJson(gitControlPath(root,
        `nassaj-preview-oid-event-control-${String(request.sequence).padStart(16, '0')}.json`), 'OID event control identity');
    if (eventControl.schema !== 'nassaj-oid-control-event/v1' || eventControl.sequence !== request.sequence
        || eventControl.oid !== request.oid || eventControl.snapshotOid !== request.oid
        || eventControl.buildId !== request.buildId
        || eventControl.controlManifestSha256 !== request.controlManifestSha256) {
        throw new Error('OID event control identity does not match the owner request.');
    }
    return request;
}
