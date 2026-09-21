import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { hasBlockingOwnerControl, tryOrdinarySafeRestart } from './preview-oid-owner-action.mjs';
import { withPreviewEventMutationLock } from './preview-oid-consumer.mjs';
function fixture(t) {
    const root = mkdtempSync('/var/tmp/b881-restart-'); t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', root]);
    return { root, request: path.join(root, '.git/nassaj-preview-oid-control-request-v1.json'),
        lock: path.join(root, '.git/nassaj-preview-event-mutation.lock') };
}
test('no-OID execution uses literal disk setting while holding event lock through runner', async t => {
    const { root, lock } = fixture(t); let calls = 0;
    const result = await tryOrdinarySafeRestart(root, { body: { TMPDIR: '/tmp' }, gate: false }, {
        run(command, argv, options) {
            calls++; assert.equal(command, 'bash');
            assert.deepEqual(argv, [path.join(root, 'scripts/safe-restart.sh'), '--set', 'TMPDIR=/var/tmp', '--exec']);
            assert.deepEqual(options, { cwd: root, encoding: 'utf8' });
            assert.notEqual(spawnSync('flock', ['-n', lock, 'true']).status, 0);
            return { status: 0 };
        },
    });
    assert.equal(result.status, 0); assert.equal(calls, 1);
    assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
});
test('gate remains --json only and does not acquire execution lock', async t => {
    const { root } = fixture(t);
    await tryOrdinarySafeRestart(root, { gate: true }, {
        lock() { assert.fail('gate must not lock for execution'); },
        run(command, argv) { assert.equal(command, 'bash'); assert.deepEqual(argv, [path.join(root, 'scripts/safe-restart.sh'), '--json']); return { status: 6 }; },
    });
});
test('OID created after first absence check prevents fallback; event lock released for normal OID path', async t => {
    const { root, request, lock } = fixture(t);
    const result = await tryOrdinarySafeRestart(root, {}, {
        lock: (repo, operation) => {
            writeFileSync(request, '{"sequence":129}');
            return withPreviewEventMutationLock(repo, operation);
        },
        run() { assert.fail('OID race must not restart ordinary target'); },
    });
    assert.equal(result, null); assert.equal(readFileSync(request, 'utf8'), '{"sequence":129}');
    assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
});
for (const mode of ['regular', 'dangling-symlink']) {
    test(`present ${mode} request uses normal OID path with no fallback`, async t => {
        const { root, request } = fixture(t);
        if (mode === 'regular') writeFileSync(request, '{}'); else symlinkSync('/missing/b881-test', request);
        assert.equal(await tryOrdinarySafeRestart(root, {}, { run() { assert.fail('no fallback'); }, lock() { assert.fail('initial OID goes directly to existing path'); } }), null);
    });
}
test('a terminal owner request matching the loaded generation permits ordinary restart', async t => {
    const { root } = fixture(t); let ran = false;
    const result = await tryOrdinarySafeRestart(root, {}, {
        ownerControlBlocks: () => false,
        run() { ran = true; return { status: 0 }; },
    });
    assert.equal(result.status, 0);
    assert.equal(ran, true);
});

test('only a differing or unreadable owner control request blocks an ordinary restart', () => {
    const matching = {
        hasOwnerControl: () => true,
        inspectOwnerControlRequest: () => ({ oid: 'oid-1', buildId: 'build-1' }),
        readLiveProvenance: () => ({ oid: 'oid-1', buildId: 'build-1' }),
    };
    assert.equal(hasBlockingOwnerControl('/unused', matching), false);
    assert.equal(hasBlockingOwnerControl('/unused', {
        ...matching,
        inspectOwnerControlRequest: () => ({ oid: 'oid-2', buildId: 'build-1' }),
    }), true);
    assert.equal(hasBlockingOwnerControl('/unused', {
        ...matching,
        inspectOwnerControlRequest: () => { throw new Error('invalid request'); },
    }), true);
});
for (const message of ['lock failed', 'lock timeout']) {
    test(`${message} prevents any restart`, async t => {
        const { root } = fixture(t);
        await assert.rejects(() => tryOrdinarySafeRestart(root, {}, {
            lock() { throw new Error(message); }, run() { assert.fail('lock failure must not restart'); },
        }), new RegExp(message));
    });
}
for (const savedValue of ['/var/tmp', '/tmp']) {
    test(`existing injection verifies saved TMPDIR=${savedValue} after mocked restart`, t => {
        const { root } = fixture(t);
        const source = readFileSync(new URL('./safe-restart.sh', import.meta.url), 'utf8');
        const start = source.indexOf('_exec_restart_with_injection() {');
        const end = source.indexOf('\n# run_restart:', start);
        assert.ok(start > 0 && end > start);
        const script = `
REPO_DIR="$B881_TEST_ROOT"
PROC_NAME=fixture
_ABSENT_SENTINEL=absent
SENSITIVE_KEYS=(JWT_SECRET)
PROTECTED_KEYS=(HOME PATH PM2_HOME)
SET_KEYS=(TMPDIR)
SET_VALS=(/var/tmp)
emit() { :; }
sleep() { :; }
_is_protected() { [[ "$1" == HOME || "$1" == PATH || "$1" == PM2_HOME ]]; }
_pm2_saved_env() {
  case "$1" in
    HOME) printf '%s' "$HOME" ;;
    PATH) printf '%s' '/usr/bin:/bin' ;;
    JWT_SECRET) printf '%s' 'fixture-only' ;;
    TMPDIR) if [[ -f "$B881_TEST_ROOT/restarted" ]]; then printf '%s' "$B881_TEST_SAVED"; else printf '%s' absent; fi ;;
    *) printf '%s' absent ;;
  esac
}
# Intercept every env invocation: no real PM2 or production command is reachable.
env() { if [[ "$*" == *'pm2 restart'* ]]; then printf '%s' yes > "$B881_TEST_ROOT/restarted"; fi; return 0; }
${source.slice(start, end)}
_exec_restart_with_injection
`;
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8',
            env: { ...process.env, B881_TEST_ROOT: root, B881_TEST_SAVED: savedValue } });
        assert.equal(result.status, savedValue === '/var/tmp' ? 0 : 5, result.stderr);
    });
}
