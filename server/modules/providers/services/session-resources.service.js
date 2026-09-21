/**
 * session-resources.js — ما تستهلكه محادثة واحدة من موارد الجهاز، وما يستهلكه
 * الجهاز كلّه. قراءة محضة من `/proc`: لا يقتل عملية ولا يرسل إشارة ولا يعيد
 * تشغيل شيئاً.
 *
 * لماذا وُجد (حادثة 29–31 يوليو 2026): سقط الصندوق بـOOM بعد أن اجتمعت 14 جلسة
 * و22 وكيلاً فرعياً، ولم يكن في الواجهة أي مؤشّر يقول «هذه المحادثة تأكل 900MB».
 * كل مشارك قدّر أن عمله خفيف لأن لا أحد يرى المجموع.
 *
 * المفاتيح الثلاثة:
 *
 * 1. **الشجرة لا العملية.** جذر المحادثة عملية الـCLI، وكل ما تُطلقه المحادثة
 *    (وكلاء فرعيون، `playwright-mcp`، متصفّح، `vitest`، بناء) ذرّيّة لها. فالنَّسْب
 *    الصحيح = مجموع الشجرة، لا العملية الجذر وحدها.
 *
 * 2. **PSS لا RSS.** ‏`RSS` يعدّ الصفحة المشتركة مرّة في كل عملية تراها، فشجرة من
 *    عشر عمليات Node تشترك في نفس الثنائي تبدو أثقل مما هي بأضعاف. ‏`PSS` من
 *    `smaps_rollup` يقسم الصفحة المشتركة على قرّائها، فمجموع الأشجار لا يتجاوز
 *    الذاكرة الفعلية. حين يتعذّر `smaps_rollup` (عملية لمستخدم آخر، أو انتهت
 *    بين المسح والقراءة) نهبط إلى RSS **ونقول ذلك** في `memorySource`.
 *
 * 3. **المعالج فرقٌ بين عيّنتين، لا متوسط عمر.** ‏`utime+stime` منذ الإقلاع مقسوماً
 *    على العمر يعطي متوسّطاً يخفي الذروة تماماً. نحتفظ بعيّنة سابقة لكل pid
 *    ونحسب الفرق؛ وأول نداء يُعيد `cpuPercent: null` — لا صفراً. الصفر ادّعاء،
 *    والـnull اعتراف.
 *
 * وحدٌّ صريح: ‏`/tmp` و`/dev/shm` **لا يُنسبان لمحادثة** — نظام ملفات مشترك لا
 * يحمل هوية كاتبه بعد الكتابة. لذلك يظهران في `getSystemResources()` وحدها.
 *
 * تصحيح 2026-07-31: ما ثبت في تلك الحادثة أن `Shmem` نما 2.7GB وبقي 45 ساعة —
 * **ولم يُقَس `/tmp` ولا مرّة داخل النافذة**، فإسنادُ النموّ إليه استنتاجٌ لا
 * قياس. ‏`Shmem` يشمل tmpfs وذاكرةً مشتركة مجهولة (‏memfd الذي يحجزه Chromium
 * بكثافة)، وقياسٌ سابق يُظهر `/tmp=700MB` بينما `shared=327MB`. الفاعل غير
 * محدَّد بعد.
 */

import fs from 'fs';

// JS module (allowJs): سجلّ الـpid خدمة عابرة للوحدات خارج شجرة modules —
// نفس السماح المبارَك الذي يستعمله workflow-status.service.ts للملف نفسه.
// eslint-disable-next-line boundaries/no-unknown
import { resolveWorkflowPid } from '@/services/workflow-liveness.js';

/** ساعة النواة (jiffies في الثانية). ثابتة 100 على لينكس x86_64. */
const HERTZ = 100;

/** عيّنة CPU السابقة لكل pid: pid → { ticks, atMs }. */
const cpuSamples = new Map();

/** أقصى عدد عيّنات محفوظة — سقف نموّ لا سياسة. */
const MAX_CPU_SAMPLES = 4000;

/**
 * تصنيف العملية من سطر أمرها. الترتيب مقصود: الأكثر تحديداً أولاً، لأن سطر
 * أمر متصفّح playwright يحوي `node` أيضاً.
 *
 * @param {string} cmdline
 * @returns {'browser'|'agent'|'test'|'build'|'session'|'other'}
 */
export function classifyProcess(cmdline) {
  const c = String(cmdline || '');
  if (/chrome|chromium|playwright|puppeteer|headless_shell/i.test(c)) return 'browser';
  if (/vitest|jest|--test\b|node:test|playwright test/i.test(c)) return 'test';
  if (/\bvite build|next build|tsc\b|esbuild|rollup|webpack|npm run build/i.test(c)) return 'build';
  // وكيل فرعي: عملية CLI ابنة تحمل وسم مهمّة/وكيل. تُفحص بعد المتصفّح والاختبار
  // كي لا تبتلع متصفّحاً أطلقه وكيل.
  if (/\b(claude|agy|codex|kimi|opencode|hermes)\b/i.test(c)) return 'agent';
  return 'other';
}

/**
 * جدول العمليات كاملاً من `/proc`. عملية تنتهي أثناء المسح تُتجاوَز بصمت —
 * السباق هنا طبيعي لا خطأ.
 *
 * @returns {Map<number, {pid:number, ppid:number, comm:string, cmdline:string, ticks:number}>}
 */
export function readProcessTable() {
  const table = new Map();
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue;
    }
    // اسم العملية بين قوسين وقد يحوي مسافات وأقواس — نقصّ من آخر ')'
    const close = stat.lastIndexOf(')');
    const open = stat.indexOf('(');
    if (close < 0 || open < 0) continue;
    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).split(' ');
    // بعد القصّ: [0]=state [1]=ppid ... [11]=utime [12]=stime
    const ppid = Number(rest[1]);
    const ticks = (Number(rest[11]) || 0) + (Number(rest[12]) || 0);
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      cmdline = comm;
    }
    table.set(pid, { pid, ppid, comm, cmdline: cmdline || comm, ticks });
  }
  return table;
}

/**
 * كل ذرّيّة `rootPid` وهو معها. تحرس ضد الحلقات (pid مُعاد استعماله يشير إلى
 * سلف) بمجموعة المرئي.
 *
 * @param {number} rootPid
 * @param {Map<number, {pid:number, ppid:number}>} table
 * @returns {number[]}
 */
export function collectTree(rootPid, table) {
  if (!table.has(rootPid)) return [];
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * ذاكرة العملية بالكيلوبايت: ‏PSS إن أمكن، وإلا RSS مع الإفصاح.
 *
 * @param {number} pid
 * @returns {{kb:number, source:'pss'|'rss'} | null}
 */
export function readProcessMemoryKb(pid) {
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = rollup.match(/^Pss:\s+(\d+)\s+kB/m);
    // ‏SwapPss يُضاف: بدونه **ينخفض** الرقم لحظةَ يبدأ الضغط وتُبدَّل الصفحات —
    // إشارة معكوسة في اللحظة الوحيدة التي وُجد المؤشّر من أجلها.
    const swapPss = rollup.match(/^SwapPss:\s+(\d+)\s+kB/m);
    if (pss) {
      return { kb: Number(pss[1]) + (swapPss ? Number(swapPss[1]) : 0), source: 'pss' };
    }
  } catch {
    /* يهبط إلى RSS */
  }
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    const pages = Number(statm[1]);
    // صفر صفحات = زومبي أو عملية انتهت — قياسٌ فاشل لا قياسٌ بصفر.
    if (Number.isFinite(pages) && pages > 0) return { kb: (pages * 4096) / 1024, source: 'rss' };
  } catch {
    /* انتهت العملية */
  }
  return null;
}

/**
 * نسبة المعالج من فرق عيّنتين. أول نداء لأي pid يُعيد null (لا صفراً).
 *
 * @param {number} pid
 * @param {number} ticks
 * @param {number} nowMs
 * @returns {number | null}
 */
function cpuPercentFor(pid, ticks, nowMs) {
  const prev = cpuSamples.get(pid);
  // نافذة أقصر من ثانية تُنتج ضجيجاً لا قياساً: دقّة العدّاد 10ms، فـtick واحد
  // في نافذة 50ms يُقرأ 20%. والأهمّ ألّا **تُستبدل** العيّنة السابقة في هذه
  // الحالة، وإلا قتل كلُّ استطلاع نافذةَ سابقه فبقي الرقم null أو صفراً أبداً
  // (مشاهدان لنفس المحادثة يكفيان).
  if (prev && nowMs - prev.atMs < 1000) return null;
  cpuSamples.set(pid, { ticks, atMs: nowMs });
  if (!prev || nowMs <= prev.atMs) return null;
  const deltaSeconds = (nowMs - prev.atMs) / 1000;
  const deltaTicks = ticks - prev.ticks;
  if (deltaTicks < 0) return null; // pid أُعيد استعماله
  return (deltaTicks / HERTZ / deltaSeconds) * 100;
}

/** قصّ ذاكرة العيّنات حين تتجاوز السقف — الأقدم أولاً (‏Map يحفظ ترتيب الإدراج). */
function pruneCpuSamples(livePids) {
  if (cpuSamples.size <= MAX_CPU_SAMPLES) return;
  for (const pid of [...cpuSamples.keys()]) {
    if (!livePids.has(pid)) cpuSamples.delete(pid);
    if (cpuSamples.size <= MAX_CPU_SAMPLES) return;
  }
}

/**
 * جذر شجرة المحادثة. المصدر الأول سجلّ الـpid في الذاكرة؛ فإن كان فارغاً
 * (السجلّ يُفرَغ بإعادة تشغيل الخادم، وهي الحالة الشائعة لا النادرة) نبحث في
 * `/proc` عن عملية يحمل سطر أمرها معرّف الجلسة — وهو يظهر فعلاً في وسيط
 * `--resume <sessionId>`. البحث آخر الحلول لا أوّلها: نداء واحد لكل عيّنة.
 *
 * @param {string} sessionId
 * @param {Map<number, {cmdline:string}>} [table]
 * @returns {{pid:number, source:'registry'|'scan'} | null}
 */
export function resolveSessionPid(sessionId, table) {
  if (!sessionId) return null;
  const registered = resolveWorkflowPid(sessionId);
  if (registered) return { pid: registered, source: 'registry' };

  // المسح آخر الحلول، ومشروط. المطابقة الحرّة `includes` كانت تُسند شجرةً
  // خاطئة: أي عملية تذكر المعرّف عرَضاً (‏`tail -f …/<id>.jsonl`، ‏`rg <id>`،
  // مخرَج `ps`) تصير «جذر المحادثة». ثلاثة قيود تُغلق ذلك:
  //   1. طول ≥ 16 — المعرّفات الحقيقية أطول، والقصيرة تطابق نصف الجهاز.
  //   2. رمز argv كامل لا سلسلة داخل سلسلة.
  //   3. العملية نفسها من نوع جلسة/وكيل — لا `grep` ولا `tail`.
  // وعند تعدّد المطابقات يُختار **أعلى سلف** بينها لا أوّل ما يعود به readdir.
  if (String(sessionId).length < 16) return null;

  const procs = table || readProcessTable();
  const matches = [];
  for (const proc of procs.values()) {
    const tokens = proc.cmdline.split(/[\s=]+/);
    if (!tokens.includes(sessionId)) continue;
    if (classifyProcess(proc.cmdline) !== 'agent') continue;
    matches.push(proc);
  }
  if (!matches.length) return null;

  const ids = new Set(matches.map(p => p.pid));
  const root = matches.find(p => !ids.has(p.ppid)) || matches[0];
  return { pid: root.pid, source: 'scan' };
}

/**
 * استهلاك محادثة واحدة. ‏`available:false` حين يتعذّر ربط المحادثة بعملية —
 * محادثة خاملة، أو انتهت، أو نجت إعادة تشغيل ولم يعثر عليها المسح. لا نُعيد
 * أصفاراً في تلك الحالة: صفرٌ يُقرأ «لا تستهلك شيئاً» وهو ادّعاء لا نملكه.
 *
 * @param {string} sessionId
 * @returns {{
 *   available: boolean,
 *   rootPid: number | null,
 *   pidSource: 'registry' | 'scan' | null,
 *   processCount: number,
 *   memoryMb: number,
 *   memorySource: 'pss' | 'rss' | 'mixed',
 *   cpuPercent: number | null,
 *   breakdown: Array<{kind:string, processCount:number, memoryMb:number}>,
 * }}
 */
export function getSessionResources(sessionId) {
  const empty = {
    available: false,
    rootPid: null,
    pidSource: null,
    processCount: 0,
    memoryMb: 0,
    memorySource: 'pss',
    cpuPercent: null,
    breakdown: [],
  };

  const table = readProcessTable();
  const resolved = resolveSessionPid(sessionId, table);
  if (!resolved) return empty;

  const pids = collectTree(resolved.pid, table);
  if (!pids.length) return empty;

  const nowMs = Date.now();
  const byKind = new Map();
  let totalKb = 0;
  let cpuTotal = 0;
  let cpuKnown = false;
  const sources = new Set();

  for (const pid of pids) {
    const proc = table.get(pid);
    if (!proc) continue;
    const mem = readProcessMemoryKb(pid);
    const kb = mem ? mem.kb : 0;
    if (mem) sources.add(mem.source);
    totalKb += kb;

    const cpu = cpuPercentFor(pid, proc.ticks, nowMs);
    if (cpu !== null) {
      cpuTotal += cpu;
      cpuKnown = true;
    }

    const kind = pid === resolved.pid ? 'session' : classifyProcess(proc.cmdline);
    const bucket = byKind.get(kind) || { kind, processCount: 0, memoryKb: 0 };
    bucket.processCount += 1;
    bucket.memoryKb += kb;
    byKind.set(kind, bucket);
  }

  pruneCpuSamples(new Set(pids));

  // ‏available = «نجح قياسٌ واحد على الأقل» لا «وُجد pid». شجرةٌ كل قياساتها
  // فشلت (زومبي، أو ماتت بين المسح والقراءة) كانت تُعلن available:true
  // وmemoryMb:0 — أي «تستهلك صفراً»، وهو الادّعاء الذي يحرّمه هذا الملف.
  if (sources.size === 0) return empty;

  return {
    available: true,
    rootPid: resolved.pid,
    pidSource: resolved.source,
    processCount: pids.length,
    memoryMb: Math.round(totalKb / 1024),
    memorySource: sources.size > 1 ? 'mixed' : sources.has('rss') ? 'rss' : 'pss',
    cpuPercent: cpuKnown ? Math.round(cpuTotal * 10) / 10 : null,
    breakdown: [...byKind.values()]
      .map(b => ({ kind: b.kind, processCount: b.processCount, memoryMb: Math.round(b.memoryKb / 1024) }))
      .sort((a, b) => b.memoryMb - a.memoryMb),
  };
}

/** يقرأ `/proc/meminfo` إلى خريطة كيلوبايت. */
function readMeminfo() {
  const out = new Map();
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
      if (m) out.set(m[1], Number(m[2]));
    }
  } catch {
    /* خريطة فارغة تُترجَم available:false في الأعلى */
  }
  return out;
}

/**
 * أنظمة الملفات التي تعيش في الذاكرة وحجم المستهلَك منها. هذه القراءة هي عين
 * ما غاب ليلة الحادثة: ‏`/tmp` بلغ 3.3GB وبقي 45 ساعة بلا أن يظهر في أي شاشة.
 *
 * @returns {Array<{mount:string, usedMb:number, sizeMb:number}>}
 */
export function readTmpfsUsage() {
  const out = [];
  let mounts;
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
  } catch {
    return out;
  }
  for (const line of mounts) {
    const parts = line.split(/\s+/);
    if (parts[2] !== 'tmpfs' || !parts[1]) continue;
    // نعرض ما يهمّ فقط: مسارات يكتب فيها العمل، لا مسارات النظام الصغيرة.
    if (!/^\/(tmp|dev\/shm|var\/tmp)$/.test(parts[1])) continue;
    try {
      const st = fs.statfsSync(parts[1]);
      const sizeMb = Math.round((Number(st.blocks) * Number(st.bsize)) / 1048576);
      const usedMb = Math.round(((Number(st.blocks) - Number(st.bfree)) * Number(st.bsize)) / 1048576);
      out.push({ mount: parts[1], usedMb, sizeMb });
    } catch {
      /* نقطة وصل اختفت — تُتجاوَز */
    }
  }
  return out;
}

/**
 * حالة الجهاز كلّه. الحقل الحاسم `memAvailableMb` لا `memFreeMb`: النواة تعدّ
 * الكاش القابل للاسترداد «مستخدماً»، فـ`free` وحده يُفزع بلا سبب — بينما
 * `MemAvailable` يقول ما يمكن أن تأخذه فعلاً.
 *
 * @returns {{
 *   available: boolean,
 *   memTotalMb: number, memAvailableMb: number,
 *   swapTotalMb: number, swapUsedMb: number,
 *   shmemMb: number,
 *   tmpfs: Array<{mount:string, usedMb:number, sizeMb:number}>,
 *   pressure: 'ok' | 'warn' | 'critical',
 * }}
 */
export function getSystemResources() {
  const info = readMeminfo();
  if (!info.size) {
    return {
      available: false,
      memTotalMb: 0,
      memAvailableMb: 0,
      swapTotalMb: 0,
      swapUsedMb: 0,
      shmemMb: 0,
      tmpfs: [],
      pressure: 'ok',
    };
  }
  const memTotalMb = Math.round((info.get('MemTotal') || 0) / 1024);
  const memAvailableMb = Math.round((info.get('MemAvailable') || 0) / 1024);
  const swapTotalMb = Math.round((info.get('SwapTotal') || 0) / 1024);
  const swapFreeMb = Math.round((info.get('SwapFree') || 0) / 1024);
  const shmemMb = Math.round((info.get('Shmem') || 0) / 1024);

  const ratio = memTotalMb > 0 ? memAvailableMb / memTotalMb : 1;
  const swapUsedMb = swapTotalMb - swapFreeMb;
  const swapExhausted = swapTotalMb > 0 && swapFreeMb / swapTotalMb < 0.05;
  // ‏swap مستنفَد + ذاكرة شحيحة = الحالة التي سبقت سقوط 31 يوليو بساعات.
  const pressure = ratio < 0.15 || (ratio < 0.3 && swapExhausted) ? 'critical' : ratio < 0.3 ? 'warn' : 'ok';

  return {
    available: true,
    memTotalMb,
    memAvailableMb,
    swapTotalMb,
    swapUsedMb,
    shmemMb,
    tmpfs: readTmpfsUsage(),
    pressure,
  };
}

// ── مَن يحمل الـswap؟ (‏T-1204) ───────────────────────────────────────────────

/** كاش نتيجة جرد الـswap — نتيجة واحدة للجهاز كلّه لا لكل جلسة. */
let swapHoldersCache = null;
const SWAP_CACHE_TTL_MS = 5000;

/** أقصى عدد عمليات نقرأ لها `smaps_rollup` بعد الترتيب — سقف كلفة لا سياسة. */
const SWAP_ROLLUP_CANDIDATES = 15;

/**
 * تعقيم اسم العملية. الاسم من حقل `Name` في `/proc/<pid>/status`، وهو **نصٌّ
 * تكتبه العملية نفسها** عبر `PR_SET_NAME` (أو تركه النواة من أول 15 بايت من
 * argv[0]) — ليس اسم ملف تنفيذي، ولا يُعدّ موثوقاً، ولا يصلح لأي قرار. قيم
 * فعلية على هذا الجهاز: `MainThread`, `node /home/example`, `PM2 v7.0.1: God`.
 *
 * فلأنه **قد يكون سطر أمر مقصوصاً**، لا يكفي تصفية غير المطبوع: نمحو كل ما
 * يشبه مساراً ونطوي رايات `--` قبل القصّ، وإلا تسرّب مسار المستخدم في حقلٍ
 * يُظنّ حميداً. عقد الحمولة يمنع `/home/` و`--` صراحةً (اختبار عدم التسريب).
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeProcName(raw) {
  return String(raw || '')
    // مطبوع لاتيني أو عربي فقط — لا تحكّم ولا صفري العرض
    .replace(/[^\x20-\x7E؀-ۿ]/g, '')
    // أي مقطع يبدأ بشرطة مائلة = مسار: يُطوى بالكامل
    .replace(/\/\S*/g, '…')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 15);
}

/**
 * يقرأ `Name` و`Uid` (الحقيقي) و`VmSwap` من `/proc/<pid>/status` بقراءة واحدة.
 *
 * @param {number} pid
 * @returns {{name:string, uid:number, swapKb:number} | null}
 */
function readProcStatus(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return null; // انتهت العملية بين المسح والقراءة — سباق طبيعي
  }
  const name = text.match(/^Name:\s*(.*)$/m);
  const uid = text.match(/^Uid:\s+(\d+)/m);
  // ‏VmSwap غائب تماماً لخيوط النواة — غيابه «لا ينطبق» لا «صفر».
  const swap = text.match(/^VmSwap:\s+(\d+)\s+kB/m);
  if (!uid) return null;
  return {
    name: sanitizeProcName(name ? name[1] : ''),
    uid: Number(uid[1]),
    swapKb: swap ? Number(swap[1]) : 0,
  };
}

/** لحظة إقلاع النواة بالثواني (`btime`)، أو null حين يتعذّر. */
function readBootTimeSeconds() {
  try {
    const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * عمر العملية بالساعات من `starttime` (الحقل 22 في `/proc/<pid>/stat`) مع
 * `btime`. القصّ من آخر `)` لأن `comm` قد يحوي مسافات وأقواساً — نفس حيلة
 * `readProcessTable`. يُعيد null حين يتعذّر القياس، لا صفراً.
 *
 * @param {number} pid
 * @param {number | null} btime
 * @returns {number | null}
 */
function readProcessAgeHours(pid, btime) {
  if (!btime) return null;
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // بعد القصّ: [0]=state [1]=ppid ... [19]=starttime (الحقل 22 مطلقاً)
  const starttime = Number(stat.slice(close + 2).split(' ')[19]);
  if (!Number.isFinite(starttime)) return null;
  const startedAtMs = (btime + starttime / HERTZ) * 1000;
  const hours = (Date.now() - startedAtMs) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return null;
  return Math.round(hours * 10) / 10;
}

/**
 * ‏`SwapPss` من `smaps_rollup`: نصيب العملية من الصفحات المُبدَّلة موزَّعاً على
 * شركائها فيها. يُقرأ لعمليات uid الخادم غالباً؛ ولغيرها يفشل بـEPERM.
 *
 * @param {number} pid
 * @returns {number | null} كيلوبايت أو null حين يتعذّر
 */
function readSwapPssKb(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^SwapPss:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * **مَن يحمل الـswap؟** جرد قراءة محضة: لا يقتل عملية ولا يرسل إشارة.
 *
 * لماذا ثلاثة دلاء لا قائمةٌ واحدة (فيتو مراجعة، مرفوع بشرطه): مقيس على هذا
 * المضيف أن مجموع `VmSwap` لكل العمليات ‏445MB بينما `SwapTotal−SwapFree` =
 * ‏813MB — أي أن **45% من الـswap غير منسوب لأي عملية حيّة** (صفحات tmpfs
 * المُبدَّلة، وصفحات عملياتٍ ماتت وبقي أثرها في `SwapCached`). قائمةٌ تعرض
 * الأعلى وحدهم تُشير إلى بريء وتسكت عن فاعل حادثة 29–31 يوليو. فالمجموع
 * المعروض يساوي `swapUsedMb` **بالبناء**:
 *
 *     Σ holders  +  system.swapMb  +  unattributedMb  ===  swapUsedMb
 *
 * والدلو الثالث يُقصّ عند صفر: الصفحة المشتركة تُعدّ مرّتين في `VmSwap` فقد
 * يخرج الباقي سالباً، وحينها يُقلَّم الدلو الأقلّ دقّة (`system`، وهو مبنيّ على
 * `VmSwap` المضاعِف) لا أن يُنشر رقمٌ سالب.
 *
 * **الخصوصية:** ‏`system` سطرٌ مجمَّع واحد بلا أسماء ولا pids — عمليات مستخدم
 * آخر ليست شأن هذه اللوحة. و`cmdline` يُقرأ خادمياً للتصنيف **ولا يُعاد أبداً**
 * (قد يحمل مفاتيح)، و`cwdPath` للاستهلاك الداخلي في المسار وحده.
 *
 * **التزامن مقصود:** ‏`readFileSync` هنا كما في بقية الملف. تحويلها يوماً إلى
 * `fs.promises` يفتح الباب لقطيع طلبات متوازية على نفس المسح، فيلزم حينها حارس
 * `inFlight` — الكاش وحده لا يكفي مع الوعود.
 *
 * @param {{limit?: number}} [options]
 * @returns {{
 *   available: boolean,
 *   measuredAt?: number,
 *   swapUsedMb?: number,
 *   swapCachedMb?: number,
 *   holders?: Array<{pid:number, name:string, kind:string, swapMb:number,
 *                    swapSource:'swappss'|'vmswap', ageHours:number|null, cwdPath:string|null}>,
 *   system?: {count:number, swapMb:number},
 *   unattributedMb?: number,
 * }}
 */
export function readSwapHolders({ limit = 8 } = {}) {
  const now = Date.now();
  // ‏`limit` جزءٌ من مفتاح الكاش: نتيجةٌ محسوبة لسقفٍ آخر ليست نفس الإجابة،
  // وإعادتها تُنتج حمولةً لا تطابق ما طُلب (وثابتةً حسابية تنكسر بلا سبب ظاهر).
  if (swapHoldersCache && swapHoldersCache.limit === limit && now - swapHoldersCache.atMs < SWAP_CACHE_TTL_MS) {
    return swapHoldersCache.value;
  }

  const value = computeSwapHolders(limit);
  swapHoldersCache = { atMs: now, limit, value };
  return value;
}

/** @param {number} limit */
function computeSwapHolders(limit) {
  // تدهور صادق: تعذّر القراءة ⇦ available:false لا أصفاراً. «صفر» يُقرأ «لا
  // swap مستخدَماً» وهو أخطر ادّعاء يمكن أن تقوله شاشة ضغطٍ.
  const unavailable = { available: false };

  const info = readMeminfo();
  if (!info.size || !info.has('SwapTotal')) return unavailable;
  const swapUsedMb = Math.round(((info.get('SwapTotal') || 0) - (info.get('SwapFree') || 0)) / 1024);
  const swapCachedMb = Math.round((info.get('SwapCached') || 0) / 1024);

  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return unavailable;
  }

  const selfUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const own = [];
  let systemCount = 0;
  let systemKb = 0;

  // المرور الأول: `status` وحده للجميع (مقيس 2.36ms للجهاز كلّه). لا
  // `smaps_rollup` هنا — ثمنها 1.5–2.6ms للعملية الواحدة، أي ثانيةٌ كاملة من
  // حجب حلقة الأحداث لو قُرئت للجميع.
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const status = readProcStatus(pid);
    if (!status || status.swapKb <= 0) continue;
    if (status.uid === selfUid) {
      own.push({ pid, name: status.name, swapKb: status.swapKb, swapSource: 'vmswap' });
    } else {
      systemCount += 1;
      systemKb += status.swapKb;
    }
  }

  // المرور الثاني: تنقية الأعلى وحدهم بـSwapPss. الترتيب قبل التنقية مبنيٌّ على
  // `VmSwap` وهو تقريبٌ كافٍ لاختيار المرشّحين، ثم يُعاد الترتيب بالرقم الأدقّ.
  own.sort((a, b) => b.swapKb - a.swapKb);
  for (const row of own.slice(0, SWAP_ROLLUP_CANDIDATES)) {
    const pss = readSwapPssKb(row.pid);
    if (pss !== null) {
      row.swapKb = pss;
      row.swapSource = 'swappss';
    }
  }
  own.sort((a, b) => b.swapKb - a.swapKb);

  const table = readProcessTable();
  const btime = readBootTimeSeconds();

  const holders = [];
  for (const row of own) {
    if (holders.length >= Math.max(0, limit)) break;
    const swapMb = Math.round(row.swapKb / 1024);
    // صفٌّ يُدوَّر إلى صفر ليس حاملاً — يبقى ضمن غير المنسوب بدل أن يزاحم
    // حاملاً حقيقياً على مقعد في القائمة.
    if (swapMb < 1) continue;
    const proc = table.get(row.pid);
    let cwdPath = null;
    try {
      cwdPath = fs.readlinkSync(`/proc/${row.pid}/cwd`);
    } catch {
      /* عملية انتهت أو مسار غير مقروء */
    }
    holders.push({
      pid: row.pid,
      name: row.name,
      // ‏cmdline يُقرأ للتصنيف فقط ولا يُسرَّب: القيمة المعادة رمزٌ من قائمة
      // مغلقة (`browser|test|build|agent|other`).
      kind: classifyProcess(proc ? proc.cmdline : ''),
      swapMb,
      swapSource: row.swapSource,
      ageHours: readProcessAgeHours(row.pid, btime),
      cwdPath,
    });
  }

  // الثابتة بالبناء: تُحسب من **الأرقام المعروضة نفسها** لا من قيمٍ أخرى، وإلا
  // تحقّقت بالصدفة أو لم تتحقّق.
  const holdersMb = holders.reduce((sum, h) => sum + h.swapMb, 0);
  const systemRawMb = Math.round(systemKb / 1024);
  const systemMb = Math.min(systemRawMb, Math.max(0, swapUsedMb - holdersMb));
  const unattributedMb = Math.max(0, swapUsedMb - holdersMb - systemMb);

  return {
    available: true,
    measuredAt: Date.now(),
    swapUsedMb,
    swapCachedMb,
    holders,
    system: { count: systemCount, swapMb: systemMb },
    unattributedMb,
  };
}

/** للاختبارات: تصفير ذاكرة عيّنات المعالج بين الحالات. */
export function resetCpuSamples() {
  cpuSamples.clear();
  resourceCache.clear();
  swapHoldersCache = null;
}

/** كاش نتيجة القياس لكل جلسة: sessionId → { atMs, value }. */
const resourceCache = new Map();
const CACHE_TTL_MS = 3000;
const MAX_CACHE_ENTRIES = 500;

/**
 * القياس مع كاش قصير — وهو **شرط تشغيلي لا تحسين**.
 *
 * كل قياس يقرأ `/proc` كاملاً ثم `smaps_rollup` لكل عملية في الشجرة، وكلّه
 * `readFileSync` **متزامن على حلقة أحداث الخادم** التي تبثّ كل المحادثات.
 * القياس على هذا الجهاز: جدول العمليات ~2ms، و`smaps_rollup` لعملية كبيرة
 * ‏1.5–2.6ms. فشجرةٌ من عشرين عملية = 40ms حجب لكل طلب — وكلفته **تتضخّم
 * طرديّاً مع عدد العمليات**، أي تبلغ ذروتها في الحادثة ذاتها التي وُجد
 * ليرصدها. ومرايا الجلسة تسمح بعدّة مشاهدين للمحادثة الواحدة، فبلا كاش
 * يتضاعف الحجب بعددهم.
 *
 * ثلاث ثوانٍ أقصر من أبطأ نبضة استطلاع (4ث أثناء البثّ)، فلا يرى المستخدم
 * رقماً بائتاً، ويُخدَم كل المشاهدين من قياس واحد.
 *
 * @param {string} sessionId
 */
export function getSessionResourcesCached(sessionId) {
  const now = Date.now();
  const hit = resourceCache.get(sessionId);
  if (hit && now - hit.atMs < CACHE_TTL_MS) return hit.value;

  const value = getSessionResources(sessionId);
  resourceCache.set(sessionId, { atMs: now, value });

  if (resourceCache.size > MAX_CACHE_ENTRIES) {
    for (const [key, entry] of resourceCache) {
      if (now - entry.atMs >= CACHE_TTL_MS) resourceCache.delete(key);
      if (resourceCache.size <= MAX_CACHE_ENTRIES) break;
    }
  }
  return value;
}
