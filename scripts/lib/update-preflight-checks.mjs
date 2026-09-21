/**
 * Update pre-flight diagnosis (ADR-156, WI-7/WI-8, T-1719/T-1720).
 *
 * Codes that answer "would a governed update fail, and why?" BEFORE any
 * write happens. Every check here is READ-ONLY: it spawns `git` with read
 * verbs, reads the release-source lock and the maintenance-gate journal, asks
 * an ALREADY-RUNNING pm2 daemon for its process list, and probes `mv --help`.
 * It never fetches, never
 * writes a ref, never touches the database, and never repairs anything — the
 * repairs listed as `autoFixable` are performed later by the update job itself
 * under the writer lease and the fence, never by a `GET`.
 *
 * The logic lives here rather than in the service so that `scripts/doctor.mjs`
 * runs exactly the same checks on a node whose server cannot boot (plan ط.2).
 * Every external effect is injected, so the unit tests need no real git.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareNassajReleaseVersions, isNassajReleaseVersion } from '../../shared/release-version-policy.js';
import { selectLatestAnnotatedReleaseTag } from '../../server/services/git-tag-release-discovery.js';
import { normalizeGitHubRepositoryIdentity, resolveReleaseSource } from '../../server/services/release-source-config.js';
import { releaseGitEnvironment, resolveGovernedSshCommand } from '../../server/services/source-updater.js';

import { supportsAtomicExchange } from './atomic-exchange-capability.mjs';
import { classifyDivergence, diffDependencyVersions } from './local-divergence.mjs';
import { parseNodeOverlay } from './node-overlay.mjs';
import pm2InstallLayout from './pm2-install-layout.cjs';
import { gitlinkChangePaths, parseTreeEntries } from './source-update-gitlinks.mjs';
import {
    conflictingPaths, describePaths, nulFields, parsePorcelainStatus,
} from './update-worktree-cleanliness.mjs';

// WI-10 keeps one definition of the cleanliness judgement; the parser stays
// exported from here because callers already import it from the pre-flight.
export { parsePorcelainStatus };

const { GIT_CHECKOUT_LAYOUT, expectedPm2Entry } = pm2InstallLayout;

const OUTPUT_LIMIT = 1024 * 1024;
/** `pm2 jlist` carries every process's environment; a fleet host can be large. */
const PM2_LIST_LIMIT = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const GITLINK_MODE = '160000';

/**
 * The release that narrows the updater's cleanliness check to the paths that
 * actually change (WI-10). Until a node runs at least this version, its
 * INSTALLED updater still rejects on `--untracked-files=all`, so an untracked
 * file really does stop the jump and the pre-flight must say so (B-1050).
 */
export const UNTRACKED_SCOPE_NARROWED_IN = '1.47.0.10';

/** ssh patterns that mean "host key policy", not "no credential" (م-1). */
const HOST_KEY_FAILURE = /host key verification failed|remote host identification has changed|authenticity of host|no matching host key/i;

/**
 * Blocker priority: the single reported blocker is the first of these that fails.
 * `source_state_unreconciled` leads: while it holds, `beginUpdate` refuses before
 * any other condition is consulted, and only an operator action clears it.
 */
export const PREFLIGHT_CODES = Object.freeze([
    'source_state_unreconciled',
    'active_sessions',
    'remote_mismatch',
    'release_source_lock',
    'fetch_capability',
    'annotated_tag',
    'non_fast_forward',
    'node_overlay_mount_conflict',
    'dirty_worktree',
    'gitlinks',
    'exchange_capability',
    'pm2_entry',
    'node_env_not_loaded',
    'node_overlay_invalid',
    'stale_restart_row',
]);

/**
 * The code-defined allowlist of NON-secret, NON-privileged keys the server loads
 * from `config/node.env` at boot (contract §3.4 step 1, M16). It holds `TMPDIR`
 * alone: everything else — `NODE_OPTIONS`, `HOST`, `PORT`, `WEBAUTHN_*`, any
 * secret — is ignored, and `NASSAJ_RELEASE_SOURCE` is pinned through the lock,
 * not loaded here. Duplicated deliberately from `server/lib/node-env-allowlist.js`
 * (W8) so the pre-flight runs on a node whose server cannot boot; a parity test
 * pins the two lists together.
 */
export const NODE_ENV_ALLOWLIST = Object.freeze(['TMPDIR']);

export const RELEASE_SOURCE_LOCK_RELATIVE_PATH = path.join('config', 'release-source.lock.json');
/** The maintenance-gate journal of a git checkout, under the COMMON git dir. */
export const SOURCE_UPDATE_JOURNAL_RELATIVE_PATH = path.join('nassaj-source-update', 'journal.json');
/** The one exit from a degraded reopen (ADR-156 ب.5; the doctor action is agent A's). */
export const SOURCE_ROLLBACK_COMMAND = 'npm run doctor -- --reopen-gate --complete-source-rollback --yes';

function positiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

/** The ONLY permitted differences from the updater's own git environment (م-1). */
export const FETCH_ENVIRONMENT_DEVIATIONS = Object.freeze({
    // Read-only probing takes no index lock; the updater holds one legitimately.
    GIT_OPTIONAL_LOCKS: '0',
    // GIT_SSH_COMMAND is deliberately NOT a deviation: the probe inherits the
    // updater's governed ssh command (BatchMode=yes, StrictHostKeyChecking=yes,
    // ConnectTimeout) verbatim. The old laxer override — no host-key policy —
    // was the false green of qa-critic H5.
});

/**
 * The updater's own git environment (`releaseGitEnvironment` in
 * `source-updater.js`) plus exactly the deviations above — imported, not
 * re-derived, so the two cannot drift (ADR-156 م-1). A drift test pins the
 * difference to `FETCH_ENVIRONMENT_DEVIATIONS`.
 */
export function releaseFetchEnvironment(env = process.env, { appRoot = null } = {}) {
    // `appRoot` lets the governed ssh command compose the repository's own
    // core.sshCommand, exactly as the fetch does (462fcabd8); without it the
    // probe would run a different ssh command than the pull it predicts.
    return { ...releaseGitEnvironment(env, { appRoot }), ...FETCH_ENVIRONMENT_DEVIATIONS };
}

/**
 * Run one read-only git command with a hard deadline. The child leads its own
 * process group so a hung `ls-remote` is killed WITH the ssh it spawned
 * (plan أ.5, "قتل بالمجموعة"). stderr is matched against one pattern and then
 * dropped: the caller learns only whether the failure was host-key policy, so a
 * credential helper's output can never reach a log or a response.
 */
export function runGitRead({ appRoot, args, env, timeoutMs, spawnImpl = spawn }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
                cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
            });
        } catch { resolve({ ok: false, code: null, stdout: '', timedOut: false }); return; }
        let stdout = '';
        let hostKeyFailure = false;
        let settled = false;
        const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ hostKeyFailure, ...result }); };
        const killGroup = () => {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        };
        const timer = setTimeout(() => { killGroup(); finish({ ok: false, code: null, stdout: '', timedOut: true }); }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > OUTPUT_LIMIT) { killGroup(); finish({ ok: false, code: null, stdout: '', timedOut: false }); }
        });
        // stderr is classified, never retained or surfaced: only the boolean
        // leaves this scope, so a credential helper's output cannot reach a log.
        child.stderr.on('data', (chunk) => { if (HOST_KEY_FAILURE.test(chunk.toString('utf8'))) hostKeyFailure = true; });
        child.once('error', () => finish({ ok: false, code: null, stdout: '', timedOut: false }));
        child.once('close', (code) => finish({ ok: code === 0, code, stdout, timedOut: false }));
    });
}

/**
 * Presence without an existsSync race: `lstatSync` inside a try answers about
 * the path ITSELF, so a dangling symlink where `.git` should be is absent
 * rather than silently present (ت-5).
 */
function isPresent(target) {
    try { return Boolean(fs.lstatSync(target)); } catch { return false; }
}

/** Read a file, or null when it is absent; other errors propagate. */
function defaultReadFile(target) {
    try { fs.lstatSync(target); } catch { return null; }
    return fs.readFileSync(target, 'utf8');
}

/** Stat a path, or null when it is absent/unreadable (injectable for tests). */
function defaultStatPath(target) {
    try { return fs.statSync(target); } catch { return null; }
}

/** The release version INSTALLED on this node, or null when unreadable. */
function readInstalledVersion(appRoot, readFile) {
    try {
        const raw = readFile(path.join(appRoot, 'package.json'));
        const version = raw === null ? null : JSON.parse(raw)?.version;
        return isNassajReleaseVersion(version) ? version : null;
    } catch { return null; }
}

/**
 * One diagnosis, in the shape every one of the ten codes returns.
 *
 * `ok` is defined as `severity === 'ok'` and nothing else: a warning is NOT ok,
 * it is a finding whose severity does not stop the jump. The overall result is
 * ok when no check reaches 'blocker'.
 */
function finding(code, severity, { ar, en }, action = null, autoFixable = false, details = null) {
    return Object.freeze({
        code,
        ok: severity === 'ok',
        severity,
        autoFixable,
        reason_ar: ar,
        reason_en: en,
        action_ar: action?.ar ?? null,
        action_en: action?.en ?? null,
        command: action?.command ?? null,
        details: details ?? null,
    });
}

/** Rebuild a finding with attached structured `details` (e.g. `{ divergence }`). */
function withDetails(check, details) {
    return finding(
        check.code, check.severity, { ar: check.reason_ar, en: check.reason_en },
        { ar: check.action_ar, en: check.action_en, command: check.command },
        check.autoFixable, details,
    );
}

const clear = (code, message) => finding(code, 'ok', message);
const blocker = (code, message, action, autoFixable = false) => finding(code, 'blocker', message, action, autoFixable);
const warning = (code, message, action) => finding(code, 'warn', message, action);

/** Paths carrying a gitlink (mode 160000) in `ls-files --stage` or `ls-tree -r` output. */
export function parseGitlinkPaths(stdout) {
    const paths = [];
    for (const record of nulFields(stdout)) {
        const match = /^(\d{6}) (?:blob|tree|commit|[a-f0-9]{40})/.exec(record);
        if (match?.[1] !== GITLINK_MODE) continue;
        const tab = record.indexOf('\t');
        if (tab >= 0) paths.push(record.slice(tab + 1));
    }
    return paths;
}

const list = (paths, limit = 5) => describePaths(paths, limit, '، ');
const listEn = (paths, limit = 5) => describePaths(paths, limit, ', ');

// --- individual checks -----------------------------------------------------

/**
 * Read the maintenance-gate journal the way `beginUpdate` will meet it, without
 * importing the gate (whose factory takes locks and may create its control
 * directory). Absent is `{ journal: null }`; anything unreadable is reported as
 * such, never as absent.
 */
async function readSourceState({ git, readFile }) {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonDir = common.ok ? common.stdout.trim() : '';
    if (!commonDir) return { unreadable: true };
    let raw;
    try { raw = readFile(path.join(commonDir, SOURCE_UPDATE_JOURNAL_RELATIVE_PATH)); }
    catch { return { unreadable: true }; }
    if (raw === null || raw === undefined) return { journal: null };
    try {
        const journal = JSON.parse(raw);
        return journal && typeof journal === 'object' ? { journal } : { unreadable: true };
    } catch { return { unreadable: true }; }
}

/**
 * ADR-156 decision 7 (ج): a degraded reopen blocks the next update, and
 * `beginUpdate` also refuses a MANUAL or still-closed gate. Each is ONE cause
 * with ONE action; the degraded one names the source-rollback exit (H3/C2).
 */
function checkSourceState({ unreadable, journal }) {
    const code = 'source_state_unreconciled';
    if (unreadable) {
        return blocker(code,
            { ar: 'دفتر بوابة الصيانة غير مقروء، والمحدّث لا يبدأ فوق حالة لا يقرؤها.', en: 'The maintenance-gate journal cannot be read, and the updater will not start on a state it cannot read.' },
            { ar: 'افحص حالة البوابة بالطبيب ثم أعد الفحص.', en: 'Inspect the gate state with the doctor, then re-run.', command: 'npm run doctor' });
    }
    if (!journal) {
        return clear(code, { ar: 'لا دفتر صيانة: لم يجرِ تحديث على هذه العقدة بعد.', en: 'No maintenance journal: no update has run on this node yet.' });
    }
    if (typeof journal.degraded === 'string' && journal.degraded) {
        const detail = /^[a-z0-9_]{1,64}$/.test(journal.degraded) ? journal.degraded : 'degraded';
        return blocker(code,
            { ar: `أُعيد فتح العقدة على الجيل السابق وشجرة المصدر ما زالت على commit الهدف (${detail})؛ المحدّث يرفض التحديث التالي بـupdate_source_state_degraded حتى يكتمل تراجع المصدر.`, en: `The node reopened on the previous generation while the source tree still sits at the target commit (${detail}); the updater refuses the next update with update_source_state_degraded until the source rollback completes.` },
            { ar: 'أكمل تراجع المصدر بالطبيب ثم أعد الفحص.', en: 'Complete the source rollback with the doctor, then re-run.', command: SOURCE_ROLLBACK_COMMAND });
    }
    if (journal.state === 'MANUAL') {
        return blocker(code,
            { ar: 'بوابة الصيانة في حالة استرداد يدوي (MANUAL)، والمحدّث يرفض البدء منها.', en: 'The maintenance gate is in MANUAL recovery, and the updater refuses to start from it.' },
            { ar: 'أعد فتح البوابة بالطبيب بعد مراجعة سجلّه ثم أعد الفحص.', en: 'Reopen the gate with the doctor after reviewing its journal, then re-run.', command: 'npm run doctor -- --reopen-gate --yes' });
    }
    if (journal.state !== 'OPEN' || journal.gateClosed) {
        const state = /^[A-Z_]{1,32}$/.test(journal.state || '') ? journal.state : 'unknown';
        return blocker(code,
            { ar: `تحديث جارٍ بالفعل (الحالة ${state})، والمحدّث يرفض تحديثاً ثانياً فوقه.`, en: `An update is already in progress (state ${state}); the updater refuses a second one on top of it.` },
            { ar: 'انتظر اكتماله ثم أعد الفحص.', en: 'Wait for it to finish, then re-run.' });
    }
    return clear(code, { ar: 'بوابة الصيانة مفتوحة وحالة المصدر متصالحة.', en: 'The maintenance gate is open and the source state is reconciled.' });
}

function checkActiveSessions(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
        return blocker('active_sessions',
            { ar: 'حالة الجلسات الحية غير متاحة، فلا يمكن الحكم على أمان التحديث.', en: 'Active session state is unavailable, so update safety cannot be judged.' },
            { ar: 'أعد تشغيل الفحص بعد أن يستقر الخادم.', en: 'Re-run the preflight once the server is stable.' });
    }
    if (count === 0) {
        return clear('active_sessions', { ar: 'لا توجد جلسات وكيل حية.', en: 'No live agent sessions.' });
    }
    return blocker('active_sessions',
        { ar: `مؤجَّل: ${count} جلسة وكيل حية؛ التحديث لا يقتل جلسة أبداً.`, en: `Deferred: ${count} live agent session(s); the update never kills a session.` },
        { ar: 'أنهِ الجلسات الحية ثم أعد المحاولة.', en: 'Finish the live sessions, then retry.' });
}

async function checkRemote({ git, remote, source }) {
    const result = await git(['remote', 'get-url', '--all', remote]);
    if (!result.ok) {
        return blocker('remote_mismatch',
            { ar: `الريموت «${remote}» غير معرَّف في هذه الشجرة.`, en: `Remote "${remote}" is not configured in this tree.` },
            { ar: 'اضبط الريموت على مصدر الإصدار المعتمد.', en: 'Point the remote at the governed release source.', command: `git remote add ${remote} ${source.repositoryUrl}` });
    }
    const urls = result.stdout.trim().split('\n').filter(Boolean);
    if (urls.length !== 1) {
        return blocker('remote_mismatch',
            { ar: `الريموت «${remote}» يحمل ${urls.length} عنواناً، والمحدّث يشترط عنواناً واحداً.`, en: `Remote "${remote}" has ${urls.length} URLs; the updater requires exactly one.` },
            { ar: 'اجعل للريموت عنواناً واحداً هو مصدر الإصدار.', en: 'Reduce the remote to the single release-source URL.', command: `git remote set-url ${remote} ${source.repositoryUrl}` });
    }
    const runtime = normalizeGitHubRepositoryIdentity(urls[0]);
    if (!runtime) {
        return blocker('remote_mismatch',
            { ar: 'عنوان الريموت ليس عنوان GitHub خالياً من بيانات الاعتماد.', en: 'The remote URL is not a credential-free GitHub URL.' },
            { ar: 'استبدله بعنوان GitHub معتمد بلا بيانات اعتماد مضمَّنة.', en: 'Replace it with a credential-free GitHub URL.', command: `git remote set-url ${remote} ${source.repositoryUrl}` });
    }
    if (runtime.identity !== source.identity) {
        return blocker('remote_mismatch',
            { ar: `ريموت الشجرة «${runtime.identity}» يخالف مصدر الإصدار المعتمد «${source.identity}».`, en: `The tree remote "${runtime.identity}" differs from the trusted release source "${source.identity}".` },
            { ar: 'الاشتقاق في المثبّت وحده: صحّح الريموت أو صحّح NASSAJ_RELEASE_SOURCE بقرار بشري.', en: 'Derivation belongs to the installer alone: correct the remote or NASSAJ_RELEASE_SOURCE by a human decision.' });
    }
    return clear('remote_mismatch', { ar: `الريموت يطابق مصدر الإصدار «${source.identity}».`, en: `The remote matches the release source "${source.identity}".` });
}

function checkReleaseSourceLock({ readLockFile, source }) {
    let raw;
    try { raw = readLockFile(); }
    catch {
        return blocker('release_source_lock',
            { ar: 'قفل مصدر الإصدار موجود لكنه غير مقروء.', en: 'The release-source lock exists but cannot be read.' },
            { ar: `صحّح صلاحيات ${RELEASE_SOURCE_LOCK_RELATIVE_PATH} أو احذفه بقرار صريح.`, en: `Fix permissions on ${RELEASE_SOURCE_LOCK_RELATIVE_PATH} or remove it deliberately.` });
    }
    if (raw === null || raw === undefined) {
        return clear('release_source_lock', { ar: 'لا يوجد قفل مصدر إصدار مثبَّت؛ البيئة وحدها هي المرجع.', en: 'No release-source lock is installed; the environment alone is authoritative.' });
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
        return blocker('release_source_lock',
            { ar: 'محتوى قفل مصدر الإصدار ليس JSON صالحاً.', en: 'The release-source lock is not valid JSON.' },
            { ar: `أعد كتابته بالمثبّت أو احذف ${RELEASE_SOURCE_LOCK_RELATIVE_PATH}.`, en: `Rewrite it with the installer or remove ${RELEASE_SOURCE_LOCK_RELATIVE_PATH}.` });
    }
    const declared = typeof parsed?.identity === 'string' && parsed.identity
        ? { identity: parsed.identity.toLowerCase() }
        : normalizeGitHubRepositoryIdentity(parsed?.releaseSource ?? parsed?.repositoryUrl ?? '');
    if (!declared?.identity) {
        return blocker('release_source_lock',
            { ar: 'قفل مصدر الإصدار لا يحمل هوية مستودع صالحة.', en: 'The release-source lock carries no valid repository identity.' },
            { ar: 'أعد توليده بالمثبّت (WI-16) لا بيدك.', en: 'Regenerate it with the installer (WI-16) rather than by hand.' });
    }
    if (declared.identity !== source.identity) {
        return blocker('release_source_lock',
            { ar: `تعارض معلن: القفل يثبّت «${declared.identity}» والبيئة تطلب «${source.identity}»؛ التحديث معطَّل حتى يُحسم بشرياً.`, en: `Declared conflict: the lock pins "${declared.identity}" while the environment asks for "${source.identity}"; updates stay disabled until a human settles it.` },
            { ar: 'وحّد config/node.env مع القفل، ولا ترجّح أحدهما صامتاً.', en: 'Reconcile config/node.env with the lock; never pick one silently.' });
    }
    return clear('release_source_lock', { ar: `القفل يصادق على «${source.identity}».`, en: `The lock attests "${source.identity}".` });
}

async function checkFetchCapability({ networkGit, remote, source, ssh }) {
    if (ssh?.conflict) {
        // The updater refuses this before its fetch (`ssh_command_conflict`), so
        // the probe must not run the conflicting command and read green over it.
        const origin = typeof ssh.source === 'string' && ssh.source ? ssh.source : 'the ssh command';
        return {
            fetch: blocker('fetch_capability',
                { ar: `أمر ssh القادم من ${origin} يضبط ${ssh.conflict}، والمحدّث يرفض التحديث بـssh_command_conflict لأنه يشترط BatchMode=yes وStrictHostKeyChecking=yes.`, en: `The ssh command from ${origin} sets ${ssh.conflict}; the updater refuses the update with ssh_command_conflict because it requires BatchMode=yes and StrictHostKeyChecking=yes.` },
                { ar: `احذف الخيار ${ssh.conflict} من ${origin} ثم أعد الفحص.`, en: `Remove the ${ssh.conflict} option from ${origin}, then re-run.` }),
            stdout: null,
        };
    }
    const result = await networkGit(['ls-remote', '--tags', '--', remote]);
    if (result.timedOut) {
        return {
            fetch: blocker('fetch_capability',
                { ar: 'تجاوز الاتصال بمصدر الإصدار المهلة المقررة.', en: 'Contacting the release source exceeded the deadline.' },
                { ar: 'تحقّق من الشبكة والوكيل ثم أعد الفحص.', en: 'Check network and proxy reachability, then re-run.', command: `git ls-remote --tags ${remote}` }),
            stdout: null,
        };
    }
    if (!result.ok && result.hostKeyFailure) {
        // Host key POLICY, not a missing credential — and the updater's fetch runs
        // under the same StrictHostKeyChecking=yes, so it would be refused too. A
        // warning here was a false green (qa-critic H5). The remedy is the key set
        // GitHub publishes, never `ssh-keyscan`, which trusts whatever answers.
        return {
            fetch: blocker('fetch_capability',
                { ar: `رفض ssh مفتاح مضيف «${source.identity}» بسياسة StrictHostKeyChecking=yes، والمحدّث يسحب بالسياسة نفسها فسيُرفض سحبه كذلك.`, en: `ssh refused the host key for "${source.identity}" under StrictHostKeyChecking=yes; the updater fetches with the same policy, so its fetch would be refused too.` },
                { ar: 'اكتب بصمات GitHub المنشورة بالمثبّت (يقرؤها من api.github.com/meta) بحساب خدمة pm2 ثم أعد الفحص؛ لا تستعمل ssh-keyscan.', en: "Write GitHub's published host keys with the installer (it reads api.github.com/meta) as the pm2 service account, then re-run; do not use ssh-keyscan.", command: 'node scripts/install-node.mjs --node <name> --yes' }),
            stdout: null,
        };
    }
    if (!result.ok) {
        return {
            fetch: blocker('fetch_capability',
                { ar: `تعذّرت قراءة أوسمة «${source.identity}» ببيئة السحب: المستودع خاص وبيانات الاعتماد غائبة أو المفتاح غير مقبول.`, en: `Reading tags from "${source.identity}" with the fetch environment failed: the repository is private and no credential is available, or the key is rejected.` },
                { ar: 'ثبّت مفتاح نشر للقراءة فقط لحساب خدمة pm2 ثم أعد الفحص بالحساب نفسه.', en: 'Install a read-only deploy key for the pm2 service account, then re-run as that same account.', command: `git ls-remote --tags ${remote}` }),
            stdout: null,
        };
    }
    return {
        fetch: clear('fetch_capability', { ar: `بيئة السحب تقرأ «${source.identity}» فعلاً.`, en: `The fetch environment can actually read "${source.identity}".` }),
        stdout: result.stdout,
    };
}

function checkAnnotatedTag({ lsRemoteStdout, source, selectTag }) {
    if (lsRemoteStdout === null) {
        return {
            tag: warning('annotated_tag',
                { ar: 'لم يُفحص الوسم لأن الاتصال بالمصدر لم ينجح.', en: 'The tag was not inspected because the source could not be reached.' },
                { ar: 'عالج fetch_capability أولاً.', en: 'Resolve fetch_capability first.' }),
            target: null,
        };
    }
    const latest = selectTag(lsRemoteStdout);
    if (!latest) {
        return {
            tag: blocker('annotated_tag',
                { ar: `لا يوجد وسم إصدار موقّع (annotated) رباعي في «${source.identity}»؛ الأوسمة الخفيفة لا تُقبل.`, en: `No annotated four-part release tag exists in "${source.identity}"; lightweight tags are not accepted.` },
                { ar: 'انشر وسماً موقّعاً بصيغة vA.B.C.D على مستودع الإصدار.', en: 'Publish an annotated vA.B.C.D tag on the release repository.' }),
            target: null,
        };
    }
    return {
        tag: clear('annotated_tag', { ar: `أحدث وسم موقّع هو v${latest.version}.`, en: `The latest annotated tag is v${latest.version}.` }),
        target: latest,
    };
}

async function checkNonFastForward({ git, target, targetIsLocal, remote, branch }) {
    if (target && targetIsLocal) {
        const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', target.commit]);
        if (ancestor.ok) {
            return clear('non_fast_forward', { ar: `القفزة إلى v${target.version} تقدّم سريع سليم.`, en: `The jump to v${target.version} is a clean fast-forward.` });
        }
        return blocker('non_fast_forward',
            { ar: `توجد commits محلية على ${branch} تمنع التقدّم السريع إلى v${target.version}.`, en: `Local commits on ${branch} block a fast-forward to v${target.version}.` },
            { ar: 'انقل التخصيص إلى overlay الإعدادات؛ لا إصلاح آلي ولا reset --hard على تاريخ العقدة.', en: 'Move the customization into the configuration overlay; there is no automatic fix and no reset --hard on node history.' });
    }
    const trackingRef = `refs/remotes/${remote}/${branch}`;
    const tracking = await git(['rev-parse', '--verify', '--quiet', trackingRef]);
    if (!tracking.ok) {
        return warning('non_fast_forward',
            { ar: `لا مرجع تتبّع ${remote}/${branch} محلياً ولا هدف محلول، فلم يُحسم التقدّم السريع.`, en: `Neither a local ${remote}/${branch} tracking ref nor a resolved target exists, so fast-forward could not be decided.` },
            { ar: 'شغّل الفحص بعد أول سحب ناجح لمرجع التتبّع.', en: 'Re-run after the tracking ref has been fetched once.' });
    }
    const ahead = await git(['rev-list', '--count', `${trackingRef}..HEAD`]);
    const count = Number(ahead.stdout.trim());
    if (ahead.ok && Number.isSafeInteger(count) && count > 0) {
        return blocker('non_fast_forward',
            { ar: `${count} commit محلي يسبق ${remote}/${branch} ويقطع مسار التقدّم السريع.`, en: `${count} local commit(s) ahead of ${remote}/${branch} break the fast-forward path.` },
            { ar: 'انقل التخصيص إلى overlay الإعدادات؛ لا إصلاح آلي.', en: 'Move the customization into the configuration overlay; there is no automatic fix.' });
    }
    if (!ahead.ok) {
        return warning('non_fast_forward',
            { ar: 'تعذّر عدّ الـcommits المحلية أمام مرجع التتبّع.', en: 'Counting local commits ahead of the tracking ref failed.' },
            { ar: 'تحقّق من سلامة شجرة git ثم أعد الفحص.', en: 'Verify the git tree, then re-run.' });
    }
    return clear('non_fast_forward', { ar: `لا commits محلية أمام ${remote}/${branch}.`, en: `No local commits ahead of ${remote}/${branch}.` });
}

/**
 * Does the updater INSTALLED on this node still reject on untracked files?
 * Unknown versions answer yes: the pre-flight guards a jump performed by the
 * installed release's code, so it fails closed rather than clearing a node it
 * cannot identify (ADR-156 ط.1).
 */
export function untrackedFilesRejectedBy(installedVersion) {
    if (!isNassajReleaseVersion(installedVersion)) return true;
    return compareNassajReleaseVersions(installedVersion, UNTRACKED_SCOPE_NARROWED_IN) < 0;
}

async function checkDirtyWorktree({ git, target, targetIsLocal, installedVersion }) {
    const scoped = Boolean(target && targetIsLocal);
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '-z']);
    if (!status.ok) {
        return blocker('dirty_worktree',
            { ar: 'تعذّرت قراءة حالة شجرة العمل.', en: 'The working tree status could not be read.' },
            { ar: 'تحقّق من سلامة دليل .git ثم أعد الفحص.', en: 'Verify the .git directory, then re-run.', command: 'git status --porcelain=v1' });
    }
    const { tracked, untracked } = parsePorcelainStatus(status.stdout);
    const installed = installedVersion || 'unknown';
    if (!scoped) {
        // The target is unresolved — the COMMON case, because a pre-flight never
        // fetches — so the changed-path set is unknowable and the scope cannot be
        // narrowed. The jump is performed by the updater ALREADY INSTALLED here,
        // and until WI-10 ships that updater runs
        // `status --untracked-files=all` and refuses on any output. Clearing an
        // untracked file in this branch would be a false green on B-1050 itself.
        const strict = untrackedFilesRejectedBy(installedVersion);
        const offending = strict ? [...tracked, ...untracked] : tracked;
        if (offending.length === 0) {
            return clear('dirty_worktree',
                { ar: `لا تعديلات تعطّل السحب (حكمٌ على محدّث العقدة المثبَّت ${installed}${strict ? '، وهو يرفض أي ملف غير متتبَّع' : '، وهو يحصر الفحص بمسارات الإصدار'}).`, en: `Nothing blocks the fetch (judged against this node's installed updater ${installed}${strict ? ', which refuses any untracked file' : ', which scopes the check to the release paths'}).` });
        }
        const untrackedCount = strict ? untracked.length : 0;
        return blocker('dirty_worktree',
            { ar: `${offending.length} ملف يعطّل السحب${untrackedCount ? ` (منها ${untrackedCount} غير متتبَّع)` : ''}: ${list(offending)}. الهدف غير محلول محلياً فلا يمكن حصر النطاق، ومحدّث العقدة المثبَّت ${installed} يرفض بـ--untracked-files=all.`, en: `${offending.length} file(s) block the fetch${untrackedCount ? ` (${untrackedCount} untracked)` : ''}: ${listEn(offending)}. The target is not resolved locally so the scope cannot be narrowed, and this node's installed updater ${installed} refuses on --untracked-files=all.` },
            { ar: 'التزم هذه الملفات أو انقلها خارج الشجرة، أو انقل التخصيص إلى overlay الإعدادات.', en: 'Commit these files or move them out of the tree, or move the customization into the configuration overlay.', command: 'git status --porcelain=v1 --untracked-files=all' });
    }
    const diff = await git(['diff', '--name-only', '-z', `HEAD..${target.commit}`]);
    if (!diff.ok) {
        return blocker('dirty_worktree',
            { ar: `تعذّرت قراءة مسارات الفرق بين HEAD وv${target.version}.`, en: `The changed-path set between HEAD and v${target.version} could not be read.` },
            { ar: 'تحقّق من وجود commit الإصدار محلياً ثم أعد الفحص.', en: 'Confirm the release commit exists locally, then re-run.' });
    }
    const conflicting = conflictingPaths({ tracked, untracked, changed: nulFields(diff.stdout) });
    if (conflicting.length === 0) {
        return clear('dirty_worktree',
            { ar: `لا تعارض: التعديلات المحلية (${tracked.length + untracked.length}) كلها خارج المسارات التي يغيّرها v${target.version}.`, en: `No conflict: all ${tracked.length + untracked.length} local change(s) lie outside the paths v${target.version} touches.` });
    }
    return blocker('dirty_worktree',
        { ar: `${conflicting.length} ملف معدَّل يقع داخل المسارات التي يغيّرها v${target.version}: ${list(conflicting)}.`, en: `${conflicting.length} local change(s) fall inside the paths v${target.version} rewrites: ${listEn(conflicting)}.` },
        { ar: 'التزم هذه الملفات أو تراجع عنها قبل التحديث.', en: 'Commit or revert these files before updating.', command: 'git status --porcelain=v1' });
}

async function checkGitlinks({ git, target, targetIsLocal }) {
    const head = await git(['ls-files', '--stage', '-z']);
    if (!head.ok) {
        return blocker('gitlinks',
            { ar: 'تعذّرت قراءة فهرس الملفات لفحص الروابط الفرعية.', en: 'The file index could not be read to check for submodule links.' },
            { ar: 'تحقّق من سلامة شجرة git ثم أعد الفحص.', en: 'Verify the git tree, then re-run.', command: 'git ls-files --stage' });
    }
    const found = new Set(parseGitlinkPaths(head.stdout));
    let changing = [];
    // `decided` means the pre-flight compared HEAD with the release tree using
    // the updater's own policy function; `refused` means a listing failed to
    // parse, which is a diagnosis gap and never a green.
    let decided = false;
    let refused = false;
    if (target && targetIsLocal) {
        const tree = await git(['ls-tree', '-r', '-z', target.commit]);
        if (tree.ok) {
            for (const entry of parseGitlinkPaths(tree.stdout)) found.add(entry);
            const current = await git(['ls-tree', '-r', '-z', 'HEAD']);
            try {
                if (current.ok) {
                    changing = gitlinkChangePaths(parseTreeEntries(current.stdout), parseTreeEntries(tree.stdout));
                    decided = true;
                }
            } catch { refused = true; }
        }
    }
    if (found.size === 0) {
        return clear('gitlinks', { ar: 'لا روابط فرعية (gitlink) في الشجرة.', en: 'No submodule gitlinks in the tree.' });
    }
    const removeAction = (paths) => ({ ar: 'الروابط الفرعية مستبعدة معمارياً (G1): احذفها من الشجرة قبل التحديث.', en: 'Submodules are architecturally excluded (G1): remove them from the tree before updating.', command: `git rm --cached ${paths[0]}` });
    // When the release is resolved locally the pre-flight gives the exact answer
    // the preparation gate will give (WI-11): the same shared policy function,
    // over the same two trees, naming the same paths.
    if (changing.length) {
        return blocker('gitlinks',
            { ar: `v${target.version} يغيّر ${changing.length} رابطاً فرعياً (gitlink)، وبوابة التجهيز ترفضه بـgitlink_change_unsupported قبل أي بناء: ${list(changing)}.`, en: `v${target.version} changes ${changing.length} submodule gitlink(s); the preparation gate refuses it as gitlink_change_unsupported before any build: ${listEn(changing)}.` },
            removeAction(changing));
    }
    const paths = [...found];
    // The updater refuses a gitlink CHANGE, never an unchanged one — before
    // WI-11 as after it (`assertUnchangedGitlinks` compared the two entries).
    // Blocking on mere presence was a false red (qa-critic L2).
    if (decided) {
        return clear('gitlinks',
            { ar: `${paths.length} رابط فرعي (gitlink) موجود وv${target.version} لا يغيّره، والمحدّث لا يرفض إلا تغييره: ${list(paths)}.`, en: `${paths.length} submodule gitlink(s) present and v${target.version} leaves them unchanged; the updater refuses only a change: ${listEn(paths)}.` });
    }
    if (refused) {
        return blocker('gitlinks',
            { ar: `تعذّر تحليل قائمة الشجرة، فلا يُعرف إن كان الإصدار يغيّر ${paths.length} رابطاً فرعياً: ${list(paths)}.`, en: `A tree listing could not be parsed, so whether the release changes ${paths.length} submodule gitlink(s) is unknown: ${listEn(paths)}.` },
            removeAction(paths));
    }
    return warning('gitlinks',
        { ar: `${paths.length} رابط فرعي (gitlink) في الشجرة والهدف غير محلول محلياً؛ إن غيّره الإصدار رفضته بوابة التجهيز بـgitlink_change_unsupported قبل أي كتابة: ${list(paths)}.`, en: `${paths.length} submodule gitlink(s) in the tree and the target is not resolved locally; if the release changes one, the preparation gate refuses it as gitlink_change_unsupported before any write: ${listEn(paths)}.` },
        removeAction(paths));
}

function checkExchangeCapability(supported) {
    if (supported === true) {
        return clear('exchange_capability', { ar: 'الأداة mv تدعم ‎--exchange‎ و‎--no-copy‎.', en: 'mv supports --exchange and --no-copy.' });
    }
    if (supported === null) {
        return blocker('exchange_capability',
            { ar: 'تعذّر تحميل مِجَسّ التبديل الذرّي، وهو نفسه الوحدة التي تنفّذ البناء.', en: 'The atomic-exchange probe could not be loaded — the same module that performs the build.' },
            { ar: 'ثبّت اعتماديات التطوير (npm install --include=dev) ثم أعد الفحص.', en: 'Install the dev dependencies (npm install --include=dev), then re-run.' });
    }
    return blocker('exchange_capability',
        { ar: 'الأداة mv لا تدعم ‎--exchange --no-copy‎، والتفعيل يشغّلها بلا بديل.', en: 'mv lacks --exchange --no-copy, and activation runs it with no fallback.' },
        { ar: 'ثبّت GNU coreutils 9 فأحدث على هذه العقدة.', en: 'Install GNU coreutils 9 or newer on this node.', command: 'mv --help | grep -- --exchange' });
}

function realOrResolved(target) {
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/**
 * Does PM2 start what this git checkout's layout requires (plan أ.3, qa-critic
 * M2)? The governed activation ends in `pm2 restart`, which restarts whatever
 * script PM2 already holds: a release-entry script on a git node, or a cwd of
 * `config/`, turns a clean update into a node that never comes back (C3).
 * The rule is `scripts/lib/pm2-install-layout.cjs`, shared with the installer.
 */
function checkPm2Entry({ processes, appRoot, env }) {
    const code = 'pm2_entry';
    if (!Array.isArray(processes)) {
        return warning(code,
            { ar: 'قائمة عمليات pm2 غير مقروءة من هذا السياق، فلم يُتحقَّق من مدخل العملية.', en: 'The pm2 process list is not readable from this context, so the process entry was not verified.' },
            { ar: 'شغّل الفحص بحساب خدمة pm2 وعفريته قيد التشغيل.', en: 'Run the preflight as the pm2 service account while its daemon is running.', command: 'pm2 jlist' });
    }
    const name = env.NASSAJ_PROCESS_NAME || env.PROC_NAME || 'nassaj-dev';
    // Inside the supervised process pm2 exports its own pm_id; that identifies
    // THIS process even when several apps share a name.
    const app = (env.pm_id !== undefined && processes.find((entry) => String(entry.pmId) === String(env.pm_id)))
        || processes.find((entry) => entry.name === name);
    const regenerate = { ar: 'أعد توليد ملف ecosystem بـscripts/install-node.mjs (نمط git) وشغّل pm2 منه.', en: 'Regenerate the ecosystem with scripts/install-node.mjs (git layout) and start PM2 from it.', command: 'node scripts/install-node.mjs --node <name> --yes' };
    if (!app) {
        return warning(code,
            { ar: `لا عملية pm2 باسم «${name}»، فلم يُتحقَّق من مدخلها.`, en: `No pm2 process named "${name}", so its entry was not verified.` },
            regenerate);
    }
    const expected = expectedPm2Entry({ layout: GIT_CHECKOUT_LAYOUT, appRoot });
    if (typeof app.script === 'string' && path.basename(app.script) === 'pm2-entry.mjs') {
        return blocker(code,
            { ar: `pm2 يشغّل «${app.name}» من مدخل الإصدار المختوم ${app.script}، وهو لا يُقلع إلا مخزن artifact-runtime-v2؛ على شجرة git هذه لن تُقلع العملية بعد إعادة التشغيل المحكومة.`, en: `pm2 starts "${app.name}" from the sealed-release entry ${app.script}, which boots only an artifact-runtime-v2 store; on this git checkout the governed restart would start nothing.` },
            regenerate);
    }
    if (!app.script || realOrResolved(app.script) !== realOrResolved(expected.script)) {
        return blocker(code,
            { ar: `pm2 يشغّل «${app.name}» من ${app.script || 'مسار مجهول'}، وشجرة git هذه يجب أن تشغّل ${expected.script}.`, en: `pm2 runs "${app.name}" from ${app.script || 'an unknown path'}; this git checkout must run ${expected.script}.` },
            regenerate);
    }
    if (!app.cwd || realOrResolved(app.cwd) !== realOrResolved(appRoot)) {
        return blocker(code,
            { ar: `دليل عمل «${app.name}» في pm2 هو ${app.cwd || 'غير معروف'} لا جذر التطبيق ${appRoot}، فيُقرأ .env وفحص حساب الخدمة من دليل آخر.`, en: `pm2 runs "${app.name}" with cwd ${app.cwd || 'unknown'}, not the app root ${appRoot}, so .env and the service-account check resolve against another directory.` },
            regenerate);
    }
    return clear(code, { ar: `pm2 يشغّل «${app.name}» من ${expected.script} بجذر التطبيق دليلاً للعمل.`, en: `pm2 runs "${app.name}" from ${expected.script} with the app root as cwd.` });
}

/**
 * The pm2 process list, reduced to the four fields `pm2_entry` reads — `jlist`
 * also carries every process environment, which never leaves this function.
 *
 * `pm2 jlist` SPAWNS a daemon when none is listening: a write this read-only
 * diagnosis must never cause. Only a daemon whose pid file names a live
 * process is asked; otherwise the answer is null ("not readable").
 */
export async function defaultListPm2Processes({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const home = env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2');
    let pid;
    try { pid = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim()); } catch { return null; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    const stdout = await new Promise((resolve) => {
        execFile('pm2', ['jlist'], { env, timeout: timeoutMs, maxBuffer: PM2_LIST_LIMIT, encoding: 'utf8' },
            (error, output) => resolve(error ? null : output));
    });
    if (typeof stdout !== 'string') return null;
    try {
        // pm2 may print a version banner before the JSON document.
        const list = JSON.parse(stdout.slice(stdout.indexOf('[')));
        if (!Array.isArray(list)) return null;
        return list.map((entry) => ({
            name: entry?.name ?? null,
            pmId: entry?.pm_id ?? entry?.pm2_env?.pm_id ?? null,
            script: entry?.pm2_env?.pm_exec_path ?? null,
            cwd: entry?.pm2_env?.pm_cwd ?? null,
        }));
    } catch { return null; }
}

/**
 * Orphaned restart rows only.
 *
 * A queued `safe-restart` bound to a FINISHED update job is the B-1056 shape:
 * the updater will queue its next row under the CANDIDATE build fingerprint and
 * `supersedeOtherGenerations` will meet this leftover. A row carrying the build
 * currently running is NOT evidence of anything — that is exactly the shape of a
 * legitimate operator safe-restart request from the command board, and treating
 * it as stale raised a blocker on every one of them.
 *
 * It is a WARNING, not a blocker: the settlement is a write, it belongs to
 * `queueSourceUpdateRestart` under the write contract, and the update path
 * performs it on its own. It is surfaced in `repairs` so the caller knows what
 * that path will clean up.
 */
function checkStaleRestartRow({ rows, isJobLive }) {
    if (!Array.isArray(rows)) {
        return warning('stale_restart_row',
            { ar: 'صفوف إعادة التشغيل غير متاحة للفحص من هذا السياق.', en: 'The restart queue is not readable from this context.' },
            { ar: 'شغّل الفحص من الخادم الحي لقراءة الصفوف.', en: 'Run the preflight from the live server to read the queue.' });
    }
    const orphaned = rows.filter((row) => row?.sourceUpdateJobId && !isJobLive(row.sourceUpdateJobId));
    if (orphaned.length === 0) {
        return clear('stale_restart_row', { ar: `لا صفوف إعادة تشغيل يتيمة (${rows.length} صفاً قيد الانتظار).`, en: `No orphaned restart rows (${rows.length} row(s) queued).` });
    }
    return finding('stale_restart_row', 'warn',
        { ar: `${orphaned.length} صفّ إعادة تشغيل مرتبط بمهمة تحديث منتهية: ${list(orphaned.map((row) => row.id))}.`, en: `${orphaned.length} restart row(s) bound to a finished update job: ${listEn(orphaned.map((row) => row.id))}.` },
        { ar: 'تشخيص فقط: يسوّيها مسار التحديث بـsupersede تحت عقد الكتابة، أو أسقِطها من لوحة الأوامر.', en: 'Diagnosis only: the update path supersedes them under the write contract, or dismiss them from the command board.' },
        true);
}

/** Parse a `KEY=value` env file's text into a plain object (no process.env mutation). */
export function parseEnvText(text) {
    const out = {};
    if (typeof text !== 'string') return out;
    for (const line of text.split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
}

/** Read and parse `config/node-overlay.json`, or null when absent; malformed throws. */
function readOverlayConfig(readFile, appRoot) {
    let raw;
    try { raw = readFile(path.join(appRoot, 'config', 'node-overlay.json')); }
    catch { return { unreadable: true }; }
    if (raw === null || raw === undefined) return { absent: true };
    return { config: parseNodeOverlay(raw) }; // throws OverlayConfigError on a bad file
}

/**
 * `node_overlay_invalid` (contract §3.1 point 8, §6): a corrupt config or seal
 * manifest disables the overlay — a WARNING, since the server still boots and
 * the overlay is decoration. Absent config is simply "no overlay".
 */
function checkNodeOverlayConfig({ readFile, appRoot, statPath = defaultStatPath, euid = (typeof process.geteuid === 'function' ? process.geteuid() : -1) }) {
    const code = 'node_overlay_invalid';
    const reseal = { ar: 'صحّح الملف المسمّى ثم أعد ختم overlay بالطبيب بامتياز المالك.', en: 'Fix the named file, then re-seal the overlay with the doctor under owner privilege.', command: 'sudo npm run doctor -- --seal-overlay' };
    let parsed;
    try { parsed = readOverlayConfig(readFile, appRoot); }
    catch (err) {
        return warning(code,
            { ar: `overlay الإعدادات معطَّل: الحقل ${err.field || 'config'} — ${err.message}.`, en: `The configuration overlay is disabled: field ${err.field || 'config'} — ${err.message}.` },
            reseal);
    }
    if (parsed.unreadable) {
        return warning(code,
            { ar: 'config/node-overlay.json موجود لكنه غير مقروء، فعُطِّل overlay.', en: 'config/node-overlay.json exists but is unreadable, so the overlay is disabled.' },
            reseal);
    }
    if (parsed.absent) return clear(code, { ar: 'لا overlay إعدادي على هذه العقدة.', en: 'No configuration overlay on this node.' });
    if (parsed.config.static.length === 0) return clear(code, { ar: 'overlay الإعدادات موجود بلا نقاط تحميل.', en: 'The configuration overlay is present with no mounts.' });
    let lockRaw;
    try { lockRaw = readFile(path.join(appRoot, 'config', 'node-overlay.lock.json')); }
    catch { lockRaw = undefined; }
    if (lockRaw === null || lockRaw === undefined) {
        return warning(code,
            { ar: `overlay يعلن ${parsed.config.static.length} نقطة تحميل بلا بيان ختم؛ لا يُخدم شيء حتى يُختم.`, en: `The overlay declares ${parsed.config.static.length} mount(s) with no seal manifest; nothing is served until it is sealed.` },
            reseal);
    }
    try {
        const lock = JSON.parse(lockRaw);
        if (lock === null || typeof lock !== 'object' || lock.files === null || typeof lock.files !== 'object' || Array.isArray(lock.files)) {
            throw new Error('the seal manifest carries no "files" object');
        }
    } catch (err) {
        return warning(code,
            { ar: `بيان ختم overlay تالف: ${err.message}.`, en: `The overlay seal manifest is corrupt: ${err.message}.` },
            reseal);
    }
    // E1 (qa-critic): config/, config/overlay/ and every mounted dir must be
    // un-writable by the service account (uid !== euid && no group/other write) —
    // a writable container lets the service rename the root-owned manifest or a
    // sealed file aside and drop its own, so sealing the files alone is not enough.
    // mountNodeOverlay disables the overlay on this; the pre-flight surfaces the
    // same finding. A stat that cannot be read is skipped (the server-side check
    // is authoritative); only a definite writable directory is a finding.
    const configDirPath = path.join(appRoot, 'config');
    const overlayRootPath = path.join(configDirPath, 'overlay');
    const dirsToCheck = [
        ['config/', configDirPath],
        ['config/overlay/', overlayRootPath],
        ...parsed.config.static.map(({ mount, dir }) => [`config/overlay/${dir} (${mount})`, path.join(overlayRootPath, dir)]),
    ];
    for (const [label, dirPath] of dirsToCheck) {
        const stat = statPath(dirPath);
        if (stat && !(stat.uid !== euid && (stat.mode & 0o022) === 0)) {
            return warning(code,
                { ar: `دليل overlay «${label}» قابل للكتابة من حساب الخدمة، فيمكنه استبدال البيان أو ملفاً مختوماً؛ overlay معطَّل حتى يملكه root بلا صلاحية كتابة للمجموعة/الآخرين.`, en: `The overlay directory "${label}" is writable by the service account, so it can swap the manifest or a sealed file; the overlay is disabled until it is root-owned with no group/other write bit.` },
                reseal);
        }
    }
    return clear(code, { ar: `overlay مختوم بـ${parsed.config.static.length} نقطة تحميل.`, en: `The overlay is sealed with ${parsed.config.static.length} mount(s).` });
}

/**
 * `node_overlay_mount_conflict` (contract §3.1, §6): the target release takes
 * precedence over the customization, so if it tracks anything under an overlay
 * mount the update is refused BEFORE the build. Only decidable when the release
 * commit is resolved locally; otherwise a warning.
 */
async function checkNodeOverlayMountConflict({ git, readFile, appRoot, target, targetIsLocal }) {
    const code = 'node_overlay_mount_conflict';
    let parsed;
    try { parsed = readOverlayConfig(readFile, appRoot); }
    catch { return clear(code, { ar: 'overlay الإعدادات معطَّل (يُبلَّغ عنه في node_overlay_invalid)، فلا يُفحص تعارض التحميل.', en: 'The overlay is disabled (reported under node_overlay_invalid), so mount conflict is not checked.' }); }
    if (parsed.absent || parsed.unreadable || parsed.config.static.length === 0) {
        return clear(code, { ar: 'لا نقاط تحميل overlay فعّالة، فلا تعارض.', en: 'No active overlay mounts, so no conflict.' });
    }
    if (!target || !targetIsLocal) {
        return warning(code,
            { ar: 'الإصدار الهدف غير محلول محلياً، فلم يُحسم تعارض نقاط التحميل مع مساراته المتتبَّعة.', en: 'The target release is not resolved locally, so a conflict between the mounts and its tracked paths was not decided.' },
            { ar: 'أعد الفحص بعد توفّر commit الإصدار محلياً.', en: 'Re-run once the release commit is available locally.' });
    }
    const conflicts = [];
    for (const { mount } of parsed.config.static) {
        const seg = mount.slice(1);
        const tree = await git(['ls-tree', '-r', '--name-only', '-z', target.commit, '--', `public/${seg}/`]);
        if (tree.ok && nulFields(tree.stdout).length > 0) conflicts.push(mount);
    }
    if (conflicts.length === 0) {
        return clear(code, { ar: `v${target.version} لا يتتبّع أي مسار تحت نقاط تحميل overlay.`, en: `v${target.version} tracks nothing under the overlay mounts.` });
    }
    return blocker(code,
        { ar: `v${target.version} يتتبّع مسارات تحت نقطة تحميل overlay (${list(conflicts)})؛ الإصدار يتقدّم على التخصيص فيُرفض التحديث قبل البناء.`, en: `v${target.version} tracks paths under overlay mount(s) (${listEn(conflicts)}); the release takes precedence over the customization, so the update is refused before the build.` },
        { ar: 'غيّر قيمة mount في config/node-overlay.json إلى مقطع لا يتتبّعه الإصدار ثم أعد الختم.', en: 'Change the mount in config/node-overlay.json to a segment the release does not track, then re-seal.', command: 'sudo npm run doctor -- --seal-overlay' });
}

/**
 * `node_env_not_loaded` (contract §3.4, M12): "loaded" means the LIVE process's
 * ACTUAL environment, NOT the merged serviceEnv (that green is the false green
 * that hid the Rukhaimi TMPDIR puzzle). An allowlisted key declared in
 * `config/node.env` that is absent or different in the live env is a blocker:
 * The in-process API supplies its effective environment after node.env loads.
 * External diagnosis can observe only exec-time values through /proc or PM2.
 * Only key NAMES are surfaced, never values. An unreadable environment is
 * "unverifiable" (warning), never green.
 */
function checkNodeEnvLoaded({ configEnv, liveEnv, allowlist = NODE_ENV_ALLOWLIST }) {
    const code = 'node_env_not_loaded';
    const declared = allowlist.filter((key) => typeof configEnv?.[key] === 'string' && configEnv[key].length > 0);
    if (declared.length === 0) {
        return clear(code, { ar: 'لا مفاتيح مسموحة معلنة في config/node.env تحتاج تحققاً.', en: 'No allowlisted keys declared in config/node.env to verify.' });
    }
    if (liveEnv === null || liveEnv === undefined) {
        return warning(code,
            { ar: 'تعذّرت قراءة البيئة الفعلية للعملية الحيّة (pm2 / ‏/proc)، فتحميل config/node.env غير قابل للتحقق.', en: 'The live process\'s actual environment (pm2 / /proc) could not be read, so config/node.env loading is unverifiable.' },
            { ar: 'شغّل الفحص بحساب خدمة pm2 وعفريته قيد التشغيل.', en: 'Run as the pm2 service account with its daemon running.', command: 'pm2 jlist' });
    }
    const mismatched = declared.filter((key) => liveEnv[key] !== configEnv[key]);
    if (mismatched.length === 0) {
        return clear(code, { ar: `المفاتيح المسموحة (${list(declared)}) محمَّلة فعلاً في العملية الحيّة.`, en: `The allowlisted keys (${listEn(declared)}) are actually loaded in the live process.` });
    }
    return blocker(code,
        { ar: `مفتاح مسموح (${list(mismatched)}) معلن في config/node.env لكنه غائب أو مختلف في البيئة المرصودة.`, en: `An allowlisted key (${listEn(mismatched)}) is declared in config/node.env but is absent or different in the observed environment.` },
        { ar: 'تحقق من نافذة التحديث داخل التطبيق. عند غياب المفتاح حمّل الإعداد عبر إعادة التشغيل الآمنة بعد انتهاء الجلسات؛ وعند تعارضه مع بيئة مدير العملية عالج التعارض بإجراء إعداد محكوم ثم أعد الفحص.', en: 'Check readiness in the application update dialog. If the key is absent, load the configuration through the governed safe restart when idle; if the process manager sets a conflicting value, resolve it through the governed configuration procedure and check again.' });
}

/**
 * Classify the local divergence for `details.divergence` on `non_fast_forward`
 * (M9). Uses the shared W2 classifier over `merge-base(HEAD, target)..HEAD`; a
 * pure diagnosis, so any git failure yields null and the message stays as-is.
 */
async function computeDivergence({ git, target }) {
    if (!target?.commit) return null;
    const mergeBaseResult = await git(['merge-base', 'HEAD', target.commit]);
    const mergeBase = mergeBaseResult.ok ? mergeBaseResult.stdout.trim() : '';
    if (!mergeBase) return null;
    const nameStatus = await git(['diff', '--name-status', '-z', `${mergeBase}..HEAD`]);
    if (!nameStatus.ok) return null;
    const targetTree = await git(['ls-tree', '-r', '--name-only', '-z', target.commit]);
    const targetTrackedPaths = targetTree.ok ? nulFields(targetTree.stdout) : [];
    const numstat = await git(['diff', '--numstat', '-z', `${mergeBase}..HEAD`, '--', '.gitignore']);
    let gitignoreAddedOnly = false;
    if (numstat.ok) {
        const record = numstat.stdout.split('\0').find(Boolean);
        const columns = record ? /^(\d+|-)\t(\d+|-)\t/.exec(record) : null;
        if (columns && columns[2] === '0') gitignoreAddedOnly = true;
    }
    let packages = [];
    try {
        const basePkg = await git(['show', `${mergeBase}:package.json`]);
        const headPkg = await git(['show', 'HEAD:package.json']);
        if (basePkg.ok && headPkg.ok) {
            packages = diffDependencyVersions(JSON.parse(basePkg.stdout), JSON.parse(headPkg.stdout));
        }
    } catch { packages = []; }
    return classifyDivergence({ nameStatusZ: nameStatus.stdout, targetTrackedPaths, gitignoreAddedOnly, packages });
}

/**
 * The LIVE process's actual environment, restricted to the allowlist keys. Reads
 * `/proc/<pid>/environ` when possible (exec-time values only) and falls
 * back to the saved `pm2_env.env`. Values never leave except back to the caller
 * for a NAME-only comparison. Never spawns a pm2 daemon (read-only diagnosis).
 */
export async function defaultReadLiveProcessEnv({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, allowlist = NODE_ENV_ALLOWLIST } = {}) {
    const home = env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2');
    let pid;
    try { pid = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim()); } catch { return null; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    const stdout = await new Promise((resolve) => {
        execFile('pm2', ['jlist'], { env, timeout: timeoutMs, maxBuffer: PM2_LIST_LIMIT, encoding: 'utf8' },
            (error, output) => resolve(error ? null : output));
    });
    if (typeof stdout !== 'string') return null;
    let processes;
    try {
        processes = JSON.parse(stdout.slice(stdout.indexOf('[')));
        if (!Array.isArray(processes)) return null;
    } catch { return null; }
    const name = env.NASSAJ_PROCESS_NAME || env.PROC_NAME || 'nassaj-dev';
    const app = (env.pm_id !== undefined
        && processes.find((entry) => String(entry?.pm2_env?.pm_id ?? entry?.pm_id) === String(env.pm_id)))
        || processes.find((entry) => entry?.name === name);
    if (!app) return null;
    const appPid = Number(app.pid ?? app?.pm2_env?.pid);
    let source = null;
    if (Number.isSafeInteger(appPid) && appPid > 0) {
        try {
            const raw = fs.readFileSync(`/proc/${appPid}/environ`, 'utf8');
            source = {};
            for (const pair of raw.split('\0')) {
                const eq = pair.indexOf('=');
                if (eq > 0) source[pair.slice(0, eq)] = pair.slice(eq + 1);
            }
        } catch { source = null; }
    }
    if (!source && app?.pm2_env?.env && typeof app.pm2_env.env === 'object') source = app.pm2_env.env;
    if (!source) return null;
    const out = {};
    for (const key of allowlist) out[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
    return out;
}

// --- orchestration ---------------------------------------------------------

/**
 * Run the read-only checks and return `{ ok, checks, repairs, blocker }`.
 * `blocker` is the single highest-priority failure in `PREFLIGHT_CODES` order,
 * shaped for the endpoint contract of plan أ.5.
 */
export async function runUpdatePreflightChecks({
    appRoot,
    env = process.env,
    remote = env.NASSAJ_UPDATE_REMOTE || 'origin',
    branch = env.NASSAJ_UPDATE_BRANCH || 'main',
    timeoutMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    git = null,
    networkGit = null,
    activeSessionCount = () => 0,
    exchangeProbe = defaultExchangeProbe,
    readLockFile = null,
    listQueuedSafeRestarts = () => null,
    isSourceUpdateJobLive = () => false,
    listPm2Processes = () => defaultListPm2Processes({ env, timeoutMs }),
    readLiveProcessEnv = () => defaultReadLiveProcessEnv({ env, timeoutMs }),
    resolveSsh = () => resolveGovernedSshCommand({ env, appRoot }),
    source = resolveReleaseSource(env),
    selectTag = selectLatestAnnotatedReleaseTag,
    installedVersion = null,
    readFile = defaultReadFile,
    statPath = defaultStatPath,
    euid = (typeof process.geteuid === 'function' ? process.geteuid() : -1),
    exists = isPresent,
} = {}) {
    if (!appRoot) throw new TypeError('Update preflight requires appRoot');
    // Built once, lazily: composing the governed ssh command reads the
    // repository's core.sshCommand, which an injected `git` never needs.
    let fetchEnvironment = null;
    const governedEnvironment = () => (fetchEnvironment ??= releaseFetchEnvironment(env, { appRoot }));
    const localGit = git || ((args) => runGitRead({ appRoot, args, env: governedEnvironment(), timeoutMs }));
    const remoteGit = networkGit || localGit;
    const lockReader = readLockFile || (() => readFile(path.join(appRoot, RELEASE_SOURCE_LOCK_RELATIVE_PATH)));
    const installed = installedVersion !== null
        ? installedVersion
        : readInstalledVersion(appRoot, readFile);

    if (!exists(path.join(appRoot, '.git'))) {
        const stop = blocker('unsupported_install_mode',
            { ar: 'هذه ليست شجرة مصدر git، والمحدّث المحكوم يشترطها.', en: 'This is not a git source tree, which the governed updater requires.' },
            { ar: 'أعد التثبيت من مصدر git أو استعمل مسار الإصدار المُدار.', en: 'Reinstall from a git source, or use the managed release path.' });
        return { ok: false, checks: [stop], repairs: [], blocker: shapeBlocker(stop) };
    }

    let sessions;
    try { sessions = activeSessionCount(); } catch { sessions = NaN; }

    const checks = new Map();
    checks.set('source_state_unreconciled', checkSourceState(await readSourceState({ git: localGit, readFile })));
    checks.set('active_sessions', checkActiveSessions(sessions));
    checks.set('remote_mismatch', await checkRemote({ git: localGit, remote, source }));
    checks.set('release_source_lock', checkReleaseSourceLock({ readLockFile: lockReader, source }));

    let ssh;
    try { ssh = resolveSsh(); } catch { ssh = null; }
    const { fetch, stdout } = await checkFetchCapability({ networkGit: remoteGit, remote, source, ssh });
    checks.set('fetch_capability', fetch);
    const { tag, target } = checkAnnotatedTag({ lsRemoteStdout: stdout, source, selectTag });
    checks.set('annotated_tag', tag);

    // A preflight never fetches, so the release commit is usable for the scoped
    // checks only when it already exists in the local object database.
    const targetIsLocal = target
        ? (await localGit(['rev-parse', '--verify', '--quiet', `${target.commit}^{commit}`])).ok
        : false;

    const nonFastForward = await checkNonFastForward({ git: localGit, target, targetIsLocal, remote, branch });
    // Attach `details.divergence` (M9) only when the release is local and the jump
    // is actually blocked: this changes the text, never the code or severity.
    let divergence = null;
    if (nonFastForward.severity === 'blocker' && target && targetIsLocal) {
        try { divergence = await computeDivergence({ git: localGit, target }); } catch { divergence = null; }
    }
    checks.set('non_fast_forward', divergence ? withDetails(nonFastForward, { divergence }) : nonFastForward);
    checks.set('node_overlay_mount_conflict', await checkNodeOverlayMountConflict({ git: localGit, readFile, appRoot, target, targetIsLocal }));
    checks.set('dirty_worktree', await checkDirtyWorktree({ git: localGit, target, targetIsLocal, installedVersion: installed }));
    checks.set('gitlinks', await checkGitlinks({ git: localGit, target, targetIsLocal }));

    let exchangeSupported = null;
    try { exchangeSupported = await exchangeProbe(); } catch { exchangeSupported = null; }
    checks.set('exchange_capability', checkExchangeCapability(exchangeSupported));

    let processes;
    try { processes = await listPm2Processes(); } catch { processes = null; }
    checks.set('pm2_entry', checkPm2Entry({ processes, appRoot, env }));

    // `node_env_not_loaded` reads the LIVE process env, but only when an
    // allowlisted key is actually declared — so a node without one never spawns
    // the pm2 read (M12).
    let configEnv = {};
    try { configEnv = parseEnvText(readFile(path.join(appRoot, 'config', 'node.env'))); } catch { configEnv = {}; }
    const declaresAllowlisted = NODE_ENV_ALLOWLIST.some((key) => typeof configEnv[key] === 'string' && configEnv[key].length > 0);
    let liveEnv = null;
    if (declaresAllowlisted) {
        try { liveEnv = await readLiveProcessEnv(); } catch { liveEnv = null; }
    }
    checks.set('node_env_not_loaded', checkNodeEnvLoaded({ configEnv, liveEnv }));

    checks.set('node_overlay_invalid', checkNodeOverlayConfig({ readFile, appRoot, statPath, euid }));

    checks.set('stale_restart_row', checkStaleRestartRow({
        rows: listQueuedSafeRestarts(), isJobLive: isSourceUpdateJobLive,
    }));

    const ordered = PREFLIGHT_CODES.map((code) => checks.get(code));
    const first = ordered.find((check) => check.severity === 'blocker') || null;
    return {
        ok: !first,
        installedVersion: installed,
        target: target ? { version: target.version, commit: target.commit, local: targetIsLocal } : null,
        checks: ordered,
        repairs: ordered.filter((check) => check.severity !== 'ok' && check.autoFixable).map((check) => check.code),
        blocker: first ? shapeBlocker(first) : null,
    };
}

/** The `{ code, ar, en, action: { ar, en, command } }` blocker shape of plan أ.5. */
export function shapeBlocker(check) {
    return {
        code: check.code,
        ar: check.reason_ar,
        en: check.reason_en,
        action: { ar: check.action_ar, en: check.action_en, command: check.command },
        ...(check.details ? { details: check.details } : {}),
    };
}

/**
 * The same `supportsAtomicExchange()` the atomic build scripts run, reused not
 * rewritten (plan أ.3). It lives in its own leaf module so importing it here
 * does not drag the TypeScript compiler into the server process, which on a
 * release node with pruned devDependencies would make this a permanent blocker
 * (ADR-156 م-2).
 */
export async function defaultExchangeProbe() {
    return supportsAtomicExchange();
}
