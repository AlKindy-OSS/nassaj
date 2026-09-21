import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { once } from 'node:events';
import { recoverB977 as recoverProductionB977 } from './b977-terminal-recovery.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Exercise the same implementation against sanitized evidence; production pins stay intact.
const source = fs.readFileSync(path.join(HERE, 'b977-terminal-recovery.mjs'), 'utf8');
const journalPin = /journalHash: '[a-f0-9]{64}'/g;
assert.equal([...source.matchAll(journalPin)].length, 1);
const fixtureHash = createHash('sha256').update(fs.readFileSync(path.join(HERE, 'fixtures/b977/journal.json'))).digest('hex');
fs.mkdirSync(path.join(HERE, '../.artifacts'), { recursive: true });
const moduleRoot = fs.mkdtempSync(path.join(HERE, '../.artifacts/b977-module-'));
after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }));
const moduleFile = path.join(moduleRoot, 'recovery.mjs');
fs.writeFileSync(moduleFile, source.replace(journalPin, `journalHash: '${fixtureHash}'`)
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${pathToFileURL(path.resolve(HERE, relative)).href}'`));
const { recoverB977 } = await import(pathToFileURL(moduleFile).href);

const NONCE = '08aec835ed5c76280d937785bae3976a8c35599c75dde28ae2a1351443668496';
const NAMES = {
    journal: `nassaj-oid-control-transaction-54-${NONCE}.json`,
    request: 'nassaj-preview-oid-control-request-v1.json',
    event: 'nassaj-preview-oid-event-control-0000000000000054.json',
    consumer: 'nassaj-preview-oid-consumer-v1.json',
    receipt: `nassaj-b977-terminal-recovery-54-${NONCE}.json`,
};
function fixture(t) {
    const root = fs.mkdtempSync('/var/tmp/b977-test-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', root]);
    const git = path.join(root, '.git');
    const files = Object.fromEntries(Object.entries(NAMES).map(([key, value]) => [key, path.join(git, value)]));
    for (const key of ['journal', 'request', 'event']) fs.copyFileSync(path.join(HERE, 'fixtures/b977', `${key}.json`), files[key]);
    fs.writeFileSync(files.consumer, JSON.stringify({ schemaVersion: 1, acceptedSequence: 128, acceptedOid: 'a'.repeat(40),
        client: { sequence: 128, phase: 'building' }, server: { sequence: 54, phase: 'awaiting_owner' } }));
    fs.writeFileSync(path.join(git, 'nassaj-preview-event-mutation.lock'), '');
    return { root, git, files };
}
function bytes(files) { return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null])); }
function edit(file, fn) { const value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value)); }

test('production pins reject sanitized evidence without receipt or deletion', t => {
    const { root, files } = fixture(t); const before = bytes(files);
    assert.throws(() => recoverProductionB977(root, { apply: true }), /b977_journal_mismatch/);
    assert.deepEqual(bytes(files), before);
    assert.equal(fs.existsSync(files.receipt), false);
});

test('read-only plan does not create a receipt or change controls; apply preserves consumer and journal exactly', t => {
    const { root, files } = fixture(t); const before = bytes(files);
    assert.equal(recoverB977(root).ready, true); assert.deepEqual(bytes(files), before);
    assert.deepEqual(recoverB977(root, { apply: true }), { ready: true, applied: true, stage: 'controls_removed' });
    assert.equal(fs.readFileSync(files.consumer, 'utf8'), before.consumer);
    assert.equal(fs.readFileSync(files.journal, 'utf8'), before.journal);
    assert.equal(fs.existsSync(files.request), false); assert.equal(fs.existsSync(files.event), false);
    assert.equal(JSON.parse(fs.readFileSync(files.receipt)).schema, 'nassaj-b977-terminal-recovery/v1');
    const completed = bytes(files); recoverB977(root, { apply: true }); assert.deepEqual(bytes(files), completed);
});
for (const field of ['oid', 'transactionNonce', 'buildId', 'previousBuildId', 'sequence', 'state', 'gate']) {
    test(`rejects modified journal ${field}`, t => {
        const { root, files } = fixture(t);
        edit(files.journal, v => { v[field] = field === 'oid' ? NONCE : 'invalid'; }); const before = bytes(files);
        assert.throws(() => recoverB977(root, { apply: true }), /b977_journal/); assert.deepEqual(bytes(files), before);
    });
}
for (const key of ['request', 'event']) {
    for (const mutation of ['new-sequence', 'oid-nonce-swap', 'extra-bytes']) {
        test(`refuses ${key} ${mutation} without mutations`, t => {
            const { root, files } = fixture(t);
            if (mutation === 'extra-bytes') fs.appendFileSync(files[key], '\n');
            else edit(files[key], v => { if (mutation === 'new-sequence') v.sequence = 129; else v.oid = NONCE; });
            const before = bytes(files); assert.throws(() => recoverB977(root, { apply: true }), /b977_control/);
            assert.deepEqual(bytes(files), before);
        });
    }
}
test('missing controls with no receipt refuse; stale consumer refuses', t => {
    const { root, files } = fixture(t); edit(files.consumer, v => { v.acceptedSequence = 54; });
    assert.throws(() => recoverB977(root, { apply: true }), /consumer_invalid/);
    edit(files.consumer, v => { v.acceptedSequence = 130; }); fs.unlinkSync(files.request);
    assert.throws(() => recoverB977(root, { apply: true }), /controls_missing/);
});
test('refuses any active transaction and any conflicting receipt namespace', t => {
    const { root, git, files } = fixture(t);
    const other = path.join(git, 'nassaj-oid-control-transaction-129-other.json');
    fs.writeFileSync(other, JSON.stringify({ state: 'prepared' }));
    assert.throws(() => recoverB977(root, { apply: true }), /nonterminal_transaction/);
    fs.unlinkSync(other); fs.writeFileSync(path.join(git, 'nassaj-b977-terminal-recovery-other.json'), '{}');
    assert.throws(() => recoverB977(root, { apply: true }), /receipt_conflict/);
    assert.equal(fs.existsSync(files.receipt), false);
});
for (const stage of ['before_receipt', 'prepared', 'before_request_remove', 'request_unlinked', 'request_removed', 'before_event_remove', 'event_unlinked', 'controls_removed']) {
    test(`crash at ${stage} resumes with advanced consumer byte-identical`, t => {
        const { root, files } = fixture(t);
        assert.throws(() => recoverB977(root, { apply: true, testHooks: { checkpoint(name) { if (name === stage) throw new Error('crash'); } } }), /crash/);
        edit(files.consumer, v => { v.acceptedSequence = 200; v.acceptedOid = 'b'.repeat(40); v.client.phase = 'served'; v.server = { sequence: 199, phase: 'awaiting_owner' }; });
        const consumer = fs.readFileSync(files.consumer, 'utf8');
        assert.equal(recoverB977(root, { apply: true }).stage, 'controls_removed');
        assert.equal(fs.readFileSync(files.consumer, 'utf8'), consumer);
    });
}
test('stable snapshot race refuses before receipt', t => {
    const { root, files } = fixture(t);
    assert.throws(() => recoverB977(root, { apply: true, testHooks: { betweenReads() { edit(files.consumer, v => { v.acceptedSequence++; }); } } }), /snapshot_changed/);
    assert.equal(fs.existsSync(files.receipt), false); assert.equal(fs.existsSync(files.request), true);
});
for (const checkpoint of ['before_receipt', 'before_request_remove', 'before_event_remove']) {
    test(`new request race at ${checkpoint} refuses without deleting it`, t => {
        const { root, files } = fixture(t);
        assert.throws(() => recoverB977(root, { apply: true, testHooks: { checkpoint(name) {
            if (name === checkpoint) fs.writeFileSync(files.request, '{"sequence":999}');
        } } }), /snapshot_changed/);
        assert.equal(fs.readFileSync(files.request, 'utf8'), '{"sequence":999}');
    });
}
test('corrupt existing receipt is rejected without touching controls', t => {
    const { root, files } = fixture(t); fs.writeFileSync(files.receipt, '{}'); const before = bytes(files);
    assert.throws(() => recoverB977(root, { apply: true }), /receipt_conflict/); assert.deepEqual(bytes(files), before);
});
test('symlink control fails before any mutation', t => {
    const { root, files } = fixture(t); fs.unlinkSync(files.request); fs.symlinkSync(files.event, files.request);
    assert.throws(() => recoverB977(root, { apply: true }), /unsafe_file/); assert.equal(fs.existsSync(files.receipt), false);
});
test('shared event lock is held during mutations', async t => {
    const { root, git } = fixture(t); let blocked = false;
    recoverB977(root, { apply: true, testHooks: { checkpoint(stage) {
        if (stage !== 'before_receipt') return;
        try { execFileSync('flock', ['-n', path.join(git, 'nassaj-preview-event-mutation.lock'), 'true']); }
        catch { blocked = true; }
    } } });
    assert.equal(blocked, true);
});
function consumerRecord(root, domains = ['client']) {
    return { pid: 991, startTicks: '123', script: path.join(root, 'scripts/preview-oid-consumer.mjs'),
        cwd: root, argvSha256: 'a'.repeat(64), domains };
}
test('client-only inventory is proven under event lock and recorded as audit evidence', t => {
    const { root, git, files } = fixture(t); let checks = 0;
    recoverB977(root, { apply: true, testHooks: { consumerInventory() {
        checks++;
        assert.throws(() => execFileSync('flock', ['-n', path.join(git, 'nassaj-preview-event-mutation.lock'), 'true']));
        return [consumerRecord(root)];
    } } });
    assert.ok(checks >= 6);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.receipt)).initialConsumerWriters, [consumerRecord(root)]);
});
for (const domains of [['server'], ['client', 'server'], [], ['unknown']]) {
    test(`inventory rejects ${JSON.stringify(domains)} before any control mutation`, t => {
        const { root, files } = fixture(t); const before = bytes(files);
        assert.throws(() => recoverB977(root, { apply: true, testHooks: { consumerInventory: () => [consumerRecord(root, domains)] } }), /server_writer_active/);
        assert.deepEqual(bytes(files), before);
    });
}
test('unreadable or unstable writer inventory refuses without a receipt', t => {
    const { root, files } = fixture(t);
    assert.throws(() => recoverB977(root, { apply: true, testHooks: { consumerInventory() { throw new Error('inventory unknown'); } } }), /inventory unknown/);
    let pid = 5;
    assert.throws(() => recoverB977(root, { apply: true, testHooks: { consumerInventory: () => [{ ...consumerRecord(root), pid: pid++ }] } }), /writer_changed/);
    assert.equal(fs.existsSync(files.receipt), false);
});
test('resumed receipt accepts a different currently proven client-only process', t => {
    const { root, files } = fixture(t);
    assert.throws(() => recoverB977(root, { apply: true, testHooks: {
        consumerInventory: () => [consumerRecord(root)], checkpoint(stage) { if (stage === 'prepared') throw new Error('crash'); },
    } }), /crash/);
    const before = fs.readFileSync(files.consumer);
    recoverB977(root, { apply: true, testHooks: { consumerInventory: () => [{ ...consumerRecord(root), pid: 992, startTicks: '456' }] } });
    assert.deepEqual(fs.readFileSync(files.consumer), before);
    assert.equal(JSON.parse(fs.readFileSync(files.receipt)).initialConsumerWriters[0].pid, 991);
});
test('ordinary root-cwd shell is not classified as an OID writer', async t => {
    const { root } = fixture(t);
    const child = spawn('bash', ['-c', 'printf ready; read -r value'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
        await once(child.stdout, 'data');
        assert.equal(recoverB977(root).ready, true);
    } finally { const done = once(child, 'exit'); child.stdin.end('\n'); await done; }
});
test('real recognized consumer with unknown domains refuses read-only plan', async t => {
    const { root, files } = fixture(t);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/preview-oid-consumer.mjs'), "process.stdin.resume();process.stdout.write('ready');");
    const env = { ...process.env }; delete env.NASSAJ_PREVIEW_OID_DOMAINS;
    const child = spawn(process.execPath, ['scripts/preview-oid-consumer.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
        await once(child.stdout, 'data'); const before = bytes(files);
        assert.throws(() => recoverB977(root), /b977_writer_inventory_unknown/);
        assert.deepEqual(bytes(files), before);
    } finally { const done = once(child, 'exit'); child.stdin.end(); await done; }
});
