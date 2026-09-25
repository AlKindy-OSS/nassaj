/**
 * نوافذ الحصّة لكل مزوّد — من **مصدره الرسمي** لا من تقدير محلّي.
 *
 * جولة توثيق المزوّدات (‏2026-07-30) خلصت إلى أن ثلاثة فقط يُعلنون حصّةً
 * قابلة للقراءة آلياً، والبقية لا تُعلن شيئاً — والصمت عنها صدقٌ لا نقص:
 *
 *  • **claude** — له خدمته القائمة (`claude-usage.service.ts`، نوافذ C/W/S/O).
 *    غير مُدار هنا كي لا يُنسخ منطقٌ يعمل.
 *  • **codex** — ‏`GET https://chatgpt.com/backend-api/wham/usage` بـBearer من
 *    `~/.codex/auth.json`. مُتحقَّق حيّاً: 200 في ~520ms، ويعيد `plan_type`
 *    و`rate_limit.primary_window/secondary_window` بـ`used_percent` و`reset_at`.
 *    ‏(`/backend-api/codex/usage` يرد 403 — ليس هو المسار.) **هذا ينقض ما كان
 *    مسجَّلاً في T-905 من أن حصص كودكس غير متاحة headless.**
 *  • **glm** — ‏`GET https://api.z.ai/api/monitor/usage/quota/limit` بترويسة
 *    `Authorization: <key>` **بلا بادئة Bearer**. مُتحقَّق حيّاً: 200 في ~2ث،
 *    ويعيد `level` (‏lite/pro/max) و`limits[]` بـ`percentage` و`nextResetTime`.
 *    ويوافق توثيق z.ai: دورة 5 ساعات + حدّ أسبوعي + مخصّص شهري لأدوات MCP.
 *
 * ومن لا مصدر له، بالتوثيق لا بالتخمين: ‏deepseek يعلن **رصيداً مالياً** فقط
 * (`/user/balance`) لا حصّة — والمبالغ ممنوعة في السطوح الدائمة (‏ADR-081)؛
 * وcursor لا واجهة
 * استخدام رسمية (المتاح معكوسٌ هندسياً)؛ وopencode-zen لا نقطة رصيد رسمية
 * (طلب ميزة مفتوح)؛ وantigravity لا يكتب عدّادات أصلاً؛ وhermes/Nous Portal
 * لا يوثّق نقطة حصّة (لوحة الويب فقط).
 *
 * **kimi استثناءٌ مُقسَّم**: مسار الاشتراك (‏Kimi Code) له نقطة أصيلة
 * ‏`GET https://api.kimi.com/coding/v1/usages` تعيد نافذة أسبوعية (‏604800ث)
 * ونافذة 5 ساعات (‏18000ث) بـ`percentUsed`/`resetsAt` — وهي مُفعَّلة هنا.
 * ومسار API key (‏`api.moonshot.ai`) لا حصّة له، رصيدٌ مالي فقط
 * ‏(`/v1/users/me/balance`) — ويُعالَج في مسارٍ مستقل (‏T-1137).
 *
 * **قواعد الصدق المفروضة هنا:**
 *  1. أي فشل — شبكة، ‏401 توكن بائت، شكل غير متوقّع — يعيد `null` = «لا نعرف»،
 *     ولا يُصنَع منه صفرٌ ولا نسبة. السطح يصمت.
 *  2. نافذة بلا `usedPercent` رقمي منتهٍ أو بلا `resetsAt` صالح **تُحذَف** لا
 *     تُكمَّل بصفر.
 *  3. الحمولة المُعادة **لا تحمل أي حقل هوية**: ردّ كودكس يحمل `email` و`user_id`
 *     ولا يعبران هذه الطبقة. رصيد الاستخدام الإضافي يمرّ فقط كـ`balance` رقمي
 *     منتهٍ و`unlimited` منطقي، إن أعلنه Codex كاملاً؛ لا يعبر كائن `credits` الخام.
 *  4. المفتاح/التوكن يُقرأ خادمياً من جذر اعتمادات **المستخدم الطالب**
 *     (‏`resolveProviderEnv`/مخزن الأسرار) ولا يصل العميل أبداً (‏ADR-014).
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveModelVendor, harnessVendor, type VendorKey } from '@/modules/providers/services/cost/model-vendor.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import type { ProviderQuotaWindow, ProviderQuotaWindows } from '@/shared/types.js';

/**
 * نفس نافذة كاش حصّة كلود (‏180ث): الرقم لا يتحرّك بما يهمّ أسرع من ذلك،
 * والمزوّدون يحدّون النداءات. والشريط العلوي يُركَّب مع كل تحميل صفحة ولكل
 * مشاهد، فبلا كاش تصير الميزة مصدرَ حِمل على حساب المالك عند المزوّد.
 */
const CACHE_TTL_MS = 180_000;

/** سقف زمن الانتظار: مزوّد بطيء لا يجوز أن يُعلّق طلب الواجهة. */
const FETCH_TIMEOUT_MS = 8_000;

/** المزوّدات التي تُدار هنا. claude غائب عمداً — له خدمته القائمة. */
export const QUOTA_WINDOW_PROVIDERS: readonly string[] = Object.freeze(['codex', 'glm', 'kimi']);

type CacheEntry = { at: number; value: ProviderQuotaWindows | null };

export type ProviderQuotaDeps = {
  /** يُحقَن في الاختبار كي لا يُلمَس قرص الجهاز ولا شبكته. */
  fetchImpl?: typeof fetch;
  /** التوكن/المفتاح جاهزاً — يتجاوز قراءة القرص والمخزن. */
  credential?: string | null;
  now?: () => Date;
  /** Encloses only a live credential/network refresh; cache hits need no lease. */
  runEffect?: <T>(effect: () => Promise<T>) => Promise<T>;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ProviderQuotaWindows | null>>();

// المفتاح بالمورّد (‏glm/openai) لا بالجسم: قارئ الحصّة واحدٌ للمورّد، فجلسة
// claude+glm وجلسة glm خالصة تتشاركان نفس اللقطة بحقّ.
const cacheKey = (userId: string | number | null, vendor: string): string =>
  `${vendor}|${userId ?? ''}`;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Codex currently returns `credits.balance` as a decimal string or number. Do not use
 * JavaScript's broad number coercion here: it accepts hex/exponent spellings
 * and can round a billing value before it crosses the API contract.
 */
function parseCodexCreditBalance(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
    if (Number.isInteger(value)) return Number.isSafeInteger(value) ? value : null;

    // Codex balances carry at most cent precision. A JSON number can arrive
    // with a float-arithmetic tail (0.30000000000000004) that has nothing to
    // do with the actual billed amount — rounding to cents absorbs that
    // instead of rejecting an otherwise-valid balance as "too many digits".
    const rounded = Math.round(value * 100) / 100;
    return Number.isFinite(rounded) && rounded >= 0 && rounded <= Number.MAX_SAFE_INTEGER
      ? rounded
      : null;
  }

  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;

  const [whole, fraction = ''] = value.split('.');
  const significantDigits = `${whole}${fraction}`.replace(/^0+/, '').length;
  const integerValue = BigInt(whole);
  if (integerValue > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  // Integers at the safe ceiling are exact. Decimal values need a stricter
  // cap so the number transported to the client retains display-safe precision.
  if (fraction && significantDigits > 15) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

/**
 * نافذة صالحة أو `null`. النسبة تُقصَر على [0,100] لأن المزوّد قد يتجاوز 100
 * عند بلوغ الحدّ، والعرض فوق 100% يقرأ خللاً لا امتلاءً؛ والقصّ هنا لا يخفي
 * شيئاً (‏100% = «نَفِدت»، وهو ما نريد قوله بالضبط).
 */
function makeWindow(
  key: string,
  usedPercent: unknown,
  resetsAtMs: unknown,
  windowSeconds?: unknown,
): ProviderQuotaWindow | null {
  if (!isFiniteNumber(usedPercent)) return null;
  if (!isFiniteNumber(resetsAtMs)) return null;

  const resetsAt = new Date(resetsAtMs);
  if (Number.isNaN(resetsAt.getTime())) return null;

  return {
    key,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: resetsAt.toISOString(),
    ...(isFiniteNumber(windowSeconds) ? { windowSeconds } : {}),
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  deps: ProviderQuotaDeps,
): Promise<unknown | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      // ‏401/403 = توكن بائت أو مفتاح بلا صلاحية مراقبة. لا يُصنَع منه رقم.
      return null;
    }
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch {
    // شبكة، مهلة، أو JSON تالف — كلها «لا نعرف».
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// codex — ChatGPT backend
// ---------------------------------------------------------------------------

function codexHome(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'codex') as Record<string, string | undefined>;
  const home = env.CODEX_HOME;
  return typeof home === 'string' && home.trim() ? home : path.join(os.homedir(), '.codex');
}

async function readCodexAuth(
  userId: string | number | null,
): Promise<{ accessToken: string; accountId: string } | null> {
  try {
    const raw = await readFile(path.join(codexHome(userId), 'auth.json'), 'utf8');
    const tokens = asRecord(asRecord(JSON.parse(raw))?.tokens);
    const accessToken = tokens?.access_token;
    const accountId = tokens?.account_id;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { accessToken, accountId: typeof accountId === 'string' ? accountId : '' };
  } catch {
    return null;
  }
}

async function readCodexQuota(
  userId: string | number | null,
  deps: ProviderQuotaDeps,
): Promise<ProviderQuotaWindows | null> {
  const auth = deps.credential
    ? { accessToken: deps.credential, accountId: '' }
    : await readCodexAuth(userId);
  if (!auth) return null;

  const body = asRecord(
    await fetchJson(
      'https://chatgpt.com/backend-api/wham/usage',
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        Accept: 'application/json',
      },
      deps,
    ),
  );
  if (!body) return null;

  // `credits` is provider-owned and may gain identity/billing fields. Deliberately
  // project only the two display-safe fields used by the settings card.
  const rawCredits = asRecord(body.credits);
  const parsedBalance = parseCodexCreditBalance(rawCredits?.balance);
  const extraUsageCredits =
    parsedBalance !== null && typeof rawCredits?.unlimited === 'boolean'
      ? { balance: parsedBalance, unlimited: rawCredits.unlimited }
      : undefined;

  const rateLimit = asRecord(body.rate_limit);

  const windows: ProviderQuotaWindow[] = [];
  // النافذتان بأسمائهما عند المزوّد: الأساسية (أسبوعية على Plus عادةً) والثانوية.
  // لا نسمّيهما «أسبوعي/5 ساعات» في العقد: الطول يأتي في `windowSeconds` من
  // المزوّد نفسه، فتسميةٌ مثبَّتة كانت ستكذب على خطة تُقاس بخلاف ذلك.
  for (const [key, field] of [
    ['primary', 'primary_window'],
    ['secondary', 'secondary_window'],
  ] as const) {
    const raw = asRecord(rateLimit?.[field]);
    if (!raw) continue;
    const resetAtSeconds = raw.reset_at;
    const window = makeWindow(
      key,
      raw.used_percent,
      isFiniteNumber(resetAtSeconds) ? resetAtSeconds * 1000 : null,
      raw.limit_window_seconds,
    );
    if (window) windows.push(window);
  }

  // Credits are independently useful: some Codex responses can include a
  // complete credit balance while omitting an active rate-limit window. Keep
  // that truthful balance visible instead of discarding the whole response.
  if (windows.length === 0 && !extraUsageCredits) return null;

  return {
    provider: 'codex',
    plan: typeof body.plan_type === 'string' ? body.plan_type : null,
    windows,
    ...(extraUsageCredits ? { extraUsageCredits } : {}),
    source: 'chatgpt.com/backend-api/wham/usage',
  };
}

// ---------------------------------------------------------------------------
// glm — z.ai monitor
// ---------------------------------------------------------------------------

/**
 * `unit`/`number` عند z.ai ⇒ طول النافذة بالثواني.
 *
 * الترقيم غير موثَّق رسمياً، لكن الخريطة أدناه **مسنودة بمطابقة التوثيق على
 * الحمولة الحيّة** لا مخمَّنة: ‏devpack/faq يعلن ثلاث نوافذ — «دورة 5 ساعات»
 * و«حدّ أسبوعي يُصفَّر كل 7 أيام» و«مخصّص شهري لأدوات MCP» — والحمولة الحيّة
 * تحمل بالضبط `(unit:3, number:5)` و`(unit:6, number:1)` و`(unit:5, number:1)`،
 * والثالثة هي صفّ `TIME_LIMIT` لأدوات MCP بعينها. فالمطابقة واحدة لواحد.
 *
 * وأي وحدة غير معروفة ⇒ `undefined`: يُعرض حينها أفق التصفير وحده بدل لصق طولٍ
 * مختلق على نافذة لا نعرف مداها.
 */
const GLM_UNIT_SECONDS: Readonly<Record<number, number>> = Object.freeze({
  3: 3_600, // ساعة
  6: 604_800, // أسبوع
  5: 2_592_000, // شهر (30 يوماً — مخصّص أدوات MCP)
});

function glmWindowSeconds(unit: unknown, number: unknown): number | undefined {
  if (!isFiniteNumber(unit) || !isFiniteNumber(number)) return undefined;
  const base = GLM_UNIT_SECONDS[unit];
  if (!base) return undefined;
  const seconds = base * number;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

async function readGlmQuota(
  userId: string | number | null,
  deps: ProviderQuotaDeps,
): Promise<ProviderQuotaWindows | null> {
  // T-1260 — `process.env.GLM_API_KEY` OUTRANKS the store and is deliberately
  // left in place. It is a real bypass (an operator-set env var answers for every
  // member and is invisible to the store, the audit log, and any future sharing
  // declaration), but removing it here would change which credential this call
  // spends — a behavioural change wave A is not allowed to make. It is unset in
  // `.env` today (checked), and closing it is tracked with the declaration work.
  const key =
    deps.credential
    ?? process.env.GLM_API_KEY
    ?? resolveSlotKey(credentialPrincipalId(userId, 'glm'), 'glm', { sharedFallback: false })?.key
    ?? null;
  if (!key) return null;

  const body = asRecord(
    await fetchJson(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      {
        // بلا بادئة Bearer — هكذا يقبله z.ai حرفياً (مُتحقَّق حيّاً؛ التوثيق
        // غير الرسمي يذكرها صراحةً، والبادئة تُنتج رفضاً).
        Authorization: key,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
      deps,
    ),
  );
  const data = asRecord(body?.data);
  const limits = Array.isArray(data?.limits) ? data.limits : null;
  if (!limits) return null;

  const windows: ProviderQuotaWindow[] = [];
  let tokenIndex = 0;
  for (const entry of limits) {
    const row = asRecord(entry);
    if (!row) continue;

    // ‏`unit`/`number` ترقيمٌ غير موثَّق رسمياً (المستنتَج: 3=ساعة، 6=أسبوع،
    // 5=شهر) فلا يُبنى عليه تصنيف. نميّز بالنوع المُعلَن فقط: ‏TOKENS_LIMIT
    // نوافذ استهلاك التوكنز (تُرقَّم بترتيب ورودها)، وTIME_LIMIT مخصّص أدوات
    // MCP — ويبقى الطول والموعد من `nextResetTime` الذي يرسله المزوّد.
    const type = typeof row.type === 'string' ? row.type : '';
    const key =
      type === 'TOKENS_LIMIT'
        ? `tokens${(tokenIndex += 1)}`
        : type === 'TIME_LIMIT'
          ? 'tools'
          : '';
    if (!key) continue;

    // طول النافذة يُرسَل حين تُعرَف وحدته: الواجهة تسمّي النافذة بطولها
    // (‏«5س»/«أسبوع»/«شهر») لا بموعد تصفيرها — وقد التبس ذلك على المالك حين
    // كانت الشارة تقول «7س 29%» عن **النافذة الأسبوعية** التي تُصفَّر بعد 7
    // ساعات، فتُقرأ «نافذة 7 ساعات».
    const window = makeWindow(
      key,
      row.percentage,
      row.nextResetTime,
      glmWindowSeconds(row.unit, row.number),
    );
    if (window) windows.push(window);
  }

  if (windows.length === 0) return null;

  return {
    provider: 'glm',
    plan: typeof data?.level === 'string' ? data.level : null,
    windows,
    source: 'api.z.ai/api/monitor/usage/quota/limit',
  };
}

// ---------------------------------------------------------------------------
// kimi — Kimi Code subscription (OAuth)
// ---------------------------------------------------------------------------

/**
 * ‏`~/.kimi-code/credentials/kimi-code.json` للمشغّل، أو
 * ‏`~/.nassaj-users/<userId>/.kimi/credentials/kimi-code.json` للمستخدم المعزول.
 * نفس قاعدة أدوات الطرف الثالث (‏quota-axi): التوكن صالح فقط إن بقي فيه أكثر
 * من 60 ثانية.
 */
async function readKimiSubscriptionAuth(
  userId: string | number | null,
): Promise<string | null> {
  const credPath =
    userId === null || userId === undefined
      ? path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
      : path.join(userConfigDir(credentialPrincipalId(userId, 'kimi'), '.kimi'), 'credentials', 'kimi-code.json');
  try {
    const raw = await readFile(credPath, 'utf8');
    const data = asRecord(JSON.parse(raw));
    const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
    const expiresAt = typeof data?.expires_at === 'number' ? data.expires_at : 0;
    if (!accessToken || !expiresAt) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    return expiresAt - nowSec > 60 ? accessToken : null;
  } catch {
    return null;
  }
}

/**
 * ‏`api.kimi.com/coding/v1/usages` — النافذة الأسبوعية (‏604800ث) ونافذة
 * الـ5 ساعات (‏18000ث) تأتيان بأسمائهما عند المزوّد، ولا نُسمّيهما «أسبوعي/5
 * ساعات» في العقد: الطول يأتي في `windowSeconds` من المزوّد نفسه.
 */
async function readKimiQuota(
  userId: string | number | null,
  deps: ProviderQuotaDeps,
): Promise<ProviderQuotaWindows | null> {
  // لا يُقبل credential مُمرَّر: نقطة الاشتراك تقبل توكن OAuth فقط، ومصدره
  // الوحيد الموثوق هو ملف الاعتمادات نفسه. مفتاح API هنا ليس بديلاً صالحاً.
  const token = await readKimiSubscriptionAuth(userId);
  if (!token) return null;

  const body = asRecord(
    await fetchJson(
      'https://api.kimi.com/coding/v1/usages',
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      deps,
    ),
  );
  if (!body) return null;

  const limits = Array.isArray(body.limits) ? body.limits : null;
  if (!limits) return null;

  const windows: ProviderQuotaWindow[] = [];
  for (const entry of limits) {
    const row = asRecord(entry);
    if (!row) continue;

    const windowSeconds = typeof row.window_seconds === 'number' ? row.window_seconds : undefined;
    const key =
      windowSeconds === 604800
        ? 'weekly'
        : windowSeconds === 18000
          ? 'five_hour'
          : `limit${windows.length + 1}`;

    const resetAtSeconds = row.reset_at;
    const window = makeWindow(
      key,
      row.percent_used,
      isFiniteNumber(resetAtSeconds) ? resetAtSeconds * 1000 : null,
      windowSeconds,
    );
    if (window) windows.push(window);
  }

  if (windows.length === 0) return null;

  return {
    provider: 'kimi',
    plan: typeof body.plan === 'string' ? body.plan : null,
    windows,
    source: 'api.kimi.com/coding/v1/usages',
  };
}

// ---------------------------------------------------------------------------
// الخدمة
// ---------------------------------------------------------------------------

/**
 * قارئ لكل **مورّد** لا لكل جسم. السبب مقيس: محور المحرّك (‏ADR-037) يجعل جسم
 * `claude` يعمل على نقطة z.ai، والختم الذي يعرف ذلك يعيش في `localStorage`
 * **لكل متصفّح** ولا يُحفَظ خادمياً (خيارٌ لكل إرسال في claude-sdk فقط). فمالكٌ
 * يفتح نفس الجلسة من جهاز آخر لا ختم عنده ⇒ كان الهيدر يعود لعرض نوافذ
 * Anthropic على استهلاكٍ يُفوتَر على z.ai (بلاغ المالك 2026-07-30 من الجوّال).
 *
 * الدليل المستقلّ عن الجهاز هو **النموذج الفعّال**: في محور المحرّك يكون معرّف
 * النموذج للمحرّك لا للجسم (‏B-235: `claude-model` يحمل `glm-5.2`)، ومصدره
 * خادمي (`/active-model`). فيُحلّ المورّد من النموذج بـ`resolveModelVendor`
 * — **نفس دالّة نظام الكلفة، لا نسخة ثانية تتعفّن.**
 */
const VENDOR_READERS: Partial<
  Record<
    VendorKey,
    (userId: string | number | null, deps: ProviderQuotaDeps) => Promise<ProviderQuotaWindows | null>
  >
> = {
  openai: readCodexQuota,
  glm: readGlmQuota,
  moonshot: readKimiQuota,
};

/**
 * نتيجة الحلّ: مورّدٌ له قارئ، أو `anthropic` (فيتولّى مسار حصّة كلود القائم)،
 * أو `null` (لا مصدر). التمييز بين الأخيرين ضروري في العقد: «هذا استهلاك حساب
 * Claude» جوابٌ يجب أن يميّزه العميل عن «لا نعرف»، وإلا عرض نوافذ Anthropic
 * كملاذٍ عند أي تعذّر — وهو الرقم الخاطئ نفسه الذي جاء البلاغ عنه.
 */
export type QuotaVendorResolution = VendorKey | null;

export function resolveQuotaVendor(provider: string, model?: string | null): QuotaVendorResolution {
  const fromModel = model && model.trim() ? resolveModelVendor(model, provider) : 'unknown';
  if (fromModel !== 'unknown') {
    return fromModel;
  }
  // لا نموذج (أو نموذج لا يدلّ): المورّد الطبيعي للجسم. `opencode` حاملٌ بلا
  // مورّد طبيعي فيبقى null — لا يُنسب استهلاكه لأحد بلا سند.
  return harnessVendor(provider);
}

export const providerQuotaService = {
  /**
   * نوافذ الحصّة لهذا المزوّد، أو `null` إن لم يكن له مصدر أو تعذّرت القراءة.
   *
   * `observedAt` يُضاف عند الإرجاع لا داخل القارئ: هو طابع **لحظة القراءة**
   * الفعلية، وهو ما يميّز «رقم لحظته الآن» من «رقم من الكاش» في أي تشخيص لاحق.
   */
  async getWindows(
    provider: string,
    userId: string | number | null = null,
    deps: ProviderQuotaDeps = {},
    model?: string | null,
  ): Promise<ProviderQuotaWindows | null> {
    const vendor = resolveQuotaVendor(provider, model);
    const reader = vendor ? VENDOR_READERS[vendor] : undefined;
    if (!reader) return null;

    // المفتاح بالمورّد لا بالجسم: جلسة claude+glm وجلسة glm خالصة تقرآن نفس
    // الحصّة فعلاً، فكاشان منفصلان كانا سيضاعفان النداء على z.ai بلا سبب.
    const key = cacheKey(userId, vendor as string);
    const cached = cache.get(key);
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (cached && nowMs - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    if (!deps.runEffect && !deps.fetchImpl) {
      throw new Error('QUOTA_AUTHENTICATED_EFFECT_RUNNER_REQUIRED');
    }

    const liveRead = () => reader(userId, deps);
    const promise = (deps.runEffect ? deps.runEffect(liveRead) : liveRead())
      .then((value) => {
        const stamped = value
          ? { ...value, observedAt: new Date(nowMs).toISOString() }
          : null;
        // الفشل يُكاش أيضاً (بنفس النافذة): مزوّد بلا مصدر أو توكن بائت لا يجوز
        // أن يُعيد المحاولة مع كل تركيب مكوّن — وهو سطحٌ يُركَّب كثيراً.
        cache.set(key, { at: nowMs, value: stamped });
        return stamped;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  },

  /** للاختبارات. */
  __resetCache(): void {
    cache.clear();
    inFlight.clear();
  },
};
