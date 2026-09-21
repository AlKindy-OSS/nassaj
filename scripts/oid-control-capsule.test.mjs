import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoNonterminalOidTransaction, writeOidControlJournal } from './oid-control-journal.mjs';

import { bundleOidControlCapsule } from './lib/oid-control-bundle.mjs';
import { verifyOidCapsuleModuleClosure } from './server-build-atomic.mjs';
const productionCapsule = bundleOidControlCapsule(path.resolve(import.meta.dirname, '..'), verifyOidCapsuleModuleClosure).bytes;
const BUILD = 'b'.repeat(64);
const PREVIOUS = 'c'.repeat(64);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const helperRoots = [];

after(() => {
    for (const root of helperRoots) rmSync(root, { recursive: true, force: true });
});

function nativeMvSupportsExchange() {
    const result = spawnSync('/usr/bin/mv', ['--help'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.includes('--exchange') && result.stdout.includes('--no-copy');
}

function buildRenameExchangeHelper() {
    if (process.platform !== 'linux') throw new Error('rename_exchange_test_helper_requires_linux');
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-capsule-exchange-'));
    helperRoots.push(root);
    const output = path.join(root, 'rename-exchange');
    const source = fileURLToPath(new URL('./test-fixtures/rename-exchange.c', import.meta.url));
    const compiled = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-o', output, source], {
        encoding: 'utf8',
    });
    if (compiled.status !== 0) {
        throw new Error(`rename_exchange_test_helper_compile_failed:${compiled.stderr.trim()}`);
    }
    return output;
}

let compiledExchangeHelper = null;
function exchangeProgram({ forceHelper = false } = {}) {
    if (!forceHelper && nativeMvSupportsExchange()) return '/usr/bin/mv';
    compiledExchangeHelper ||= buildRenameExchangeHelper();
    return compiledExchangeHelper;
}

function exchangeForTest(left, right, options) {
    return spawnSync(exchangeProgram(options), ['--exchange', '--no-copy', '-T', left, right], {
        encoding: 'utf8',
    });
}

function capsuleWithExchangeProgram(program) {
    const source = productionCapsule.toString('utf8');
    // esbuild may rename the imported `spawn` binding when it bundles the capsule
    // (e.g. `spawn2` after caac8feae added child_process imports), so anchor on the
    // pinned /usr/bin/mv literal and preserve whatever identifier is emitted rather
    // than matching a fixed `spawn(`. Assert exactly one hit so a future capsule
    // that moves or duplicates this call fails loudly instead of silently skipping.
    const pattern = /(spawn\d*)\((["'])\/usr\/bin\/mv\2,/g;
    const hits = source.match(pattern) ?? [];
    assert.equal(hits.length, 1,
        `test transport must replace exactly one pinned /usr/bin/mv spawn, found ${hits.length}`);
    const replaced = source.replace(pattern, `$1($2${program}$2,`);
    assert.notEqual(replaced, source, 'test transport must replace the pinned production mv command');
    return Buffer.from(replaced);
}

function capsuleForTestHost() {
    if (nativeMvSupportsExchange()) return productionCapsule;
    return capsuleWithExchangeProgram(exchangeProgram());
}

const capsule = capsuleForTestHost();

const argvSafe = Buffer.from(`#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$NASSAJ_CAPSULE_REPO_ROOT/safe-argv"
printf '\\n' >> "$NASSAJ_CAPSULE_REPO_ROOT/safe-argv"
exit 0
`);

function capturedArgv(value) {
    return readFileSync(path.join(value.root, 'safe-argv'), 'utf8').trimEnd()
        .split('\n').map(line => line.split('\0').filter(Boolean));
}

function assertRestartArguments(args, journal, rollback = false) {
    assert.deepEqual(args, ['--set', 'TMPDIR=/var/tmp',
        '--set', `NASSAJ_PREVIEW_TRANSACTION_NONCE=${journal.transactionNonce}`,
        '--set', `NASSAJ_PREVIEW_BOOT_NONCE=${rollback ? journal.rollbackBootNonce : journal.bootNonce}`,
        '--exec']);
}

function fixture(build = BUILD, previous = PREVIOUS) {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-capsule-'));
    const git = (args) => {
        const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    writeFileSync(path.join(root, 'seed'), 'seed');
    git(['add', 'seed']); git(['commit', '-qm', 'seed']);
    const oid = git(['rev-parse', 'HEAD']);
    const group = 'event-0000000000000007';
    for (const ref of [
        'refs/nassaj/previews/v1/events/0000000000000007/event',
        'refs/nassaj/previews/v1/events/0000000000000007/server',
        `refs/nassaj/previews/v1/groups/${group}/desired`,
        `refs/nassaj/previews/v1/groups/${group}/server/desired`,
        `refs/nassaj/previews/v1/groups/${group}/server/candidate`,
    ]) git(['update-ref', ref, oid]);
    const candidate = path.join(root, '.nassaj-local-preview', 'server-candidates', build);
    const snapshot = path.join(root, '.nassaj-local-preview', 'oid-snapshots', oid);
    const live = path.join(root, 'dist-server');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(snapshot, { recursive: true });
    mkdirSync(live);
    const input = Buffer.from('snapshot-input');
    writeFileSync(path.join(snapshot, 'package.json'), input, { mode: 0o444 });
    chmodSync(snapshot, 0o555);
    writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), JSON.stringify({
        artifact: 'server', commit: oid, baseCommit: oid, buildId: build, dirty: false,
    }));
    writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', commit: 'd'.repeat(40), buildId: previous }));
    writeFileSync(path.join(candidate, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify({
        schemaVersion: 2, buildId: build,
        inputs: [{ path: 'package.json', mode: 0o444, sha256: sha(input) }],
    }));
    const manifest = Buffer.from(`${JSON.stringify({
        schema: 'nassaj-oid-control-runtime/v1', protocol: 1, oid, serverBuildId: build,
    })}\n`);
    writeFileSync(path.join(candidate, 'OID_CONTROL_MANIFEST.json'), manifest, { mode: 0o444 });
    writeFileSync(path.join(root, '.git', 'nassaj-preview-oid-control-request-v1.json'), JSON.stringify({
        schemaVersion: 1, action: 'promote-and-safe-restart', sequence: 7, oid, buildId: build,
        controlManifestSha256: sha(manifest), snapshotOid: oid, group,
    }));
    writeFileSync(path.join(root, '.git', 'nassaj-preview-oid-event-control-0000000000000007.json'), JSON.stringify({
        schema: 'nassaj-oid-control-event/v1', sequence: 7, oid, snapshotOid: oid,
        buildId: build, controlManifestSha256: sha(manifest),
    }));
    writeFileSync(path.join(root, '.git', 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
        schemaVersion: 1, acceptedSequence: 7,
        server: { sequence: 7, oid, buildId: build, phase: 'awaiting_owner', controlManifestSha256: sha(manifest) },
    }));
    const lock = path.join(root, '.git', 'nassaj-preview-event-mutation.lock');
    writeFileSync(lock, '');
    const lockMetadata = statSync(lock);
    return { root, candidate, live, manifest, oid, lockIdentity: { dev: String(lockMetadata.dev), ino: String(lockMetadata.ino) } };
}

/**
 * Build the same immutable capsule layout in a real linked worktree.  Control
 * files deliberately live in the primary repository's common Git directory:
 * a linked worktree's `.git` is a file and must never be treated as a folder.
 */
function linkedWorktreeFixture() {
    const main = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-capsule-main-'));
    const linked = `${main}-linked`;
    const git = (cwd, args) => {
        const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git(main, ['init', '-q']);
    git(main, ['config', 'user.email', 'test@example.invalid']);
    git(main, ['config', 'user.name', 'test']);
    writeFileSync(path.join(main, 'seed'), 'seed');
    git(main, ['add', 'seed']); git(main, ['commit', '-qm', 'seed']);
    git(main, ['worktree', 'add', '--detach', linked]);
    const oid = git(linked, ['rev-parse', 'HEAD']);
    const control = git(linked, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    assert.equal(statSync(path.join(linked, '.git')).isFile(), true);
    const group = 'event-0000000000000007';
    for (const ref of [
        'refs/nassaj/previews/v1/events/0000000000000007/event',
        'refs/nassaj/previews/v1/events/0000000000000007/server',
        `refs/nassaj/previews/v1/groups/${group}/desired`,
        `refs/nassaj/previews/v1/groups/${group}/server/desired`,
        `refs/nassaj/previews/v1/groups/${group}/server/candidate`,
    ]) git(linked, ['update-ref', ref, oid]);
    const candidate = path.join(linked, '.nassaj-local-preview', 'server-candidates', BUILD);
    const snapshot = path.join(linked, '.nassaj-local-preview', 'oid-snapshots', oid);
    const live = path.join(linked, 'dist-server');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(snapshot, { recursive: true });
    mkdirSync(live);
    const input = Buffer.from('snapshot-input');
    writeFileSync(path.join(snapshot, 'package.json'), input, { mode: 0o444 });
    chmodSync(snapshot, 0o555);
    writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), JSON.stringify({
        artifact: 'server', commit: oid, baseCommit: oid, buildId: BUILD, dirty: false,
    }));
    writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', commit: 'd'.repeat(40), buildId: PREVIOUS }));
    writeFileSync(path.join(candidate, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify({
        schemaVersion: 2, buildId: BUILD,
        inputs: [{ path: 'package.json', mode: 0o444, sha256: sha(input) }],
    }));
    const manifest = Buffer.from(`${JSON.stringify({
        schema: 'nassaj-oid-control-runtime/v1', protocol: 1, oid, serverBuildId: BUILD,
    })}\n`);
    writeFileSync(path.join(candidate, 'OID_CONTROL_MANIFEST.json'), manifest, { mode: 0o444 });
    writeFileSync(path.join(control, 'nassaj-preview-oid-control-request-v1.json'), JSON.stringify({
        schemaVersion: 1, action: 'promote-and-safe-restart', sequence: 7, oid, buildId: BUILD,
        controlManifestSha256: sha(manifest), snapshotOid: oid, group,
    }));
    writeFileSync(path.join(control, 'nassaj-preview-oid-event-control-0000000000000007.json'), JSON.stringify({
        schema: 'nassaj-oid-control-event/v1', sequence: 7, oid, snapshotOid: oid,
        buildId: BUILD, controlManifestSha256: sha(manifest),
    }));
    writeFileSync(path.join(control, 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
        schemaVersion: 1, acceptedSequence: 7,
        server: { sequence: 7, oid, buildId: BUILD, phase: 'awaiting_owner', controlManifestSha256: sha(manifest) },
    }));
    const lock = path.join(control, 'nassaj-preview-event-mutation.lock');
    writeFileSync(lock, '');
    const lockMetadata = statSync(lock);
    return {
        root: linked, candidate, live, manifest, oid, control, cleanupRoots: [linked, main],
        lockIdentity: { dev: String(lockMetadata.dev), ino: String(lockMetadata.ino) },
    };
}

function runCapsule(value, safeBytes, overrides = {}, env = {}, capsuleBytes = capsule) {
    const handshakePath = path.join(value.control || path.join(value.root, '.git'), 'handshake.json');
    const record = Buffer.from(JSON.stringify({
        repoRoot: value.root, artifactRoot: value.candidate, liveRoot: value.live,
        safeRestartSha256: sha(safeBytes),
        capsuleModeAbi: 'nassaj-capsule-roots/v1', transactionNonce: 'e'.repeat(64),
        handshakePath, lockIdentity: value.lockIdentity, oldPid: process.pid, oldStartTicks: '1',
        ...overrides,
    }));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-'], {
            cwd: value.root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdin.end(capsuleBytes);
        child.stdio[3].end(safeBytes);
        child.stdio[4].end(record);
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
    });
}

function cleanup(value) {
    const snapshot = path.join(value.root, '.nassaj-local-preview', 'oid-snapshots', value.oid);
    try { chmodSync(snapshot, 0o755); } catch { /* fixture may have been replaced */ }
    try { chmodSync(path.join(snapshot, 'package.json'), 0o644); } catch { /* fixture may have been replaced */ }
    for (const root of value.cleanupRoots || [value.root]) rmSync(root, { recursive: true, force: true });
}

function journalFile(value) {
    const control = value.control || path.join(value.root, '.git');
    const name = readdirSync(control)
        .find((entry) => entry.startsWith('nassaj-oid-control-transaction-7-'));
    return name ? path.join(control, name) : path.join(control, 'missing-journal');
}

test('fd3 gate deferral before exchange leaves live bytes intact and journals a retryable terminal state', async () => {
    const value = fixture();
    try {
        const safe = Buffer.from('#!/usr/bin/env bash\nexit 6\n');
        const result = await runCapsule(value, safe);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.state, 'restart_deferred_restored');
        assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root));
    } finally { cleanup(value); }
});

test('linked worktree capsule reaches executor_ready then safely defers through the shared Git control directory', async () => {
    const value = linkedWorktreeFixture();
    try {
        // This is the real capsule process and real common Git directory, not a
        // launcher bridge mock.  Exit 6 is the documented owner-gate refusal:
        // it must occur before exchange, so no restart or live-byte mutation.
        const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 6\n'));
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.state, 'restart_deferred_restored');
        const handshake = JSON.parse(readFileSync(path.join(value.control, 'handshake.json')));
        assert.equal(handshake.state, 'executor_ready');
        assert.equal(handshake.sequence, 7);
        assert.equal(path.dirname(journalFile(value)), value.control);
        assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root));
    } finally { cleanup(value); }
});

test('empty/short fd3, external manifest tamper, and candidate symlink fail before exchange', async () => {
    for (const mode of ['empty', 'short', 'manifest', 'symlink']) {
        const value = fixture();
        try {
            const safe = mode === 'empty' ? Buffer.alloc(0) : Buffer.from('#!/usr/bin/env bash\nexit 6\n');
            if (mode === 'manifest') {
                const manifestPath = path.join(value.candidate, 'OID_CONTROL_MANIFEST.json');
                chmodSync(manifestPath, 0o644);
                writeFileSync(manifestPath, 'tampered');
            }
            if (mode === 'symlink') {
                const real = `${value.candidate}-real`;
                renameSync(value.candidate, real);
                symlinkSync(real, value.candidate, 'dir');
            }
            const result = await runCapsule(value, safe, mode === 'short'
                ? { safeRestartSha256: sha(Buffer.from(`${safe.toString()}# missing-tail`)) } : {});
            assert.notEqual(result.code, 0, mode);
            assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        } finally { cleanup(value); }
    }
});

test('global fence blocks every nonterminal state and releases terminal states', () => {
    const value = fixture();
    try {
        const file = path.join(value.root, '.git', 'nassaj-oid-control-transaction-9.json');
        writeOidControlJournal(file, { state: 'restart_outcome_unknown', transactionNonce: '1'.repeat(64) });
        assert.throws(() => assertNoNonterminalOidTransaction(value.root), /transaction_in_progress/);
        assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root, '1'.repeat(64)));
        writeOidControlJournal(file, { state: 'loaded', transactionNonce: '1'.repeat(64) });
        assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root));
    } finally { cleanup(value); }
});

test('candidate attestation mismatch restores and attests the previous generation before rolled_back', async () => {
    const value = fixture();
    let expectedPromotionBootNonce = null;
    const server = http.createServer((_request, response) => {
        let journal = null;
        try {
            journal = JSON.parse(readFileSync(journalFile(value)));
        } catch { /* transaction has not started */ }
        const rollback = journal?.state === 'rollback_prepared' && journal?.rollbackBootNonce;
        if (!rollback && journal?.bootNonce) expectedPromotionBootNonce ??= journal.bootNonce;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(rollback ? {
            status: 'ok', serverLoadedOid: 'd'.repeat(40), serverLoadedBuildId: PREVIOUS,
            serverTransactionNonce: journal.transactionNonce, serverBootNonce: journal.rollbackBootNonce,
            serverProcessStartTicks: '999', pid: 999,
        } : { status: 'ok', serverLoadedOid: '0'.repeat(40), serverLoadedBuildId: '0'.repeat(64) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const safe = argvSafe;
        const { port } = server.address();
        const result = await runCapsule(value, safe, {}, {
            NASSAJ_PREVIEW_HEALTH_URL: `http://127.0.0.1:${port}/health`,
            NASSAJ_OID_HEALTH_ATTEMPTS: '2', NASSAJ_OID_HEALTH_INTERVAL_MS: '5',
        });
        assert.equal(result.code, 0, result.stderr);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.state, 'rolled_back');
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        const calls = capturedArgv(value);
        assert.deepEqual(calls.slice(0, 2), [['--json'], ['--json']]);
        assert.equal(calls.length, 4);
        assert.match(expectedPromotionBootNonce, /^[a-f0-9]{64}$/);
        assert.notEqual(expectedPromotionBootNonce, journal.rollbackBootNonce);
        assertRestartArguments(calls[2], { ...journal, bootNonce: expectedPromotionBootNonce });
        assertRestartArguments(calls[3], journal, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        cleanup(value);
    }
});

test('post-exchange rc6 writes rollback intent and restores previous bytes without restart', async () => {
    const value = fixture();
    try {
        const safe = Buffer.from(`#!/usr/bin/env bash
counter="$NASSAJ_CAPSULE_REPO_ROOT/.safe-counter"
count=0; [ ! -f "$counter" ] || count="$(/usr/bin/cat "$counter")"
count=$((count + 1)); printf '%s' "$count" > "$counter"
[ "$count" -lt 2 ] && exit 0
exit 6
`);
        const result = await runCapsule(value, safe);
        assert.equal(result.code, 0, result.stderr);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.state, 'restart_deferred_restored');
        assert.equal(journal.gate, 6);
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
    } finally { cleanup(value); }
});

test('a replacement launcher resumes a dead supervisor transaction under the same event lock', async () => {
    const value = fixture();
    try {
        const oldNonce = '9'.repeat(64);
        writeOidControlJournal(path.join(
            value.root, '.git', `nassaj-oid-control-transaction-7-${oldNonce}.json`,
        ), {
            schema: 'nassaj-oid-control-transaction/v1', state: 'prepared', sequence: 7,
            group: 'event-0000000000000007', oid: value.oid, buildId: BUILD,
            previousOid: 'd'.repeat(40), previousBuildId: PREVIOUS,
            candidatePath: value.candidate, livePath: value.live,
            transactionNonce: oldNonce, controlManifestSha256: sha(value.manifest),
            oldStartTicks: '1',
        });
        const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 6\n'));
        assert.equal(result.code, 0, result.stderr);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.transactionNonce, oldNonce);
        assert.equal(journal.state, 'restart_deferred_restored');
        const handshake = JSON.parse(readFileSync(path.join(value.root, '.git', 'handshake.json')));
        assert.equal(handshake.transactionNonce, oldNonce);
        assert.equal(handshake.launcherNonce, 'e'.repeat(64));
    } finally { cleanup(value); }
});

test('prepared and rollback_prepared crash seams with candidate live deterministically roll back', async () => {
    for (const state of ['prepared', 'rollback_prepared']) {
        const value = fixture();
        const oldNonce = '8'.repeat(64);
        const journal = path.join(value.root, '.git', `nassaj-oid-control-transaction-7-${oldNonce}.json`);
        const exchanged = exchangeForTest(value.candidate, value.live);
        assert.equal(exchanged.status, 0, exchanged.stderr);
        writeOidControlJournal(journal, {
            schema: 'nassaj-oid-control-transaction/v1', state, sequence: 7,
            group: 'event-0000000000000007', oid: value.oid, buildId: BUILD,
            previousOid: 'd'.repeat(40), previousBuildId: PREVIOUS,
            candidatePath: value.candidate, livePath: value.live,
            transactionNonce: oldNonce, controlManifestSha256: sha(value.manifest), oldStartTicks: '1',
        });
        const server = http.createServer((_request, response) => {
            const current = JSON.parse(readFileSync(journal));
            response.end(JSON.stringify({
                status: 'ok', serverLoadedOid: 'd'.repeat(40), serverLoadedBuildId: PREVIOUS,
                serverTransactionNonce: oldNonce, serverBootNonce: current.rollbackBootNonce,
                serverProcessStartTicks: '777', pid: 777,
            }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 0\n'), {}, {
                NASSAJ_PREVIEW_HEALTH_URL: `http://127.0.0.1:${server.address().port}/health`,
                NASSAJ_OID_HEALTH_ATTEMPTS: '3', NASSAJ_OID_HEALTH_INTERVAL_MS: '5',
            });
            assert.equal(result.code, 0, `${state}: ${result.stderr}`);
            assert.equal(JSON.parse(readFileSync(journal)).state, 'rolled_back');
            assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        } finally {
            await new Promise((resolve) => server.close(resolve));
            cleanup(value);
        }
    }
});

test('failure injected after exchange is recovered by deterministic rollback, never a second exchange', async () => {
    const value = fixture();
    try {
        const safe = Buffer.from('#!/usr/bin/env bash\nexit 0\n');
        const failed = await runCapsule(value, safe, {}, { NODE_ENV: 'test', NASSAJ_OID_CAPSULE_FAIL_AT: 'after_exchange' });
        assert.notEqual(failed.code, 0, failed.stderr);
        assert.equal(JSON.parse(readFileSync(journalFile(value))).state, 'exchanged');
        assert.equal(JSON.parse(readFileSync(journalFile(value))).eventGroup, 'event-0000000000000007');
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, BUILD);
        const server = http.createServer((_request, response) => {
            const journal = JSON.parse(readFileSync(journalFile(value)));
            response.end(JSON.stringify({ status: 'ok', serverLoadedOid: 'd'.repeat(40), serverLoadedBuildId: PREVIOUS,
                serverTransactionNonce: journal.transactionNonce, serverBootNonce: journal.rollbackBootNonce,
                serverProcessStartTicks: '777', pid: 777 }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const resumed = await runCapsule(value, safe, {}, {
                NASSAJ_PREVIEW_HEALTH_URL: `http://127.0.0.1:${server.address().port}/health`,
                NASSAJ_OID_HEALTH_ATTEMPTS: '3', NASSAJ_OID_HEALTH_INTERVAL_MS: '5',
            });
            assert.equal(resumed.code, 0, resumed.stderr);
            assert.equal(JSON.parse(readFileSync(journalFile(value))).state, 'rolled_back');
            assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
        } finally { await new Promise((resolve) => server.close(resolve)); }
    } finally { cleanup(value); }
});

test('recovered journal resumes its pinned nonce to served after housekeeping interruption', async () => {
    const value = fixture();
    const server = http.createServer((_request, response) => {
        const journal = JSON.parse(readFileSync(journalFile(value)));
        response.end(JSON.stringify({ status: 'ok', serverLoadedOid: value.oid, serverLoadedBuildId: BUILD,
            serverTransactionNonce: journal.transactionNonce, serverBootNonce: journal.bootNonce,
            serverProcessStartTicks: '777', pid: 777 }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const safe = Buffer.from('#!/usr/bin/env bash\nexit 0\n');
        const env = { NODE_ENV: 'test', NASSAJ_OID_CAPSULE_FAIL_AT: 'after_recovered',
            NASSAJ_PREVIEW_HEALTH_URL: `http://127.0.0.1:${server.address().port}/health`,
            NASSAJ_OID_HEALTH_ATTEMPTS: '3', NASSAJ_OID_HEALTH_INTERVAL_MS: '5' };
        const failed = await runCapsule(value, safe, {}, env);
        assert.notEqual(failed.code, 0, failed.stderr);
        assert.equal(JSON.parse(readFileSync(journalFile(value))).state, 'recovered');
        const resumed = await runCapsule(value, safe, {}, {
            NASSAJ_PREVIEW_HEALTH_URL: env.NASSAJ_PREVIEW_HEALTH_URL,
            NASSAJ_OID_HEALTH_ATTEMPTS: '3', NASSAJ_OID_HEALTH_INTERVAL_MS: '5',
        });
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.equal(JSON.parse(readFileSync(journalFile(value))).state, 'served');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        cleanup(value);
    }
});

test('capsule source has no mutable-root or self-location fallback', () => {
    const source = productionCapsule.toString('utf8');
    assert.doesNotMatch(source, /import\.meta|BASH_SOURCE|fileURLToPath/);
    assert.doesNotMatch(source, /from ['"]\.\.?\//);
    // esbuild may rename the imported `spawn` binding (e.g. `spawn2`); assert the
    // pinned mv command shape without pinning the emitted identifier.
    assert.match(source, /spawn\d*\(['"]\/usr\/bin\/mv['"], \[['"]--exchange['"], ['"]--no-copy['"], ['"]-T['"]/);
    assert.match(source, /lastIndexOf\(['"]\)['"]\)/);
    assert.match(source, /fields\[19\]/);
    assert.doesNotMatch(source, /split\(' '\)\[21\]/);
});

test('Linux renameat2 fixture preserves a real directory exchange on hosts without modern GNU mv', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-capsule-exchange-proof-'));
    try {
        const left = path.join(root, 'left');
        const right = path.join(root, 'right');
        mkdirSync(left); mkdirSync(right);
        writeFileSync(path.join(left, 'identity'), 'left');
        writeFileSync(path.join(right, 'identity'), 'right');
        const before = { left: statSync(left).ino, right: statSync(right).ino };
        const exchanged = exchangeForTest(left, right, { forceHelper: true });
        assert.equal(exchanged.status, 0, exchanged.stderr);
        assert.equal(statSync(left).ino, before.right);
        assert.equal(statSync(right).ino, before.left);
        assert.equal(readFileSync(path.join(left, 'identity'), 'utf8'), 'right');
        assert.equal(readFileSync(path.join(right, 'identity'), 'utf8'), 'left');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('capsule rollback uses the Linux renameat2 test transport when GNU mv lacks exchange', async () => {
    const value = fixture();
    try {
        const safe = Buffer.from(`#!/usr/bin/env bash
counter="$NASSAJ_CAPSULE_REPO_ROOT/.safe-counter"
count=0; [ ! -f "$counter" ] || count="$(/usr/bin/cat "$counter")"
count=$((count + 1)); printf '%s' "$count" > "$counter"
[ "$count" -lt 2 ] && exit 0
exit 6
`);
        const fallbackCapsule = capsuleWithExchangeProgram(exchangeProgram({ forceHelper: true }));
        const result = await runCapsule(value, safe, {}, {}, fallbackCapsule);
        assert.equal(result.code, 0, result.stderr);
        const journal = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(journal.state, 'restart_deferred_restored');
        assert.equal(journal.gate, 6);
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
    } finally {
        cleanup(value);
    }
});

for (const expectedBuildId of [undefined, '0'.repeat(64)]) {
    test(`owner click cannot execute replacement candidate: ${expectedBuildId ? 'different build' : 'missing identity'}`, async () => {
        const value = fixture();
        try {
            const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 6\n'), {
                actionId: '12345678-1234-1234-1234-123456789abc', expectedBuildId,
            });
            assert.notEqual(result.code, 0);
            assert.match(result.stderr, /action_(expected_build_required|candidate_superseded)/);
            assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
            assert.equal(existsSync(journalFile(value)), false);
        } finally { cleanup(value); }
    });
}

test('exact owner build reaches safe deferral with its action and nonce intact', async () => {
    const value = fixture();
    try {
        const actionId = '12345678-1234-1234-1234-123456789abc';
        const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 3\n'), {
            actionId, expectedBuildId: BUILD,
        });
        assert.equal(result.code, 0, result.stderr);
        const receipt = JSON.parse(readFileSync(journalFile(value)));
        assert.equal(receipt.actionId, actionId);
        assert.equal(receipt.transactionNonce, 'e'.repeat(64));
        assert.equal(receipt.gate, 3);
    } finally { cleanup(value); }
});

test('owner click cannot resume another build transaction', async () => {
    const value = fixture();
    try {
        const file = path.join(value.root, '.git', `nassaj-oid-control-transaction-7-${'9'.repeat(64)}.json`);
        writeOidControlJournal(file, {
            schema: 'nassaj-oid-control-transaction/v1', state: 'prepared', sequence: 7,
            buildId: BUILD, transactionNonce: '9'.repeat(64),
        });
        const before = readFileSync(file, 'utf8');
        const result = await runCapsule(value, Buffer.from('#!/usr/bin/env bash\nexit 6\n'), {
            actionId: '12345678-1234-1234-1234-123456789abc', expectedBuildId: '0'.repeat(64),
        });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /action_candidate_superseded/);
        assert.equal(readFileSync(file, 'utf8'), before);
        assert.equal(JSON.parse(readFileSync(path.join(value.live, 'BUILD_PROVENANCE.json'))).buildId, PREVIOUS);
    } finally { cleanup(value); }
});

/** Materialize the same pinned launcher/capsule layout used by the loaded route. */
function installLoadedControl(directory, bytes, oid, buildId) {
    mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    writeFileSync(path.join(directory, 'scripts', 'preview-oid-capsule-launcher.mjs'),
        readFileSync(new URL('./preview-oid-capsule-launcher.mjs', import.meta.url)));
    writeFileSync(path.join(directory, 'OID_CONTROL_CAPSULE.mjs'), bytes, { mode: 0o444 });
    writeFileSync(path.join(directory, 'scripts', 'safe-restart.sh'), argvSafe, { mode: 0o555 });
    const manifest = Buffer.from(JSON.stringify({
        schema: 'nassaj-oid-control-runtime/v1', protocol: 1, oid, serverBuildId: buildId,
        launcherAbi: 'nassaj-oid-launcher/v1', capsuleModeAbi: 'nassaj-capsule-roots/v1',
        capsuleSha256: sha(bytes), capsuleSize: bytes.length, capsuleMode: 0o444,
        safeRestartSha256: sha(argvSafe), safeRestartSize: argvSafe.length, safeRestartMode: 0o555,
    }));
    const file = path.join(directory, 'OID_CONTROL_MANIFEST.json');
    if (existsSync(file)) chmodSync(file, 0o644);
    writeFileSync(file, manifest, { mode: 0o444 });
    chmodSync(file, 0o444);
    return manifest;
}

function launchLoadedFixture(value, healthUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
            [path.join(value.live, 'scripts', 'preview-oid-capsule-launcher.mjs')], {
                cwd: value.root, env: { ...process.env, TMPDIR: '/tmp',
                    NASSAJ_PREVIEW_HEALTH_URL: healthUrl,
                    NASSAJ_OID_HEALTH_ATTEMPTS: '2', NASSAJ_OID_HEALTH_INTERVAL_MS: '5',
                    NASSAJ_OID_ACTION_ID: '12345678-1234-1234-1234-123456789abc',
                    NASSAJ_OID_ATTEMPT_NONCE: 'e'.repeat(64),
                    NASSAJ_OID_EXPECTED_BUILD_ID: JSON.parse(readFileSync(path.join(value.candidate, 'BUILD_PROVENANCE.json'))).buildId,
                }, stdio: ['ignore', 'pipe', 'pipe'],
            });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

test('loaded capsule authority needs bridge then distinct final generation to set disk TMPDIR', async () => {
    // Optional operational acceptance uses the actual loaded immutable bytes.
    // The portable fixture models precisely the pre-ADR-148 argv contract.
    const oldBytes = process.env.B979_LOADED_CAPSULE
        ? readFileSync(process.env.B979_LOADED_CAPSULE)
        : Buffer.from(capsule.toString().replace(/['"]--set['"],\s*['"]TMPDIR=\/var\/tmp['"],\s*/g, ''));
    assert.equal(oldBytes.toString().includes("'TMPDIR=/var/tmp'"), false);
    let loadedBytes = oldBytes;
    for (const [index, buildId] of [BUILD, 'f'.repeat(64)].entries()) {
        const value = fixture(buildId, index === 0 ? PREVIOUS : BUILD);
        const server = http.createServer((_req, response) => {
            const journal = JSON.parse(readFileSync(journalFile(value)));
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ status: 'ok', serverLoadedOid: value.oid,
                serverLoadedBuildId: buildId, serverTransactionNonce: journal.transactionNonce,
                serverBootNonce: journal.bootNonce, serverProcessStartTicks: '999', pid: 999 }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            installLoadedControl(value.live, loadedBytes, 'd'.repeat(40), index === 0 ? PREVIOUS : BUILD);
            const manifest = installLoadedControl(value.candidate, capsule, value.oid, buildId);
            for (const name of ['nassaj-preview-oid-control-request-v1.json',
                'nassaj-preview-oid-event-control-0000000000000007.json', 'nassaj-preview-oid-consumer-v1.json']) {
                const file = path.join(value.root, '.git', name);
                const record = JSON.parse(readFileSync(file));
                (record.server || record).controlManifestSha256 = sha(manifest);
                writeFileSync(file, JSON.stringify(record));
            }
            const result = await launchLoadedFixture(value, `http://127.0.0.1:${server.address().port}/health`);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).status, 'served');
            const journal = JSON.parse(readFileSync(journalFile(value)));
            assert.equal(journal.buildId, buildId);
            assert.equal(journal.previousBuildId, index === 0 ? PREVIOUS : BUILD);
            const calls = capturedArgv(value);
            assert.deepEqual(calls.slice(0, 2), [['--json'], ['--json']]);
            assert.equal(calls.length, 3);
            if (index === 0) assert.equal(calls[2].some(arg => arg.startsWith('TMPDIR=')), false);
            else assertRestartArguments(calls[2], journal);
            loadedBytes = readFileSync(path.join(value.live, 'OID_CONTROL_CAPSULE.mjs'));
            assert.equal(sha(loadedBytes), sha(capsule));
        } finally {
            await new Promise(resolve => server.close(resolve));
            cleanup(value);
        }
    }
});
