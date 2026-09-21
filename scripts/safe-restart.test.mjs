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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, copyFileSync, existsSync } from 'node:fs';
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
// detectSessionId يقع في المدى نفسه (بين detect وsessions)، ويُصدَّر معه لأن قصّ
// سياج bwrap يخصّه أيضاً تحت القفص (B-327).
const detectSrc = baseMatch[0] + '\n' + src.slice(blockStart, blockEnd) + '\nreturn { detect, detectSessionId };';
let detect, detectSessionId;
try { ({ detect, detectSessionId } = new Function(detectSrc)()); }
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
  // ── تحت قفص المزوّدات: argv[0]=bwrap (B-327/T-1113) ──────────────────────────
  // بلا هذا كان basename=bwrap ∉ PROV ⇒ الجلسة غير مرئية ⇒ تمرير زائف ⇒ 502 (B-95).
  ['قفص: bwrap -- claude',         ['bwrap', '--unshare-user', '--', 'claude'],   'claude'],
  ['قفص: bwrap بمسار مطلق',        ['/opt/codex/bwrap', '--dev', '/dev', '--', 'codex'], 'codex'],
  ['قفص: تركيب ثم مزوّد',          ['bwrap', '--ro-bind', '/usr', '/usr', '--tmpfs', '/workspace/.nassaj-users', '--bind', '/w', '/w', '--', 'agy'], 'agy'],
  ['قفص: shim مفسّر بعد الفاصل',    ['bwrap', '--bind', '/a', '/a', '--', 'node', '/x/@anthropic-ai/claude-code/cli.js'], 'claude'],
  ['قفص: hermes بعد الفاصل',       ['bwrap', '--proc', '/proc', '--', '/usr/bin/hermes'], 'hermes'],
  // قيمة علم اسمها مزوّد يجب ألّا تُلتقط قبل الفاصل (سبب رفض عدّ الأرِيّات).
  ['قفص: مسار تركيب باسم مزوّد',    ['bwrap', '--bind', '/opt/opencode', '/opt/opencode', '--', 'claude'], 'claude'],
  // fail-closed: bwrap لا يحمل الفاصل ⇒ لا نمرّ على عمياء بل نعدّه جلسة حيّة.
  ['قفص: بلا فاصل ⇒ caged',        ['bwrap', '--unshare-all', 'claude'],          'caged'],
  ['قفص: الفاصل آخر رمز ⇒ caged',  ['bwrap', '--dev', '/dev', '--'],              'caged'],
  ['قفص: أمر مجهول بعد الفاصل',    ['bwrap', '--', '/usr/bin/some-tool'],         'caged'],
  ['قفص: bubblewrap اسماً بديلاً',  ['bubblewrap', '--', 'codex'],                'codex'],
];
for (const [name, argv, want] of cases) eq('detect: ' + name, detect(argv), want);

// ── الجزء A2: القفص على argv حقيقي من buildCagedLaunch لا من fixture (B-327) ───
// الحالات أعلاه مصطنعة بيدي، وقد تمرّ كلها بينما الشكل الحقيقي مختلف — وهو بالضبط
// ما حدث في حادثة reconcile ‏2026-06-28 (‏regex طابق 6.5% من الواقع رغم 18/18 خضراء).
// فنبني هنا argv من **مُنتِج الإنتاج نفسه** ونمرّره على detect() المستخرَجة، ليكسر
// الاختبارُ إن غيّر أحدٌ عقد الفاصل `--` في provider-cage.js.
console.log('\n# الجزء A2: كشف القفص على argv حقيقي من buildCagedLaunch (B-327)');
try {
  process.env.NASSAJ_PROVIDER_CAGE = 'true';
  const { buildCagedLaunch } = await import('../server/services/isolation/provider-cage.js');
  for (const prov of ['claude', 'agy', 'opencode', 'hermes']) {
    const built = buildCagedLaunch(
      { userId: 2, provider: prov, cmd: prov, args: ['--resume', 'abc12345'], cwd: process.cwd() },
      { resolveBwrapPath: () => '/usr/bin/bwrap' },
    );
    const argv = [built.cmd, ...built.args];
    eq(`قفص حقيقي: argv[0]=bwrap لـ${prov}`, argv[0].endsWith('/bwrap'), true);
    eq(`قفص حقيقي: detect يرى ${prov}`, detect(argv), prov);
    eq(`قفص حقيقي: sessionId يُقرأ لـ${prov}`, detectSessionId(argv), 'abc12345');
  }
} catch (e) {
  eq('قفص حقيقي: تعذّر بناء argv الإنتاج (' + (e && e.message) + ')', false, true);
} finally {
  delete process.env.NASSAJ_PROVIDER_CAGE;
}

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

// ── الجزء B2: مسار rollback recovery المقيد داخل safe-restart نفسه ────────────
console.log('\n# الجزء B2: تكامل rollback recovery (PM2 errored)');
function runRecoveryCase({ guardOk, providerBlocked }) {
  const root = mkdtempSync(join(tmpdir(), 'sr-recovery-'));
  try {
    const buildId = 'a'.repeat(64);
    const artifactScripts = join(root, '.nassaj-local-preview', 'server-candidates', buildId, 'scripts');
    const liveScripts = join(root, 'dist-server', 'scripts');
    const bin = join(root, 'bin');
    const wfBase = join(root, 'wf');
    mkdirSync(artifactScripts, { recursive: true });
    mkdirSync(liveScripts, { recursive: true });
    mkdirSync(bin);
    mkdirSync(wfBase);
    const candidateSafeRestart = join(artifactScripts, 'safe-restart.sh');
    copyFileSync(SCRIPT, candidateSafeRestart);
    chmodSync(candidateSafeRestart, 0o755);
    writeFileSync(join(liveScripts, 'local-preview-server-activation.mjs'),
      'process.exit(process.env.RECOVERY_GUARD_OK === "1" ? 0 : 1);\n');

    const mutationLog = join(root, 'pm2-mutations.log');
    writeFileSync(join(bin, 'pm2'), `#!/usr/bin/env bash
case "$1" in
  jlist) printf '%s' '[{"name":"nassaj-dev","pid":0,"pm2_env":{"status":"errored","pm_cwd":"${root}","exec_interpreter":"${join(bin, 'node')}"}}]' ;;
  restart|save) printf '%s\\n' "$*" >> "${mutationLog}" ;;
esac
`);
    chmodSync(join(bin, 'pm2'), 0o755);
    writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
if [ "$1" = "-e" ] && [[ "$2" == *'const names=/(^|\\/)(claude'* ]]; then
  [ "${'${RECOVERY_PROVIDER_BLOCKED:-0}'}" = "1" ] && exit 1
  exit 0
fi
if [ "$1" = "-e" ] && [[ "$2" == *'better-sqlite3'* ]]; then exit 0; fi
exec "${process.execPath}" "$@"
`);
    chmodSync(join(bin, 'node'), 0o755);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
case "$*" in *http_code*) printf '200' ;; *) printf '{}' ;; esac
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROC_NAME: 'nassaj-dev',
      WF_BASE: wfBase,
      HEALTH_URL: 'http://127.0.0.1:1/health',
      WORKFLOW_SUPERVISOR: '',
      RECOVERY_GUARD_OK: guardOk ? '1' : '0',
      RECOVERY_PROVIDER_BLOCKED: providerBlocked ? '1' : '0',
    };
    let code = 0;
    try {
      execFileSync('bash', [candidateSafeRestart, '--rollback-recovery', '--exec'], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { code = error.status; }
    return { code, mutations: existsSync(mutationLog) ? readFileSync(mutationLog, 'utf8').trim().split('\n') : [] };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invalidRecovery = runRecoveryCase({ guardOk: false, providerBlocked: false });
eq('recovery: validation fail ⇒ exit 4', invalidRecovery.code, 4);
eq('recovery: validation fail ⇒ no PM2 mutation', invalidRecovery.mutations, []);
const blockedRecovery = runRecoveryCase({ guardOk: true, providerBlocked: true });
eq('recovery: provider blocker ⇒ exit 6', blockedRecovery.code, 6);
eq('recovery: provider blocker ⇒ no PM2 mutation', blockedRecovery.mutations, []);
const successfulRecovery = runRecoveryCase({ guardOk: true, providerBlocked: false });
eq('recovery: valid identity + zero provider ⇒ exit 0', successfulRecovery.code, 0);
eq('recovery: mutation is exactly restart then save', successfulRecovery.mutations,
  ['restart nassaj-dev', 'save']);

// ── الجزء C: اشتقاق WF_BASE بلا مسار مثبَّت (B-302) ───────────────────────────
// الانحدار الذي يحرسه هذا الجزء: تنظيفُ اسم مستودع الحوكمة قبل النشر استبدل
// الاحتياطيَّ المثبَّت بعبارة وصفية فيها مسافات داخل سطر تنفيذي، فصار
// المسار غير موجود وخرج الحارس بـ2 (خطأ إعداد) عند كل تشغيل من الخادم — بيئة pm2
// لا تحمل CLAUDE_CONFIG_DIR — بينما نجح من صدفة المشغّل التي تحمله. النتيجة في
// الواجهة: «An unexpected error occurred» بدل «أُجِّل: جلسات حيّة».
//
// B-1005: WF_BASE tests exercise the real shell gate with a non-daemonizing
// PM2 boundary. No real PM2 client (including cleanup/kill) is ever executed.
console.log('\n# الجزء C: اشتقاق WF_BASE بلا مسار مثبَّت (B-302)');
function runWithHome(home, { withProjects }) {
  const escaped = __dirname.replace(/\/scripts$/, '').replace(/\//g, '-');
  if (withProjects) mkdirSync(join(home, '.claude', 'projects', escaped), { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const calls = join(home, 'pm2-calls');
  const pm2 = join(bin, 'pm2');
  writeFileSync(pm2, `#!/bin/bash
printf '%s\\n' "$*" >> "$PM2_FIXTURE_CALLS"
case "$1" in
  jlist) printf '[]\\n' ;;
  describe) exit 1 ;;
  *) exit 97 ;;
esac
`);
  chmodSync(pm2, 0o700);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, PM2_HOME: join(home, '.pm2'),
    PM2_FIXTURE_CALLS: calls, NODE_OPTIONS: '--max-old-space-size=64',
    HEALTH_URL: 'http://127.0.0.1:1/health', WORKFLOW_SUPERVISOR: '',
  };
  let stdout = '', code = 0, observed = [];
  try {
    // Refuse before invoking the real shell if PATH no longer selects our stub.
    const resolvedPm2 = execFileSync('/bin/bash', ['-c', 'command -v pm2'], { env, encoding: 'utf8' }).trim();
    if (resolvedPm2 !== pm2) throw new Error('Unsafe PM2 fixture resolution');
    eq('B-1005: isolated PM2 executable', resolvedPm2, pm2);
    // timeout owns its process group; prlimit bounds CPU/address space and V8
    // heap is capped. Even a hung subprocess is killed within 22 seconds.
    stdout = execFileSync('/usr/bin/timeout', ['-k', '2s', '20s', '/usr/bin/prlimit',
      '--cpu=10', '--as=8589934592', '--', '/bin/bash', SCRIPT, '--json'],
    { env, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 });
  } catch (error) {
    stdout = (error.stdout || '').toString(); code = error.status;
    if (error.error || [124, 137, null].includes(code)) throw error;
  } finally {
    observed = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    eq('B-1005: no PM2 runtime/socket directory created', existsSync(env.PM2_HOME), false);
    rmSync(home, { recursive: true, force: true });
    eq('B-1005: fixture directory removed', existsSync(home), false);
  }
  eq('B-1005: only read-only PM2 boundary calls', observed.every(call => /^(jlist|describe(?: |$))/.test(call)), true);
  if (withProjects) eq('B-1005: existing workflow root reached PM2 boundary', observed.length > 0, true);
  const line = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).pop();
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* asserted by the caller */ }
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
//     ثم يتوقف عند حد PM2 الاصطناعي بلا إنشاء أي عفريت.
const found = runWithHome(mkdtempSync(join(tmpdir(), 'sr-wfbase-std-')), { withProjects: true });
eq('B-302: $HOME/.claude موجود ⇒ لا wf_base_missing',
   Boolean(found.parsed && found.parsed.error === 'wf_base_missing'), false);
eq('B-302: ولا يخرج بـ2 (خطأ إعداد)', found.code === 2, false);

// ── الحصيلة ───────────────────────────────────────────────────────────────────
console.log(`\nالمجموع: ${pass} ناجحة / ${fail} فاشلة (من ${pass + fail}).`);
if (fail > 0) { console.log('الفواشل:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
process.exit(0);
