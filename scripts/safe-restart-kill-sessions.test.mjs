#!/usr/bin/env node
// ============================================================================
// scripts/safe-restart-kill-sessions.test.mjs  (T-1677, ADR-066)
// ----------------------------------------------------------------------------
// اختبارات علم --kill-sessions ومتغيّر NASSAJ_RESTART_KILL_SESSIONS في
// safe-restart.sh. ملف مستقل بجوار safe-restart.test.mjs (الذي تعدّله جلسة أخرى)
// تفادياً للتضارب. لا يوجد مشغّل اختبار للسكربتات (راجع ترويسة safe-restart.sh).
//
// ⚠️ لا يُشغَّل أي مسار --exec إطلاقاً (ممنوع: قد يعيد تشغيل الخادم فعلاً). كل
//    التحققات هنا: (أ) قراءة-فقط (--json)، (ب) رفض وسائط (exit 2 قبل أي تنفيذ)،
//    (ج) تأكيدات على نصّ السكربت (وجود المنطق وترتيبه).
//
// التشغيل: node scripts/safe-restart-kill-sessions.test.mjs   (exit 0 = نجاح).
// ============================================================================
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'safe-restart.sh');
const src = readFileSync(SCRIPT, 'utf8');

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ': ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// يشغّل السكربت (قراءة-فقط) بمهلة قصيرة ويعيد {code, stderr, stdout}. افتراضياً
// PROC_NAME مبدّل إلى اسم وهمي كي لا يلمس أي عملية pm2 حقيقية؛ مرّر {realProc:true}
// لاستخدام الاسم الحقيقي (لاختبار مسار القراءة --json الذي يعتمد وجود العملية).
function run(args, extraEnv = {}, { realProc = false } = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!realProc) env.PROC_NAME = '__nassaj_t1677_test_nope__';
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  return { code: r.status, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}
const lastJson = (stdout) => {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { return null; }
};

console.log('# safe-restart --kill-sessions / NASSAJ_RESTART_KILL_SESSIONS (T-1677)');

// (1) رفض --kill-sessions بلا --exec → exit 2 برسالة «requires --exec»
//     (يثبت أنه علم معروف يتطلّب --exec، لا وسيط مجهول).
{
  const r = run(['--kill-sessions']);
  ok('--kill-sessions بلا --exec ⇒ exit 2', r.code === 2, `code=${r.code}`);
  ok('--kill-sessions بلا --exec ⇒ رسالة requires --exec',
    /requires --exec/.test(r.stderr), r.stderr.slice(0, 120));
  ok('--kill-sessions بلا --exec ليست رسالة «unknown arg» (علم معروف)',
    !/unknown arg/.test(r.stderr));
}

// (1ب) --kill-sessions --json (لا --exec) يبقى مرفوضاً (يتطلّب --exec).
{
  const r = run(['--kill-sessions', '--json']);
  ok('--kill-sessions --json (بلا --exec) ⇒ exit 2', r.code === 2, `code=${r.code}`);
}

// (2) تباين: وسيط مجهول ⇒ exit 2 برسالة «unknown arg» (يميّز القبول عن الرفض).
{
  const r = run(['--totally-unknown-xyz']);
  ok('وسيط مجهول ⇒ exit 2', r.code === 2, `code=${r.code}`);
  ok('وسيط مجهول ⇒ رسالة unknown arg', /unknown arg/.test(r.stderr), r.stderr.slice(0, 120));
}

// (3) متغيّر البيئة في وضع القراءة (--json): يُتجاهَل تماماً — لا قتل، ونتيجة
//     مطابقة للتشغيل بلا env. نستخدم الاسم الحقيقي (القراءة تعتمد وجود العملية)،
//     ولا نثبّت رمز خروج بعينه (يتبع الحالة الحيّة)، بل نُثبت التكافؤ وغياب القتل.
{
  const withEnv = run(['--json'], { NASSAJ_RESTART_KILL_SESSIONS: '1' }, { realProc: true });
  const without = run(['--json'], {}, { realProc: true });
  ok('القراءة مع env القتل لا تُصدر SR-SESSION-KILLED (env مُتجاهَل في القراءة)',
    !/SR-SESSION-KILLED/.test(withEnv.stderr));
  const a = lastJson(withEnv.stdout);
  const b = lastJson(without.stdout);
  ok('القراءة مع env القتل تُصدر JSON صالحاً', a !== null && typeof a === 'object');
  ok('exit code متطابق مع/بدون env في القراءة', withEnv.code === without.code,
    `withEnv=${withEnv.code} without=${without.code}`);
  ok('sessionCount متطابق مع/بدون env في القراءة',
    a && b && a.sessionCount === b.sessionCount, `${a?.sessionCount} vs ${b?.sessionCount}`);
}

// (4) تأكيدات نصّية على منطق القتل وترتيبه (لا يمكن تشغيل --exec بأمان هنا).
ok('محلّل الوسائط يعرف --kill-sessions', /--kill-sessions\)\s*_KILL_SESSIONS_FLAG=1/.test(src));
ok('دالة القتل _kill_live_sessions موجودة', /_kill_live_sessions\(\)\s*\{/.test(src));
ok('يُرسَل SIGTERM ثم SIGKILL', /kill -TERM/.test(src) && /kill -KILL/.test(src));
ok('كل قتل مسجَّل بصيغة SR-SESSION-KILLED pid=… provider=…',
  /SR-SESSION-KILLED pid=\$\{x\.pid\} provider=\$\{x\.provider\}/.test(src));
ok('إعادة الكشف بعد القتل عبر _scan_session_json', /_kill_live_sessions[\s\S]*?SESSION_JSON="\$\(_scan_session_json\)"/.test(src));
ok('فشل القتل fail-closed ⇒ exit 6', /SR-SESSION-KILL-FAILED[\s\S]*?exit 6/.test(src));
ok('env القتل يُقبَل في --exec فقط', /if \[ "\$DO_EXEC" -eq 1 \] && _truthy "\$\{NASSAJ_RESTART_KILL_SESSIONS:-\}"/.test(src));
ok('القتل يستلزم FORCE ضمناً', /if \[ "\$KILL_SESSIONS" -eq 1 \]; then\s*\n\s*FORCE=1/.test(src));
// كتلة القتل تسبق قرار التأجيل (كي يُعاد الكشف قبل الحكم).
{
  const killIdx = src.indexOf('اقتل الجلسات الحيّة قتلاً صريحاً قبل قرار التأجيل');
  const deferIdx = src.indexOf('if [ "$SESSION_COUNT" -gt 0 ] || [ "$LIVE_COUNT" -gt 0 ] || [ "$SESSION_DETECT_BLOCK" -eq 1 ]; then');
  ok('كتلة القتل تسبق كتلة التأجيل', killIdx > 0 && deferIdx > 0 && killIdx < deferIdx,
    `killIdx=${killIdx} deferIdx=${deferIdx}`);
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'}: ${pass} ok, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error('  - ' + f); process.exit(1); }
