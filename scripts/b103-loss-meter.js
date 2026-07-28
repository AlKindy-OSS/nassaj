#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
// b103-loss-meter.js  (T-714 — بوابة ب3 الكمية لـADR-053 المحسوم ب1)
// ----------------------------------------------------------------------------
// عدّاد «الفقد العضوي» لظاهرة B-103. أداة قراءة-فقط: تمسح سجلّات PM2 لعملية
// nassaj-dev، تستخرج أحداث فقد البثّ (stream-orphaned)، وتصنّف كل حدث:
//   organic   = خروج عملية Claude المنسِّقة دون عملية خادم مقترنة (فقد B-103 عضوي).
//   server-op = مقترن زمنياً بعملية خادم (restart/stop/reload — يدوي أو حارس).
//
// A read-only "organic loss" meter for the B-103 phenomenon. It scans the
// nassaj-dev PM2 logs, extracts stream-loss events, and classifies each as
// organic (coordinator process exit, no server op) vs server-op (correlated
// with a drain/restart). ZERO server mutation, ZERO restart, output to stdout
// (an optional --report writes one markdown file under docs/).
//
// ── مصدر الإشارة والحدود / Signal source & limits ────────────────────────────
//  • إشارة الفقد: أسطر `[WS-DIAG] stream-orphaned` (claude-sdk.js:1711). تُطلَق
//    مرّة لكل بثّ حين يُغلَق مقبس العميل بينما مولّد الخادم لا يزال حيّاً. هي
//    أغنى إشارة اضطراب مؤقّتة متاحة في السجلّ نفسه الذي يحوي علامات الخادم.
//  • **حدّ جوهري (يُصرَّح للمالك):** هذه الإشارة مقبس-يموت لا عملية-تموت. مولّد
//    الخادم كثيراً ما ينجو (هذا نصّ الحدث حرفياً). فموت B-103 الحقيقي = مجموعة
//    جزئية منها. لذا العدّ العضوي هنا **حدّ أعلى / مرشّحون** لا فقدٌ مؤكَّد؛ كثير
//    من الأحداث العضوية قد تكون فصل عميل حميداً (تبويب أُغلق) والعمل نجا. التأكيد
//    النهائي بيد الترياج (journal الورشة بلا نتيجة + pid الابن غائب).
//  • **رُفض reconcile «No completion record» (B-93):** يعمل عند الإقلاع فقط ويرى
//    فقط ورشات مُيتَّمة عبر restart — أعمى تماماً عن B-103 العضوي (ADR-053 ح-1)،
//    والعبارة الحرفية غير مُطلَقة أصلاً في الكود.
//  • علامات الخادم: `[DRAIN] SIGINT` + `all sessions finished` تبني فترات drain
//    موثوقة (كل restart/stop/reload يمرّ بها بحكم treekill:false+drain). حارس
//    B-130 (memory-guard.log) يُستشار لوسم السبب (حارس مقابل يدوي) لا للكشف.
//
// ── التشغيل / Run ────────────────────────────────────────────────────────────
//   node scripts/b103-loss-meter.js                         # منذ خط الأساس (15:11Z 07-06)
//   node scripts/b103-loss-meter.js --since 2026-07-06T00:00:00Z   # يوم كامل (اختبار)
//   node scripts/b103-loss-meter.js --json                  # مخرج آلي
//   node scripts/b103-loss-meter.js --report docs/b103-loss-YYYYMMDD.md
//
// الأعلام / Flags:
//   --since <ISO>     بداية النافذة (افتراضي 2026-07-06T15:11:00Z = تفعيل B-130)
//   --until <ISO>     نهاية النافذة (افتراضي الآن)
//   --logs <glob,..>  مسارات سجلّات out (افتراضي سجلّات nassaj-dev الحيّ+المدوّرة)
//   --guard-log <p>   سجلّ memory-guard (افتراضي ~/.pm2/logs/nassaj-memory-guard.log)
//   --pre <sec>       هامش قبل SIGINT لاحتواء ترتيب الأسطر (افتراضي 180)
//   --post <sec>      سقف نهاية drain حين تغيب علامة الإنهاء (افتراضي 1800)
//   --json            مخرج JSON بدل الجدول
//   --report <path>   يكتب تقرير md تحت docs/ (المسار الوحيد المسموح بالكتابة)
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── قراءة الأعلام ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    since: '2026-07-06T15:11:00Z',
    until: null,
    logs: null,
    guardLog: path.join(os.homedir(), '.pm2/logs/nassaj-memory-guard.log'),
    pre: 180,
    post: 1800,
    json: false,
    report: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const next = () => argv[(i += 1)];
    if (k === '--since') a.since = next();
    else if (k === '--until') a.until = next();
    else if (k === '--logs') a.logs = next();
    else if (k === '--guard-log') a.guardLog = next();
    else if (k === '--pre') a.pre = Number(next());
    else if (k === '--post') a.post = Number(next());
    else if (k === '--json') a.json = true;
    else if (k === '--report') a.report = next();
    else if (k === '-h' || k === '--help') { a.help = true; }
    else throw new Error(`unknown flag: ${k}`);
  }
  return a;
}

// السطر: `2026-07-06 09:57:47.748 +03:00: <msg>` → epoch ms (يحترم الإزاحة الفعلية)
const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3}) ([+-]\d{2}):(\d{2}): (.*)$/;
function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, date, time, ms, offH, offM, msg] = m;
  const iso = `${date}T${time}.${ms}${offH}:${offM}`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return { t, iso, msg };
}

function defaultLogGlob() {
  const dir = path.join(os.homedir(), '.pm2/logs');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^nassaj-dev-out(__.*)?\.log$/.test(f))
      .map((f) => path.join(dir, f));
  } catch { /* dir missing */ }
  return files;
}

function readFiles(globArg) {
  const files = globArg
    ? globArg.split(',').map((s) => s.trim()).filter(Boolean)
    : defaultLogGlob();
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    out.push({ file: f, lines: text.split('\n') });
  }
  return out;
}

// ── استخراج الأحداث ──────────────────────────────────────────────────────────
function collect(fileBlocks) {
  const loss = [];      // stream-orphaned
  const opStart = [];   // [DRAIN] SIGINT: listener closed
  const opFinish = [];  // [DRAIN] all sessions finished
  for (const { lines } of fileBlocks) {
    for (const raw of lines) {
      const p = parseLine(raw);
      if (!p) continue;
      if (p.msg.includes('[WS-DIAG] stream-orphaned')) {
        const sid = (/session=([^\s]+)/.exec(p.msg) || [])[1] || 'unknown';
        const msgs = Number((/messagesSoFar=(\d+)/.exec(p.msg) || [])[1] || 0);
        loss.push({ t: p.t, iso: p.iso, session: sid, messagesSoFar: msgs });
      } else if (p.msg.includes('[DRAIN] SIGINT: listener closed')) {
        opStart.push({ t: p.t, iso: p.iso });
      } else if (p.msg.includes('[DRAIN] all sessions finished')) {
        opFinish.push({ t: p.t, iso: p.iso });
      }
    }
  }
  const dedupSort = (arr) => {
    const seen = new Set();
    return arr.filter((e) => {
      const key = `${e.t}|${e.session || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((x, y) => x.t - y.t);
  };
  return { loss: dedupSort(loss), opStart: dedupSort(opStart), opFinish: dedupSort(opFinish) };
}

function readGuardRestarts(guardLog) {
  // memory-guard يسجّل عند إطلاق safe-restart فعلياً؛ نلتقط الطوابع لوسم السبب.
  const events = [];
  let text;
  try { text = fs.readFileSync(guardLog, 'utf8'); } catch { return events; }
  for (const raw of text.split('\n')) {
    if (!/safe-restart|RESTART|restart/i.test(raw)) continue;
    // memory-guard timestamp: ISO مع إزاحة، مثل 2026-07-06T21:27:01+0300
    const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})/.exec(raw);
    if (!m) continue;
    const t = Date.parse(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (!Number.isNaN(t)) events.push({ t });
  }
  return events;
}

// ── بناء فترات الخادم / Server-op intervals ──────────────────────────────────
// لكل SIGINT: النهاية = أول «all sessions finished» قبل الـSIGINT التالي، وإلّا
// الـSIGINT التالي، وإلّا start+post. تُمدَّد بـpre قبل البداية لاحتواء ترتيب الأسطر.
function buildIntervals(opStart, opFinish, preSec, postSec) {
  const intervals = [];
  for (let i = 0; i < opStart.length; i += 1) {
    const start = opStart[i].t;
    const nextStart = i + 1 < opStart.length ? opStart[i + 1].t : Infinity;
    const finish = opFinish.find((f) => f.t >= start && f.t < nextStart);
    // النهاية = علامة إنهاء الـdrain إن وُجدت، وإلّا سقف post (لا تُمدَّد حتى
    // الـrestart التالي مهما بَعُد — كي لا يُخنق فقدٌ عضويّ في فجوة هدوء طويلة؛
    // under-count العضوي هو الاتجاه الخطر لأنه يُفوّت دراسة مستحقّة).
    let end;
    let endKind;
    if (finish) { end = finish.t; endKind = 'drain-finished'; }
    else {
      const capped = start + postSec * 1000;
      end = Math.min(capped, nextStart);
      endKind = end === nextStart && nextStart !== Infinity ? 'next-restart' : 'post-cap';
    }
    intervals.push({
      start, end, endKind,
      lo: start - preSec * 1000,
      hi: end + preSec * 1000,
      startIso: opStart[i].iso,
    });
  }
  return intervals;
}

function classify(loss, intervals, guardRestarts) {
  return loss.map((ev) => {
    const hit = intervals.find((iv) => ev.t >= iv.lo && ev.t <= iv.hi);
    // أقرب SIGINT لأي حدث (للشفافية حتى للعضوي)
    let nearest = null;
    for (const iv of intervals) {
      const d = Math.abs(ev.t - iv.start);
      if (nearest === null || d < nearest.deltaMs) {
        nearest = { deltaMs: d, startIso: iv.startIso, signed: ev.t - iv.start };
      }
    }
    let cause = null;
    if (hit) {
      const guard = guardRestarts.find((g) => Math.abs(g.t - hit.start) <= 120 * 1000);
      cause = guard ? 'memory-guard(B-130)' : 'manual/safe-restart';
    }
    return {
      ...ev,
      class: hit ? 'server-op' : 'organic',
      opStartIso: hit ? hit.startIso : null,
      opEndKind: hit ? hit.endKind : null,
      cause,
      nearestOpIso: nearest ? nearest.startIso : null,
      nearestOpDeltaSec: nearest ? Math.round(nearest.signed / 1000) : null,
    };
  });
}

// ── العرض ────────────────────────────────────────────────────────────────────
function fmt(iso) { return iso.replace('T', ' ').replace(/\.\d{3}/, ''); }

function render(events, meta) {
  const org = events.filter((e) => e.class === 'organic');
  const srv = events.filter((e) => e.class === 'server-op');
  const L = [];
  L.push('B-103 Organic-Loss Meter (T-714)');
  L.push(`window: ${meta.since}  →  ${meta.until}`);
  L.push(`signal: [WS-DIAG] stream-orphaned  |  server-op: [DRAIN] intervals (${meta.nOps})`);
  L.push(`logs: ${meta.nFiles} file(s)  |  correlation pre=${meta.pre}s post-cap=${meta.post}s`);
  L.push('');
  if (events.length === 0) {
    L.push('  (no stream-loss events in window)');
  } else {
    L.push('  ts (local)            session        msgs  class      cause / nearest-op Δ');
    L.push('  --------------------  -------------  ----  ---------  ------------------------');
    for (const e of events) {
      const sid = (e.session || '').slice(0, 13).padEnd(13);
      const cls = e.class.padEnd(9);
      const tail = e.class === 'server-op'
        ? `${e.cause} @${fmt(e.opStartIso).slice(11)} (${e.opEndKind})`
        : `nearest op ${e.nearestOpDeltaSec >= 0 ? '+' : ''}${e.nearestOpDeltaSec}s`;
      L.push(`  ${fmt(e.iso).padEnd(20)}  ${sid}  ${String(e.messagesSoFar).padStart(4)}  ${cls}  ${tail}`);
    }
  }
  L.push('');
  L.push(`TOTALS  organic=${org.length}  server-op=${srv.length}  total=${events.length}`);
  L.push('note: organic = CANDIDATE B-103 loss (upper bound; benign client disconnects');
  L.push('      inflate it). Confirm true loss via workflow journal (no result) + child pid gone.');
  return L.join('\n');
}

function main() {
  const a = parseArgs(process.argv);
  if (a.help) {
    console.log('usage: node scripts/b103-loss-meter.js [--since ISO] [--until ISO] [--json] [--report path]');
    return 0;
  }
  const sinceMs = Date.parse(a.since);
  const untilMs = a.until ? Date.parse(a.until) : Date.now();
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    console.error('invalid --since/--until (use ISO 8601, e.g. 2026-07-06T15:11:00Z)');
    return 2;
  }
  const blocks = readFiles(a.logs);
  const { loss, opStart, opFinish } = collect(blocks);
  const guardRestarts = readGuardRestarts(a.guardLog);
  const intervals = buildIntervals(opStart, opFinish, a.pre, a.post);
  const inWindow = loss.filter((e) => e.t >= sinceMs && e.t <= untilMs);
  const events = classify(inWindow, intervals, guardRestarts);

  const meta = {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    nOps: intervals.length,
    nFiles: blocks.length,
    pre: a.pre,
    post: a.post,
  };

  if (a.json) {
    console.log(JSON.stringify({
      meta,
      totals: {
        organic: events.filter((e) => e.class === 'organic').length,
        serverOp: events.filter((e) => e.class === 'server-op').length,
        total: events.length,
      },
      events,
    }, null, 2));
  } else {
    console.log(render(events, meta));
  }

  if (a.report) {
    if (!/(^|\/)docs\//.test(a.report)) {
      console.error('--report must be under docs/ (read-only tool: single report path allowed)');
      return 2;
    }
    fs.mkdirSync(path.dirname(a.report), { recursive: true });
    fs.writeFileSync(a.report, `# B-103 Organic-Loss Meter — ${meta.since}\n\n\`\`\`\n${render(events, meta)}\n\`\`\`\n`);
    console.error(`report written: ${a.report}`);
  }
  return 0;
}

process.exit(main());
