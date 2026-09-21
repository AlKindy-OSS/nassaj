/**
 * restartSignal — T-1296
 *
 * قناة إشارة واحدة لدورة «إعادة تشغيل الخادم» تُشارَك بين المكوّنات وبين تبويبات
 * المتصفّح، وتحلّ مشكلتين مقيستين:
 *
 * 1) اللافتة الصفراء البائتة. `useVersionCheck` كان يستجلب `/health` كل 60 ثانية،
 *    بينما إعادة التشغيل تكتمل في 2–5 ثوانٍ. فتبقى اللافتة معروضة حتى دقيقة كاملة
 *    بعد أن صارت باطلة، فيضغطها المالك ظانّاً أن طلبه لم يُنفَّذ.
 * 2) الضغط المكرّر. حارس `restartInFlight` في الخادم يعيش في ذاكرة العملية،
 *    وعملية إعادة التشغيل تستبدل تلك العملية — فالضغطة الثانية بعد ثانيتين تصل
 *    عمليةً جديدة بحارس نظيف فتُنفَّذ فعلاً (رُصدت ثلاث إعادات في أربع ثوانٍ).
 *
 * ما يغطّيه هذا الملف وما لا يغطّيه — بصراحة:
 *   ✅ مكوّنات متعددة في نفس الصفحة (مشترك في الوحدة).
 *   ✅ تبويبات متعددة في نفس المتصفّح (BroadcastChannel + حدث storage).
 *   ✅ إعادة تحميل الصفحة أثناء فترة التهدئة (الطابع الزمني في localStorage).
 *   ❌ متصفّح آخر، أو جهاز آخر، أو مرايا الجلسة اللحظية لمشاهد ثانٍ.
 * الحالة الأخيرة لا يحسمها عميل أصلاً؛ تحتاج طابعاً زمنياً معمَّراً يبثّه الخادم
 * في `/health` (بند اللوحة T-1302). فلا تقرأ هذا الحارس على أنه كافٍ وحده.
 */

/** طُلبت إعادة تشغيل فعلياً (الخادم أجاب `restarting`) أو اكتملت. */
export type RestartSignal = 'triggered' | 'completed';

const CHANNEL_NAME = 'nassaj:restart-signal';
const STORAGE_KEY = 'nassaj:restart-triggered-at';

/**
 * نافذة التهدئة بعد طلب ناجح. إعادة التشغيل تكتمل في 2–5 ثوانٍ، وقياس
 * `system_restart_triggered` أظهر 27 انفجاراً بفارق أقل من 120 ثانية. عشرون ثانية
 * تبتلع كل ضغطة تكرار بشرية معقولة دون أن تحبس إعادة تشغيل ثانية مشروعة طويلاً.
 */
export const RESTART_COOLDOWN_MS = 20_000;

type Listener = (signal: RestartSignal) => void;

const listeners = new Set<Listener>();

let channel: BroadcastChannel | null = null;
let channelTried = false;
let storageBound = false;

function emitLocal(signal: RestartSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // مستمع واحد يرمي لا يُسقط البقية.
    }
  }
}

function getChannel(): BroadcastChannel | null {
  if (channelTried) return channel;
  channelTried = true;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    // تحت Node (اختبارات vitest) القناة كائن libuv قد يُبقي حلقة الأحداث حيّة.
    (channel as unknown as { unref?: () => void }).unref?.();
    channel.onmessage = (event: MessageEvent) => {
      const signal = event.data;
      if (signal === 'triggered' || signal === 'completed') emitLocal(signal);
    };
  } catch {
    channel = null;
  }
  return channel;
}

/**
 * احتياط لمتصفّح بلا BroadcastChannel: كتابة localStorage تُطلق حدث `storage`
 * في التبويبات الأخرى وحدها — وهو بالضبط ما نريده هنا.
 */
function bindStorage(): void {
  if (storageBound || typeof window === 'undefined') return;
  storageBound = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    emitLocal(event.newValue ? 'triggered' : 'completed');
  });
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // وضع خصوصية صارم — التهدئة تسقط إلى نطاق الصفحة وحدها.
    return null;
  }
}

/** يُنادى عند خروج فعليّ لطلب إعادة تشغيل، أو عند تأكّد عودة الخادم. */
export function publishRestartSignal(signal: RestartSignal): void {
  const store = safeLocalStorage();
  try {
    if (signal === 'triggered') store?.setItem(STORAGE_KEY, String(Date.now()));
    else store?.removeItem(STORAGE_KEY);
  } catch {
    // ممتلئ أو محظور — الإشارة اللحظية تكفي.
  }
  try {
    getChannel()?.postMessage(signal);
  } catch {
    // قناة مغلقة — لا شيء يُفعل.
  }
  emitLocal(signal);
}

/** يعيد دالة إلغاء الاشتراك. */
export function subscribeRestartSignal(listener: Listener): () => void {
  getChannel();
  bindStorage();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** ما تبقّى من نافذة التهدئة بالملّي ثانية؛ صفرٌ يعني «لا مانع». */
export function restartCooldownRemainingMs(now: number = Date.now()): number {
  const raw = safeLocalStorage()?.getItem(STORAGE_KEY);
  if (!raw) return 0;
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return 0;
  // ساعة مضبوطة للخلف أو طابع من المستقبل: لا نحبس المالك إلى الأبد.
  if (at > now) return 0;
  return Math.max(0, RESTART_COOLDOWN_MS - (now - at));
}

/** للاختبارات وحدها: يُعيد الوحدة إلى حالة نظيفة. */
export function __resetRestartSignalForTests(): void {
  listeners.clear();
  try {
    safeLocalStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // تجاهل
  }
}
