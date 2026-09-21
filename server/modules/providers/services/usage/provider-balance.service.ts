/**
 * رصيد المزوّد المدفوع بالتوكن — من **مصدره الرسمي** لا من حساب محلّي.
 *
 * هذا مقابلٌ مكمّل لـ`provider-quota.service.ts`، والفرق بينهما ليس تقنياً بل
 * في طبيعة ما يُقاس: مزوّد الاشتراك يعلن **نسبةً مستهلكة من نافذة** تُصفَّر،
 * ومزوّد الدفع-بالتوكن يعلن **رصيداً يَنقُص** بلا تصفير. خلطهما في عقد واحد
 * كان سيُنتج «نسبة» مختلقة من رصيدٍ لا سقف له.
 *
 * المصادر المُتحقَّق منها (توثيق المزوّد، 2026-07-31):
 *  • **moonshot (kimi)** — ‏`GET https://api.moonshot.ai/v1/users/me/balance`
 *    بـ`Authorization: Bearer <key>`. يعيد `data.available_balance` (نقدي +
 *    قسائم) و`data.cash_balance` (قد يكون سالباً = دَين) و`data.voucher_balance`.
 *    وحين `available_balance <= 0` تُرفَض نداءات الاستدلال بـ
 *    `exceeded_current_quota_error`.
 *  • **deepseek** — ‏`/user/balance`، غير مُفعَّل هنا بعد (لا حاجة مثبتة).
 *
 * **قواعد الصدق المفروضة هنا** (نفس قواعد الحصّة):
 *  1. أي فشل — شبكة، ‏401، شكل غير متوقّع — يعيد `null` = «لا نعرف»، ولا
 *     يُصنَع منه صفرٌ. والصفر هنا كذبةٌ مضاعفة: يُقرأ «نَفِد رصيدك».
 *  2. المفتاح يُقرأ خادمياً من مخزن أسرار **المستخدم الطالب** ولا يصل العميل
 *     أبداً (‏ADR-014).
 *  3. المبلغ يُعرض في **البطاقة الاختيارية** لا في السطح الدائم: ‏ADR-081
 *     يمنع المبالغ في الشريط العلوي، وبطاقة الاشتراك تعرض مبلغاً أصلاً.
 */

import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import type { VendorKey } from '@/modules/providers/services/cost/model-vendor.js';

/** نفس نافذة كاش الحصّة: الرقم لا يتحرّك بما يهمّ أسرع من ذلك. */
const CACHE_TTL_MS = 180_000;

/** سقف زمن الانتظار: مزوّد بطيء لا يجوز أن يُعلّق طلب الواجهة. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * رصيد مزوّد واحد. `availableUsd` هو ما يُنفَق فعلاً (نقدي + قسائم)، وهو
 * الرقم الذي يحكم قبول النداء عند المزوّد.
 */
export type ProviderBalance = {
  provider: string;
  /** الرصيد المتاح بالدولار (نقدي + قسائم). */
  availableUsd: number;
  /** الشقّ النقدي — قد يكون سالباً (دَين مستحقّ). */
  cashUsd: number | null;
  /** شقّ القسائم — لا يكون سالباً. */
  voucherUsd: number | null;
  /** ISO للحظة القراءة الفعلية من المزوّد (لا من الكاش). */
  observedAt?: string;
  /** النقطة التي جاء منها — إثباتٌ للتدقيق، لا يُعرض في أي واجهة. */
  source: string;
};

export type ProviderBalanceDeps = {
  /** يُحقَن في الاختبار كي لا تُلمَس شبكة الجهاز. */
  fetchImpl?: typeof fetch;
  /** المفتاح جاهزاً — يتجاوز قراءة المخزن. */
  credential?: string | null;
  now?: () => Date;
  /** Encloses only a live credential/network refresh; cache hits need no lease. */
  runEffect?: <T>(effect: () => Promise<T>) => Promise<T>;
};

type CacheEntry = { at: number; value: ProviderBalance | null };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ProviderBalance | null>>();

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

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  deps: ProviderBalanceDeps,
): Promise<unknown | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// moonshot (kimi) — platform balance
// ---------------------------------------------------------------------------

/**
 * ‏`api.moonshot.ai/v1/users/me/balance`. الردّ يلفّ الحقول في `data`، ويحمل
 * `code: 0` عند النجاح. `available_balance` وحده إلزامي: الشقّان الآخران
 * يُنقَلان حين يكونان رقمين، ولا يُلفَّقان بصفر حين يغيبان.
 */
async function readMoonshotBalance(
  userId: string | number | null,
  deps: ProviderBalanceDeps,
): Promise<ProviderBalance | null> {
  // T-1260 — see the twin note in provider-quota.service.ts: the env bypass
  // outranks the store and stays, because removing it would change which
  // credential this call spends. Wave A converts the store read only.
  const key =
    deps.credential
    ?? process.env.KIMI_API_KEY
    ?? resolveSlotKey(credentialPrincipalId(userId, 'kimi'), 'kimi', { sharedFallback: false })?.key
    ?? null;
  if (!key) return null;

  const body = asRecord(
    await fetchJson(
      'https://api.moonshot.ai/v1/users/me/balance',
      {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      deps,
    ),
  );
  const data = asRecord(body?.data);
  if (!data) return null;

  const available = data.available_balance;
  if (!isFiniteNumber(available)) return null;

  return {
    provider: 'moonshot',
    availableUsd: available,
    cashUsd: isFiniteNumber(data.cash_balance) ? data.cash_balance : null,
    voucherUsd: isFiniteNumber(data.voucher_balance) ? data.voucher_balance : null,
    source: 'api.moonshot.ai/v1/users/me/balance',
  };
}

// ---------------------------------------------------------------------------
// الخدمة
// ---------------------------------------------------------------------------

/**
 * قارئ لكل **مورّد** لا لكل جسم — نفس قاعدة الحصّة: مفتاح Moonshot واحدٌ
 * يقرأه جسم kimi ومحرّك kimi تحت claude، فرصيدهما واحد بحقّ.
 */
const VENDOR_READERS: Partial<
  Record<
    VendorKey,
    (userId: string | number | null, deps: ProviderBalanceDeps) => Promise<ProviderBalance | null>
  >
> = {
  moonshot: readMoonshotBalance,
};

/** هل لهذا المورّد نقطة رصيد رسمية؟ */
export const hasBalanceSource = (vendor: string): boolean =>
  Object.prototype.hasOwnProperty.call(VENDOR_READERS, vendor);

export const providerBalanceService = {
  /**
   * رصيد هذا المورّد، أو `null` إن لم يكن له مصدر أو تعذّرت القراءة.
   * الكاش وsingle-flight بنفس منطق خدمة الحصّة: السطح يُركَّب كثيراً.
   */
  async getBalance(
    vendor: string,
    userId: string | number | null = null,
    deps: ProviderBalanceDeps = {},
  ): Promise<ProviderBalance | null> {
    const reader = VENDOR_READERS[vendor as VendorKey];
    if (!reader) return null;

    const key = cacheKey(userId, vendor);
    const cached = cache.get(key);
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (cached && nowMs - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    if (!deps.runEffect && !deps.fetchImpl) {
      throw new Error('BALANCE_AUTHENTICATED_EFFECT_RUNNER_REQUIRED');
    }

    const liveRead = () => reader(userId, deps);
    const promise = (deps.runEffect ? deps.runEffect(liveRead) : liveRead())
      .then((value) => {
        const stamped = value ? { ...value, observedAt: new Date(nowMs).toISOString() } : null;
        // الفشل يُكاش أيضاً: مفتاح بلا صلاحية لا يُعيد المحاولة مع كل تركيب.
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
