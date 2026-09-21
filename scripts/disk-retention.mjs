#!/usr/bin/env node
// T-1686 — أداة استبقاء بقايا القرص داخل جذر نسّاج ديف.
//
// الوضع الافتراضي `--dry-run`: تخطيط وطباعة فقط. `--apply` وحده يتصرّف، وحتى هو
// **لا يحذف مباشرة**: ينقل إلى حجْر `.retention-trash/<ts>/` في جذر المشروع، ولا
// يُمحى الحجْر إلا في تشغيل لاحق بعد مرور مهلة الاسترداد. فأي خطأ في السياسة قابل
// للتراجع خلال يوم كامل.
//
// **حماية البادئات المستخرجة من الكود تخفيف لا سياسة (ج-13):** ماسح المراجع يلتقط
// ما ذُكر اسمه حرفياً في الشجرة، ولا يرى اسماً يُركَّب وقت التشغيل ولا يُقرأ من إعداد
// ولا يصل من وكيل. فهو يقلّل الخطأ ولا ينفيه؛ الضمانة الحقيقية هي الحجْر ونافذة
// الاسترداد، لا اكتمال هذه القائمة.
//
// الأداة لا تكتب شيئاً خارج جذر المشروع، ولا تستعمل `/tmp` ولا tmpfs، ولا تثبّت
// ولا تفعّل أي وحدة systemd (وحدات `ops/nassaj-disk-retention.*` تُثبّت يدوياً).
//
// الاستعمال:
//   node scripts/disk-retention.mjs                     # خطة فقط (افتراضي)
//   node scripts/disk-retention.mjs --apply
//   node scripts/disk-retention.mjs --apply --max-delete-bytes 8G
//   node scripts/disk-retention.mjs --json
//
// التقارير في `.artifacts/retention-reports/` على مرحلتين: `<ts>-plan.json` قبل
// أول تصرّف، و`<ts>-applied.jsonl` سطراً بسطر أثناءه، و`<ts>-applied.json` بعده.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const GIB = 1024 ** 3;
// عيّنة المحميّ المُضمَّنة في التقرير (التقارير لها استبقاؤها الذاتي، لا تُترك تتضخّم).
const RETAINED_SAMPLE = 25;
// تُسجَّل في مانيفست كل دفعة حجْر، فيُعرف أي إصدار من السياسة أنتج الدفعة.
export const TOOL_VERSION = 'disk-retention/3';

// نمط بقايا الانهيار. **مصدره الوحيد** `scripts/check-crash-artifacts.mjs:13`.
// لا يمكن استيراده: ذلك الملف سكربت ذو أثر جانبي (يمسح الشجرة ويطبع ويضبط exit code)
// بلا أي export. لذا يُنسخ هنا، ويحرس `disk-retention.test.mjs` تطابقهما نصّياً
// فينكسر الاختبار فور انحراف أحدهما عن الآخر.
export const CRASH_ARTIFACT = /^(?:core(?:\.\d+)?|.*\.core)$/;
export const CRASH_ARTIFACT_SOURCE = 'scripts/check-crash-artifacts.mjs';

/* ------------------------------------------------------------------ *
 * السياسة الثابتة — مصدر الحقيقة الوحيد لما يُحجَر وما لا يُمسّ.
 * ------------------------------------------------------------------ */
export const POLICY = Object.freeze({
    projectName: 'nassaj',

    artifacts: Object.freeze({
        dir: '.artifacts',
        maxAgeMs: 14 * DAY_MS,
        // سقف إجمالي على حجم `.artifacts` كله؛ عند تجاوزه يُجمع الأقدم أولاً
        // ومن المرشّحين وحدهم — المحميّ لا يدخل الجمع ولو بقي السقف متجاوَزاً.
        capBytes: 4 * GIB,
        // مهلة إعفاء من قاعدة السقف وحدها: ما دون يومين لا تمسّه إلا قاعدة العمر.
        capGraceMs: 2 * DAY_MS,
        // حارس بناء جارٍ: شجرة لُمست خلال هذه المدة تُترك ولو طابقت المرشّحين.
        activeBuildWindowMs: 6 * HOUR_MS,
        activeBuildMarker: '.build-in-progress',
        // المرشّحون: مجلدات فقط (الملفات المفردة خارج هذه السياسة عمداً).
        candidatePatterns: Object.freeze([
            /^local-forward-build-/,
            /^local-activation-build-/,
            /^fleet8-/,
            /^release-/,
            /^release8-/,
            /^b[0-9]+-.*-cold-extracted$/,
            /^b[0-9]+-candidate-/,
            /^codex-quota-candidate-/,
        ]),
        // استثناءات مطلقة لا تُجمع مهما بلغ العمر أو الحجم.
        absoluteKeep: Object.freeze([
            /^b896-retention-.*\.json$/,
            /^incidents$/,
            /^b979-database-snapshots$/,
            // أدلّة إصدار محتملة لا مخبأ بناء — تبقى بانتظار قرار المالك (بند 3).
            /^release-node-/,
            /^release-pm2-/,
        ]),
        referenceScanDirs: Object.freeze([
            'tests', 'server', 'scripts', 'src', 'ops', 'automation',
            'docs', '.github', 'shared',
            // Deployment-specific extra dirs (e.g. a governance overlay) come from
            // the environment so no operator layout is baked into the published tree.
            ...(process.env.NASSAJ_EXTRA_REFERENCE_SCAN_DIRS
                ? process.env.NASSAJ_EXTRA_REFERENCE_SCAN_DIRS.split(',').map((d) => d.trim()).filter(Boolean)
                : []),
        ]),
        referenceScanIncludes: Object.freeze([
            '*.mjs', '*.js', '*.cjs', '*.ts', '*.tsx', '*.jsx',
            '*.py', '*.sh', '*.yml', '*.yaml', '*.md', '*.json',
        ]),
        referencePattern: String.raw`\.artifacts/[A-Za-z0-9_.-]+`,
    }),

    // الحجْر في **جذر المشروع** لا داخل `.artifacts` (ج-1): وجوده هناك كان يضخّم
    // إجمالي `.artifacts` فيغذّي السقف بما جُمع لأجل السقف نفسه — حلقة تجعل كل
    // تشغيل يجمع أكثر. وهو في `neverTouch` فلا يبلغه إلا مسار الحجْر المصرَّح به.
    quarantine: Object.freeze({
        dir: '.retention-trash',
        // لا يُمحى حجْر قبل مرور هذه المهلة: نافذة استرداد يدوي كاملة.
        purgeAfterMs: DAY_MS,
        manifest: 'manifest.json',
        manifestSchema: 'nassaj-disk-retention-quarantine/v1',
        lock: '.lock',
    }),
    reports: Object.freeze({
        dir: 'retention-reports',
        keep: 30,
    }),

    // قواطع أمان: سقف حجم الدفعة الواحدة وعددها. التجاوز **لا يرفض التشغيل** (ج-2)
    // بل يجمع الأقدم حتى الحدّ ويؤجّل الباقي إلى الغد مع إبلاغ صريح — الرفض الكلي
    // المتكرر يومياً يصير ضجيجاً يُتجاهَل، ولا يُنقص القرص بايتاً واحداً.
    breakers: Object.freeze({
        maxDeleteBytes: 6 * GIB,
        maxDeleteCount: 20,
    }),

    backups: Object.freeze({
        dir: '.backups',
        maxAgeMs: 30 * DAY_MS,
        // قائمة مرشّحين صريحة: ما لم يُذكر هنا يبقى. لا «احذف كل شيء إلا المستثنى».
        candidatePatterns: Object.freeze([
            /^dist-server-.*-[0-9]{8}-[0-9]{6}$/,
        ]),
    }),

    buildBackups: Object.freeze({
        candidatePattern: /^(?:dist-server|dist)\.bak-[0-9]{8}-[0-9]{6}$/,
        // لها آلية استبقاء خاصة في scripts/client-build-atomic.mjs — لا تُمسّ هنا.
        absoluteKeep: Object.freeze([
            /^dist-server\.bak-staging$/,
            /^dist-server\.bak-previous$/,
            /^dist\.atomic\.predeploy-/,
        ]),
    }),

    coreDumps: Object.freeze({
        candidatePattern: CRASH_ARTIFACT,
        // بصمة ELF شرط لازم: لا يُجمع ملف باسم مطابق ما لم يكن core حقيقياً.
        elfMagic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        stringsMinLength: 8,
        stringsPattern: /heap|fatal|abort/i,
        stringsInputBytes: 8 * 1024 * 1024,
    }),

    sessionWorkspaces: Object.freeze({
        module: 'server/modules/session-workspaces/session-workspace-overlay.js',
        maxAgeMs: DAY_MS,
        statePath: 'nassaj-session-overlays',
    }),

    // مسارات ممنوع لمسها إطلاقاً.
    neverTouch: Object.freeze([
        '.retention-trash',
        'database',
        'dist',
        'dist-server',
        'dist-server.bak-previous',
        'dist-server.bak-staging',
        'node_modules',
        '.worktrees',
        '.claude',
        '.nassaj-local-preview',
        '.nassaj-client-publish',
        '.nassaj-client-snapshots',
        '.codex-worktrees',
        '.codex-tasks',
        '.git',
    ]),
});

/* ------------------------------------------------------------------ *
 * حرّاس السلامة
 * ------------------------------------------------------------------ */

/** يرفض العمل إن لم يكن الجذر جذر نسّاج ديف فعلاً. */
export function assertProjectRoot(root) {
    const manifest = path.join(root, 'package.json');
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch (error) {
        throw new Error(`not a nassaj project root (unreadable ${manifest}): ${error.message}`);
    }
    if (parsed?.name !== POLICY.projectName) {
        throw new Error(
            `refusing to run outside nassaj-dev: package.json name is ${JSON.stringify(parsed?.name)}`,
        );
    }
    // داخل طبقة جلسة يكون `.git` ملفاً لا دليلاً — تلك شجرة عمل مؤقتة لا الجذر الحيّ.
    const gitPath = path.join(root, '.git');
    if (fs.existsSync(gitPath) && !fs.lstatSync(gitPath).isDirectory()) {
        throw new Error('refusing to run inside a session overlay worktree (.git is not a directory)');
    }
    return fs.realpathSync(root);
}

/**
 * يتحقّق أن المسار المرشّح داخل الجذر فعلاً ولا يعبره عبر رابط رمزي.
 * يُرجع المسار المحلول، أو يرمي إن خرج عن الجذر أو وقع في قائمة الممنوع.
 */
export function resolveInsideRoot(realRoot, target, { allowRoot = null } = {}) {
    // الفحص المعجمي أولاً: يعطي سبب رفض واضحاً حتى لو كان المسار غير موجود.
    assertContained(realRoot, path.resolve(target), target, allowRoot);

    const parent = path.dirname(path.resolve(target));
    let realParent;
    try {
        realParent = fs.realpathSync(parent);
    } catch (error) {
        throw new Error(`cannot resolve parent of ${target}: ${error.message}`);
    }
    // الفحص الفيزيائي ثانياً: يمنع العبور إلى الخارج عبر رابط رمزي في السلسلة.
    const resolved = path.join(realParent, path.basename(target));
    assertContained(realRoot, resolved, target, allowRoot);
    return resolved;
}

/**
 * وجهة الحجْر تمرّ بالحارس نفسه لا بضمّ نصّي (ج-8): `.retention-trash` في
 * `neverTouch`، فيُصرَّح به هنا باسمه وحده — والاحتواء داخل الجذر يبقى مفروضاً.
 */
export function resolveQuarantinePath(realRoot, target, policy = POLICY) {
    return resolveInsideRoot(realRoot, target, { allowRoot: policy.quarantine.dir });
}

function assertContained(realRoot, candidate, original, allowRoot) {
    if (candidate === realRoot || !candidate.startsWith(realRoot + path.sep)) {
        throw new Error(`path escapes project root: ${original} -> ${candidate}`);
    }
    const relative = path.relative(realRoot, candidate);
    const [head] = relative.split(path.sep);
    if (head !== allowRoot && POLICY.neverTouch.includes(head)) {
        throw new Error(`path is in the never-touch set: ${relative}`);
    }
}

/**
 * حجم شجرة بلا اتّباع أي رابط رمزي، بالمساحة المحجوزة فعلاً (blocks*512)
 * مع إسقاط تكرار الروابط الصلبة، مع أحدث mtime في الشجرة كلها.
 */
export function measureTree(target) {
    let bytes = 0;
    let entries = 0;
    let newestMtimeMs = 0;
    const seen = new Set();
    const stack = [target];
    while (stack.length > 0) {
        const current = stack.pop();
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch {
            continue;
        }
        entries += 1;
        if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
        // الإسقاط للملفات العادية وحدها: nlink على الدليل يعدّ أبناءه لا نسخاً
        // منه، فإسقاط الأدلة كان يبتلع أشجاراً كاملة من الحساب (ج-11).
        if (stat.isFile() && stat.nlink > 1) {
            const identity = `${stat.dev}:${stat.ino}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
        }
        bytes += Number(stat.blocks) * 512;
        if (stat.isDirectory()) {
            let children = [];
            try {
                children = fs.readdirSync(current);
            } catch {
                children = [];
            }
            for (const child of children) stack.push(path.join(current, child));
        }
    }
    return { bytes, entries, newestMtimeMs };
}

/* ------------------------------------------------------------------ *
 * البادئات المحميّة المستخرجة من الكود
 * ------------------------------------------------------------------ */

/**
 * كل مدخل `.artifacts/<name>` مذكور بالاسم في الشجرة يُعتبر بادئة محميّة.
 * الاستخراج آلي حتى لا تتقادم قائمة يدوية؛ وتعذّره حاجزٌ لا تحذير:
 * التخطيط بلا هذه القائمة يعني الجمع فوق مداخل يعتمد عليها الكود.
 */
export function discoverReferencedPrefixes(realRoot) {
    const { referenceScanDirs, referenceScanIncludes, referencePattern } = POLICY.artifacts;
    const dirs = referenceScanDirs.filter((dir) => fs.existsSync(path.join(realRoot, dir)));
    if (dirs.length === 0) {
        // ح-6: شجرة بلا أي دليل مسح ليست شجرةً بلا مراجع — هي شجرة تعذّر فحصها.
        return {
            prefixes: [], scannedDirs: [], available: false,
            note: `none of the reference scan directories exist: ${referenceScanDirs.join(', ')}`,
        };
    }

    const includes = referenceScanIncludes.map((glob) => `--include=${glob}`);
    const result = spawnSync('grep', ['-rhoE', referencePattern, ...dirs, ...includes], {
        cwd: realRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    // grep يُرجع 1 عند انعدام المطابقات — ليس خطأً.
    if (result.error || (result.status !== 0 && result.status !== 1)) {
        return {
            prefixes: [],
            scannedDirs: dirs,
            available: false,
            note: `protected-prefix scan failed: ${result.error?.message ?? result.stderr}`,
        };
    }
    const prefixes = new Set();
    for (const line of (result.stdout ?? '').split('\n')) {
        const name = line.trim().slice('.artifacts/'.length);
        if (name.length > 0) prefixes.add(name);
    }
    return { prefixes: [...prefixes].sort(), scannedDirs: dirs, available: true };
}

/* ------------------------------------------------------------------ *
 * أقسام الخطة
 * ------------------------------------------------------------------ */

function classify(name, patterns) {
    return patterns.some((pattern) => pattern.test(name));
}

function describe(realRoot, name, resolved, stat, now) {
    const { bytes, entries, newestMtimeMs } = measureTree(resolved);
    return {
        name,
        path: path.relative(realRoot, resolved),
        kind: stat.isDirectory() ? 'directory' : 'file',
        bytes,
        entries,
        mtimeMs: stat.mtimeMs,
        newestMtimeMs,
        mtime: new Date(stat.mtimeMs).toISOString(),
        ageDays: Number(Math.max(0, (now - stat.mtimeMs) / DAY_MS).toFixed(2)),
    };
}

function listSection(realRoot, dir) {
    const absolute = path.join(realRoot, dir);
    if (!fs.existsSync(absolute)) return [];
    return fs.readdirSync(absolute).sort();
}

/** حارس البناء الجاري: علامة صريحة أو أي لمسة حديثة في الشجرة كلها. */
function activeBuildReason(resolved, item, { now, config }) {
    if (fs.existsSync(path.join(resolved, config.activeBuildMarker))) {
        return `active build marker (${config.activeBuildMarker})`;
    }
    if (now - item.newestMtimeMs < config.activeBuildWindowMs) {
        const hours = (config.activeBuildWindowMs / HOUR_MS).toFixed(0);
        return `tree touched within ${hours}h (possible build in progress)`;
    }
    return null;
}

/** `.artifacts/` — عمر أقصى + سقف إجمالي، والجمع من المرشّحين وحدهم. */
export function planArtifacts(realRoot, { now, policy, protectedPrefixes }) {
    const config = policy.artifacts;
    const kept = [];
    const candidates = [];
    const skipped = [];
    let totalBytes = 0;
    let reportsBytes = 0;

    for (const name of listSection(realRoot, config.dir)) {
        const target = path.join(realRoot, config.dir, name);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            continue;
        }
        if (stat.isSymbolicLink()) {
            skipped.push({ name, reason: 'symlink (never followed, never collected)' });
            continue;
        }

        let resolved;
        try {
            resolved = resolveInsideRoot(realRoot, target);
        } catch (error) {
            skipped.push({ name, reason: `guard refused: ${error.message}` });
            continue;
        }

        const item = describe(realRoot, name, resolved, stat, now);

        // دليل التقارير مُدار بدورته الخاصة، ولا يدخل إجمالي السقف: احتسابه كان
        // يجعل الأداة تجمع لتموّل حجم ما تكتبه هي (ج-1).
        if (name === policy.reports.dir) {
            reportsBytes += item.bytes;
            kept.push({ ...item, reason: 'managed by this tool (own lifecycle)' });
            continue;
        }
        totalBytes += item.bytes;
        if (classify(name, config.absoluteKeep)) {
            kept.push({ ...item, reason: 'absolute exception' });
            continue;
        }
        const referenced = protectedPrefixes.find((prefix) => name.startsWith(prefix));
        if (referenced) {
            kept.push({ ...item, reason: `referenced by code (${referenced})` });
            continue;
        }
        if (!stat.isDirectory()) {
            kept.push({ ...item, reason: 'not a directory (out of policy scope)' });
            continue;
        }
        if (!classify(name, config.candidatePatterns)) {
            kept.push({ ...item, reason: 'no candidate pattern match' });
            continue;
        }
        const building = activeBuildReason(resolved, item, { now, config });
        if (building) {
            kept.push({ ...item, reason: building });
            continue;
        }
        candidates.push(item);
    }

    return finishArtifactsPlan({ config, kept, candidates, skipped, totalBytes, reportsBytes, now, policy });
}

function finishArtifactsPlan({ config, kept, candidates, skipped, totalBytes, reportsBytes, now, policy }) {
    // 1) قاعدة العمر.
    const doomed = new Map();
    for (const item of candidates) {
        if (now - item.mtimeMs >= config.maxAgeMs) {
            doomed.set(item.name, { ...item, reason: `older than ${config.maxAgeMs / DAY_MS}d` });
        }
    }

    // 2) قاعدة السقف — الأقدم أولاً، ومن المرشّحين خارج مهلة الإعفاء فقط.
    const capGraceMs = config.capGraceMs ?? 0;
    let projected = totalBytes - [...doomed.values()].reduce((sum, item) => sum + item.bytes, 0);
    const remaining = [...candidates].filter((item) => !doomed.has(item.name));
    const eligible = remaining.filter((item) => now - item.mtimeMs >= capGraceMs);
    const graced = remaining.filter((item) => now - item.mtimeMs < capGraceMs);
    eligible.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    for (const item of eligible) {
        if (projected <= config.capBytes) break;
        doomed.set(item.name, {
            ...item,
            reason: `over ${formatBytes(config.capBytes)} cap (oldest first)`,
        });
        projected -= item.bytes;
    }

    const over = projected > config.capBytes;
    const gracedBytes = graced.reduce((sum, item) => sum + item.bytes, 0);
    return {
        dir: config.dir,
        maxAgeDays: config.maxAgeMs / DAY_MS,
        capBytes: config.capBytes,
        capGraceDays: capGraceMs / DAY_MS,
        // `totalBytes` هو الحيّ وحده: ما يقاس ضد السقف. التقارير والحجْر منفصلان.
        totalBytes,
        liveBytes: totalBytes,
        reportsBytes,
        quarantineDir: policy.quarantine.dir,
        protectedBytes: kept.reduce((sum, item) => sum + item.bytes, 0),
        candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
        projectedBytesAfter: projected,
        capStillExceeded: over,
        // تمييز سبب بقاء السقف متجاوَزاً: محميّ لا يُمسّ، أم مُعفى مؤقتاً سيُنظر فيه غداً.
        capBlockedBy: !over ? null : (gracedBytes > 0 ? 'grace-window' : 'protected-content'),
        gracedCount: graced.length,
        gracedBytes,
        protectedCount: kept.length,
        candidateCount: candidates.length,
        deletions: [...doomed.values()],
        retainedLargest: [...kept]
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, RETAINED_SAMPLE)
            .map(({ name, bytes, ageDays, reason }) => ({ name, bytes, ageDays, reason })),
        skipped,
    };
}

/** `.backups/` — قائمة مرشّحين صريحة، وما عداها يبقى مهما بلغ عمره. */
export function planBackups(realRoot, { now, policy }) {
    const config = policy.backups;
    const deletions = [];
    const retained = [];
    const skipped = [];

    for (const name of listSection(realRoot, config.dir)) {
        const target = path.join(realRoot, config.dir, name);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            continue;
        }
        if (!classify(name, config.candidatePatterns)) {
            retained.push({ name, reason: 'not on the explicit candidate list' });
            continue;
        }
        if (stat.isSymbolicLink()) {
            skipped.push({ name, reason: 'symlink (never followed, never collected)' });
            continue;
        }
        let resolved;
        try {
            resolved = resolveInsideRoot(realRoot, target);
        } catch (error) {
            skipped.push({ name, reason: `guard refused: ${error.message}` });
            continue;
        }
        const item = describe(realRoot, name, resolved, stat, now);
        if (now - item.mtimeMs < config.maxAgeMs) {
            retained.push({ ...item, reason: `younger than ${config.maxAgeMs / DAY_MS}d` });
            continue;
        }
        deletions.push({ ...item, reason: `candidate older than ${config.maxAgeMs / DAY_MS}d` });
    }

    return { dir: config.dir, maxAgeDays: config.maxAgeMs / DAY_MS, deletions, retained, skipped };
}

/** نسخ البناء المؤرّخة في الجذر — تُجمع دائماً، مع صون نسخ الناشر الذري. */
export function planBuildBackups(realRoot, { now, policy }) {
    const config = policy.buildBackups;
    const deletions = [];
    const retained = [];
    const skipped = [];

    for (const name of fs.readdirSync(realRoot).sort()) {
        // الاستثناء يُفحص أولاً: أسماؤه في neverTouch فلا يجوز حتى تمريرها للحارس.
        if (classify(name, config.absoluteKeep)) {
            retained.push({ name, reason: 'owned by scripts/client-build-atomic.mjs retention' });
            continue;
        }
        if (!config.candidatePattern.test(name)) continue;
        const target = path.join(realRoot, name);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            continue;
        }
        if (stat.isSymbolicLink()) {
            skipped.push({ name, reason: 'symlink (never followed, never collected)' });
            continue;
        }
        let resolved;
        try {
            resolved = resolveInsideRoot(realRoot, target);
        } catch (error) {
            skipped.push({ name, reason: `guard refused: ${error.message}` });
            continue;
        }
        deletions.push({
            ...describe(realRoot, name, resolved, stat, now),
            reason: 'dated build backup (always collected)',
        });
    }

    return { deletions, retained, skipped };
}

/** سطر تشخيصي مختصر من core dump قبل جمعه (دخل محدود بـ 8M). */
export function inspectCoreDump(file, { policy } = { policy: POLICY }) {
    const config = policy.coreDumps;
    let head;
    try {
        head = readHead(file, config.stringsInputBytes);
    } catch (error) {
        return { available: false, note: `unreadable: ${error.message}` };
    }
    const result = spawnSync('strings', ['-n', String(config.stringsMinLength)], {
        input: head,
        encoding: 'utf8',
        maxBuffer: config.stringsInputBytes,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    if (result.error) return { available: false, note: `strings unavailable: ${result.error.message}` };
    const output = result.stdout ?? '';
    const match = output.split('\n').find((line) => config.stringsPattern.test(line));
    return {
        available: true,
        scannedInputBytes: head.length,
        firstMatch: match ? match.trim().slice(0, 400) : null,
    };
}

function readHead(file, maxBytes) {
    const descriptor = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const read = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, read);
    } finally {
        fs.closeSync(descriptor);
    }
}

/** بقايا الانهيار في الجذر — بشرط بصمة ELF، وبعد تسجيل السطر التشخيصي. */
export function planCoreDumps(realRoot, { now, policy, inspect = inspectCoreDump }) {
    const config = policy.coreDumps;
    const deletions = [];
    const skipped = [];

    for (const name of fs.readdirSync(realRoot).sort()) {
        if (!config.candidatePattern.test(name)) continue;
        const target = path.join(realRoot, name);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            continue;
        }
        if (!stat.isFile()) {
            skipped.push({ name, reason: 'not a regular file' });
            continue;
        }
        let resolved;
        try {
            resolved = resolveInsideRoot(realRoot, target);
        } catch (error) {
            skipped.push({ name, reason: `guard refused: ${error.message}` });
            continue;
        }
        // اسمٌ مطابق لا يكفي: `core.config.js` اسمه core لكنه مصدر لا انهيار.
        if (!hasElfMagic(resolved, config.elfMagic)) {
            skipped.push({ name, reason: 'not an ELF core dump (magic mismatch)' });
            continue;
        }
        deletions.push({
            ...describe(realRoot, name, resolved, stat, now),
            reason: 'ELF core dump (always collected)',
            diagnostic: inspect(resolved, { policy }),
        });
    }

    return { deletions, skipped };
}

function hasElfMagic(file, magic) {
    try {
        return readHead(file, magic.length).equals(magic);
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * الحجْر: جمعٌ قابل للتراجع، ومحوٌ مؤجَّل للتشغيل التالي
 * ------------------------------------------------------------------ */

/**
 * طابع الدفعة يُقرأ من **اسم الدليل** لا من mtime (ج-4): أي `touch` أو نسخ أو
 * استرداد جزئي يحرّك mtime فيمدّ نافذة الاسترداد إلى ما لا نهاية أو يقصّرها.
 * الاسم لا يتغيّر إلا بإعادة تسمية متعمّدة.
 */
export function parseBatchStamp(name) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, ms] = match;
    const at = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);
    return Number.isFinite(at) ? at : null;
}

/** مانيفست الدفعة: بلا مانيفست صالح لا محو (ج-3). */
export function readBatchManifest(batchDir, policy = POLICY) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(batchDir, policy.quarantine.manifest), 'utf8'));
    } catch (error) {
        return { valid: false, reason: `unreadable manifest: ${error.message}` };
    }
    if (parsed?.schema !== policy.quarantine.manifestSchema) {
        return { valid: false, reason: `unexpected manifest schema: ${String(parsed?.schema)}` };
    }
    if (!Number.isFinite(Date.parse(parsed.quarantinedAt ?? '')) || !Array.isArray(parsed.entries)) {
        return { valid: false, reason: 'manifest is missing quarantinedAt or entries' };
    }
    return { valid: true, manifest: parsed };
}

/** الدفعات المحجورة التي تجاوزت مهلة الاسترداد فصارت قابلة للمحو. */
export function planQuarantinePurge(realRoot, { now, policy }) {
    const config = policy.quarantine;
    const due = [];
    const holding = [];
    const blocked = [];
    const trashRoot = path.join(realRoot, config.dir);
    const names = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot).sort() : [];

    for (const name of names) {
        if (name === config.lock) continue;
        const target = path.join(trashRoot, name);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            blocked.push({ name, reason: 'not a plain directory' });
            continue;
        }
        let resolved;
        try {
            resolved = resolveQuarantinePath(realRoot, target, policy);
        } catch (error) {
            blocked.push({ name, reason: `guard refused: ${error.message}` });
            continue;
        }
        // ج-4: طابع غير صالح في الاسم ⇒ لا يُمحى أبداً، ويُبلَّغ عنه.
        const stampedAt = parseBatchStamp(name);
        if (stampedAt === null) {
            blocked.push({ name, reason: 'batch name carries no valid timestamp; never purged' });
            continue;
        }
        const item = {
            ...describe(realRoot, name, resolved, stat, now),
            stampedAt: new Date(stampedAt).toISOString(),
            ageHours: Number(((now - stampedAt) / HOUR_MS).toFixed(2)),
        };
        if (now - stampedAt < config.purgeAfterMs) {
            holding.push({ ...item, reason: 'still inside the recovery window' });
            continue;
        }
        // ج-3: مستحقّ زمنياً لا يكفي — بلا مانيفست صالح لا محو.
        const manifest = readBatchManifest(resolved, policy);
        if (!manifest.valid) {
            blocked.push({ ...item, reason: `no valid manifest; never purged (${manifest.reason})` });
            continue;
        }
        due.push({
            ...item,
            reason: `quarantined longer than ${config.purgeAfterMs / HOUR_MS}h`,
            manifestEntries: manifest.manifest.entries.length,
        });
    }

    return {
        dir: config.dir,
        purgeAfterHours: config.purgeAfterMs / HOUR_MS,
        due,
        holding,
        blocked,
        dueBytes: due.reduce((sum, item) => sum + item.bytes, 0),
        holdingBytes: holding.reduce((sum, item) => sum + item.bytes, 0),
        blockedBytes: blocked.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    };
}

/* ------------------------------------------------------------------ *
 * التخطيط
 * ------------------------------------------------------------------ */

/**
 * معاينة قراءة-فقط لطبقات الجلسات. **خارج النطاق افتراضياً** (بند 9):
 * `withStateLock` يكسر قفل عملية حيّة بعد 30 ثانية، وكل الطبقات القائمة تحمل
 * sessionId فالحصاد صفر أصلاً. لا يعمل إلا بعلم `--reap-overlays` صريح.
 */
export function previewSessionWorkspaces(realRoot, { now, policy }) {
    const config = policy.sessionWorkspaces;
    const gitDir = spawnSync('git', ['-C', realRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    if (gitDir.status !== 0) {
        return { available: false, note: 'not a git repository', staleCount: 0, stale: [] };
    }
    const instancesRoot = path.join(gitDir.stdout.trim(), config.statePath, 'instances');
    if (!fs.existsSync(instancesRoot)) {
        return { available: true, note: 'no overlay state', staleCount: 0, stale: [] };
    }
    const stale = [];
    let total = 0;
    for (const entry of fs.readdirSync(instancesRoot)) {
        total += 1;
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(instancesRoot, entry, 'manifest.json'), 'utf8'));
        } catch {
            continue;
        }
        const lastUsed = Date.parse(manifest?.lastUsedAt ?? manifest?.createdAt ?? '');
        if (manifest?.sessionId || !Number.isFinite(lastUsed)) continue;
        if (now - lastUsed < config.maxAgeMs) continue;
        stale.push({ overlayId: manifest.overlayId ?? entry, lastUsedAt: new Date(lastUsed).toISOString() });
    }
    return { available: true, instances: total, staleCount: stale.length, stale };
}

export function planRetention(root, { now = Date.now(), policy = POLICY, reapOverlays = false, breakers } = {}) {
    const realRoot = assertProjectRoot(root);
    const referenced = discoverReferencedPrefixes(realRoot);
    // بند 6: بلا قائمة المراجع لا خطة. الفشل حاجز لا تحذير.
    if (!referenced.available) {
        throw new Error(
            `refusing to plan without the protected-prefix scan: ${referenced.note ?? 'scan unavailable'}`,
        );
    }

    const artifacts = planArtifacts(realRoot, { now, policy, protectedPrefixes: referenced.prefixes });
    const sections = {
        artifacts,
        backups: planBackups(realRoot, { now, policy }),
        buildBackups: planBuildBackups(realRoot, { now, policy }),
        coreDumps: planCoreDumps(realRoot, { now, policy }),
        quarantine: planQuarantinePurge(realRoot, { now, policy }),
        sessionWorkspaces: reapOverlays
            ? previewSessionWorkspaces(realRoot, { now, policy })
            : { available: false, outOfScope: true, note: 'out of scope; enable with --reap-overlays', staleCount: 0, stale: [] },
    };

    const candidates = [
        ...sections.artifacts.deletions.map((item) => ({ section: 'artifacts', ...item })),
        ...sections.backups.deletions.map((item) => ({ section: 'backups', ...item })),
        ...sections.buildBackups.deletions.map((item) => ({ section: 'buildBackups', ...item })),
        ...sections.coreDumps.deletions.map((item) => ({ section: 'coreDumps', ...item })),
    ];

    const limits = { ...policy.breakers, ...(breakers ?? {}) };
    // ج-2: القاطع يحدّ الدفعة ولا يلغي التشغيل. الأقدم أولاً حتى الحدّ، والباقي
    // يُؤجَّل إلى الغد ويُسمّى في التقرير — فلا يتحوّل الحدّ إلى رفض يومي عقيم.
    const ordered = [...candidates].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    const collections = [];
    const deferred = [];
    let batchBytes = 0;
    for (const item of ordered) {
        const overBytes = batchBytes + item.bytes > limits.maxDeleteBytes && collections.length > 0;
        const overCount = collections.length >= limits.maxDeleteCount;
        if (overBytes || overCount) {
            deferred.push({
                ...item,
                deferredBecause: overCount
                    ? `batch already holds ${limits.maxDeleteCount} entries (--max-delete-count)`
                    : `batch would exceed ${formatBytes(limits.maxDeleteBytes)} (--max-delete-bytes)`,
            });
            continue;
        }
        collections.push(item);
        batchBytes += item.bytes;
    }

    return {
        schema: 3,
        toolVersion: TOOL_VERSION,
        root: realRoot,
        generatedAt: new Date(now).toISOString(),
        reapOverlays,
        protectedPrefixes: referenced,
        sections,
        // ما يُنقل إلى الحجْر في هذه الدفعة — ليس محواً.
        collections,
        deferred,
        breakers: {
            limits,
            capped: deferred.length > 0,
            batchBytes,
            deferredBytes: deferred.reduce((sum, item) => sum + item.bytes, 0),
        },
        totals: {
            eligible: candidates.length,
            plannedCollections: collections.length,
            plannedBytes: batchBytes,
            deferredCollections: deferred.length,
            quarantinePurgeBytes: sections.quarantine.dueBytes,
        },
    };
}

/* ------------------------------------------------------------------ *
 * التنفيذ: نقل إلى الحجْر ثم محو الحجْر المستحق
 * ------------------------------------------------------------------ */

function quarantineBatchDir(realRoot, policy, stamp) {
    return path.join(realRoot, policy.quarantine.dir, stamp);
}

/**
 * قفل حصري بين تشغيلين (ج-10): تشغيلان متزامنان يخطّطان على نفس اللقطة ثم ينقل
 * أحدهما ما خطّط له الآخر، فيرى الثاني ENOENT ويسجّل فشلاً كاذباً — أو أسوأ:
 * يمحو دفعةً يكتبها الأول. ‏`wx` ذرّي على كل أنظمة الملفات المعنية هنا.
 */
function acquireLock(realRoot, policy) {
    const lockFile = path.join(realRoot, policy.quarantine.dir, policy.quarantine.lock);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
            { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder = '';
        try {
            holder = fs.readFileSync(lockFile, 'utf8');
        } catch { /* القارئ ليس ملزماً بنجاح القراءة */ }
        throw new Error(`another disk-retention run holds the lock (${lockFile}): ${holder}`);
    }
    return () => {
        try {
            fs.rmSync(lockFile, { force: true });
        } catch { /* الإفلات لا يُفشل تشغيلاً نجح */ }
    };
}

function moveToQuarantine(realRoot, relative, batchDir, policy) {
    const resolved = resolveInsideRoot(realRoot, path.join(realRoot, relative));
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`refusing to move symlink: ${relative}`);
    // ج-8: الوجهة تمرّ بالحارس مثل المصدر، لا بضمّ نصّي. والحارس يحلّ الأب فعلياً،
    // فلا بدّ من وجود دليل الدفعة قبله (إنشاء متكرر لا ضرر فيه).
    fs.mkdirSync(batchDir, { recursive: true, mode: 0o700 });
    const flattened = relative.split(path.sep).join('__');
    const destination = resolveQuarantinePath(realRoot, path.join(batchDir, flattened), policy);
    if (fs.existsSync(destination)) throw new Error(`quarantine slot already taken: ${destination}`);
    try {
        fs.renameSync(resolved, destination);
    } catch (error) {
        // ج-7: عبور أنظمة ملفات. النسخ ثم الحذف يفقد خاصية الذرّية التي يقوم
        // عليها الحجْر كله، فالحالة تُبلَّغ صراحةً ولا يُلتفّ عليها.
        if (error.code === 'EXDEV') {
            throw new Error(
                `cannot quarantine across filesystems (EXDEV): ${relative} and `
                + `${policy.quarantine.dir}/ are on different devices; move the quarantine `
                + 'directory onto the same filesystem instead of copy+delete',
            );
        }
        throw error;
    }
    return destination;
}

function purgeQuarantine(realRoot, relative, policy) {
    const resolved = resolveQuarantinePath(realRoot, path.join(realRoot, relative), policy);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`refusing to purge symlink: ${relative}`);
    const trashRoot = path.join(realRoot, policy.quarantine.dir);
    if (path.dirname(resolved) !== trashRoot) {
        throw new Error(`refusing to purge a path outside the quarantine root: ${relative}`);
    }
    if (parseBatchStamp(path.basename(resolved)) === null) {
        throw new Error(`refusing to purge a batch with no valid timestamp: ${relative}`);
    }
    if (!readBatchManifest(resolved, policy).valid) {
        throw new Error(`refusing to purge a batch with no valid manifest: ${relative}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function reapSessions(realRoot, { policy }) {
    const modulePath = path.join(realRoot, policy.sessionWorkspaces.module);
    if (!fs.existsSync(modulePath)) return { ran: false, note: 'overlay module not present' };
    const { reapSessionWorkspaces } = await import(pathToFileURL(modulePath).href);
    const reaped = reapSessionWorkspaces({ projectPath: realRoot });
    const prune = spawnSync('git', ['-C', realRoot, 'worktree', 'prune'], {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    return {
        ran: true,
        reaped,
        reapedCount: reaped.length,
        worktreePrune: prune.status === 0 ? 'ok' : `exit ${prune.status}: ${(prune.stderr ?? '').trim()}`,
    };
}

export async function runRetention(root, options = {}) {
    const {
        apply = false, now = Date.now(), policy = POLICY,
        reapOverlays = false, breakers,
    } = options;
    const report = planRetention(root, { now, policy, reapOverlays, breakers });
    report.mode = apply ? 'apply' : 'dry-run';
    report.applied = {
        quarantined: [], purged: [], failed: [],
        quarantinedBytes: 0, purgedBytes: 0, sessionWorkspaces: null,
    };

    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const paths = reportPaths(report.root, policy, stamp);
    // بند 5: خطة مكتوبة على القرص **قبل** أول تصرّف.
    fs.mkdirSync(path.dirname(paths.plan), { recursive: true });
    fs.writeFileSync(paths.plan, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
    report.planPath = path.relative(report.root, paths.plan);

    if (apply) await applyPlan(report, { policy, stamp, paths, reapOverlays });

    report.finishedAt = new Date().toISOString();
    if (apply) {
        fs.writeFileSync(paths.applied, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
        report.appliedPath = path.relative(report.root, paths.applied);
    }
    pruneReports(report.root, policy);
    report.summary = humanSummary(report);
    return report;
}

function reportPaths(realRoot, policy, stamp) {
    const dir = path.join(realRoot, policy.artifacts.dir, policy.reports.dir);
    return {
        dir,
        plan: path.join(dir, `${stamp}-plan.json`),
        applied: path.join(dir, `${stamp}-applied.json`),
        journal: path.join(dir, `${stamp}-applied.jsonl`),
    };
}

async function applyPlan(report, { policy, stamp, paths, reapOverlays }) {
    const batchDir = quarantineBatchDir(report.root, policy, stamp);
    // سجل append-only: النيّة قبل الفعل والنتيجة بعده (ج-9)، فقتلٌ مفاجئ بين
    // السطرين يترك أثراً يقول «بدأ ولم يُعرف مصيره» بدل صمتٍ يوهم أنه لم يقع.
    const journal = (record) => {
        try {
            fs.appendFileSync(paths.journal, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
                { mode: 0o644 });
        } catch { /* السجل مساعد؛ فشله لا يوقف التنفيذ */ }
    };
    const flush = () => {
        report.interrupted = true;
        report.finishedAt = new Date().toISOString();
        try {
            fs.writeFileSync(paths.applied, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
        } catch { /* لا شيء أكثر يمكن فعله أثناء الإنهاء */ }
    };
    const onSignal = (signal) => {
        journal({ event: 'signal', signal });
        flush();
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    let release = () => {};
    try {
        release = acquireLock(report.root, policy);
    } catch (error) {
        report.applied.failed.push({ action: 'lock', error: error.message });
        report.lockBlocked = true;
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
        return;
    }

    try {
        for (const item of report.collections) {
            journal({ action: 'quarantine', phase: 'intent', path: item.path, bytes: item.bytes });
            try {
                const moved = moveToQuarantine(report.root, item.path, batchDir, policy);
                const record = {
                    action: 'quarantine', phase: 'done', path: item.path,
                    to: path.relative(report.root, moved), bytes: item.bytes,
                };
                report.applied.quarantined.push(record);
                report.applied.quarantinedBytes += item.bytes;
                journal(record);
            } catch (error) {
                const record = { action: 'quarantine', phase: 'failed', path: item.path, error: error.message };
                report.applied.failed.push(record);
                journal(record);
            }
        }
        writeBatchManifest(report, { policy, stamp, batchDir, journal });

        // ج-2: المحو مستقل عن القاطع تماماً — القاطع يحدّ ما يدخل الحجْر، ولا
        // يمنع تحرير ما استوفى نافذته. ربطهما كان يجعل الضغط يمنع علاجه.
        for (const batch of report.sections.quarantine.due) {
            journal({ action: 'purge', phase: 'intent', path: batch.path, bytes: batch.bytes });
            try {
                purgeQuarantine(report.root, batch.path, policy);
                const record = { action: 'purge', phase: 'done', path: batch.path, bytes: batch.bytes };
                report.applied.purged.push(record);
                report.applied.purgedBytes += batch.bytes;
                journal(record);
            } catch (error) {
                const record = { action: 'purge', phase: 'failed', path: batch.path, error: error.message };
                report.applied.failed.push(record);
                journal(record);
            }
        }

        if (reapOverlays) {
            try {
                report.applied.sessionWorkspaces = await reapSessions(report.root, { policy });
            } catch (error) {
                report.applied.sessionWorkspaces = { ran: false, error: error.message };
            }
        }
    } finally {
        release();
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
    }
}

/** مانيفست الدفعة (ج-3): بلا هذا الملف لا تُمحى الدفعة لاحقاً أبداً. */
function writeBatchManifest(report, { policy, stamp, batchDir, journal }) {
    if (report.applied.quarantined.length === 0) return;
    const manifest = {
        schema: policy.quarantine.manifestSchema,
        toolVersion: TOOL_VERSION,
        batch: stamp,
        quarantinedAt: new Date().toISOString(),
        pid: process.pid,
        planReport: report.planPath,
        entries: report.applied.quarantined.map(({ path: from, to, bytes }) => ({ from, to, bytes })),
    };
    try {
        fs.writeFileSync(path.join(batchDir, policy.quarantine.manifest),
            `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
        report.applied.quarantineDir = path.relative(report.root, batchDir);
        report.applied.manifestWritten = true;
    } catch (error) {
        // بلا مانيفست تبقى الدفعة محجوزة إلى الأبد بدل أن تُمحى بلا سجلّ.
        report.applied.manifestWritten = false;
        report.applied.failed.push({ action: 'manifest', path: batchDir, error: error.message });
        journal({ action: 'manifest', phase: 'failed', path: batchDir, error: error.message });
    }
}

/** استبقاء ذاتي للتقارير: آخر `keep` طوابع زمنية، بكل ملفاتها. */
function pruneReports(realRoot, policy) {
    const dir = path.join(realRoot, policy.artifacts.dir, policy.reports.dir);
    if (!fs.existsSync(dir)) return;
    try {
        const stamps = new Map();
        for (const name of fs.readdirSync(dir)) {
            const stamp = name.replace(/-(?:plan|applied)\.(?:json|jsonl)$/, '');
            if (stamp === name) continue;
            if (!stamps.has(stamp)) stamps.set(stamp, []);
            stamps.get(stamp).push(name);
        }
        const ordered = [...stamps.keys()].sort();
        for (const stamp of ordered.slice(0, Math.max(0, ordered.length - policy.reports.keep))) {
            for (const name of stamps.get(stamp)) {
                // ج-5: recursive+force حتى لا يُفشل مدخلٌ شاذّ تشغيلاً نجح.
                fs.rmSync(path.join(dir, name), { recursive: true, force: true });
            }
        }
    } catch { /* تنظيف التقارير رفاهية؛ فشله لا يبطل تشغيلاً اكتمل */ }
}

/* ------------------------------------------------------------------ *
 * العرض
 * ------------------------------------------------------------------ */

export function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function sectionBytes(section) {
    return formatBytes(section.deletions.reduce((sum, item) => sum + item.bytes, 0));
}

export function humanSummary(report) {
    const { sections, totals } = report;
    const artifacts = sections.artifacts;
    const lines = [];

    const verb = report.mode === 'apply' ? 'quarantined' : 'would quarantine';
    const bytes = report.mode === 'apply' ? report.applied.quarantinedBytes : totals.plannedBytes;
    const count = report.mode === 'apply' ? report.applied.quarantined.length : totals.plannedCollections;
    lines.push(`disk-retention [${report.mode}] ${verb} ${count} entries, ${formatBytes(bytes)}`);
    lines.push(`  ${[
        `.artifacts ${sectionBytes(artifacts)}`,
        `.backups ${sectionBytes(sections.backups)}`,
        `build-backups ${sectionBytes(sections.buildBackups)}`,
        `core dumps ${sectionBytes(sections.coreDumps)}`,
    ].join(' | ')}`);

    if (report.lockBlocked) {
        lines.push('  ! another run holds the quarantine lock; nothing was moved or purged');
    }
    if (report.breakers.capped) {
        lines.push(
            `  batch capped: ${totals.deferredCollections} more entries`
            + ` (${formatBytes(report.breakers.deferredBytes)}) deferred to the next run`
            + ` — limits ${formatBytes(report.breakers.limits.maxDeleteBytes)} / ${report.breakers.limits.maxDeleteCount} entries`,
        );
    }

    const capNote = !artifacts.capStillExceeded ? ''
        : artifacts.capBlockedBy === 'grace-window'
            ? `, still over — ${artifacts.gracedCount} candidates inside the ${artifacts.capGraceDays}d grace window (${formatBytes(artifacts.gracedBytes)})`
            : ', still over — protected content alone exceeds the cap';
    lines.push(
        `  .artifacts live ${formatBytes(artifacts.liveBytes)}`
        + ` -> ${formatBytes(artifacts.projectedBytesAfter)}`
        + ` (cap ${formatBytes(artifacts.capBytes)}${capNote})`,
    );
    lines.push(
        `  protected ${artifacts.protectedCount} entries`
        + ` (${report.protectedPrefixes.prefixes.length} code-referenced prefixes)`
        + `; reports ${formatBytes(artifacts.reportsBytes)} (outside the cap)`,
    );

    const quarantine = sections.quarantine;
    const purged = report.mode === 'apply'
        ? `purged ${report.applied.purged.length} (${formatBytes(report.applied.purgedBytes)})`
        : `${quarantine.due.length} batches due for purge (${formatBytes(quarantine.dueBytes)})`;
    lines.push(
        `  quarantine ${quarantine.dir}/: ${purged}; ${quarantine.holding.length} held`
        + ` (${formatBytes(quarantine.holdingBytes)}, ${quarantine.purgeAfterHours}h recovery window)`
        + `${quarantine.blocked.length > 0 ? `; ${quarantine.blocked.length} blocked from purge` : ''}`,
    );
    lines.push(`  session overlays: ${report.reapOverlays
        ? `${sections.sessionWorkspaces.staleCount} stale`
        : 'out of scope (--reap-overlays disabled by default)'}`);
    lines.push(`  plan: ${report.planPath}${report.appliedPath ? ` | applied: ${report.appliedPath}` : ''}`);
    return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseBytes(value) {
    const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(String(value).trim());
    if (!match) throw new Error(`invalid byte size: ${value}`);
    const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
    return Math.round(Number(match[1]) * scale[match[2].toUpperCase()]);
}

function requireValue(argv, index, flag) {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseArgs(argv) {
    const options = { apply: false, json: false, root: process.cwd(), reapOverlays: false, breakers: {} };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') options.apply = true;
        else if (arg === '--dry-run') options.apply = false;
        else if (arg === '--json') options.json = true;
        else if (arg === '--reap-overlays') options.reapOverlays = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--root') {
            index += 1;
            options.root = requireValue(argv, index, '--root');
        } else if (arg === '--max-delete-bytes') {
            index += 1;
            options.breakers.maxDeleteBytes = parseBytes(requireValue(argv, index, '--max-delete-bytes'));
        } else if (arg === '--max-delete-count') {
            index += 1;
            const value = Number(requireValue(argv, index, '--max-delete-count'));
            if (!Number.isInteger(value) || value < 0) throw new Error('--max-delete-count must be a non-negative integer');
            options.breakers.maxDeleteCount = value;
        } else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

const USAGE = `usage: node scripts/disk-retention.mjs [--dry-run|--apply] [options]

  --dry-run              (default) plan only; nothing is moved or purged
  --apply                move planned entries to quarantine, purge due batches
  --json                 print the full JSON report to stdout
  --root <path>          project root to operate on (must be a nassaj root)
  --max-delete-bytes <n> per-run batch cap, default 6G (accepts 6G / 500M / bytes)
  --max-delete-count <n> per-run batch cap, default 20
  --reap-overlays        also reap session overlays (off by default; see docs)

Nothing is deleted outright: --apply moves entries into .retention-trash/<ts>/
and only a LATER run purges a batch, once it has sat out the recovery window and
carries a valid manifest. Exceeding a batch cap defers the remainder to the next
run; it never blocks purging what is already due.`;

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    try {
        const report = await runRetention(options.root, {
            apply: options.apply,
            reapOverlays: options.reapOverlays,
            breakers: options.breakers,
        });
        if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${report.summary}\n`);
        if (report.applied.failed.length > 0) process.exitCode = 1;
    } catch (error) {
        process.stderr.write(`disk-retention failed: ${error.message}\n`);
        process.exitCode = 2;
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    await main();
}
