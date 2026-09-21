/**
 * session-resources.test.ts — ما يُنسب لمحادثة وما لا يُنسب.
 *
 * الاختبارات على الحدود التي تكذب بسهولة: شجرة فيها حلقة (pid أُعيد استعماله)،
 * وسطر أمر متصفّح أطلقه وكيل فاجتمع فيه `claude` و`chromium`، ونسبة معالج بلا
 * عيّنة سابقة. والقياسات الحيّة تُجرى على **عملية الاختبار نفسها** لا على
 * fixtures مصطنعة — درس `feedback_synthetic_fixtures_false_confidence`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  classifyProcess,
  getSessionResourcesCached,
  collectTree,
  getSessionResources,
  getSystemResources,
  readProcessMemoryKb,
  readProcessTable,
  readSwapHolders,
  resetCpuSamples,
} from '@/modules/providers/services/session-resources.service.js';

type Row = { pid: number; ppid: number; comm: string; cmdline: string; ticks: number };
const table = (rows: Array<[number, number, string]>): Map<number, Row> =>
  new Map(
    rows.map(([pid, ppid, cmdline]) => [
      pid,
      { pid, ppid, comm: cmdline.split(' ')[0], cmdline, ticks: 0 },
    ]),
  );

beforeEach(() => resetCpuSamples());

describe('classifyProcess', () => {
  it('يصنّف المتصفّح متصفّحاً حتى لو أطلقه وكيل — الأخصّ يفوز', () => {
    assert.equal(classifyProcess('node .../playwright-mcp --browser chromium --headless'), 'browser');
    assert.equal(classifyProcess('/opt/chromium/headless_shell --type=renderer'), 'browser');
  });

  it('يفصل الاختبار والبناء عن الوكيل', () => {
    assert.equal(classifyProcess('node npx vitest run src/components'), 'test');
    assert.equal(classifyProcess('node vite build --mode production'), 'build');
    assert.equal(classifyProcess('claude --output-format stream-json --resume abc'), 'agent');
  });

  it('ما لا يُعرف يبقى other — لا يُلحق بدلو مريح', () => {
    assert.equal(classifyProcess('sleep 300'), 'other');
    assert.equal(classifyProcess(''), 'other');
  });
});

describe('collectTree', () => {
  it('يجمع كل الذرّيّة مهما عمقت، ولا يتعدّى إلى شجرة أخرى', () => {
    const t = table([
      [100, 1, 'claude --resume s1'],
      [101, 100, 'npm exec playwright-mcp'],
      [102, 101, 'chromium --headless'],
      [103, 100, 'npx vitest run'],
      [200, 1, 'claude --resume s2'],
    ]);
    assert.deepEqual(collectTree(100, t).sort((a, b) => a - b), [100, 101, 102, 103]);
  });

  it('لا يعلّق على حلقة ناتجة عن إعادة استعمال pid', () => {
    const t = table([
      [10, 11, 'a'],
      [11, 10, 'b'],
    ]);
    assert.deepEqual(collectTree(10, t).sort((a, b) => a - b), [10, 11]);
  });

  it('جذر غير موجود يُعيد فراغاً ولا يرمي', () => {
    assert.deepEqual(collectTree(999999, table([[1, 0, 'init']])), []);
  });
});

describe('القراءة الحيّة من /proc', () => {
  it('يقرأ جدول العمليات ويجد عملية الاختبار نفسها', () => {
    const t = readProcessTable();
    assert.ok(t.size > 5, `جدول العمليات صغير بلا معنى: ${t.size}`);
    assert.ok(t.has(process.pid));
    assert.match(t.get(process.pid)!.cmdline, /node|tsx/);
  });

  it('يقيس ذاكرة عملية الاختبار ويُفصح عن مصدر الرقم', () => {
    const mem = readProcessMemoryKb(process.pid);
    assert.ok(mem, 'تعذّر قياس ذاكرة عملية حيّة');
    assert.ok(mem!.kb > 1000, `رقم غير معقول: ${mem!.kb}kB`);
    assert.ok(['pss', 'rss'].includes(mem!.source));
  });

  it('عملية غير موجودة تُعيد null لا صفراً', () => {
    assert.equal(readProcessMemoryKb(4194303), null);
  });
});

describe('getSessionResources', () => {
  it('محادثة بلا عملية تُعيد available:false ولا تدّعي صفراً', () => {
    const r = getSessionResources('no-such-session-id-9c1f');
    assert.equal(r.available, false);
    assert.equal(r.rootPid, null);
    assert.equal(r.cpuPercent, null);
  });

  it('معرّف فارغ لا يرمي', () => {
    assert.equal(getSessionResources('').available, false);
  });

  it('يقيس شجرة حقيقية حين يُحلّ الـpid بالمسح، وأول عيّنة معالج null', () => {
    // `session-resources` يظهر في سطر أمر عملية الاختبار (اسم ملف الاختبار)،
    // فيُحلّ الـpid بمسح /proc — وهو مسار الاسترجاع بعد إعادة تشغيل الخادم.
    const first = getSessionResources('session-resources');
    if (!first.available) return; // مشغّل اختبارات لا يمرّر اسم الملف — لا نختبر ما لا نضمنه
    assert.equal(first.cpuPercent, null, 'أول عيّنة يجب أن تعترف بالجهل لا أن تقول صفراً');
    assert.ok(first.memoryMb > 0);
    assert.ok(first.processCount > 0);
    assert.ok(['registry', 'scan'].includes(first.pidSource!));
  });
});

describe('صدق القياس — أعطال أثبتتها المراجعة النقدية 2026-07-31', () => {
  it('المسح يرفض المعرّفات القصيرة — كانت تطابق نصف الجهاز', () => {
    // `includes` الحرّة على معرّف من حرفين كانت تُسند شجرةً عشوائية.
    assert.equal(getSessionResources('a').available, false);
    assert.equal(getSessionResources('abc-123').available, false);
  });

  it('المسح لا يلتقط عملية تذكر المعرّف عرَضاً (grep/tail)', () => {
    // معرّف طويل يظهر في سطر أمر عملية الاختبار نفسها (مسار الملف)، لكن
    // تصنيفها ليس 'agent' فلا تُقبل جذراً.
    const longId = 'session-resources-test-marker-0123456789';
    assert.equal(getSessionResources(longId).available, false);
  });

  it('أول عيّنة معالج null، والثانية الفورية null أيضاً لا صفراً', () => {
    const table = readProcessTable();
    const self = table.get(process.pid);
    assert.ok(self);
    // نداءان متتاليان على نفس الشجرة: النافذة دون الثانية ⇒ لا رقم مُلفَّق.
    const a = getSessionResources('no-such-session-id-for-cpu-window');
    const b = getSessionResources('no-such-session-id-for-cpu-window');
    assert.equal(a.cpuPercent, null);
    assert.equal(b.cpuPercent, null);
  });

  it('readProcessMemoryKb يرفض صفر صفحات — الزومبي قياسٌ فاشل لا صفر', () => {
    // pid غير موجود يمثّل الحالة نفسها: null لا {kb:0}.
    assert.equal(readProcessMemoryKb(4194303), null);
  });
});

describe('الكاش — شرط تشغيلي لا تحسين', () => {
  it('نداءان متتاليان يُعيدان **نفس الكائن** فلا يُقرأ /proc مرّتين', () => {
    const a = getSessionResourcesCached('cache-probe-session-id-000');
    const b = getSessionResourcesCached('cache-probe-session-id-000');
    // نفس المرجع = خدمة من الكاش. لو قُرئ /proc ثانيةً لكان كائناً جديداً.
    assert.equal(a, b);
  });

  it('الكاش لا يخلط جلسةً بأخرى', () => {
    const a = getSessionResourcesCached('cache-probe-session-id-aaa');
    const b = getSessionResourcesCached('cache-probe-session-id-bbb');
    assert.notEqual(a, b);
  });
});

describe('getSystemResources', () => {
  it('يقرأ الذاكرة والـswap من الجهاز الحقيقي', () => {
    const s = getSystemResources();
    assert.equal(s.available, true);
    assert.ok(s.memTotalMb > 500);
    assert.ok(s.memAvailableMb > 0);
    assert.ok(s.memAvailableMb <= s.memTotalMb);
    assert.ok(['ok', 'warn', 'critical'].includes(s.pressure));
  });

  it('يرصد /tmp حين يكون tmpfs — وهو سبب حادثة 29–31 يوليو', () => {
    const s = getSystemResources();
    const tmp = s.tmpfs.find(t => t.mount === '/tmp');
    // ليست كل عقدة تضع /tmp على tmpfs: الغياب مقبول، والوجود يجب أن يكون متّسقاً.
    if (!tmp) return;
    assert.ok(tmp.sizeMb > 0);
    assert.ok(tmp.usedMb >= 0);
    assert.ok(tmp.usedMb <= tmp.sizeMb);
  });
});

describe('readSwapHolders — مَن يحمل الـswap؟', () => {
  it('الثابتة: الدلاء الثلاثة تجمع swapUsedMb بالضبط، وغير المنسوب غير سالب', () => {
    const s = readSwapHolders({ limit: 200 });
    if (!s.available) return; // مضيف بلا /proc — لا نختبر ما لا نضمنه
    const holdersMb = s.holders!.reduce((sum, h) => sum + h.swapMb, 0);
    assert.ok(s.unattributedMb! >= 0, `غير المنسوب سالب: ${s.unattributedMb}`);
    assert.ok(s.system!.swapMb >= 0);
    assert.equal(
      holdersMb + s.system!.swapMb + s.unattributedMb!,
      s.swapUsedMb,
      'قائمةٌ لا تجمع الكلَّ تُشير إلى بريء وتسكت عن الفاعل',
    );
  });

  it('عقدُ عدم التسريب: لا مسارات ولا سطور أوامر في الحمولة', () => {
    // ‏cwdPath حقلٌ داخلي للمسار وحده؛ وهذا الاختبار يفشل يوم يضيف أحدهم
    // ‏cmdline «للتشخيص». يُحاكى ما يُرسَل فعلاً: الخدمة تُبقي cwdPath والمسار
    // يحذفه، فنحذفه هنا كما يفعل هو بالضبط.
    const s = readSwapHolders({ limit: 200 });
    if (!s.available) return;
    const wire = JSON.stringify({
      ...s,
      holders: s.holders!.map(({ cwdPath, ...rest }) => rest),
    });
    assert.ok(!wire.includes('/home/'), `تسرّب مسار منزل في الحمولة: ${wire.slice(0, 400)}`);
    assert.ok(!wire.includes('cmdline'), 'حقل cmdline لا مكان له في الحمولة');
    assert.ok(!wire.includes('--'), `تسرّب سطر أمر (راية --) في الحمولة: ${wire.slice(0, 400)}`);
  });

  it('حيّ: صفوف الحاملين متّسقة، وعملية الاختبار تظهر إن كانت تحمل swap فعلاً', () => {
    const s = readSwapHolders({ limit: 200 });
    if (!s.available) return;
    for (const h of s.holders!) {
      assert.ok(Number.isInteger(h.pid) && h.pid > 0);
      assert.ok(h.swapMb >= 1, 'صفٌّ بصفر ميغابايت ليس حاملاً');
      assert.ok(['swappss', 'vmswap'].includes(h.swapSource));
      assert.ok(['browser', 'agent', 'test', 'build', 'session', 'other'].includes(h.kind));
      assert.ok(h.ageHours === null || h.ageHours >= 0);
      assert.ok(h.name.length <= 15);
    }
    // ‏VmSwap الحقيقي لعملية الاختبار: إن تجاوز ميغابايت فلا عذر لغيابه من
    // قائمة بلا قصّ. وإن كان صفراً فالمطلوب بنيةٌ صحيحة لا أصفار ملفَّقة.
    const own = fs.readFileSync(`/proc/${process.pid}/status`, 'utf8').match(/^VmSwap:\s+(\d+)\s+kB/m);
    const ownMb = own ? Number(own[1]) / 1024 : 0;
    if (ownMb >= 1.5) {
      assert.ok(
        s.holders!.some(h => h.pid === process.pid),
        `عملية الاختبار تحمل ~${ownMb.toFixed(1)}MB ولم تظهر في الجرد`,
      );
    } else {
      assert.ok(Array.isArray(s.holders));
      assert.equal(typeof s.swapCachedMb, 'number');
    }
  });

  it('تدهور صادق: تعذُّر مسح /proc يُعيد available:false لا أصفاراً', () => {
    mock.method(fs, 'readdirSync', () => {
      throw new Error('EACCES');
    });
    try {
      resetCpuSamples(); // يمسح كاش الـswap كي لا تُخدَم نتيجةٌ سابقة
      const s = readSwapHolders({ limit: 8 });
      assert.equal(s.available, false);
      assert.equal(s.swapUsedMb, undefined, 'available:false لا يحمل أرقاماً — الصفر ادّعاء');
      assert.equal(s.holders, undefined);
    } finally {
      mock.restoreAll();
      resetCpuSamples();
    }
  });

  it('الكاش يُمسح مع resetCpuSamples فلا تتسرّب الحالة بين الاختبارات', () => {
    const a = readSwapHolders({ limit: 8 });
    const b = readSwapHolders({ limit: 8 });
    assert.equal(a, b, 'نداءان متتاليان يُخدمان من الكاش');
    resetCpuSamples();
    const c = readSwapHolders({ limit: 8 });
    assert.notEqual(a, c, 'بعد المسح يُعاد القياس');
  });
});
