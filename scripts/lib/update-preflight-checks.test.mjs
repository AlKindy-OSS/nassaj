import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { releaseGitEnvironment, resolveGovernedSshCommand } from '../../server/services/source-updater.js';

import {
    FETCH_ENVIRONMENT_DEVIATIONS, PREFLIGHT_CODES, SOURCE_ROLLBACK_COMMAND, UNTRACKED_SCOPE_NARROWED_IN,
    defaultListPm2Processes, parseGitlinkPaths, parsePorcelainStatus, releaseFetchEnvironment,
    runUpdatePreflightChecks, shapeBlocker, untrackedFilesRejectedBy,
} from './update-preflight-checks.mjs';

const SOURCE = 'https://github.com/AlKindy-OSS/nassaj';
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** ls-remote output whose peeled line proves an annotated v1.47.0.10 tag. */
const lsRemote = (version = '1.47.0.10', commit = COMMIT) =>
    `${OTHER}\trefs/tags/v${version}\n${commit}\trefs/tags/v${version}^{}\n`;

/**
 * A git stub keyed by the leading verb(s) of the argument list. Anything not
 * listed answers "ok with empty stdout", which is the clean-tree default.
 */
function fakeGit(routes = {}) {
    const calls = [];
    const run = async (args) => {
        calls.push(args);
        const prefixes = Object.entries(routes).sort(([a], [b]) => b.length - a.length);
        for (const [prefix, reply] of prefixes) {
            if (args.join(' ').startsWith(prefix)) {
                return { ok: true, code: 0, stdout: '', timedOut: false, ...(typeof reply === 'function' ? reply(args) : reply) };
            }
        }
        return { ok: true, code: 0, stdout: '', timedOut: false };
    };
    run.calls = calls;
    return run;
}

/** A node already running the release that narrows the cleanliness check. */
const NARROWED = UNTRACKED_SCOPE_NARROWED_IN;
/** A node still running an updater that refuses on any untracked file. */
const STRICT = '1.47.0.9';

/** The pm2 process a correctly installed git checkout at /fixture runs (C3/M2). */
const PM2_OK = Object.freeze({ name: 'nassaj-dev', pmId: 0, script: '/fixture/dist-server/server/index.js', cwd: '/fixture' });

const baseline = (routes = {}, overrides = {}) => runUpdatePreflightChecks({
    appRoot: '/fixture',
    env: { NASSAJ_RELEASE_SOURCE: SOURCE },
    installedVersion: NARROWED,
    readFile: () => null,
    exists: () => true,
    listPm2Processes: async () => [PM2_OK],
    resolveSsh: () => ({ command: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', source: null, conflict: null }),
    git: fakeGit({
        'rev-parse --path-format=absolute --git-common-dir': { stdout: '/fixture/.git\n' },
        'remote get-url': { stdout: `${SOURCE}\n` },
        'ls-remote': { stdout: lsRemote() },
        'rev-parse --verify --quiet': { stdout: `${COMMIT}\n` },
        'merge-base --is-ancestor': { ok: true, code: 0 },
        ...routes,
    }),
    readLockFile: () => null,
    exchangeProbe: async () => true,
    listQueuedSafeRestarts: () => [],
    ...overrides,
});

const byCode = (result, code) => result.checks.find((check) => check.code === code);

test('a healthy node reports every code clear, in blocker priority order', async () => {
    const result = await baseline();
    assert.equal(result.ok, true);
    assert.equal(result.blocker, null);
    assert.deepEqual(result.checks.map((check) => check.code), [...PREFLIGHT_CODES]);
    assert.equal(result.checks.length, 15); // 15 codes post-ADR-156 T-1730: +node_overlay_mount_conflict, +node_env_not_loaded, +node_overlay_invalid
    for (const check of result.checks) {
        assert.equal(check.ok, true, `${check.code} should be clear`);
        assert.ok(check.reason_ar && check.reason_en, `${check.code} needs both languages`);
    }
    assert.deepEqual(result.target, { version: '1.47.0.10', commit: COMMIT, local: true });
});

test('a non-git tree stops before any check rather than failing all ten', async () => {
    const result = await runUpdatePreflightChecks({
        appRoot: '/fixture', env: {}, exists: () => false, git: fakeGit(), readLockFile: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'unsupported_install_mode');
    assert.equal(result.checks.length, 1);
});

test('live sessions defer the update and never propose killing them', async () => {
    const result = await baseline({}, { activeSessionCount: () => 3 });
    assert.equal(result.blocker.code, 'active_sessions');
    assert.match(result.blocker.ar, /3 جلسة/);
    assert.match(result.blocker.action.en, /Finish the live sessions/);
    assert.doesNotMatch(JSON.stringify(result.blocker.action), /kill/i);
});

test('unreadable session state is a blocker, not a silent zero', async () => {
    const result = await baseline({}, { activeSessionCount: () => { throw new Error('db down'); } });
    assert.equal(result.blocker.code, 'active_sessions');
});

test('remote_mismatch names both identities and never auto-fixes', async () => {
    const result = await baseline({ 'remote get-url': { stdout: 'https://github.com/someone/fork\n' } });
    assert.equal(result.blocker.code, 'remote_mismatch');
    assert.match(result.blocker.ar, /someone\/fork/);
    assert.match(result.blocker.ar, /alkindy-oss\/nassaj/);
    assert.equal(byCode(result, 'remote_mismatch').autoFixable, false);
});

test('a remote with two URLs is rejected as ambiguous', async () => {
    const result = await baseline({ 'remote get-url': { stdout: `${SOURCE}\n${SOURCE}\n` } });
    assert.equal(result.blocker.code, 'remote_mismatch');
    assert.match(result.blocker.en, /2 URLs/);
});

test('an absent release-source lock is clear, a mismatching one is fail-closed', async () => {
    const absent = await baseline({}, { readLockFile: () => null });
    assert.equal(byCode(absent, 'release_source_lock').ok, true);

    const matching = await baseline({}, { readLockFile: () => JSON.stringify({ releaseSource: SOURCE }) });
    assert.equal(byCode(matching, 'release_source_lock').ok, true);

    const conflicting = await baseline({}, { readLockFile: () => JSON.stringify({ releaseSource: 'https://github.com/other/repo' }) });
    assert.equal(conflicting.blocker.code, 'release_source_lock');
    assert.match(conflicting.blocker.en, /other\/repo/);

    const malformed = await baseline({}, { readLockFile: () => 'not json' });
    assert.equal(malformed.blocker.code, 'release_source_lock');
});

test('fetch_capability fails closed and suppresses the downstream tag check', async () => {
    const result = await baseline({ 'ls-remote': { ok: false, code: 128, stdout: '' } });
    assert.equal(result.blocker.code, 'fetch_capability');
    assert.match(result.blocker.ar, /خاص|الاعتماد/);
    assert.equal(byCode(result, 'annotated_tag').severity, 'warn');
    assert.equal(result.target, null);
});

test('a network timeout is reported as a timeout, not as a missing credential', async () => {
    const result = await baseline({ 'ls-remote': { ok: false, timedOut: true, stdout: '' } });
    assert.equal(result.blocker.code, 'fetch_capability');
    assert.match(result.blocker.en, /deadline/);
});

test('a lightweight-only tag set is an annotated_tag blocker', async () => {
    const result = await baseline({ 'ls-remote': { stdout: `${COMMIT}\trefs/tags/v1.47.0.10\n` } });
    assert.equal(result.blocker.code, 'annotated_tag');
});

test('non_fast_forward uses the resolved target when the commit is local', async () => {
    const result = await baseline({ 'merge-base --is-ancestor': { ok: false, code: 1 } });
    assert.equal(result.blocker.code, 'non_fast_forward');
    assert.equal(byCode(result, 'non_fast_forward').autoFixable, false);
    assert.match(result.blocker.action.ar, /overlay/);
});

test('non_fast_forward falls back to the tracking ref when the target is not local', async () => {
    const result = await baseline({
        'rev-parse --verify --quiet a': { ok: false, code: 1, stdout: '' },
        'rev-parse --verify --quiet refs/remotes/origin/main': { stdout: `${OTHER}\n` },
        'rev-list --count': { stdout: '2\n' },
    });
    assert.equal(result.target.local, false);
    assert.equal(result.blocker.code, 'non_fast_forward');
    assert.match(result.blocker.en, /2 local commit/);
});

test('with no target and no tracking ref, fast-forward is a warning not a false green', async () => {
    const result = await baseline({
        'rev-parse --verify --quiet': { ok: false, code: 1, stdout: '' },
        'ls-remote': { ok: false, code: 128, stdout: '' },
    });
    assert.equal(byCode(result, 'non_fast_forward').severity, 'warn');
    assert.equal(byCode(result, 'non_fast_forward').ok, false);
});

test('dirty_worktree ignores a dirty file outside the changed-path set (B-1050)', async () => {
    const result = await baseline({
        'status --porcelain': { stdout: '?? .env.bak-20260910\u0000 M docs/notes.md\u0000' },
        'diff --name-only': { stdout: 'server/index.js\u0000package.json\u0000' },
    });
    assert.equal(byCode(result, 'dirty_worktree').ok, true);
    assert.equal(result.ok, true);
});

test('dirty_worktree blocks only on a file the release itself rewrites', async () => {
    const result = await baseline({
        'status --porcelain': { stdout: ' M server/index.js\u0000?? .env.bak-20260910\u0000' },
        'diff --name-only': { stdout: 'server/index.js\u0000' },
    });
    assert.equal(result.blocker.code, 'dirty_worktree');
    assert.match(result.blocker.en, /server\/index\.js/);
    assert.doesNotMatch(result.blocker.en, /\.env\.bak/);
});

test('without a local target an untracked file BLOCKS while the installed updater is strict', async () => {
    const unresolved = {
        'rev-parse --verify --quiet a': { ok: false, code: 1, stdout: '' },
        'rev-parse --verify --quiet refs/remotes': { stdout: `${OTHER}\n` },
        'status --porcelain': { stdout: '?? .env.bak-20260910\u0000' },
    };
    // The node whose updater still runs --untracked-files=all really will be
    // refused, so clearing it here would be a false green on B-1050 itself.
    const strict = await baseline(unresolved, { installedVersion: STRICT });
    assert.equal(strict.blocker.code, 'dirty_worktree');
    assert.match(strict.blocker.en, /\.env\.bak-20260910/);
    assert.match(strict.blocker.en, new RegExp(`installed updater ${STRICT}`));
    assert.match(strict.blocker.en, /--untracked-files=all/);
    assert.match(strict.blocker.ar, new RegExp(STRICT));

    // Once the narrowing ships, the same tree is clean.
    const narrowed = await baseline(unresolved, { installedVersion: NARROWED });
    assert.equal(byCode(narrowed, 'dirty_worktree').ok, true);
    assert.match(byCode(narrowed, 'dirty_worktree').reason_en, new RegExp(NARROWED));
});

test('an unreadable installed version fails closed, not open', async () => {
    const result = await baseline({
        'rev-parse --verify --quiet a': { ok: false, code: 1, stdout: '' },
        'rev-parse --verify --quiet refs/remotes': { stdout: `${OTHER}\n` },
        'status --porcelain': { stdout: '?? stray.log\u0000' },
    }, { installedVersion: null, readFile: () => null });
    assert.equal(result.blocker.code, 'dirty_worktree');
    assert.match(result.blocker.en, /installed updater unknown/);
    assert.equal(result.installedVersion, null);
});

test('the strictness gate is decided by the installed version alone', () => {
    assert.equal(untrackedFilesRejectedBy('1.47.0.8'), true);
    assert.equal(untrackedFilesRejectedBy('1.47.0.9'), true);
    // WI-10 ships the narrowing in 1.47.0.10, so that release and later clear.
    assert.equal(UNTRACKED_SCOPE_NARROWED_IN, '1.47.0.10');
    assert.equal(untrackedFilesRejectedBy(UNTRACKED_SCOPE_NARROWED_IN), false);
    assert.equal(untrackedFilesRejectedBy('1.48.0.0'), false);
    assert.equal(untrackedFilesRejectedBy(null), true);
    assert.equal(untrackedFilesRejectedBy('not-a-version'), true);
});

test('the installed version is read from the tree when it is not injected', async () => {
    const result = await baseline({}, {
        installedVersion: null,
        readFile: (file) => (file.endsWith('package.json') ? JSON.stringify({ version: '1.47.0.9' }) : null),
    });
    assert.equal(result.installedVersion, '1.47.0.9');
});

const NUL = String.fromCharCode(0);
const GITLINK_INDEX = `160000 ${COMMIT} 0\tvendor/theme${NUL}100644 ${OTHER} 0\tREADME.md${NUL}`;
const GITLINK_TREE = `160000 commit ${COMMIT}\tvendor/theme${NUL}`;

test('an unchanged gitlink is clear: the updater refuses only a change (qa-critic L2)', async () => {
    const result = await baseline({
        'ls-files --stage': { stdout: GITLINK_INDEX },
        'ls-tree -r -z HEAD': { stdout: GITLINK_TREE },
        [`ls-tree -r -z ${COMMIT}`]: { stdout: GITLINK_TREE },
    });
    const check = byCode(result, 'gitlinks');
    assert.equal(check.ok, true);
    assert.match(check.reason_en, /leaves them unchanged/);
    assert.match(check.reason_ar, /vendor\/theme/);
    assert.equal(result.ok, true);
});

test('a gitlink with an unresolved target is a warning, never a blocker (qa-critic L2)', async () => {
    const result = await baseline({
        'ls-files --stage': { stdout: GITLINK_INDEX },
        'rev-parse --verify --quiet': { ok: false, code: 1, stdout: '' },
    });
    const check = byCode(result, 'gitlinks');
    assert.equal(check.severity, 'warn');
    assert.match(check.reason_en, /gitlink_change_unsupported/);
    assert.notEqual(result.blocker?.code, 'gitlinks');
});

test('a tree listing the parser refuses is a gap, not a green', async () => {
    const result = await baseline({
        'ls-files --stage': { stdout: GITLINK_INDEX },
        'ls-tree -r -z HEAD': { stdout: `not a tree listing${NUL}` },
    });
    assert.equal(byCode(result, 'gitlinks').severity, 'blocker');
});

test('a gitlink present only in the target tree is still caught', async () => {
    const result = await baseline({
        'ls-tree -r -z HEAD': { stdout: '' },
        [`ls-tree -r -z ${COMMIT}`]: { stdout: GITLINK_TREE },
    });
    assert.equal(result.blocker.code, 'gitlinks');
    assert.match(result.blocker.en, /gitlink_change_unsupported/);
});

test('a release that changes a gitlink is named with the gate that will refuse it (WI-11)', async () => {
    const result = await baseline({
        'ls-tree -r -z HEAD': { stdout: `160000 commit ${COMMIT}\tvendor/theme\u0000` },
        [`ls-tree -r -z ${COMMIT}`]: { stdout: `160000 commit ${OTHER}\tvendor/theme\u0000` },
    });
    assert.equal(result.blocker.code, 'gitlinks');
    assert.match(result.blocker.en, /gitlink_change_unsupported/);
    assert.match(result.blocker.en, /vendor\/theme/);
    assert.match(result.blocker.ar, /vendor\/theme/);
});

test('exchange_capability blocks when mv lacks --exchange, and when its probe cannot load', async () => {
    const unsupported = await baseline({}, { exchangeProbe: async () => false });
    assert.equal(unsupported.blocker.code, 'exchange_capability');
    assert.match(unsupported.blocker.en, /--exchange --no-copy/);

    const unloadable = await baseline({}, { exchangeProbe: async () => { throw new Error('no typescript'); } });
    assert.equal(unloadable.blocker.code, 'exchange_capability');
    assert.match(unloadable.blocker.en, /could not be loaded/);
});

test('a legitimate operator safe-restart row is NOT stale', async () => {
    // A row carrying the running build is exactly what the command board queues
    // for an ordinary safe-restart request; calling it stale raised a blocker on
    // every single one of them.
    const result = await baseline({}, {
        listQueuedSafeRestarts: () => [{ id: 'row-1', expectedServerBuildId: 'f'.repeat(64), sourceUpdateJobId: null }],
    });
    assert.equal(byCode(result, 'stale_restart_row').ok, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.repairs, []);
});

test('a row bound to a finished job warns and is left to the write contract', async () => {
    const orphaned = await baseline({}, {
        listQueuedSafeRestarts: () => [{ id: 'row-2', expectedServerBuildId: 'e'.repeat(64), sourceUpdateJobId: 'job-9' }],
        isSourceUpdateJobLive: () => false,
    });
    const check = byCode(orphaned, 'stale_restart_row');
    assert.equal(check.severity, 'warn');
    assert.equal(check.autoFixable, true);
    assert.equal(orphaned.blocker, null, 'a diagnosis the update path repairs itself must not stop the jump');
    assert.deepEqual(orphaned.repairs, ['stale_restart_row']);
    assert.match(check.action_en, /Diagnosis only/);
    assert.doesNotMatch(check.reason_en, /same fingerprint/);

    const live = await baseline({}, {
        listQueuedSafeRestarts: () => [{ id: 'row-3', expectedServerBuildId: 'e'.repeat(64), sourceUpdateJobId: 'job-9' }],
        isSourceUpdateJobLive: () => true,
    });
    assert.equal(byCode(live, 'stale_restart_row').ok, true);
});

test('an unreadable restart queue warns rather than passing silently', async () => {
    const result = await baseline({}, { listQueuedSafeRestarts: () => null });
    assert.equal(byCode(result, 'stale_restart_row').severity, 'warn');
    assert.equal(result.ok, true);
});

test('the highest-priority blocker alone is reported when several fail', async () => {
    const result = await baseline({
        'remote get-url': { stdout: 'https://github.com/someone/fork\n' },
    }, { activeSessionCount: () => 1, exchangeProbe: async () => false });
    assert.equal(result.blocker.code, 'active_sessions');
    assert.equal(result.checks.filter((check) => check.severity === 'blocker').length, 3);
});

/** A journal reader for `/fixture/.git/nassaj-source-update/journal.json`. */
const journalAt = (journal) => (file) => (
    file === '/fixture/.git/nassaj-source-update/journal.json' ? JSON.stringify(journal) : null
);

test('a degraded reopen is the first blocker, with one cause and the source-rollback action (H3/C2)', async () => {
    const result = await baseline({}, {
        activeSessionCount: () => 2,
        readFile: journalAt({ state: 'OPEN', gateClosed: false, degraded: 'source_tree_at_target', exitPath: 'x' }),
    });
    assert.equal(result.blocker.code, 'source_state_unreconciled');
    assert.match(result.blocker.en, /update_source_state_degraded/);
    assert.match(result.blocker.en, /source_tree_at_target/);
    assert.match(result.blocker.ar, /update_source_state_degraded/);
    assert.equal(result.blocker.action.command, SOURCE_ROLLBACK_COMMAND);
    assert.match(SOURCE_ROLLBACK_COMMAND, /--reopen-gate --complete-source-rollback --yes$/);
});

test('MANUAL, an update in flight, and an unreadable journal all block; an open gate is clear', async () => {
    const manual = await baseline({}, { readFile: journalAt({ state: 'MANUAL', gateClosed: true }) });
    assert.equal(manual.blocker.code, 'source_state_unreconciled');
    assert.match(manual.blocker.action.command, /--reopen-gate --yes/);

    const busy = await baseline({}, { readFile: journalAt({ state: 'UPDATING', gateClosed: true }) });
    assert.match(busy.blocker.en, /already in progress \(state UPDATING\)/);

    const corrupt = await baseline({}, { readFile: (file) => (file.endsWith('journal.json') ? '{not json' : null) });
    assert.match(corrupt.blocker.en, /cannot be read/);

    const noCommonDir = await baseline({ 'rev-parse --path-format=absolute --git-common-dir': { ok: false, code: 128 } });
    assert.equal(noCommonDir.blocker.code, 'source_state_unreconciled');

    const open = await baseline({}, { readFile: journalAt({ state: 'OPEN', gateClosed: false, degraded: null }) });
    assert.equal(byCode(open, 'source_state_unreconciled').ok, true);
    assert.equal(open.ok, true);
});

test('pm2_entry blocks a git node that pm2 starts through the sealed-release entry (M2/C3)', async () => {
    const result = await baseline({}, {
        listPm2Processes: async () => [{ ...PM2_OK, script: '/opt/nassaj/launcher/pm2-entry.mjs', cwd: '/fixture/config' }],
    });
    assert.equal(result.blocker.code, 'pm2_entry');
    assert.match(result.blocker.en, /sealed-release entry/);
    assert.match(result.blocker.action.command, /install-node\.mjs/);
});

test('pm2_entry blocks a wrong script or a cwd other than the app root', async () => {
    const script = await baseline({}, { listPm2Processes: async () => [{ ...PM2_OK, script: '/elsewhere/index.js' }] });
    assert.match(script.blocker.en, /must run \/fixture\/dist-server\/server\/index\.js/);
    const cwd = await baseline({}, { listPm2Processes: async () => [{ ...PM2_OK, cwd: '/fixture/config' }] });
    assert.match(cwd.blocker.en, /cwd \/fixture\/config, not the app root \/fixture/);
});

test('pm2_entry finds its own process by pm_id before the name, and never guesses', async () => {
    const own = await baseline({}, {
        env: { NASSAJ_RELEASE_SOURCE: SOURCE, pm_id: '7' },
        listPm2Processes: async () => [{ ...PM2_OK, script: '/other/index.js' }, { ...PM2_OK, pmId: 7, name: 'renamed' }],
    });
    assert.equal(byCode(own, 'pm2_entry').ok, true);

    const missing = await baseline({}, { listPm2Processes: async () => [{ ...PM2_OK, name: 'another-app' }] });
    assert.equal(byCode(missing, 'pm2_entry').severity, 'warn');
    const unreadable = await baseline({}, { listPm2Processes: async () => null });
    assert.equal(byCode(unreadable, 'pm2_entry').severity, 'warn');
    const thrown = await baseline({}, { listPm2Processes: async () => { throw new Error('boom'); } });
    assert.equal(byCode(thrown, 'pm2_entry').severity, 'warn');
});

test('the default pm2 reader never spawns a daemon: no live pid file means no pm2 call', async (t) => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-pm2-home-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { PATH: '/nonexistent', PM2_HOME: home };
    assert.equal(await defaultListPm2Processes({ env }), null);
    fs.writeFileSync(path.join(home, 'pm2.pid'), '999999999\n');
    assert.equal(await defaultListPm2Processes({ env }), null);
    assert.deepEqual(fs.readdirSync(home), ['pm2.pid'], 'nothing was created in PM2_HOME');
});

test('the fetch environment strips update secrets and forbids interactive ssh', () => {
    const built = releaseFetchEnvironment({
        PATH: '/usr/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
        NASSAJ_UPDATE_CONTROL_ROOT: '/x', NASSAJ_RELEASE_SOURCE: SOURCE,
    });
    assert.equal(built.GH_TOKEN, undefined);
    assert.equal(built.GITHUB_TOKEN, undefined);
    assert.equal(built.NASSAJ_UPDATE_CONTROL_ROOT, undefined);
    assert.equal(built.NASSAJ_RELEASE_SOURCE, SOURCE);
    assert.equal(built.GIT_TERMINAL_PROMPT, '0');
    assert.equal(built.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.match(built.GIT_SSH_COMMAND, /BatchMode=yes/);
    assert.match(built.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
});

test('the probe environment does not drift from the updater it is predicting', () => {
    // A probe richer than the fetch is the false green of B-1053; a probe
    // laxer on host keys than the fetch is the false green of H5. Only the
    // deviations declared as such are allowed.
    const source = { PATH: '/usr/bin', HOME: '/var/lib/nassaj-svc', GH_TOKEN: 'secret', NASSAJ_UPDATE_REMOTE: 'origin' };
    const updater = releaseGitEnvironment(source);
    const probe = releaseFetchEnvironment(source);

    const drifted = Object.keys({ ...updater, ...probe })
        .filter((key) => updater[key] !== probe[key]);
    assert.deepEqual(drifted.sort(), Object.keys(FETCH_ENVIRONMENT_DEVIATIONS).sort());
    for (const [key, value] of Object.entries(FETCH_ENVIRONMENT_DEVIATIONS)) {
        assert.equal(probe[key], value);
    }
    assert.match(probe.GIT_SSH_COMMAND, /-o BatchMode=yes -o StrictHostKeyChecking=yes/,
        'the probe runs the same host-key policy as the updater fetch (qa-critic H5)');
});

test('the probe composes the repository core.sshCommand exactly as the fetch does (462fcabd8)', (t) => {
    const root = realRepository(t);
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -i /srv/keys/deploy'], { cwd: root });
    const source = { PATH: process.env.PATH, HOME: root };
    const probe = releaseFetchEnvironment(source, { appRoot: root });
    assert.equal(probe.GIT_SSH_COMMAND, releaseGitEnvironment(source, { appRoot: root }).GIT_SSH_COMMAND);
    assert.match(probe.GIT_SSH_COMMAND, /^ssh -i \/srv\/keys\/deploy -o BatchMode=yes -o StrictHostKeyChecking=yes/);
    // Without appRoot the repository command is invisible: that was the drift.
    assert.doesNotMatch(releaseFetchEnvironment(source).GIT_SSH_COMMAND, /deploy/);
});

test('an ssh command conflict is a fetch_capability blocker and the probe never runs it', async () => {
    const result = await baseline({}, {
        resolveSsh: () => ({ command: 'x', source: 'core.sshCommand', conflict: 'StrictHostKeyChecking=no' }),
    });
    assert.equal(result.blocker.code, 'fetch_capability');
    assert.match(result.blocker.en, /core\.sshCommand sets StrictHostKeyChecking=no/);
    assert.match(result.blocker.en, /ssh_command_conflict/);
    assert.match(result.blocker.ar, /ssh_command_conflict/);
    assert.match(result.blocker.action.en, /Remove the StrictHostKeyChecking=no option from core\.sshCommand/);
    assert.equal(byCode(result, 'annotated_tag').severity, 'warn');
});

test('against a real repository a conflicting core.sshCommand is caught by the real resolver', async (t) => {
    const root = realRepository(t);
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -o StrictHostKeyChecking=no'], { cwd: root });
    assert.equal(resolveGovernedSshCommand({ env: {}, appRoot: root }).conflict, 'StrictHostKeyChecking=no');
    let probed = false;
    const result = await againstRealRepo(root, { networkGit: async () => { probed = true; return { ok: true, code: 0, stdout: '' }; } });
    assert.equal(byCode(result, 'fetch_capability').severity, 'blocker');
    assert.match(byCode(result, 'fetch_capability').reason_en, /ssh_command_conflict/);
    assert.equal(probed, false, 'the conflicting command is never run');
});

test('a host key refusal is a blocker: the updater fetch would be refused too (qa-critic H5)', async () => {
    const result = await baseline({ 'ls-remote': { ok: false, code: 128, stdout: '', hostKeyFailure: true } });
    const check = byCode(result, 'fetch_capability');
    assert.equal(check.severity, 'blocker');
    assert.match(check.reason_en, /StrictHostKeyChecking=yes/);
    assert.match(check.reason_ar, /StrictHostKeyChecking=yes/);
    assert.equal(result.blocker.code, 'fetch_capability');
    assert.match(check.command, /install-node\.mjs/);
    assert.doesNotMatch(check.command, /ssh-keyscan/, 'keyscan trusts whatever answers');
    // The tag still cannot be inspected, so it stays a warning, not a pass.
    assert.equal(byCode(result, 'annotated_tag').severity, 'warn');
});

test('porcelain and ls-files parsers handle renames, spaces, and gitlink modes', () => {
    assert.deepEqual(parsePorcelainStatus('R  new name.md\u0000old name.md\u0000?? build.log\u0000'),
        { tracked: ['new name.md'], untracked: ['build.log'] });
    assert.deepEqual(parseGitlinkPaths(`160000 ${COMMIT} 0\tvendor/a\u0000100644 ${OTHER} 0\tb.md\u0000160000 commit ${COMMIT}\tvendor/c\u0000`),
        ['vendor/a', 'vendor/c']);
});

test('shapeBlocker produces the plan أ.5 contract', () => {
    const shaped = shapeBlocker({
        code: 'gitlinks', reason_ar: 'س', reason_en: 'r', action_ar: 'إ', action_en: 'a', command: 'git rm',
    });
    assert.deepEqual(shaped, { code: 'gitlinks', ar: 'س', en: 'r', action: { ar: 'إ', en: 'a', command: 'git rm' } });
});

/** Every path under a tree, with size and mtime, .git included (ت-5). */
function snapshot(root) {
    const entries = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, entry.name);
            const stat = fs.lstatSync(absolute);
            entries.push(`${path.relative(root, absolute)}|${stat.size}|${stat.mtimeMs}`);
            if (entry.isDirectory()) walk(absolute);
        }
    };
    walk(root);
    return entries;
}

function realRepository(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-preflight-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'preflight@example.invalid');
    git('config', 'user.name', 'Preflight');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-qm', 'base');
    git('remote', 'add', 'origin', SOURCE);
    return root;
}

const againstRealRepo = (root, overrides = {}) => runUpdatePreflightChecks({
    appRoot: root,
    env: { PATH: process.env.PATH, HOME: root, NASSAJ_RELEASE_SOURCE: SOURCE },
    networkGit: async () => ({ ok: false, code: 128, stdout: '', timedOut: false }),
    exchangeProbe: async () => true,
    listQueuedSafeRestarts: () => [],
    ...overrides,
});

test('against a real repository the preflight writes nothing, not even inside .git', async (t) => {
    const root = realRepository(t);
    fs.writeFileSync(path.join(root, 'untracked.log'), 'noise\n');
    const before = snapshot(root);

    const result = await againstRealRepo(root);

    assert.equal(byCode(result, 'remote_mismatch').ok, true);
    assert.equal(byCode(result, 'gitlinks').ok, true);
    assert.equal(byCode(result, 'release_source_lock').ok, true);
    assert.equal(result.blocker.code, 'fetch_capability');
    // The whole tree, .git and its index/refs/logs included, is byte-identical.
    assert.deepEqual(snapshot(root), before);
});

test('a real tree with an untracked file is refused while the installed updater is strict', async (t) => {
    const root = realRepository(t);
    fs.writeFileSync(path.join(root, '.env.bak-20260910'), 'secret\n');

    const strict = await againstRealRepo(root, { installedVersion: STRICT });
    assert.equal(byCode(strict, 'dirty_worktree').ok, false);
    assert.match(byCode(strict, 'dirty_worktree').reason_en, /\.env\.bak-20260910/);

    const narrowed = await againstRealRepo(root, { installedVersion: NARROWED });
    assert.equal(byCode(narrowed, 'dirty_worktree').ok, true);
});

test('a real clean tree clears the cleanliness check on any installed version', async (t) => {
    const root = realRepository(t);
    for (const installedVersion of [STRICT, NARROWED, null]) {
        const result = await againstRealRepo(root, { installedVersion });
        assert.equal(byCode(result, 'dirty_worktree').ok, true, `installed ${installedVersion}`);
    }
});
