/**
 * scripts/memory-guard.test.ts — اختبارات انحدار لحارس الذاكرة (B-177)
 *
 * تشغيل:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test "scripts/memory-guard.test.ts"
 *
 * كلّ اختبار يعزل الحارس تماماً: PM2_HOME وهمي، `pm2` مزيّف على PATH، وسجل/حالة
 * في مجلد مؤقّت. لا يُستدعى pm2 الحقيقي ولا safe-restart ولا أي restart إطلاقاً
 * (كل الاختبارات دون العتبة أو في وضع --check).
 */
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD = path.resolve(import.meta.dirname, 'memory-guard.sh');
const PROC = 'nassaj-dev';

let tmp: string;
/** عمليات God Daemon مزيّفة أُطلقت في الاختبار — تُقتل في afterEach. */
let fakeDaemons: number[] = [];

/** يبني مجلد PM2_HOME وهمياً + `pm2` مزيّفاً يطبع ما نمليه، ويسجّل كل استدعاء. */
function scaffold(jlistStdout: string) {
  const pm2Home = path.join(tmp, 'pm2home');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(pm2Home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'jlist.out'), jlistStdout);
  // pm2 مزيّف: يسجّل أنه استُدعي (+ PM2_HOME الذي وصله) ثم يطبع المخرج المُملى.
  fs.writeFileSync(
    path.join(bin, 'pm2'),
    [
      '#!/usr/bin/env bash',
      `echo "$*|PM2_HOME=${'${PM2_HOME:-<unset>}'}" >> "${path.join(tmp, 'pm2.calls')}"`,
      `cat "${path.join(tmp, 'jlist.out')}"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { pm2Home, bin };
}

/** يُطلق عملية بـargv مطابق لتوقيع God Daemon، ويكتب pidها في pm2.pid. */
function spawnFakeDaemon(pm2Home: string) {
  const argv0 = `PM2 v7.0.1: God Daemon (${pm2Home})`;
  const child = spawn('bash', ['-c', `exec -a "${argv0}" sleep 120`], {
    stdio: 'ignore',
    detached: false,
  });
  fakeDaemons.push(child.pid!);
  fs.writeFileSync(path.join(pm2Home, 'pm2.pid'), String(child.pid));
  // انتظر حتى يصير /proc/<pid>/cmdline يحمل التوقيع (exec يستبدل bash).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const cl = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
      if (cl.includes('God Daemon')) return child.pid!;
    } catch {
      /* ما زال يُقلع */
    }
    execFileSync('sleep', ['0.05']);
  }
  throw new Error('fake God Daemon did not come up');
}

interface RunResult {
  code: number;
  stdout: string;
  log: string;
  state: string;
  pm2Called: boolean;
}

function runGuard(env: Record<string, string>, args: string[] = []): RunResult {
  const logFile = path.join(tmp, 'guard.log');
  const stateFile = path.join(tmp, 'guard.state');
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [GUARD, ...args], {
      encoding: 'utf8',
      env: {
        // بيئة فقيرة عمداً كبيئة cron: لا PM2_HOME ولا PATH غنيّ.
        HOME: os.homedir(),
        PATH: `${path.join(tmp, 'bin')}:/usr/bin:/bin`,
        MEM_GUARD_LOG: logFile,
        MEM_GUARD_STATE: stateFile,
        MEM_GUARD_FAIL_STATE: path.join(tmp, 'guard.fail'),
        MEM_GUARD_LOCK: path.join(tmp, 'guard.lock'),
        // عتبة مستحيلة: يستحيل أن يسلك أي اختبار مسار restart.
        MEM_GUARD_THRESHOLD_MB: '999999',
        ...env,
      },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    code = err.status ?? -1;
    stdout = err.stdout ?? '';
  }
  return {
    code,
    stdout,
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
    state: fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '',
    pm2Called: fs.existsSync(path.join(tmp, 'pm2.calls')),
  };
}

const app = (name: string, rssMb: number, status = 'online') =>
  JSON.stringify([
    { pid: 4242, name, monit: { memory: rssMb * 1048576 }, pm2_env: { status } },
  ]);

describe('memory-guard.sh — رؤية عملية PM2 (B-177)', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-test-'));
    fakeDaemons = [];
  });
  afterEach(() => {
    for (const pid of fakeDaemons) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* خرج أصلاً */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('يرى العملية ويقيس ذاكرتها عبر PM2_HOME المُثبَّت حتى ببيئة cron فقيرة', () => {
    const { pm2Home } = scaffold(app(PROC, 216));
    spawnFakeDaemon(pm2Home);

    const r = runGuard({ MEM_GUARD_PM2_HOME: pm2Home }, ['--check']);

    assert.equal(r.code, 0, `توقّعنا رؤية العملية. stdout=${r.stdout} log=${r.log}`);
    assert.match(r.state, /rss=216MB/);
    assert.match(r.state, /\bok\b/);
    assert.doesNotMatch(r.log, /غير موجودة/);
  });

  it('daemon حيّ بصفر تطبيقات = انفصال رؤية مُشخَّص، لا «العملية غير موجودة»', () => {
    // هذا قلب B-177: قبل الإصلاح كان `[]` يُصنَّف MISSING («لا شيء لحراسته»)
    // وهو تشخيص مضلِّل يخفي أن الحارس ينظر إلى PM2_HOME/daemon خاطئ.
    const { pm2Home } = scaffold('[]');
    spawnFakeDaemon(pm2Home);

    const r = runGuard({ MEM_GUARD_PM2_HOME: pm2Home }, ['--check']);

    assert.equal(r.code, 1, '--check يجب أن يخرج بـ1 حين يكون الحارس أعمى');
    assert.match(r.state, /error:pm2-empty/, `state=${r.state}`);
    assert.match(r.log, /انفصال رؤية/);
    assert.match(r.log, new RegExp(pm2Home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(r.state, /^.*\bmissing\b/m);
  });

  it('لا يستدعي pm2 إطلاقاً حين لا God Daemon حيّ (منع إطلاق daemon شبح)', () => {
    // `pm2 jlist` على PM2_HOME بلا daemon يُطلق daemon فارغاً جديداً ويُعيد [] —
    // مصدر «انفصال الرؤية» الدائم. البوّابة تمنع الاستدعاء أصلاً.
    const { pm2Home } = scaffold(app(PROC, 216));
    // لا spawnFakeDaemon، ولا pm2.pid.

    const r = runGuard({ MEM_GUARD_PM2_HOME: pm2Home }, ['--check']);

    assert.equal(r.pm2Called, false, 'استُدعي pm2 رغم غياب daemon → خطر daemon شبح');
    assert.equal(r.code, 1);
    assert.match(r.state, /error:no-daemon/, `state=${r.state}`);
    assert.match(r.log, /daemon شبح/);
  });

  it('غياب العملية عن قائمة غير فارغة يُبلَّغ كـmissing مع عدد التطبيقات', () => {
    const { pm2Home } = scaffold(app('diwan-api-dev', 100));
    spawnFakeDaemon(pm2Home);

    const r = runGuard({ MEM_GUARD_PM2_HOME: pm2Home }, ['--check']);

    assert.equal(r.code, 1);
    assert.match(r.state, /missing:streak=1/, `state=${r.state}`);
    assert.match(r.log, /ضمن 1 تطبيقاً/);
  });

  it('لا يغرق السجل: تكرار العمى يصعّد مرة واحدة بدل سطر لكل دورة', () => {
    // العطل الميداني: 2263 سطراً متطابقاً على مدى 5 أيام، بلا تصعيد ولا انتباه.
    const { pm2Home } = scaffold('[]');
    spawnFakeDaemon(pm2Home);
    const env = { MEM_GUARD_PM2_HOME: pm2Home, MEM_GUARD_FAIL_ESCALATE_AT: '3' };

    let last: RunResult | undefined;
    for (let i = 0; i < 6; i++) last = runGuard(env, ['--check']);

    const lines = last!.log.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, `توقّعنا سطرين فقط (WARN + CRITICAL): ${last!.log}`);
    assert.match(lines[0], /\[WARN\]/);
    assert.match(lines[1], /\[CRITICAL\]/);
    assert.match(lines[1], /أعمى منذ 3 دورة/);
    assert.match(last!.state, /streak=6/);
  });

  it('يسجّل استعادة الرؤية بعد نافذة عمى (لا صمت عند التعافي)', () => {
    const { pm2Home } = scaffold('[]');
    spawnFakeDaemon(pm2Home);
    const env = { MEM_GUARD_PM2_HOME: pm2Home };

    runGuard(env, ['--check']);
    runGuard(env, ['--check']);
    fs.writeFileSync(path.join(tmp, 'jlist.out'), app(PROC, 216)); // عاد للظهور

    const r = runGuard(env, ['--check']);

    assert.equal(r.code, 0);
    assert.match(r.log, /استعاد رؤية nassaj-dev بعد 2 دورة عمياء/);
    assert.match(r.state, /rss=216MB.*\bok\b/);
  });
});
