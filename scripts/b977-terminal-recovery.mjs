#!/usr/bin/env node
/** ADR-147: recover only the byte-pinned sequence-54 terminal control remnants. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commonGitDir } from './git-control-root.mjs';
import { OID_TERMINAL_STATES } from './oid-control-journal.mjs';
import { parseConsumerDomains } from './preview-oid-consumer.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PREFIX = 'nassaj-b977-terminal-recovery-';
const FACTS = Object.freeze({
    sequence: 54, oid: 'a3c40fd6fec74b108fb0da42415f6d2088ed99b8',
    nonce: '08aec835ed5c76280d937785bae3976a8c35599c75dde28ae2a1351443668496',
    candidate: '124c8e340ac58dc1ec925d0148938fa876abaa32c5fc29fa5c0f65d2bccb668a',
    previous: '87b603545c212adce51853b20a80ad8a69c2a6e323cfe88b65eed3477637dc68',
    manifest: '1345080efd5f671cc6d8e9d71a32526bbd42b7ad53d8a92f0251b55316e44bd4',
    journalHash: 'b6548b2a2068f8031089628623aaad67166a470290d50f9b0bb5c6e87bb62534',
    requestHash: 'f94ef216946a7cc872864b6e9cadeef582d0544b3256c391cac02a0507bdfc5a',
    eventHash: 'a6371745bbbfeba1c7d743b8fafc11d7ea47f82540f6a73dbb914edba9915650',
});
const RECEIPT = `${PREFIX}54-${FACTS.nonce}.json`;
const REQUEST = 'nassaj-preview-oid-control-request-v1.json';
const EVENT = 'nassaj-preview-oid-event-control-0000000000000054.json';
const CONSUMER = 'nassaj-preview-oid-consumer-v1.json';
const JOURNAL = `nassaj-oid-control-transaction-54-${FACTS.nonce}.json`;
function requireProof(condition, code) { if (!condition) throw new Error(`b977_${code}`); }
function metadata(stat) { return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(':'); }

const OTHER_WRITERS = new Set(['preview-oid-owner-action.mjs', 'preview-oid-activate.mjs',
    'oid-terminal-control-reconcile.mjs', 'oid-terminal-ledger-provenance-repair.mjs',
    'oid-control-capsule.mjs', 'install-preview-oid-consumer.mjs']);
function readConsumerProcess(pid, root) {
    if (Number(pid) === process.pid) return null;
    const base = `/proc/${pid}`;
    if (fs.statSync(base).uid !== process.getuid()) return null;
    const ticks = () => { const value = fs.readFileSync(`${base}/stat`, 'utf8'); return value.slice(value.lastIndexOf(')') + 2).split(' ')[19]; };
    const startTicks = ticks();
    const argv = fs.readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (!argv.length) return null;
    const scriptIndex = argv.findIndex((arg, index) => index > 0
        && (path.basename(arg) === 'preview-oid-consumer.mjs' || OTHER_WRITERS.has(path.basename(arg))));
    if (scriptIndex < 0) return null;
    const cwd = fs.realpathSync(`${base}/cwd`);
    const executable = path.basename(fs.readlinkSync(`${base}/exe`));
    const script = fs.realpathSync(path.resolve(cwd, argv[scriptIndex]));
    const args = argv.slice(scriptIndex + 1);
    let target = path.resolve(path.dirname(script), '..');
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--repo' && args[index + 1]) target = path.resolve(cwd, args[++index]);
    }
    if (fs.realpathSync(target) !== root) return null;
    requireProof(!OTHER_WRITERS.has(path.basename(script)), 'server_writer_active');
    requireProof(cwd === root && /^node(?:js)?$/.test(executable)
        && script === path.join(root, 'scripts/preview-oid-consumer.mjs'), 'writer_unknown');
    for (let index = 0; index < args.length; index += 2) {
        requireProof(args[index]?.startsWith('--') && args[index + 1] != null, 'writer_unknown');
    }
    const env = Object.fromEntries(fs.readFileSync(`${base}/environ`, 'utf8').split('\0')
        .filter(pair => pair.includes('=')).map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)]; }));
    const domains = parseConsumerDomains(env.NASSAJ_PREVIEW_OID_DOMAINS).sort();
    const domainFlag = args.indexOf('--domains');
    if (domainFlag >= 0) requireProof(JSON.stringify(parseConsumerDomains(args[domainFlag + 1]).sort()) === JSON.stringify(domains), 'writer_unknown');
    requireProof(ticks() === startTicks, 'writer_changed');
    return { pid: Number(pid), startTicks, script, cwd, argvSha256: digest(JSON.stringify(argv)), domains };
}

/** Read only documented persistent consumer CLI processes; reject unresolved matching writers. */
export function inspectB977ConsumerWriters(root) {
    const canonical = fs.realpathSync(root); const consumers = [];
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try { const value = readConsumerProcess(pid, canonical); if (value) consumers.push(value); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw new Error(`b977_writer_inventory_unknown:pid=${pid}:${error.message}`); }
    }
    return consumers.sort((left, right) => left.pid - right.pid);
}
function proveConsumerWriters(root, inventory) {
    const first = inventory(root); const second = inventory(root);
    requireProof(JSON.stringify(first) === JSON.stringify(second), 'writer_changed');
    requireProof(Array.isArray(second) && second.every(item => Number.isSafeInteger(item.pid) && item.pid > 0
        && /^\d+$/.test(item.startTicks) && typeof item.script === 'string'
        && typeof item.cwd === 'string' && /^[a-f0-9]{64}$/.test(item.argvSha256 || '')
        && Array.isArray(item.domains) && item.domains.length === 1 && item.domains[0] === 'client'), 'server_writer_active');
    return second;
}

function snapshot(file) {
    let before;
    try { before = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    requireProof(before.isFile() && !before.isSymbolicLink() && before.size <= 2 * 1024 * 1024, 'unsafe_file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        requireProof(metadata(before) === metadata(fs.fstatSync(fd)), 'file_changed');
        const bytes = fs.readFileSync(fd);
        requireProof(metadata(before) === metadata(fs.fstatSync(fd))
            && metadata(before) === metadata(fs.lstatSync(file)), 'file_changed');
        return { identity: metadata(before), sha256: digest(bytes), value: JSON.parse(bytes.toString('utf8')) };
    } finally { fs.closeSync(fd); }
}
function capture(git) {
    const names = fs.readdirSync(git).filter((name) => name.startsWith('nassaj-oid-control-transaction-')
        || name.startsWith(PREFIX) || [REQUEST, EVENT, CONSUMER].includes(name)).sort();
    return Object.fromEntries(names.map((name) => [name, snapshot(path.join(git, name))]));
}
function stableCapture(git, hooks) {
    const first = capture(git);
    hooks?.betweenReads?.();
    const second = capture(git);
    requireProof(JSON.stringify(first) === JSON.stringify(second), 'snapshot_changed');
    return second;
}
function checkControls(state) {
    for (const [name, hash] of [[REQUEST, FACTS.requestHash], [EVENT, FACTS.eventHash]]) {
        const item = state[name];
        if (!item) continue;
        const value = item.value;
        requireProof(item.sha256 === hash && value.sequence === FACTS.sequence && value.oid === FACTS.oid
            && value.snapshotOid === FACTS.oid && value.buildId === FACTS.candidate
            && value.controlManifestSha256 === FACTS.manifest && value.transactionNonce == null, 'control_mismatch');
    }
}
function checkReceipt(item) {
    if (!item) return;
    const value = item.value;
    const keys = ['schema', 'facts', 'initialConsumerSha256', 'initialConsumerWriters', 'stage'];
    requireProof(Object.keys(value).sort().join() === keys.sort().join()
        && value.schema === 'nassaj-b977-terminal-recovery/v1'
        && JSON.stringify(value.facts) === JSON.stringify(FACTS)
        && /^[a-f0-9]{64}$/.test(value.initialConsumerSha256 || '')
        && Array.isArray(value.initialConsumerWriters)
        && ['prepared', 'request_removed', 'controls_removed'].includes(value.stage), 'receipt_conflict');
}
function validate(state) {
    const journal = state[JOURNAL];
    requireProof(journal?.sha256 === FACTS.journalHash, 'journal_mismatch');
    const tx = journal.value;
    requireProof(tx.state === 'restart_deferred_restored' && tx.gate === 6 && tx.sequence === FACTS.sequence
        && tx.oid === FACTS.oid && tx.transactionNonce === FACTS.nonce && tx.buildId === FACTS.candidate
        && tx.previousBuildId === FACTS.previous && tx.controlManifestSha256 === FACTS.manifest, 'journal_identity');
    for (const [name, item] of Object.entries(state)) {
        if (name.startsWith('nassaj-oid-control-transaction-')) {
            requireProof(item && OID_TERMINAL_STATES.has(item.value?.state), 'nonterminal_transaction');
        }
        if (name.startsWith(PREFIX)) requireProof(name === RECEIPT, 'receipt_conflict');
    }
    const consumer = state[CONSUMER]?.value;
    requireProof(consumer?.schemaVersion === 1 && Number.isSafeInteger(consumer.acceptedSequence)
        && consumer.acceptedSequence > 54 && /^[a-f0-9]{40}$/.test(consumer.acceptedOid || ''), 'consumer_invalid');
    checkControls(state); checkReceipt(state[RECEIPT]);
    const stage = state[RECEIPT]?.value.stage;
    if (!stage) requireProof(state[REQUEST] && state[EVENT], 'controls_missing');
    if (stage === 'prepared') requireProof(state[EVENT], 'event_missing');
    if (stage === 'request_removed') requireProof(!state[REQUEST], 'request_reappeared');
    if (stage === 'controls_removed') requireProof(!state[REQUEST] && !state[EVENT], 'controls_reappeared');
}
function syncDirectory(git) {
    const fd = fs.openSync(git, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeReceipt(git, value, exclusive = false) {
    const target = path.join(git, RECEIPT);
    const temporary = path.join(git, `.b977-receipt-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
        if (exclusive) { fs.linkSync(temporary, target); fs.unlinkSync(temporary); }
        else fs.renameSync(temporary, target);
        syncDirectory(git);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function unchanged(git, expected) {
    const current = stableCapture(git);
    requireProof(JSON.stringify(current) === JSON.stringify(expected), 'snapshot_changed');
    validate(current);
}
function executeLocked(root, git, apply, hooks, inventory) {
    const consumerWriters = proveConsumerWriters(root, inventory);
    let state = stableCapture(git, hooks); validate(state);
    if (!apply) return { ready: true, applied: false, stage: state[RECEIPT]?.value.stage || 'unstarted',
        consumerSha256: state[CONSUMER].sha256, consumerWriters, facts: FACTS };
    let receipt = state[RECEIPT]?.value;
    if (!receipt) {
        hooks?.checkpoint?.('before_receipt'); unchanged(git, state);
        receipt = { schema: 'nassaj-b977-terminal-recovery/v1', facts: FACTS,
            initialConsumerSha256: state[CONSUMER].sha256, initialConsumerWriters: consumerWriters, stage: 'prepared' };
        writeReceipt(git, receipt, true); hooks?.checkpoint?.('prepared');
        state = stableCapture(git); validate(state);
    }
    if (receipt.stage === 'prepared') {
        hooks?.checkpoint?.('before_request_remove'); proveConsumerWriters(root, inventory); unchanged(git, state);
        if (state[REQUEST]) { fs.unlinkSync(path.join(git, REQUEST)); syncDirectory(git); }
        hooks?.checkpoint?.('request_unlinked');
        const afterRequest = { ...state }; delete afterRequest[REQUEST]; unchanged(git, afterRequest);
        receipt = { ...receipt, stage: 'request_removed' }; writeReceipt(git, receipt);
        hooks?.checkpoint?.('request_removed'); state = stableCapture(git); validate(state);
    }
    if (receipt.stage === 'request_removed') {
        hooks?.checkpoint?.('before_event_remove'); proveConsumerWriters(root, inventory); unchanged(git, state);
        if (state[EVENT]) { fs.unlinkSync(path.join(git, EVENT)); syncDirectory(git); }
        hooks?.checkpoint?.('event_unlinked');
        const afterEvent = { ...state }; delete afterEvent[EVENT]; unchanged(git, afterEvent);
        receipt = { ...receipt, stage: 'controls_removed' }; writeReceipt(git, receipt);
        hooks?.checkpoint?.('controls_removed');
    }
    validate(stableCapture(git));
    return { ready: true, applied: true, stage: 'controls_removed' };
}

/** Plan or apply pinned recovery under the existing shared event lock; never writes consumer or runtime. */
export function recoverB977(root, { apply = false, testHooks } = {}) {
    const git = commonGitDir(root);
    const lock = path.join(git, 'nassaj-preview-event-mutation.lock');
    const fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        requireProof(fs.fstatSync(fd).isFile(), 'unsafe_lock');
        // flock locks the inherited open-file description; this parent retains fd until completion.
        const result = spawnSync('flock', ['-x', '-w', '5', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
        requireProof(result.status === 0, 'lock_unavailable');
        requireProof(metadata(fs.fstatSync(fd)) === metadata(fs.lstatSync(lock)), 'lock_changed');
        return executeLocked(root, git, apply, testHooks, testHooks?.consumerInventory || inspectB977ConsumerWriters);
    } finally { fs.closeSync(fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        requireProof(process.argv.length === 4 && ['--plan', '--apply'].includes(process.argv[2]), 'usage');
        process.stdout.write(`${JSON.stringify(recoverB977(path.resolve(process.argv[3]), { apply: process.argv[2] === '--apply' }))}\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
