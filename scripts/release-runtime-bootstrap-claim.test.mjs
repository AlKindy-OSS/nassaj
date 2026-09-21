import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import test from 'node:test';
import { consumeCutoverBootstrapClaim, withCutoverStateLock, executeReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';
import { observeBootstrapClaimCaller } from './lib/release-runtime-host-operations.mjs';
import { readHostDispatcherInput } from './release-runtime-host-dispatcher.mjs';
import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';

const hash = 'a'.repeat(64);
const bootId = '12345678-1234-1234-1234-123456789012';
const expected = Object.fromEntries(['hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256',
    'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256', 'ownerApprovalKeySha256',
    'targetSchemaDigest', 'serverBuildId', 'clientBuildId'].map((key) => [key, hash]));
Object.assign(expected, { nodeInstanceId: 'node-1234', generationId: 'generation-1234' });
const caller = { uid: 1000, pid: 1234, startTicks: '12345', bootId };
function fixture(t) {
    const base = path.resolve('.artifacts'); mkdirSync(base, { recursive: true });
    const controlRoot = mkdtempSync(path.join(base, 't1579-claim-'));
    t.after(() => rmSync(controlRoot, { force: true, recursive: true }));
    const file = path.join(controlRoot, 'first-cutover.json');
    const journal = { schema: 'nassaj-release-runtime-cutover/v1', state: 'running', phase: 'startup_claim_pending',
        expected, transactionId: 'transaction-1234', revision: 5, startupClaim: { state: 'pending',
            attemptNonce: 'attempt-1234', startupClosureSha256: hash, databaseDev: 1, databaseIno: 2,
            startupPolicyId: 'existing-security-state/v1' } };
    const save = (value) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); save(journal);
    // The fixed root state mutex is production code here; give it its measured authority.
    const authority = installFixedStateMutexAuthority(t, controlRoot, {});
    const request = { transactionId: journal.transactionId, expectedRevision: 5, attemptNonce: 'attempt-1234',
        challenge: hash, pid: caller.pid, startTicks: caller.startTicks, bootId,
        releaseIdentitySha256: hash, startupClosureSha256: hash };
    return { file, journal, save, authority, options: { controlRoot, expected, request,
        observeCaller: () => caller, verifyAuthority: () => true } };
}

test('claim consumes durably once and duplicate cannot retry even when response is lost', (t) => {
    const f = fixture(t); const result = consumeCutoverBootstrapClaim(f.options);
    const saved = JSON.parse(readFileSync(f.file));
    assert.equal(result.decision, 'claimed'); assert.equal(saved.revision, 6);
    assert.equal(saved.startupClaim.claimId, result.claimId); assert.equal(saved.startupClaim.state, 'consumed');
    assert.throws(() => consumeCutoverBootstrapClaim(f.options), /claim_denied/);
});

test('replaced canonical journal is read again, never an old descriptor', (t) => {
    const f = fixture(t); const replacement = `${f.file}.replacement`;
    writeFileSync(replacement, JSON.stringify({ ...f.journal, revision: 6 }), { mode: 0o600 });
    renameSync(replacement, f.file);
    assert.throws(() => consumeCutoverBootstrapClaim(f.options), /claim_denied/);
});

test('invalid pending identities and states deny without changing journal', async (t) => {
    for (const patch of [{ revision: 4 }, { phase: 'manual_recovery' }, { state: 'committed' },
        { transactionId: 'other-transaction' }, { startupClaim: { state: 'consumed' } }]) {
        await t.test(JSON.stringify(patch), (child) => {
            const f = fixture(child); f.save({ ...f.journal, ...patch }); const before = readFileSync(f.file);
            assert.throws(() => consumeCutoverBootstrapClaim(f.options), /claim_denied/);
            assert.deepEqual(readFileSync(f.file), before);
        });
    }
});

test('unknown authority, supplied foreign PID, and changing caller fail before journal mutation', (t) => {
    const f = fixture(t); const before = readFileSync(f.file);
    assert.throws(() => consumeCutoverBootstrapClaim({ ...f.options, verifyAuthority: () => { throw Error('unapproved'); } }), /unapproved/);
    assert.throws(() => consumeCutoverBootstrapClaim({ ...f.options, request: { ...f.options.request, pid: 2 } }), /claim_denied/);
    let reads = 0;
    assert.throws(() => consumeCutoverBootstrapClaim({ ...f.options,
        observeCaller: () => ({ ...caller, startTicks: ++reads === 1 ? caller.startTicks : '98765' }) }), /caller_changed/);
    assert.deepEqual(readFileSync(f.file), before);
});

test('short state lock excludes claim and operator rereads the consumed current journal', async (t) => {
    const f = fixture(t);
    withCutoverStateLock(f.options.controlRoot, () => {
        assert.throws(() => consumeCutoverBootstrapClaim(f.options), /cutover_state_busy/);
    });
    const claimed = consumeCutoverBootstrapClaim(f.options);
    const contained = await executeReleaseRuntimeCutover({ controlRoot: f.options.controlRoot, expected });
    assert.equal(contained.state, 'manual_recovery');
    assert.equal(contained.startupClaim.claimId, claimed.claimId);
    assert.equal(contained.startupClaim.state, 'consumed');
});

function ancestryFixture() {
    const config = { bootstrapClaim: { applicationUid: 1000, sudoExecutable: '/usr/bin/sudo', sudoSha256: hash,
        nodeExecutable: '/usr/bin/node', nodeSha256: hash } };
    const records = { 40: { pid: 40, parentPid: 41, startTicks: '10', uids: [1000, 0, 0, 0], executable: '/usr/bin/sudo' },
        41: { pid: 41, parentPid: 42, startTicks: '11', uids: [1000, 0, 0, 0], executable: '/usr/bin/sudo' },
        42: { pid: 42, parentPid: 43, startTicks: '12', uids: [1000, 1000, 1000, 1000], executable: '/usr/bin/node' } };
    const deps = { effectiveUid: () => 0, parentPid: 40, verifyPinnedExecutable: () => {},
        readClaimProcess: (pid) => records[pid], readBootId: () => bootId };
    return { config, records, deps };
}

test('caller is derived through observed sudo monitor chain, never arbitrary request PID', () => {
    const f = ancestryFixture();
    assert.deepEqual(observeBootstrapClaimCaller(f.config, f.deps), { uid: 1000, pid: 42, startTicks: '12', bootId });
    f.records[40].executable = '/bin/sh';
    assert.throws(() => observeBootstrapClaimCaller(f.config, f.deps), /sudo_ancestry_invalid/);
});

test('kernel observation loss, boot change and wrong caller credentials deny', () => {
    const f = ancestryFixture(); let count = 0;
    assert.throws(() => observeBootstrapClaimCaller(f.config, { ...f.deps,
        readBootId: () => ++count === 1 ? bootId : '22345678-1234-1234-1234-123456789012' }), /process_changed/);
    f.records[42].uids[1] = 0;
    assert.throws(() => observeBootstrapClaimCaller(f.config, f.deps), /sudo_ancestry_invalid/);
    assert.throws(() => observeBootstrapClaimCaller(f.config, { ...f.deps, readClaimProcess: () => { throw Error('EACCES'); } }), /EACCES/);
});

test('dispatcher bounds size, trailing content, malformed input and incomplete streams before locking', async () => {
    assert.deepEqual(await readHostDispatcherInput(Readable.from(['{"ok":true}'])), { ok: true });
    await assert.rejects(readHostDispatcherInput(Readable.from(['{}{}'])), SyntaxError);
    await assert.rejects(readHostDispatcherInput(Readable.from(['xxxxx']), { maximumBytes: 4 }), /input_too_large/);
    await assert.rejects(readHostDispatcherInput(new PassThrough(), { timeoutMs: 10 }), /input_timeout/);
});

function childClaim(options, failAt = 0, authorityFile) {
    const modulePath = new URL('./lib/release-runtime-cutover.mjs', import.meta.url).href;
    const authorityUrl = new URL('./fixtures/fixed-state-mutex-authority.mjs', import.meta.url).href;
    const source = `import fs from 'node:fs';
        import { mock as mutexMock } from 'node:test';
        import { installFixedStateMutexAuthority, withNativeBuiltinExports } from ${JSON.stringify(authorityUrl)};
        import { consumeCutoverBootstrapClaim } from ${JSON.stringify(modulePath)};
        const options = JSON.parse(process.argv[1]);
        installFixedStateMutexAuthority({ mock: mutexMock }, options.controlRoot,
            JSON.parse(fs.readFileSync(${JSON.stringify(authorityFile)}, 'utf8')), { file: ${JSON.stringify(authorityFile)} });
        let calls = 0;
        withNativeBuiltinExports(() => { const original = fs.fsyncSync; fs.fsyncSync = (...args) => {
            if (++calls === ${failAt}) throw Error('injected_fsync_failure'); return original(...args);
        }; });
        try { const result = consumeCutoverBootstrapClaim({ ...options,
            observeCaller: () => options.caller, verifyAuthority: () => true });
            process.stdout.write(JSON.stringify(result));
        } catch (error) { process.stderr.write(error.message); process.exitCode = 78; }`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({
            controlRoot: options.controlRoot, expected: options.expected, request: options.request, caller })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('two real processes produce at most one successful durable consume', async (t) => {
    const f = fixture(t); const results = await Promise.all([childClaim(f.options, 0, f.authority.file), childClaim(f.options, 0, f.authority.file)]);
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(JSON.parse(readFileSync(f.file)).startupClaim.state, 'consumed');
});

test('fsync failure emits no success; failure after rename leaves consumed claim non-retryable', async (t) => {
    for (const failAt of [1, 2, 3, 4]) {
        await t.test(`fsync ${failAt}`, async (child) => {
            const f = fixture(child); const result = await childClaim(f.options, failAt, f.authority.file);
            assert.equal(result.code, 78); assert.equal(result.stdout, '');
            assert.match(result.stderr, /injected_fsync_failure/);
            const saved = JSON.parse(readFileSync(f.file));
            if (failAt === 4) {
                assert.equal(saved.startupClaim.state, 'consumed');
                assert.throws(() => consumeCutoverBootstrapClaim(f.options), /claim_denied/);
            } else assert.equal(saved.startupClaim.state, 'pending');
        });
    }
});
