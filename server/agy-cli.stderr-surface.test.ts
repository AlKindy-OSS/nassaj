// اختبار انحدار للفشل الصامت B-394.
//
// العَرَض المرصود (2026-08-01، جلسة agy_1785603316578_kmi8kzj0): نفدت حصة
// Gemini فكتب agy سطر الخطأ على stderr وخرج بـexitCode=1 **بلا كتابة شيء في
// النصّ** — فرأى المالك محادثة فارغة بلا أي سبب، ثلاث مرات متتالية. السجل كان
// يحمل السبب كاملاً (`Individual quota reached ... Resets in 119h35m`) بينما
// الواجهة لا تحمل حرفاً منه.
//
// ودقّة أهمّ كشفها هذا الاختبار نفسه: مسار الخطأ لم يكن غائباً بل **مضلِّلاً** —
// خريطة رموز الخروج تقول عن الرمز 1 «تحقّق من تثبيت agy» بينما السبب الحقيقي
// نفاد الحصة. فالإصلاح استبدالُ النصّ لا إضافةُ رسالة ثانية: يُحتفَظ بآخر سطر
// خطأ حقيقي من stderr ويُقدَّم على الخريطة، والخريطة تبقى احتياطاً حين يخرج
// agy صامتاً.
//
// يقود الاختبار الدالة الأصلية spawnAntigravity (تُستبدَل حدود العملية وحدها).

import assert from 'node:assert/strict';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import test, { mock, before, beforeEach, after } from 'node:test';

// Preserve transitive import exports without granting this fixture new process effects.
let unexpectedProcessCalls = 0;
const rejectUnexpectedProcess = () => {
  unexpectedProcessCalls++;
  assert.fail('unexpected process in provider fixture');
};
after(() => assert.equal(unexpectedProcessCalls, 0));

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  spawnArgs: string[] = [];
  kill() {
    this.killed = true;
    return true;
  }
  emitStdout(text: string) {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }
  emitStderr(text: string) {
    this.stderr.emit('data', Buffer.from(text, 'utf8'));
  }
  emitClose(code = 0) {
    this.emit('close', code);
  }
}

let spawnSignal: { promise: Promise<FakeChildProcess>; resolve: (c: FakeChildProcess) => void };
function armSpawnSignal() {
  let resolve!: (c: FakeChildProcess) => void;
  const promise = new Promise<FakeChildProcess>((r) => {
    resolve = r;
  });
  spawnSignal = { promise, resolve };
}

const sessionStore = new Map<string, any>();
const dbRows = new Map<string, any>();
let HOME_DIR = '';
let spawnAntigravity: typeof import('./agy-cli.js').spawnAntigravity;

before(async () => {
  HOME_DIR = mkdtempSync(path.join(os.tmpdir(), 'agy-stderr-'));
  process.env.HOME = HOME_DIR;
  process.env.NASSAJ_RESPONSE_LANGUAGE = 'formal Arabic (العربية الفصحى)';

  mock.module('child_process', {
    namedExports: {
      // Imported release collaborators must never execute processes in this fixture.
      execFileSync: rejectUnexpectedProcess,
      execFile: rejectUnexpectedProcess,
      spawnSync: realSpawnSync,
      spawn: (_cmd: string, args: string[]) => {
        const child = new FakeChildProcess();
        child.spawnArgs = Array.isArray(args) ? args : [];
        spawnSignal?.resolve(child);
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      },
    },
  });

  mock.module('./sessionManager.js', {
    defaultExport: {
      getSession: (id: string) => sessionStore.get(id) ?? null,
      createSession: (id: string) => {
        if (!sessionStore.has(id)) sessionStore.set(id, { id, messages: [] });
      },
      saveSession: () => {},
      addMessage: (id: string, role: string, content: string) => {
        const s = sessionStore.get(id);
        if (s) s.messages.push({ role, content });
      },
    },
    namedExports: { ready: Promise.resolve() },
  });

  mock.module('@/modules/database/repositories/participants.db.js', {
    namedExports: { participantsDb: { recordSpawn: () => {} } },
  });
  mock.module('@/modules/database/repositories/sessions.db.js', {
    namedExports: {
      sessionsDb: {
        getSessionById: (id: string) => dbRows.get(id) ?? null,
        createSession: (id: string, provider: string, cwd: string) => {
          dbRows.set(id, { session_id: id, provider, cwd, jsonl_path: null });
        },
      },
    },
  });
  mock.module('./modules/providers/list/antigravity/antigravity-project-registry.js', {
    namedExports: {
      registerAntigravityProjectPath: () => {},
      clearAntigravityProjectPath: () => {},
    },
  });
  mock.module('./services/notification-orchestrator.js', {
    namedExports: { notifyRunStopped: () => {}, notifyRunFailed: () => {} },
  });

  const mod = await import('./agy-cli.js');
  spawnAntigravity = mod.spawnAntigravity;
});

beforeEach(() => {
  sessionStore.clear();
  dbRows.clear();
});

function makeWs() {
  const forwarded: any[] = [];
  return {
    forwarded,
    send(msg: any) {
      forwarded.push(msg);
    },
  };
}

async function runSpawn(command: string, ws: ReturnType<typeof makeWs>, drive: (c: FakeChildProcess) => void) {
  armSpawnSignal();
  const promise = spawnAntigravity(command, { projectPath: HOME_DIR, cwd: HOME_DIR }, ws as any);
  const child = await spawnSignal.promise;
  drive(child);
  return promise;
}

/** نصّ الحصة كما كتبه agy حرفياً في السجل يوم الحادثة. */
const QUOTA_ERROR =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 119h35m29s.';

test('خروج غير صفري بلا ردّ: يصل سطر خطأ agy إلى الواجهة قبل complete (B-394)', async () => {
  const ws = makeWs();
  await runSpawn('سويلي بحث', ws, (child) => {
    child.emitStderr(QUOTA_ERROR + '\n');
    child.emitClose(1);
  });

  const errors = ws.forwarded.filter((m) => m.kind === 'error');
  assert.equal(errors.length, 1, 'رسالة خطأ واحدة لا اثنتان');
  assert.equal(errors[0].code, 'usage_limit', 'يصل رمز خطأ الحصة للواجهة');
  assert.match(errors[0].content, /Individual quota reached/);
  assert.match(errors[0].content, /119h35m/, 'موعد التجدّد يصل المالك كما كتبه agy');
  assert.doesNotMatch(
    errors[0].content,
    /Check if agy is installed/,
    'النصيحة الخاطئة لا تحلّ مكان السبب الحقيقي',
  );

  const kinds = ws.forwarded.map((m) => m.kind);
  assert.ok(
    kinds.indexOf('error') < kinds.indexOf('complete'),
    'الخطأ يسبق complete — بعده تُمسح الدوّارة فلا يُرى',
  );
});

test('ضجيج الإهمال وحده: تبقى رسالة الخريطة احتياطاً', async () => {
  const ws = makeWs();
  await runSpawn('اختبار', ws, (child) => {
    child.emitStderr('(node:123) [DEP0040] DeprecationWarning: punycode is deprecated\n');
    child.emitClose(1);
  });

  const errors = ws.forwarded.filter((m) => m.kind === 'error');
  assert.equal(errors.length, 1, 'الخروج غير الصفري يُبلَّغ دائماً');
  assert.match(errors[0].content, /agy CLI general error/, 'الاحتياط هو الخريطة لا سطر إهمال مكبوت');
});

test('ردّ ناجح ثم خروج غير صفري: السبب الحقيقي لا الخريطة', async () => {
  const ws = makeWs();
  await runSpawn('مرحبا', ws, (child) => {
    child.emitStdout('أهلاً بك');
    child.emitStderr(QUOTA_ERROR + '\n');
    child.emitClose(1);
  });

  const errors = ws.forwarded.filter((m) => m.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].content, /Individual quota reached/);
});

test('خروج صفري نظيف: لا رسالة خطأ إطلاقاً', async () => {
  const ws = makeWs();
  await runSpawn('مرحبا', ws, (child) => {
    child.emitStdout('تمّ');
    child.emitClose(0);
  });

  assert.equal(ws.forwarded.filter((m) => m.kind === 'error').length, 0);
});
