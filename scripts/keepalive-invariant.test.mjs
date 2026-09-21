#!/usr/bin/env node
// ============================================================================
// scripts/keepalive-invariant.test.mjs
// ----------------------------------------------------------------------------
// حارس B-239 — الـ502 المتقطّع من cloudflared بينما nassaj-dev حيّ.
//
// العطل الأصلي: يحتفظ cloudflared بحوض اتصالات أصل خاملة ويعيد استخدامها حتى
// `originRequest.keepAliveTimeout` (90s)، بينما افتراضي Node هو 5s فقط. فإن كتب
// الوسيطُ طلباً في اتصال أغلقه الأصلُ للتوّ رأى EOF فردّ 502 للمتصفح — والعملية
// حيّة طوال الوقت، فلا `pm2 list` ولا مرصاد /health المحلي يريان شيئاً.
//
// الثابتة الواجب صونها:  headersTimeout > keepAliveTimeout(الأصل) > keepAliveTimeout(الوسيط)
//
// لماذا اختبار لا تعليق؟ لأن طرفَي الثابتة يعيشان في **ملفّين منفصلين**، أحدهما
// خارج المستودع أصلاً (`~/.cloudflared/config.yml`). رفعُ مهلة الوسيط وحدها يُعيد
// العطل صامتاً بلا أي تغيير في هذا الريبو — وهذا الاختبار هو ما يكسر الصمت.
//
// التشغيل: node scripts/keepalive-invariant.test.mjs   (exit 0 = نجحت).
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(__dirname, '..', 'server', 'index.js');
// يقبل التصويب على إعداد بعينه (للاختبار الذاتي ولبيئات لا نفق فيها).
const TUNNEL_CFG =
    process.env.CLOUDFLARED_CONFIG || join(homedir(), '.cloudflared', 'config.yml');

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
    if (condition) {
        pass++;
        console.log(`  ok   ${name}`);
    } else {
        fail++;
        console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
    }
}

// ---- الطرف الأول: مهل الأصل، تُقرأ من المصدر لا من نسخة موازية تنجرف ----------
const src = readFileSync(SERVER_SRC, 'utf8');

// `95_000` بفواصل الآحاد الاختيارية في JS — تُنزع قبل التحويل.
function readTimeout(prop) {
    const m = src.match(new RegExp(`server\\.${prop}\\s*=\\s*([0-9_]+)`));
    return m ? Number(m[1].replace(/_/g, '')) : null;
}

const keepAlive = readTimeout('keepAliveTimeout');
const headers = readTimeout('headersTimeout');

console.log('B-239 — ثابتة مهلة الإبقاء بين الأصل والوسيط\n');

check(
    'server.keepAliveTimeout مضبوط صراحةً في server/index.js',
    keepAlive !== null,
    'غير موجود: يعود Node إلى افتراضه 5s فيعود الـ502 المتقطّع (B-239).'
);
check(
    'server.headersTimeout مضبوط صراحةً في server/index.js',
    headers !== null,
    'غير موجود: headersTimeout الأقل من keepAliveTimeout يقطع الطلبات البطيئة.'
);

if (keepAlive !== null && headers !== null) {
    check(
        'headersTimeout > keepAliveTimeout',
        headers > keepAlive,
        `headersTimeout=${headers}ms ليس أكبر من keepAliveTimeout=${keepAlive}ms — ` +
            'يُغلق Node الاتصال قبل اكتمال ترويسات الطلب البطيء.'
    );
}

// ---- الطرف الثاني: مهلة الوسيط، من إعداد cloudflared خارج المستودع ------------
if (!existsSync(TUNNEL_CFG)) {
    // بيئة بلا نفق (CI مثلاً): الثوابت الداخلية فُحصت أعلاه، والمقارنة العابرة
    // للملفّين تُتخطّى صراحةً — تخطٍّ معلَن لا نجاح صامت.
    console.log(`\n  skip المقارنة مع الوسيط — لا إعداد على ${TUNNEL_CFG}`);
} else {
    const cfg = readFileSync(TUNNEL_CFG, 'utf8');
    // يُلتقط داخل originRequest فقط، وتُتجاهل الأسطر المُعلَّقة.
    const m = cfg.match(/^\s*keepAliveTimeout:\s*(\d+)(s|m)?\s*$/m);
    const proxyMs = m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1_000) : null;

    check(
        'keepAliveTimeout مقروء من إعداد cloudflared',
        proxyMs !== null,
        `تعذّرت قراءته من ${TUNNEL_CFG} — راجع الصياغة يدوياً.`
    );

    if (proxyMs !== null && keepAlive !== null) {
        check(
            `keepAliveTimeout(الأصل) > keepAliveTimeout(الوسيط=${proxyMs / 1000}s)`,
            keepAlive > proxyMs,
            `الأصل=${keepAlive}ms والوسيط=${proxyMs}ms. حين تكون مهلة الأصل أقصر ` +
                'يعيد الوسيط استخدام اتصال أغلقه الأصل → EOF → 502 متقطّع (B-239). ' +
                `ارفع server.keepAliveTimeout فوق ${proxyMs}ms في server/index.js.`
        );
    }
}

console.log(`\nنجح: ${pass}  فشل: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
