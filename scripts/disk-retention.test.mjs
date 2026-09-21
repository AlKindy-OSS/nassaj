// T-1686 — اختبارات أداة الاستبقاء على شجرة وهمية على القرص (لا tmpfs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CRASH_ARTIFACT,
    CRASH_ARTIFACT_SOURCE,
    POLICY,
    assertProjectRoot,
    discoverReferencedPrefixes,
    formatBytes,
    parseArgs,
    parseBatchStamp,
    parseBytes,
    planRetention,
    resolveInsideRoot,
    runRetention,
    TOOL_VERSION,
} from './disk-retention.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// تُبنى المسارات تركيبياً لا حرفياً: حرفية `.artifacts/<name>` هنا كانت ستُحسب
// بادئةً محميّة في المستودع الحقيقي عبر ماسح المراجع، فتحمي بقايا حقيقية بالخطأ.
const ART = '.artifacts';
const BAK = '.backups';
// /tmp و/dev/shm على هذا المضيف tmpfs؛ الاختبار يكتب على القرص عمداً.
const SCRATCH_BASE = process.env.NASSAJ_TEST_TMP || '/var/tmp';
// عمر يتجاوز مهلة الإعفاء وقاعدة العمر معاً.
const STALE = 40 * DAY_MS;
// عمر يتجاوز نافذة البناء الجاري (6 ساعات) دون بلوغ قاعدة العمر.
const SETTLED = 3 * DAY_MS;

function scratchDir(t, label) {
    const dir = fs.mkdtempSync(path.join(SCRATCH_BASE, `nassaj-disk-retention-${label}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function makeRoot(t) {
    const root = scratchDir(t, 'root');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'nassaj' }));
    fs.mkdirSync(path.join(root, ART), { recursive: true });
    fs.mkdirSync(path.join(root, BAK), { recursive: true });
    // ح-6: بلا دليل مسح واحد على الأقل يرفض التخطيط رأساً.
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'noop.mjs'), 'export const noop = 1;\n');
    return fs.realpathSync(root);
}

function touch(target, ageMs, now) {
    const stamp = new Date(now - ageMs);
    fs.utimesSync(target, stamp, stamp);
}

function makeTree(root, relative, { bytes = 1024, ageMs = 0, now = Date.now(), extra = {} } = {}) {
    const target = path.join(root, relative);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'payload.bin'), Buffer.alloc(bytes, 7));
    for (const [name, content] of Object.entries(extra)) {
        fs.writeFileSync(path.join(target, name), content);
    }
    // الشجرة كلها تُؤرَّخ: حارس البناء الجاري ينظر إلى أحدث mtime في العمق لا القمة.
    for (const child of fs.readdirSync(target)) touch(path.join(target, child), ageMs, now);
    touch(target, ageMs, now);
    return target;
}

function makeFile(root, relative, { bytes = 64, ageMs = 0, now = Date.now(), fill = 3 } = {}) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes, fill));
    touch(target, ageMs, now);
    return target;
}

function makeCore(root, name, { ageMs = 0, now = Date.now(), elf = true } = {}) {
    const target = path.join(root, name);
    const head = elf ? Buffer.from([0x7f, 0x45, 0x4c, 0x46]) : Buffer.from('module.exports');
    fs.writeFileSync(target, Buffer.concat([head, Buffer.from('\nFATAL ERROR: heap out of memory\n')]));
    touch(target, ageMs, now);
    return target;
}

function names(items) {
    return items.map((item) => item.name).sort();
}

function collectedPaths(report) {
    return new Set(report.collections.map((item) => item.path));
}

test('يرفض العمل خارج جذر نسّاج ديف أو داخل طبقة جلسة', (t) => {
    const alien = scratchDir(t, 'alien');
    assert.throws(() => assertProjectRoot(alien), /not a nassaj project root/);

    fs.writeFileSync(path.join(alien, 'package.json'), JSON.stringify({ name: 'not-nassaj' }));
    assert.throws(() => assertProjectRoot(alien), /refusing to run outside nassaj-dev/);

    // بند التحسين: داخل طبقة جلسة يكون .git ملفاً لا دليلاً.
    fs.writeFileSync(path.join(alien, 'package.json'), JSON.stringify({ name: 'nassaj' }));
    fs.writeFileSync(path.join(alien, '.git'), 'gitdir: /elsewhere\n');
    assert.throws(() => assertProjectRoot(alien), /session overlay worktree/);
});

test('[بند 1] بقايا الانهيار: نمط check-crash-artifacts وحده + بصمة ELF', async (t) => {
    // مصدر واحد لا نسختان: أي انحراف عن السكربت الأصلي يكسر هذا الاختبار.
    // ج-12: يُقاس من موقع هذا الملف لا من cwd، فلا يتعلّق نجاحه بمكان الاستدعاء.
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const source = fs.readFileSync(path.join(repoRoot, CRASH_ARTIFACT_SOURCE), 'utf8');
    const declared = /const CRASH_ARTIFACT = (\/.*\/);/.exec(source);
    assert.ok(declared, `CRASH_ARTIFACT literal not found in ${CRASH_ARTIFACT_SOURCE}`);
    assert.equal(declared[1], CRASH_ARTIFACT.toString(), 'crash-artifact pattern drifted from its source');

    const now = Date.now();
    const root = makeRoot(t);
    makeCore(root, 'core', { now });
    makeCore(root, 'core.4242', { now });
    makeCore(root, 'crash.core', { now });
    // يطابق النمط بالاسم لكنه ليس core حقيقياً — تحجزه بصمة ELF.
    makeCore(root, 'decoy.core', { now, elf: false });
    // لا يطابق النمط أصلاً: النمط القديم /^core\..+/ كان يبتلعه، والجديد لا يراه.
    makeCore(root, 'core.config.js', { now, elf: false });
    makeFile(root, 'core-notes.md', { now });

    const plan = planRetention(root, { now });
    const coreDumps = plan.sections.coreDumps;
    assert.deepEqual(names(coreDumps.deletions), ['core', 'core.4242', 'crash.core']);
    assert.ok(
        coreDumps.skipped.some((item) => item.name === 'decoy.core' && /ELF/.test(item.reason)),
        'decoy.core must be skipped on the ELF magic check',
    );
    for (const untouched of ['core.config.js', 'core-notes.md']) {
        assert.equal(
            [...coreDumps.deletions, ...coreDumps.skipped].some((item) => item.name === untouched),
            false, `${untouched} must not even be considered`,
        );
    }
    for (const item of plan.sections.coreDumps.deletions) {
        assert.ok(Object.hasOwn(item, 'diagnostic'), 'each core dump carries a diagnostic line');
    }

    const report = await runRetention(root, { apply: true, now });
    assert.ok(fs.existsSync(path.join(root, 'core.config.js')), 'the JS source must survive');
    assert.equal(fs.existsSync(path.join(root, 'core.4242')), false, 'the real core is quarantined');
    assert.equal(report.applied.failed.length, 0, JSON.stringify(report.applied.failed));
});

test('[بند 2] .backups: قائمة مرشّحين صريحة وما عداها يبقى', (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const old = { ageMs: 90 * DAY_MS, now };

    // مرشّح صريح وقديم.
    makeTree(root, `${BAK}/dist-server-cb6efcae-replaced-20260907-195159`, { ...old, bytes: 256 });
    // مرشّح صريح لكنه حديث.
    makeTree(root, `${BAK}/dist-server-pre-cb6efcae-20260907-192408`, { bytes: 256, ageMs: DAY_MS, now });
    // كل ما يلي خارج قائمة المرشّحين — يبقى مهما بلغ عمره.
    makeFile(root, `${BAK}/db.pre-source-cutover-20260817T030056.sqlite`, { ...old, bytes: 256 });
    makeFile(root, `${BAK}/cutover.log`, old);
    makeFile(root, `${BAK}/cutover-to-source.sh`, old);
    makeFile(root, `${BAK}/dump.pm2.bak-20260817T030056`, old);
    makeFile(root, `${BAK}/some-unknown-future-backup.tar`, old);
    makeTree(root, `${BAK}/unknown-directory`, old);

    const backups = planRetention(root, { now }).sections.backups;
    assert.deepEqual(names(backups.deletions), ['dist-server-cb6efcae-replaced-20260907-195159']);
    const retained = new Set(backups.retained.map((item) => item.name));
    for (const survivor of [
        'db.pre-source-cutover-20260817T030056.sqlite', 'cutover.log', 'cutover-to-source.sh',
        'dump.pm2.bak-20260817T030056', 'some-unknown-future-backup.tar', 'unknown-directory',
        'dist-server-pre-cb6efcae-20260907-192408',
    ]) {
        assert.ok(retained.has(survivor), `${survivor} must be retained`);
    }
});

test('[بند 6 + ح-6] تعذّر ماسح المراجع حاجز، وغياب أدلة المسح تعذّر', (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-stale`, { bytes: 1024, ageMs: STALE, now });

    // ح-6: شجرة بلا أي دليل مسح ⇒ available:false ⇒ رفض، لا «صفر مراجع».
    fs.rmSync(path.join(root, 'scripts'), { recursive: true, force: true });
    const scan = discoverReferencedPrefixes(root);
    assert.equal(scan.available, false);
    assert.match(scan.note, /none of the reference scan directories exist/);
    assert.throws(() => planRetention(root, { now }), /refusing to plan without the protected-prefix scan/);

    // وتعذّر grep نفسه حاجز كذلك.
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'noop.mjs'), 'export const noop = 1;\n');
    const savedPath = process.env.PATH;
    process.env.PATH = scratchDir(t, 'nobin');
    t.after(() => { process.env.PATH = savedPath; });
    assert.throws(() => planRetention(root, { now }), /refusing to plan without the protected-prefix scan/);
});

test('[بند 7] حارس البناء الجاري: علامة صريحة أو لمسة حديثة في العمق', (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    // مرشّح قديم بعلامة بناء صريحة.
    makeTree(root, `${ART}/fleet8-marked`, {
        bytes: 1024, ageMs: STALE, now, extra: { '.build-in-progress': 'pid 1\n' },
    });
    // مرشّح قديم من القمة لكن فيه ملف عميق لُمس قبل ساعة.
    const fresh = makeTree(root, `${ART}/fleet8-deep-fresh`, { bytes: 1024, ageMs: STALE, now });
    fs.mkdirSync(path.join(fresh, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'nested', 'chunk.bin'), Buffer.alloc(256, 1));
    touch(path.join(fresh, 'nested', 'chunk.bin'), HOUR_MS, now);
    touch(path.join(fresh, 'nested'), HOUR_MS, now);
    touch(fresh, STALE, now);
    // مرشّح قديم هادئ بالكامل.
    makeTree(root, `${ART}/fleet8-quiet`, { bytes: 1024, ageMs: STALE, now });

    const artifacts = planRetention(root, { now }).sections.artifacts;
    assert.deepEqual(names(artifacts.deletions), ['fleet8-quiet']);
    const reasons = new Map(artifacts.retainedLargest.map((item) => [item.name, item.reason]));
    assert.match(reasons.get('fleet8-marked') ?? '', /active build marker/);
    assert.match(reasons.get('fleet8-deep-fresh') ?? '', /touched within 6h/);
});

test('[بند 3 + ج-1] الحجْر خارج .artifacts: النقل ثم المحو في تشغيل لاحق', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const victim = makeTree(root, `${ART}/fleet8-collectme`, { bytes: 2048, ageMs: STALE, now });

    const first = await runRetention(root, { apply: true, now });
    assert.equal(first.applied.quarantined.length, 1);
    assert.equal(first.applied.purged.length, 0, 'nothing is purged on the run that quarantines');
    assert.equal(fs.existsSync(victim), false, 'the entry left its original place');

    // ج-1: الحجْر في جذر المشروع لا داخل .artifacts.
    const batchDir = path.join(root, first.applied.quarantineDir);
    assert.ok(batchDir.startsWith(path.join(root, POLICY.quarantine.dir) + path.sep));
    assert.equal(batchDir.startsWith(path.join(root, ART)), false, 'quarantine must not sit inside .artifacts');
    const held = fs.readdirSync(batchDir).filter((name) => name !== POLICY.quarantine.manifest);
    assert.equal(held.length, 1);
    assert.ok(fs.existsSync(path.join(batchDir, held[0], 'payload.bin')), 'content stays recoverable');

    // ج-3: مانيفست صالح داخل الدفعة.
    const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, POLICY.quarantine.manifest), 'utf8'));
    assert.equal(manifest.schema, POLICY.quarantine.manifestSchema);
    assert.equal(manifest.toolVersion, TOOL_VERSION);
    assert.equal(manifest.pid, process.pid);
    assert.equal(manifest.entries.length, 1);
    assert.ok(Number.isFinite(Date.parse(manifest.quarantinedAt)));

    const soon = await runRetention(root, { apply: true, now: now + HOUR_MS });
    assert.equal(soon.applied.purged.length, 0);
    assert.equal(soon.sections.quarantine.holding.length, 1);
    assert.ok(fs.existsSync(batchDir), 'still recoverable');

    const later = await runRetention(root, { apply: true, now: now + 2 * DAY_MS });
    assert.equal(later.applied.purged.length, 1);
    assert.equal(fs.existsSync(batchDir), false, 'purged after the recovery window');
});

test('[ج-1] السقف يقيس الحيّ وحده: الحجْر والتقارير خارج الحساب', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-bulk`, { bytes: 400_000, ageMs: STALE, now });

    const policy = { ...POLICY, artifacts: { ...POLICY.artifacts, capBytes: 300_000 } };
    const before = planRetention(root, { now, policy }).sections.artifacts;
    const liveBefore = before.liveBytes;

    // بعد الجمع: المنقول غادر .artifacts فهبط الحيّ، ولم ينتقل الحمل إلى داخلها.
    await runRetention(root, { apply: true, now, policy });
    const after = planRetention(root, { now, policy }).sections.artifacts;
    assert.ok(after.liveBytes < liveBefore, 'live bytes drop once an entry is quarantined');
    assert.ok(fs.existsSync(path.join(root, POLICY.quarantine.dir)));

    // دليل التقارير موجود داخل .artifacts لكنه لا يدخل الإجمالي المقيس ضد السقف.
    assert.ok(after.reportsBytes > 0, 'reports do occupy space');
    const reports = path.join(root, ART, POLICY.reports.dir);
    const measured = fs.readdirSync(reports).length;
    assert.ok(measured > 0);
    assert.equal(after.totalBytes, after.liveBytes, 'totalBytes is the live figure');
});

test('[ج-3 + ج-4] لا محو بلا مانيفست صالح ولا بطابع صالح في الاسم', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const trash = path.join(root, POLICY.quarantine.dir);
    fs.mkdirSync(trash, { recursive: true });

    const validStamp = '2026-01-01T00-00-00-000Z';
    const withManifest = path.join(trash, validStamp);
    fs.mkdirSync(withManifest);
    fs.writeFileSync(path.join(withManifest, POLICY.quarantine.manifest), JSON.stringify({
        schema: POLICY.quarantine.manifestSchema, quarantinedAt: '2026-01-01T00:00:00.000Z', entries: [],
    }));
    // دفعة قديمة بطابع صالح لكن بلا مانيفست.
    const noManifest = path.join(trash, '2026-01-02T00-00-00-000Z');
    fs.mkdirSync(noManifest);
    // دفعة بمانيفست لكن باسم بلا طابع صالح.
    const noStamp = path.join(trash, 'hand-made-batch');
    fs.mkdirSync(noStamp);
    fs.writeFileSync(path.join(noStamp, POLICY.quarantine.manifest), JSON.stringify({
        schema: POLICY.quarantine.manifestSchema, quarantinedAt: '2026-01-01T00:00:00.000Z', entries: [],
    }));
    // ومانيفست بمخطّط غريب.
    const badSchema = path.join(trash, '2026-01-03T00-00-00-000Z');
    fs.mkdirSync(badSchema);
    fs.writeFileSync(path.join(badSchema, POLICY.quarantine.manifest), JSON.stringify({ schema: 'something-else' }));

    // ج-4: mtime حديث جداً لكن الطابع في الاسم قديم — العبرة بالاسم.
    for (const dir of [withManifest, noManifest, noStamp, badSchema]) touch(dir, 0, now);

    const report = await runRetention(root, { apply: true, now });
    const purged = report.applied.purged.map((record) => path.basename(record.path));
    assert.deepEqual(purged, [validStamp], 'only the valid, timestamped, manifested batch is purged');
    assert.equal(fs.existsSync(withManifest), false);
    for (const survivor of [noManifest, noStamp, badSchema]) {
        assert.ok(fs.existsSync(survivor), `${path.basename(survivor)} must never be purged`);
    }
    const blocked = report.sections.quarantine.blocked.map((item) => item.name).sort();
    assert.deepEqual(blocked, ['2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z', 'hand-made-batch']);
    assert.equal(parseBatchStamp('hand-made-batch'), null);
    assert.equal(parseBatchStamp(validStamp), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('[ج-5] فشل تنظيف التقارير لا يُفشل تشغيلاً نجح', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const reports = path.join(root, ART, POLICY.reports.dir);
    fs.mkdirSync(reports, { recursive: true });
    // مدخل شاذّ: دليل يحمل اسم تقرير — rmSync غير recursive كان يرمي عليه.
    for (let index = 0; index < 35; index += 1) {
        const stamp = `2026-02-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`;
        fs.mkdirSync(path.join(reports, `${stamp}-plan.json`), { recursive: true });
        fs.writeFileSync(path.join(reports, `${stamp}-plan.json`, 'inner'), 'x');
    }
    const report = await runRetention(root, { apply: false, now });
    assert.equal(report.mode, 'dry-run');
    const stamps = new Set(fs.readdirSync(reports).map((name) => name.replace(/-(?:plan|applied)\.(?:json|jsonl)$/, '')));
    assert.equal(stamps.size, POLICY.reports.keep);
});

test('[ج-10] قفل يمنع تشغيلين متزامنين من التصرّف', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-locked`, { bytes: 2048, ageMs: STALE, now });
    const lockFile = path.join(root, POLICY.quarantine.dir, POLICY.quarantine.lock);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));

    const report = await runRetention(root, { apply: true, now });
    assert.equal(report.lockBlocked, true);
    assert.equal(report.applied.quarantined.length, 0);
    assert.ok(fs.existsSync(path.join(root, ART, 'fleet8-locked')), 'nothing moved under a held lock');
    assert.match(report.summary, /another run holds the quarantine lock/);

    // وبعد تحرير القفل يمضي التشغيل التالي.
    fs.rmSync(lockFile);
    const second = await runRetention(root, { apply: true, now });
    assert.equal(second.lockBlocked, undefined);
    assert.equal(second.applied.quarantined.length, 1);
});

test('[ج-2] الحدّ يجمع الأقدم ويؤجّل الباقي، ولا يرفض التشغيل', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    // ثلاثة مرشّحين متمايزي العمر، الأقدم أولاً في الجمع.
    makeTree(root, `${ART}/fleet8-batch-old`, { bytes: 200_000, ageMs: STALE + 2 * DAY_MS, now });
    makeTree(root, `${ART}/fleet8-batch-mid`, { bytes: 200_000, ageMs: STALE + DAY_MS, now });
    makeTree(root, `${ART}/fleet8-batch-new`, { bytes: 200_000, ageMs: STALE, now });

    const capped = await runRetention(root, { apply: true, now, breakers: { maxDeleteCount: 2 } });
    assert.equal(capped.refused, undefined, 'a capped batch is not a refusal');
    assert.equal(capped.breakers.capped, true);
    assert.equal(capped.applied.quarantined.length, 2);
    assert.equal(capped.deferred.length, 1);
    // الأقدم جُمعا، والأحدث أُجّل.
    assert.deepEqual(
        capped.applied.quarantined.map((record) => path.basename(record.path)).sort(),
        ['fleet8-batch-mid', 'fleet8-batch-old'],
    );
    assert.equal(path.basename(capped.deferred[0].path), 'fleet8-batch-new');
    assert.ok(fs.existsSync(path.join(root, ART, 'fleet8-batch-new')));
    assert.match(capped.summary, /batch capped: 1 more entries/);

    // وحدّ البايتات يعمل بنفس المنطق، ويجمع واحداً على الأقل مهما ضاق.
    const root2 = makeRoot(t);
    makeTree(root2, `${ART}/fleet8-single`, { bytes: 200_000, ageMs: STALE, now });
    const tiny = await runRetention(root2, { apply: true, now, breakers: { maxDeleteBytes: 1024 } });
    assert.equal(tiny.applied.quarantined.length, 1, 'a single oversized entry still moves');
    assert.equal(tiny.deferred.length, 0);
});

test('[ج-2] المحو المستحق يعمل مهما شُدّ الحدّ', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-first`, { bytes: 2048, ageMs: STALE, now });
    const first = await runRetention(root, { apply: true, now });
    const batch = path.join(root, POLICY.quarantine.dir, first.applied.quarantineDir.split(path.sep).pop());
    assert.ok(fs.existsSync(batch));

    // بعد يومين ومع حدّ صفري للجمع: لا جمع، لكن المحو يمضي.
    makeTree(root, `${ART}/fleet8-second`, { bytes: 2048, ageMs: STALE, now });
    const later = await runRetention(root, {
        apply: true, now: now + 2 * DAY_MS, breakers: { maxDeleteCount: 0 },
    });
    assert.equal(later.applied.quarantined.length, 0, 'the cap blocks collection');
    assert.equal(later.applied.purged.length, 1, 'but never blocks purging what is due');
    assert.equal(fs.existsSync(batch), false);
    assert.ok(fs.existsSync(path.join(root, ART, 'fleet8-second')), 'deferred, not lost');
});

test('dry-run لا ينقل ولا يمحو، ويكتب خطته قبل أي تصرّف', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const doomed = makeTree(root, `${ART}/fleet8-old-run`, { bytes: 2048, ageMs: STALE, now });
    const coreDump = makeCore(root, 'core.4242', { now });
    const datedBackup = makeTree(root, 'dist-server.bak-20260101-010101', { bytes: 256, ageMs: SETTLED, now });

    const report = await runRetention(root, { apply: false, now });

    assert.equal(report.mode, 'dry-run');
    assert.ok(report.totals.plannedCollections >= 3);
    assert.deepEqual(report.applied.quarantined, []);
    assert.deepEqual(report.applied.purged, []);

    assert.ok(fs.existsSync(doomed));
    assert.ok(fs.existsSync(coreDump));
    assert.ok(fs.existsSync(datedBackup));

    // [بند 5 + 10] الخطة مكتوبة في دليل التقارير داخل الجذر، ولا ملف تنفيذ في dry-run.
    const planPath = path.join(root, report.planPath);
    assert.ok(planPath.startsWith(path.join(root, ART, POLICY.reports.dir) + path.sep));
    assert.ok(planPath.endsWith('-plan.json'));
    assert.equal(JSON.parse(fs.readFileSync(planPath, 'utf8')).mode, 'dry-run');
    assert.equal(report.appliedPath, undefined);
});

test('[بند 5] التنفيذ يكتب خطةً ثم سجلاً ثم تقرير تنفيذ', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-two-phase`, { bytes: 2048, ageMs: STALE, now });

    const report = await runRetention(root, { apply: true, now });
    const reportsDir = path.join(root, ART, POLICY.reports.dir);
    const files = fs.readdirSync(reportsDir).sort();

    assert.equal(files.filter((name) => name.endsWith('-plan.json')).length, 1);
    assert.equal(files.filter((name) => name.endsWith('-applied.json')).length, 1);
    const journal = files.find((name) => name.endsWith('-applied.jsonl'));
    assert.ok(journal, 'append-only journal must exist');
    const records = fs.readFileSync(path.join(reportsDir, journal), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records[0].action, 'quarantine');
    assert.equal(records[0].path, path.join(ART, 'fleet8-two-phase'));
    // الخطة كُتبت قبل التنفيذ فلا تحمل نتائجه.
    const planned = JSON.parse(fs.readFileSync(path.join(root, report.planPath), 'utf8'));
    assert.deepEqual(planned.applied.quarantined, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, report.appliedPath), 'utf8')).applied.quarantined.length, 1);
});

test('[بند 10] التقارير لها استبقاؤها الذاتي: آخر 30 طابعاً', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const reportsDir = path.join(root, ART, POLICY.reports.dir);
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let index = 0; index < 40; index += 1) {
        const stamp = `2026-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`;
        fs.writeFileSync(path.join(reportsDir, `${stamp}-plan.json`), '{}');
    }
    await runRetention(root, { apply: false, now });
    const stamps = new Set(fs.readdirSync(reportsDir).map((name) => name.replace(/-(?:plan|applied)\.(?:json|jsonl)$/, '')));
    assert.equal(stamps.size, POLICY.reports.keep);
});

test('الاستثناءات المطلقة والمراجع البرمجية محميّة من الجمع', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const old = { ageMs: STALE, now };

    makeTree(root, `${ART}/incidents`, { ...old, bytes: 4096 });
    makeTree(root, `${ART}/b979-database-snapshots`, { ...old, bytes: 4096 });
    makeFile(root, `${ART}/b896-retention-2026.json`, { ...old, bytes: 128 });
    // [بند 3] أدلّة إصدار محتملة — تبقى بانتظار قرار المالك.
    makeTree(root, `${ART}/release-node-24.20.0`, { ...old, bytes: 4096 });
    makeTree(root, `${ART}/release-pm2-701`, { ...old, bytes: 4096 });
    // مدخل مذكور بالاسم في الكود — يطابق نمط المرشّحين لكنه محميّ بالمرجع.
    fs.writeFileSync(
        path.join(root, 'scripts', 'fixture-consumer.mjs'),
        `export const fixture = '${ART}/release-keepme-fixture';\n`,
    );
    makeTree(root, `${ART}/release-keepme-fixture`, { ...old, bytes: 4096 });
    makeTree(root, `${ART}/release-throwaway`, { ...old, bytes: 4096 });

    makeTree(root, 'dist-server.bak-staging', { ...old, bytes: 128 });
    makeTree(root, 'dist-server.bak-previous', { ...old, bytes: 128 });
    makeTree(root, 'dist.atomic.predeploy-previous-1789063409520-66f7667e4c7d', { ...old, bytes: 128 });
    makeTree(root, 'dist.bak-20260101-010101', { ...old, bytes: 128 });

    for (const forbidden of POLICY.neverTouch) {
        makeTree(root, path.join(forbidden, 'inner'), { ...old, bytes: 64 });
    }

    const plan = planRetention(root, { now });
    const doomed = collectedPaths(plan);

    for (const survivor of [
        `${ART}/incidents`, `${ART}/b979-database-snapshots`, `${ART}/b896-retention-2026.json`,
        `${ART}/release-node-24.20.0`, `${ART}/release-pm2-701`, `${ART}/release-keepme-fixture`,
        'dist-server.bak-staging', 'dist-server.bak-previous',
        'dist.atomic.predeploy-previous-1789063409520-66f7667e4c7d',
    ]) {
        assert.equal(doomed.has(survivor), false, `${survivor} must never be planned`);
    }
    for (const victim of [`${ART}/release-throwaway`, 'dist.bak-20260101-010101']) {
        assert.equal(doomed.has(victim), true, `${victim} must be planned`);
    }
    for (const item of plan.collections) {
        const [head] = item.path.split(path.sep);
        assert.equal(POLICY.neverTouch.includes(head), false, `plan touched ${item.path}`);
    }

    const report = await runRetention(root, { apply: true, now, breakers: { maxDeleteCount: 100 } });
    assert.equal(report.applied.failed.length, 0, JSON.stringify(report.applied.failed));
    assert.ok(fs.existsSync(path.join(root, ART, 'incidents')));
    assert.ok(fs.existsSync(path.join(root, ART, 'release-node-24.20.0')));
    assert.ok(fs.existsSync(path.join(root, 'dist-server.bak-previous')));
    assert.equal(fs.existsSync(path.join(root, ART, 'release-throwaway')), false);
    for (const forbidden of POLICY.neverTouch) {
        assert.ok(fs.existsSync(path.join(root, forbidden, 'inner')), `${forbidden} must survive`);
    }
});

test('لا خروج عن الجذر: الروابط الرمزية لا تُتبع ولا تُنقل', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const outside = scratchDir(t, 'outside');
    const outsideVictim = path.join(outside, 'precious');
    fs.mkdirSync(outsideVictim);
    fs.writeFileSync(path.join(outsideVictim, 'keep.txt'), 'keep');

    const link = path.join(root, ART, 'fleet8-escape-hatch');
    fs.symlinkSync(outsideVictim, link);
    const past = new Date(now - 90 * DAY_MS);
    fs.lutimesSync(link, past, past);

    const report = await runRetention(root, { apply: true, now });

    assert.equal(
        report.collections.some((item) => item.path.includes('fleet8-escape-hatch')), false,
        'symlinked entry must never be planned',
    );
    assert.ok(report.sections.artifacts.skipped.some((item) => item.name === 'fleet8-escape-hatch'));
    assert.ok(fs.existsSync(path.join(outsideVictim, 'keep.txt')), 'outside target must survive');
    assert.ok(fs.existsSync(link), 'the symlink itself must survive');

    assert.throws(() => resolveInsideRoot(root, path.join(os.tmpdir(), 'anything')), /escapes project root/);
    assert.throws(() => resolveInsideRoot(root, path.join(root, 'database')), /never-touch/);
    assert.throws(() => resolveInsideRoot(root, path.join(root, '.git', 'config')), /never-touch/);
    assert.throws(() => resolveInsideRoot(root, path.join(root, 'dist-server', 'x')), /never-touch/);
    assert.throws(() => resolveInsideRoot(root, root), /escapes project root/);
});

test('السقف الإجمالي يجمع الأقدم أولاً ويتوقف عند بلوغه', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const size = 200_000;
    // أعمار فوق مهلة الإعفاء (capGraceMs = يومان) وتحت قاعدة العمر (14 يوماً).
    makeTree(root, `${ART}/fleet8-oldest`, { bytes: size, ageMs: 5 * DAY_MS, now });
    makeTree(root, `${ART}/fleet8-middle`, { bytes: size, ageMs: 4 * DAY_MS, now });
    makeTree(root, `${ART}/fleet8-newest`, { bytes: size, ageMs: 3 * DAY_MS, now });

    const policy = { ...POLICY, artifacts: { ...POLICY.artifacts, capBytes: 280_000 } };
    const artifacts = planRetention(root, { now, policy }).sections.artifacts;

    assert.equal(artifacts.candidateCount, 3);
    assert.deepEqual(names(artifacts.deletions), ['fleet8-middle', 'fleet8-oldest']);
    for (const item of artifacts.deletions) assert.match(item.reason, /cap \(oldest first\)/);
    assert.ok(artifacts.projectedBytesAfter <= policy.artifacts.capBytes);
    assert.equal(artifacts.capStillExceeded, false);

    const report = await runRetention(root, { apply: true, now, policy });
    assert.equal(report.applied.failed.length, 0, JSON.stringify(report.applied.failed));
    assert.equal(fs.existsSync(path.join(root, ART, 'fleet8-oldest')), false);
    assert.equal(fs.existsSync(path.join(root, ART, 'fleet8-middle')), false);
    assert.ok(fs.existsSync(path.join(root, ART, 'fleet8-newest')), 'newest candidate survives');
});

test('مهلة الإعفاء تحمي الحديث من قاعدة السقف وتُسمّى في التقرير', (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    // أحدث من مهلة الإعفاء (يومان) وأقدم من نافذة البناء (6 ساعات).
    makeTree(root, `${ART}/fleet8-fresh`, { bytes: 400_000, ageMs: 12 * HOUR_MS, now });

    const policy = { ...POLICY, artifacts: { ...POLICY.artifacts, capBytes: 1024 } };
    const artifacts = planRetention(root, { now, policy }).sections.artifacts;

    assert.deepEqual(artifacts.deletions, []);
    assert.equal(artifacts.capStillExceeded, true);
    assert.equal(artifacts.capBlockedBy, 'grace-window');
    assert.equal(artifacts.gracedCount, 1);
});

test('قاعدة العمر تسبق السقف ولا يمسّ الجمع غير المرشّحين', (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    makeTree(root, `${ART}/fleet8-ancient`, { bytes: 1024, ageMs: 20 * DAY_MS, now });
    makeTree(root, `${ART}/some-unrelated-output`, { bytes: 4_000_000, ageMs: 90 * DAY_MS, now });

    const policy = { ...POLICY, artifacts: { ...POLICY.artifacts, capBytes: 1024 } };
    const artifacts = planRetention(root, { now, policy }).sections.artifacts;

    assert.deepEqual(names(artifacts.deletions), ['fleet8-ancient']);
    assert.match(artifacts.deletions[0].reason, /older than 14d/);
    assert.equal(artifacts.capStillExceeded, true);
    assert.equal(artifacts.capBlockedBy, 'protected-content');
});

test('[بند 9] طبقات الجلسات خارج النطاق افتراضياً', async (t) => {
    const now = Date.now();
    const root = makeRoot(t);
    const report = await runRetention(root, { apply: false, now });
    assert.equal(report.reapOverlays, false);
    assert.equal(report.sections.sessionWorkspaces.outOfScope, true);
    assert.match(report.summary, /session overlays: out of scope/);
});

test('تحليل الوسائط: قيم مفقودة ووحدات الحجم', () => {
    assert.throws(() => parseArgs(['--root']), /--root requires a value/);
    assert.throws(() => parseArgs(['--root', '--json']), /--root requires a value/);
    assert.throws(() => parseArgs(['--max-delete-bytes']), /requires a value/);
    assert.throws(() => parseArgs(['--max-delete-count', 'abc']), /non-negative integer/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);

    assert.equal(parseBytes('6G'), 6 * 1024 ** 3);
    assert.equal(parseBytes('500M'), 500 * 1024 ** 2);
    assert.equal(parseBytes('1024'), 1024);
    assert.throws(() => parseBytes('lots'), /invalid byte size/);

    assert.equal(parseArgs([]).apply, false, 'dry-run is the default');
    assert.equal(parseArgs(['--apply']).apply, true);
    assert.equal(parseArgs(['--apply', '--dry-run']).apply, false);
});

test('formatBytes يعطي وحدات مقروءة', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(4 * 1024 ** 3), '4.0 GiB');
});
