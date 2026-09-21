#!/usr/bin/env node
// ============================================================================
// scripts/governance-write-guard.test.mjs
// ----------------------------------------------------------------------------
// حارس B-573 — لا قناةَ كتابةٍ من دليل عمل مشروع إلى مادة حوكمة الأسطول.
//
// العطل الأصلي (مقيس 2026-08-07): كان `<repo>/AGENTS.md` و`<repo>/GEMINI.md`
// رابطَين رمزيَّين إلى `~/.claude/{AGENTS,GEMINI}.md` — وهو نفسه
// `nassaj-core/` — بهدفٍ 0644. فأي جلسة أو وكيل أو أداة تكتب `AGENTS.md` في
// جذر المشروع كانت تكتب **في تعليمات كل المستخدمين وكل المحرّكات**، ثم تنشر
// آلية الشفاء بفحص البصمة ذلك التسميم إلى نُسخ المستخدمين عند أول إطلاق.
// وأثبت القياس أن الواصف المفتوح على الرابط يحمل inode المصدر نفسه.
//
// الثابتة الواجب صونها — ثلاثة أشطر معاً، وسقوط أيّها يُعيد الثغرة:
//
//   1. نوعاً:  مادة الحوكمة في جذر المشروع **نسخة** لا رابط رمزي.
//   2. إذناً:  غير قابلة للكتابة (0444) — فلا كتابة ساذجة ولا سهو.
//   3. هويةً:  بصمتها sha256 **مطابقة** للمصدر المحايد — وإلا سقطت حوكمة
//              المحرّكات التي تقرأ من دليل العمل: cursor و agy و hermes
//              و opencode (ملف مطابقٌ في الاسم ومنحرفٌ في المحتوى أسوأ من
//              غيابه، لأنه يمرّ صامتاً).
//
// لماذا نسخة لا رابط؟ هي الثابتة الأمنية نفسها التي يفرضها المستودع أصلاً على
// نُسخ المزوّدين في `server/services/isolation/vendor-cli-governance-material.js`
// («‏a hostile same-uid turn … can NEVER write THROUGH a link into the shared,
// fleet-wide neutral source»). كان جذر المشروع هو الموضع الوحيد المتخلّف عنها.
//
// ‏0444 ليست حاجزاً أمام مهاجم على الـuid نفسه — يستطيع `chmod` ثم الكتابة.
// الضمانة الصلبة أن النسخة **ليست قناة**: أسوأ ما يبلغه إفسادُ النسخة المحلية،
// ولا يبلغ مصدرَ الأسطول أبداً. وهذا الحارس هو ما يكشف ذلك الإفساد.
//
// لماذا حارسٌ لا تعليق؟ لأن الملف **مُهمَل في `.gitignore:220-221`** عمداً (الروح
// في نسّاج-كور لا هنا، commit a91bb036)، فلا يظهر في `git status` ولا في أي
// مراجعة diff. هذا الحارس هو ما يجعل ملفاً غير مرئيّ **مُثبَتاً** على كل تشغيل.
//
// التشغيل:  node scripts/governance-write-guard.test.mjs     (exit 0 = نجح)
//           يعمل ضمن `npm test` ← `test:scripts`، ومنه في CI على كل دفعة.
// ============================================================================
import { lstatSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// يقبل التصويب على جذرٍ بعينه — للاختبار الذاتي السلبي (إثبات أن الحارس يسقط
// فعلاً حين تعود الثغرة) ولفحص جذور أخرى يدوياً. الافتراضي جذر هذا المستودع.
const REPO_ROOT =
    process.env.NASSAJ_GOVERNED_REPO_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ‏(أ) ما **يُتوقَّع وجوده** في جذر المشروع لأن محرّكات تقرؤه من دليل العمل ولا
// قناة أخرى لها. المرجع المقيس:
// docs/design/engine-instruction-redirect-research-2026-08-07.md
//   cursor  → AGENTS.md   (صعود الأسلاف؛ **لا متغيّر ولا علم ولا مفتاح** — هذه
//                          قناة حوكمته الوحيدة، فغيابها يُسقط حوكمة محرّك كامل)
//   agy     → GEMINI.md · AGENTS.md   (‏HOME فقط؛ GEMINI_CLI_HOME لا يعمل، مقيس)
//   hermes  → AGENTS.md  (من cwd)   ·   opencode → AGENTS.md
// وcodex يحجب مستوى المشروع صراحةً بـ project_doc_max_bytes=0 فلا يعنيه هذا.
// وهما الاسمان نفسهما اللذان يستبدلهما scripts/export-public.sh بنسخة محايدة —
// تأكيدٌ مستقل أن هذين بالذات هما سطح الحوكمة على مستوى المشروع.
const EXPECTED_AT_ROOT = ['AGENTS.md', 'GEMINI.md'];

// ‏(ب) ما **يُمنع أن يكون قناة كتابة** إن وُجد — أوسع من (أ). ‏NASSAJ.md
// و AGENTS.codex.md يصلان المحرّكات عبر `~/.claude/CLAUDE.md` و`$CODEX_HOME`
// لا عبر جذر المشروع، فوجودهما هنا ليس مطلوباً؛ لكن ظهور أيّهما رابطاً كتابياً
// في جذر مشروع هو النمط نفسه الذي أغلقناه، فيُدان.
const GOVERNANCE_FILENAMES = [
    ...EXPECTED_AT_ROOT,
    'AGENTS.codex.md',
    'CLAUDE.md',
    'NASSAJ.md',
];

// جذر مادة الحوكمة المحايدة. ‏`~/.claude` رابط إلى `nassaj-core` على عقد
// الأسطول، فنحلّه فعلياً كي تُقارَن المسارات بالحقيقة لا بالاسم.
const GOVERNANCE_ROOT = (() => {
    const raw = process.env.NASSAJ_GOVERNANCE_ROOT || join(homedir(), '.claude');
    try {
        return realpathSync(raw);
    } catch {
        return null;
    }
})();

let pass = 0;
let fail = 0;
const repairs = [];

function check(name, condition, detail) {
    if (condition) {
        pass++;
        console.log(`  ok   ${name}`);
    } else {
        fail++;
        console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
    }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** المصدر المحايد لاسم ملف حوكمة، أو null إن لم يكن على هذه العقدة. */
function neutralSourceFor(filename) {
    if (!GOVERNANCE_ROOT) return null;
    const p = join(GOVERNANCE_ROOT, filename);
    try {
        const st = lstatSync(p);
        // المصدر ملفٌ حقيقي غير فارغ. رابطٌ هنا يعني إعداداً لا نعرفه — لا نبني عليه.
        return st.isFile() && st.size > 0 ? p : null;
    } catch {
        return null;
    }
}

// ---- الشطر الأول: جذر هذا المستودع — يعمل في كل بيئة بما فيها CI ------------
console.log(`\n[1] مادة الحوكمة في جذر المستودع — ${REPO_ROOT}`);

for (const filename of GOVERNANCE_FILENAMES) {
    const target = join(REPO_ROOT, filename);
    const source = neutralSourceFor(filename);

    let st = null;
    try {
        st = lstatSync(target);
    } catch {
        st = null;
    }

    if (!st) {
        if (source && EXPECTED_AT_ROOT.includes(filename)) {
            // عقدة مشغِّل: المصدر موجود والنسخة غائبة ⇒ سقطت حوكمة المحرّكات
            // التي تقرأ من دليل العمل (cursor بالذات، فلا قناة أخرى له).
            check(
                `${filename} — موجود بجانب مصدرٍ محايد قائم`,
                false,
                `المصدر ${source} موجود ولا نسخة في جذر المستودع. ` +
                    'المحرّكات التي تقرأ من دليل العمل (cursor، agy، hermes، opencode) ' +
                    'تعمل الآن بلا حوكمة نسّاج.'
            );
            repairs.push([target, source]);
        } else if (source) {
            // مادة حوكمة تصل المحرّكات بقناة أخرى (‏CODEX_HOME، ‏~/.claude/CLAUDE.md)
            // فغيابها من جذر المشروع هو الحالة الصحيحة لا نقصاً.
            console.log(`  skip ${filename} — لا يُجسَّد في جذر المشروع (قناته أخرى)`);
        } else {
            // نسخة عامة من الـfork بلا مادة حوكمة مشغِّل — الحالة الصحيحة.
            console.log(`  skip ${filename} — لا نسخة ولا مصدر محايد (استنساخ عام)`);
        }
        continue;
    }

    // (1) نوعاً — رابطٌ رمزي هو الثغرة بعينها.
    const isLink = st.isSymbolicLink();
    check(
        `${filename} — نسخة حقيقية لا رابط رمزي`,
        !isLink,
        isLink
            ? `رابط إلى ${(() => {
                  try {
                      return realpathSync(target);
                  } catch {
                      return '(هدف معطوب)';
                  }
              })()} — الكتابة هنا تنفذ إلى مادة حوكمة الأسطول (B-573).`
            : `${filename} ليس ملفاً عادياً.`
    );
    if (isLink) {
        if (source) repairs.push([target, source]);
        continue;
    }

    if (!st.isFile()) {
        check(`${filename} — ملف عادي`, false, 'ليس ملفاً عادياً ولا رابطاً.');
        continue;
    }

    // (2) إذناً — أي بت كتابة مرفوع يعيد فتح الباب للكتابة الساذجة.
    const mode = st.mode & 0o777;
    check(
        `${filename} — غير قابل للكتابة (المقيس ${mode.toString(8).padStart(4, '0')})`,
        (st.mode & 0o222) === 0,
        `المتوقَّع 0444. أصلحه بـ: chmod 0444 ${target}`
    );

    // (3) هويةً — بصمة مطابقة للمصدر، وإلا فالحوكمة منحرفة صامتة.
    if (!source) {
        console.log(`  skip ${filename} — لا مصدر محايد على هذه العقدة، فلا مقارنة بصمة`);
        continue;
    }
    const got = sha256(readFileSync(target));
    const want = sha256(readFileSync(source));
    const identical = got === want;
    check(
        `${filename} — بصمته مطابقة للمصدر المحايد`,
        identical,
        `النسخة=${got.slice(0, 16)}…  المصدر=${want.slice(0, 16)}…\n` +
            `       ‏build-agents أعاد توليد المصدر (أو أُفسدت النسخة). ` +
            'ما يقرؤه cursor الآن ليس حوكمة نسّاج الحالية.'
    );
    if (!identical) repairs.push([target, source]);
}

// ---- الشطر الثاني: كنس جذور المشاريع المجاورة عن تكرار النمط ----------------
// يُتخطّى معلَناً حين لا تكون بنية الأسطول موجودة (CI مثلاً) — تخطٍّ مصرَّح به
// لا نجاحٌ صامت، على عُرف scripts/keepalive-invariant.test.mjs.
const PROJECTS_DIR = process.env.NASSAJ_PROJECTS_DIR || dirname(REPO_ROOT);
console.log(`\n[2] كنس جذور المشاريع المجاورة — ${PROJECTS_DIR}`);

if (!GOVERNANCE_ROOT || !existsSync(PROJECTS_DIR)) {
    console.log(`  skip لا مادة حوكمة (${GOVERNANCE_ROOT ?? 'غائبة'}) أو لا دليل مشاريع`);
} else {
    let entries = [];
    try {
        entries = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) =>
            e.isDirectory()
        );
    } catch (err) {
        console.log(`  skip تعذّرت قراءة ${PROJECTS_DIR}: ${err.message}`);
    }

    const offenders = [];
    for (const dir of entries) {
        const root = join(PROJECTS_DIR, dir.name);
        for (const filename of GOVERNANCE_FILENAMES) {
            const p = join(root, filename);
            let st;
            try {
                st = lstatSync(p);
            } catch {
                continue;
            }
            if (!st.isSymbolicLink()) continue;

            let real;
            try {
                real = realpathSync(p);
            } catch {
                continue; // رابط معطوب: لا ينفذ إلى شيء، فليس قناة كتابة.
            }
            // الحدّ الفاصل المقصود: **قمة** شجرة الحوكمة (مادة الأسطول) وحدها.
            // ‏`nassaj-core/products/<منتج>/docs/*` روابط عملٍ مقصودة يكتب فيها
            // الوكلاء خططاً وقرارات — ليست مادة حوكمة ولا تُدان هنا.
            if (dirname(real) !== GOVERNANCE_ROOT) continue;

            let writable = false;
            try {
                writable = (lstatSync(real).mode & 0o222) !== 0;
            } catch {
                writable = false;
            }
            offenders.push({ link: p, real, writable });
        }
    }

    check(
        'لا رابط رمزي في جذر أي مشروع ينفذ إلى مادة حوكمة الأسطول',
        offenders.length === 0,
        offenders
            .map(
                (o) =>
                    `${o.link}\n         → ${o.real} (${o.writable ? 'قابل للكتابة — ثغرة حيّة' : 'الهدف للقراءة فقط'})`
            )
            .join('\n       ')
    );
    for (const o of offenders) {
        if (basename(o.link) && existsSync(o.real)) repairs.push([o.link, o.real]);
    }
    if (offenders.length === 0) {
        console.log(`  info فُحص ${entries.length} جذر مشروع`);
    }
}

// ---- الإصلاح: يُطبع ولا يُنفَّذ، على عُرف scripts/doctor.mjs -------------------
// هذا الحارس **للقراءة فقط**: لا يكتب في مستودع ولا يغيّر إذناً. أن يشفي نفسه
// صامتاً يعني أن انحراف المصدر لن يُرى أبداً — والرؤية هي الغرض.
if (repairs.length > 0) {
    console.error('\n  الإصلاح — بالآلية المُعتمدة في المستودع (نسخة 0444، لا رابط):\n');
    console.error(
        "    node --input-type=module -e \"import {materializeGovernanceCopy} from " +
            "'$PWD/server/services/isolation/vendor-cli-governance-material.js';" +
            [...new Set(repairs.map(([t, s]) => `materializeGovernanceCopy('${dirname(t)}','${basename(t)}','${s}');`))].join('') +
            '"\n'
    );
}

console.log(`\nنجح: ${pass}  فشل: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
