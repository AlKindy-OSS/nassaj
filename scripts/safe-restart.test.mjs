#!/usr/bin/env node
// ============================================================================
// scripts/safe-restart.test.mjs
// ----------------------------------------------------------------------------
// اختبارات scripts/safe-restart.sh. لا يوجد مشغّل اختبار للسكربتات في المستودع
// (راجع ترويسة safe-restart.sh)، فهذا سكربت node قائم بذاته بلا تبعيات.
//
//   الجزء A: اختبارات وحدة لدالة detect() — تُستخرَج **حرفياً** من safe-restart.sh
//            وقت التشغيل (لا نسخة موازية تنجرف) وتُشغَّل على حالات مطابقة المزوّد
//            (يحرس B-196: shim الحزمة، تخطّي قيم أعلام node، تمييز codex عن opencode).
//   الجزء B: اختبار تكامل يثبّت ترتيب إصدار --json بعد حسم القرار النهائي (B-198):
//            في مسار الحافة online+SERVER_PID-غير-محلول يجب أن تعكس التلمترية القرارَ
//            (sessionDetectError:true + sessionDetectBlock:true + reason النهائي)،
//            ورمز الخروج 6. يفشل على الكود القديم الذي كان يُصدر --json قبل حارس online.
//
// التشغيل: node scripts/safe-restart.test.mjs   (exit 0 = كل الحالات نجحت).
// ============================================================================
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// SR_SCRIPT يتيح تصويب الاختبار على نسخة سكربت بعينها (يُستعمل لإثبات أن اختبار
// الترتيب B-198 يفشل على الكود القديم)؛ الافتراضي = السكربت المجاور.
const SCRIPT = process.env.SR_SCRIPT || join(__dirname, 'safe-restart.sh');
const src = readFileSync(SCRIPT, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}: got ${g} want ${w}`); console.log(`  FAIL ${name}: got ${g} want ${w}`); }
}

// ── الجزء A: استخراج detect() حرفياً من safe-restart.sh ────────────────────────
// detect() ودوالّه/مجموعاته (base/PROV/INTERP/EVAL_FLAGS/VALUE_FLAGS/PKG_MARKERS)
// داخل heredoc لـSESSION_JSON. نستخرج base() (سطر واحد) + الكتلة من `const PROV`
// حتى بداية `const sessions = [];` (تلي نهاية detect مباشرةً)، ونبنيها في دالة.
console.log('# الجزء A: اختبارات وحدة detect() (مستخرَجة حرفياً من safe-restart.sh)');
const baseMatch = src.match(/const base = \(p\) => \{[^\n]*\};/);
const blockStart = src.indexOf('const PROV = new Set(');
const blockEnd = src.indexOf('const sessions = [];');
if (!baseMatch || blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) {
  console.error('ERR: تعذّر استخراج detect() من السكربت (تغيّرت العلامات؟).');
  process.exit(2);
}
const detectSrc = baseMatch[0] + '\n' + src.slice(blockStart, blockEnd) + '\nreturn detect;';
let detect;
try { detect = new Function(detectSrc)(); }
catch (e) { console.error('ERR: فشل بناء detect() المستخرَجة: ' + e.message); process.exit(2); }

const cases = [
  // ── مباشرة (PROV): basename(argv[0]) اسم مزوّد ───────────────────────────────
  ['claude مباشر',                 ['claude'],                                    'claude'],
  ['codex مباشر',                  ['codex'],                                     'codex'],
  ['agy مباشر',                    ['agy'],                                       'agy'],
  ['opencode مباشر',               ['opencode'],                                  'opencode'],
  ['hermes مباشر',                 ['hermes'],                                    'hermes'],
  ['claude بمسار مطلق',            ['/usr/local/bin/claude'],                     'claude'],
  ['codex بمسار + وسيط',           ['/opt/x/codex', 'resume'],                    'codex'],
  // ── سلبية: ليست جلسة مزوّد ───────────────────────────────────────────────────
  ['argv فارغ',                    [],                                            null],
  ['argv = null',                  null,                                          null],
  ['grep يحمل الاسم',              ['grep', 'claude'],                            null],
  ['محرِّر يفتح ملف codex',         ['vim', '/x/codex-live-cage.js'],              null],
  ['bash ليس مفسّراً مزوّداً',      ['bash', 'claude'],                            null],
  ['sh -c ليس مفسّراً مزوّداً',     ['sh', '-c', 'claude foo'],                    null],
  // ── مفسّر + basename السكربت (سلوك سابق) ─────────────────────────────────────
  ['node opencode.js',             ['node', '/x/opencode.js'],                    'opencode'],
  ['node claude.mjs',              ['node', '/x/claude.mjs'],                     'claude'],
  ['node codex.cjs',               ['node', '/x/codex.cjs'],                      'codex'],
  ['bun run opencode.js',          ['bun', 'run', '/x/opencode.js'],              'opencode'],
  ['bun run opencode (bareword)',  ['bun', 'run', 'opencode'],                    'opencode'],
  ['deno run hermes.js',           ['deno', 'run', '/x/hermes.js'],               'hermes'],
  // ── أعلام node التقييمية (EVAL_FLAGS) قبل رمز السكربت ⇒ null (B-196) ──────────
  ['node -e code',                 ['node', '-e', 'require("x");claude'],         null],
  ['node --eval code',             ['node', '--eval', 'opencode()'],              null],
  ['node -p code',                 ['node', '-p', 'codex'],                       null],
  ['node --print code',            ['node', '--print', 'agy'],                    null],
  // ── أعلام node ذات قيمة منفصلة (VALUE_FLAGS): تُتخطّى القيمة (B-196) ───────────
  ['node --loader ثم shim claude', ['node', '--loader', 'ts-node/esm', '/x/@anthropic-ai/claude-code/cli.js'], 'claude'],
  ['node -r ثم opencode.js',       ['node', '-r', 'esm', '/x/opencode.js'],       'opencode'],
  ['node --import ثم codex.mjs',   ['node', '--import', 'tsx', '/x/codex.mjs'],   'codex'],
  // ── shim حزمة عبر مقطع مسار (PKG_MARKERS — B-196) ────────────────────────────
  ['shim @anthropic-ai/claude-code', ['node', '/h/.npm/@anthropic-ai/claude-code/cli.js'], 'claude'],
  ['shim @openai/codex',           ['node', '/x/node_modules/@openai/codex/bin/index.js'], 'codex'],
  ['shim claude-code',             ['node', '/x/claude-code/cli.js'],             'claude'],
  ['shim opencode dir',            ['node', '/x/opencode/dist/index.js'],         'opencode'],
  ['shim agy dir',                 ['node', '/x/agy/bin.js'],                     'agy'],
  ['shim hermes dir',              ['node', '/x/hermes/run.js'],                  'hermes'],
  // ── تمييز codex عن opencode: '/opencode/' لا يُنسب codex (B-196) ──────────────
  ['opencode لا يُنسب codex',       ['node', '/x/opencode/cli.js'],               'opencode'],
  // ── وسيط موضعي بعد رمز السكربت الأول لا يُفحص (B-196) ─────────────────────────
  ['وسيط تالٍ opencode مُهمَل',      ['node', '/x/script.js', 'opencode'],          null],
  // ── shim مع أعلام لاحقة يُطابق على الرمز الأول ────────────────────────────────
  ['shim ثم علم لاحق',             ['node', '/x/@anthropic-ai/claude-code/cli.js', '--verbose'], 'claude'],
];
for (const [name, argv, want] of cases) eq('detect: ' + name, detect(argv), want);

// ── الجزء B: ترتيب إصدار --json بعد حسم القرار (B-198) ─────────────────────────
// نحاكي حالة الحافة «online مؤكّد + SERVER_PID غير محلول» حتمياً عبر pm2 مزيّف
// يُرجع status=online لكن pid=0 (غير صالح): استنباط SERVER_PID يفشل (pid≤0) بينما
// حارس online يرى status=online ⇒ PROC_ONLINE_CONFIRMED=1 مع SERVER_PID فارغ.
// لا --exec ⇒ لا restart إطلاقاً (غير مدمّر). المتوقّع: exit 6 وJSON نهائي متّسق.
console.log('# الجزء B: تكامل — ترتيب إصدار --json (B-198، online+pid-غير-محلول)');
function runEdgeCase() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-b198-'));
  const wfBase = join(dir, 'wf');            // موجود لكن فارغ ⇒ scanned=0
  mkdirSync(wfBase, { recursive: true });
  const fakePm2 = join(dir, 'pm2');          // pm2 مزيّف على رأس PATH
  writeFileSync(fakePm2,
    '#!/usr/bin/env bash\n' +
    'case "$1" in\n' +
    "  jlist) printf '%s' '[{\"name\":\"nassaj-dev\",\"pid\":0,\"pm2_env\":{\"status\":\"online\",\"treekill\":false,\"kill_timeout\":86400000,\"env\":{}}}]' ;;\n" +
    '  *) exit 0 ;;\n' +
    'esac\n');
  chmodSync(fakePm2, 0o755);
  const env = {
    ...process.env,
    PATH: dir + ':' + process.env.PATH,      // pm2 المزيّف أولاً؛ node الحقيقي يبقى
    PROC_NAME: 'nassaj-dev',
    WF_BASE: wfBase,
    HEALTH_URL: 'http://127.0.0.1:1/health', // منفذ ميت ⇒ curl يفشل سريعاً (قراءة-فقط)
    WORKFLOW_SUPERVISOR: '',                  // مطفأ ⇒ لا systemctl
  };
  let stdout = '', code = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT, '--json'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    code = e.status;
  }
  return { stdout, code };
}

const edge = runEdgeCase();
const jsonLines = edge.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
let obj = null;
try { obj = JSON.parse(jsonLines[jsonLines.length - 1]); } catch (_) {}

// (1) رمز الخروج ما زال 6 — المرجع الآلي لمستهلك HTTP (B-193). لا انحدار.
eq('B-198: exit code = 6', edge.code, 6);
// (2) كائن JSON واحد فقط على stdout في هذا المسار (لا كائن يسبق القرار).
eq('B-198: كائن JSON واحد على stdout', jsonLines.length, 1);
// (3) التلمترية تعكس القرار النهائي fail-closed — تفشل على الكود القديم (كان false).
eq('B-198: sessionDetectError = true (نهائي)', obj && obj.sessionDetectError, true);
eq('B-198: sessionDetectBlock = true (نهائي)', obj && obj.sessionDetectBlock, true);
eq('B-198: sessionDetectReason = server_pid_unresolved_while_online',
   obj && obj.sessionDetectReason, 'server_pid_unresolved_while_online');
// (4) حقول الفحص محفوظة (لم يُكسر دمج SCAN_JSON).
eq('B-198: scan ok = true محفوظ', obj && obj.ok, true);
eq('B-198: sessionCount = 0 محفوظ', obj && obj.sessionCount, 0);
eq('B-198: sessionServerPid = null (pid غير محلول)', obj && obj.sessionServerPid, null);

// ── الجزء C: اشتقاق WF_BASE بلا مسار مثبَّت (B-302) ───────────────────────────
// الانحدار الذي يحرسه هذا الجزء: تنظيفُ اسم مستودع الحوكمة قبل النشر استبدل
// الاحتياطيَّ المثبَّت بعبارة وصفية فيها مسافات داخل سطر تنفيذي، فصار
// المسار غير موجود وخرج الحارس بـ2 (خطأ إعداد) عند كل تشغيل من الخادم — بيئة pm2
// لا تحمل CLAUDE_CONFIG_DIR — بينما نجح من صدفة المشغّل التي تحمله. النتيجة في
// الواجهة: «An unexpected error occurred» بدل «أُجِّل: جلسات حيّة».
//
// يُشغَّل السكربت ببيئة معزولة تماماً (env -i فعلياً: كائن env مبنيّ من الصفر) مع
// HOME مؤقّت، فيتوقّف عند بوابة WF_BASE قبل أي تفاعل مع pm2 — لا يلمس النظام.
console.log('\n# الجزء C: اشتقاق WF_BASE بلا مسار مثبَّت (B-302)');
function runWithHome(home, { withProjects }) {
  const escaped = __dirname.replace(/\/scripts$/, '').replace(/\//g, '-');
  if (withProjects) {
    mkdirSync(join(home, '.claude', 'projects', escaped), { recursive: true });
  }
  const env = {
    PATH: process.env.PATH,     // node مطلوب للتحليل؛ لا CLAUDE_CONFIG_DIR ولا WF_BASE
    HOME: home,
    HEALTH_URL: 'http://127.0.0.1:1/health',
    WORKFLOW_SUPERVISOR: '',
  };
  let stdout = '', code = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT, '--json'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    code = e.status;
  }
  const line = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop();
  let parsed = null;
  try { parsed = JSON.parse(line); } catch (_) {}
  return { code, parsed };
}

// (1) بلا جذر claude على الإطلاق: يفشل بـwf_base_missing — وهو صحيح — لكن المسار
//     المذكور يجب أن يكون مشتقاً حقيقياً تحت $HOME/.claude، لا عبارةً بشرية.
const missing = runWithHome(mkdtempSync(join(tmpdir(), 'sr-wfbase-none-')), { withProjects: false });
eq('B-302: بلا جذر ⇒ الخطأ wf_base_missing', missing.parsed && missing.parsed.error, 'wf_base_missing');
eq('B-302: الاحتياطي تحت $HOME/.claude/projects',
   Boolean(missing.parsed && /\/\.claude\/projects\//.test(missing.parsed.wfBase)), true);
eq('B-302: لا مسافات في المسار المشتقّ (لا عبارة وصفية في سطر تنفيذي)',
   Boolean(missing.parsed && !/\s/.test(missing.parsed.wfBase)), true);

// (2) جذر claude قياسي موجود بلا CLAUDE_CONFIG_DIR: يجب تجاوز بوابة WF_BASE —
//     أي ألّا يكون سبب الخروج wf_base_missing (يخرج لاحقاً على pm2، وهذا مقبول).
const found = runWithHome(mkdtempSync(join(tmpdir(), 'sr-wfbase-std-')), { withProjects: true });
eq('B-302: $HOME/.claude موجود ⇒ لا wf_base_missing',
   Boolean(found.parsed && found.parsed.error === 'wf_base_missing'), false);
eq('B-302: ولا يخرج بـ2 (خطأ إعداد)', found.code === 2, false);

// ── الحصيلة ───────────────────────────────────────────────────────────────────
console.log(`\nالمجموع: ${pass} ناجحة / ${fail} فاشلة (من ${pass + fail}).`);
if (fail > 0) { console.log('الفواشل:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
process.exit(0);
