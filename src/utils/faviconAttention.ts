/**
 * أيقونة التبويب — الكاتب الوحيد لـ`link[rel="icon"]` (‏T-2041).
 *
 * على نمط `pageTitleNotification`: لكل جزءٍ مالكٌ يكتب نصيبه فقط، ويُركَّب
 * الناتج هنا من آخر قيمتين معروفتين مهما كان ترتيب التأثيرات:
 *
 *  • **الأساس** (`setBaseFavicon`) — مالكه `BrandingContext`: أيقونة الخادم أو
 *    الشعار، أو `null` للعودة إلى أيقونات `index.html` الأصلية.
 *  • **الانتباه** (`setFaviconAttention`) — مالكه `AppContent`: سؤالٌ ينتظر
 *    جواب المستخدم. يُرسم فوق الأساس نقطةٌ بلون `--primary` (لون شارة السؤال في
 *    الشريط الجانبي نفسه)، تنبض كل ثانية ما دام التبويب مخفيّاً، وتثبت حين
 *    يظهر أو حين يطلب النظام تقليل الحركة.
 *
 * والعلّة: لو كتب مالكا الأساس والانتباه الروابط مباشرةً لمحا آخرُهما نصيبَ
 * الآخر — تغيير العلامة يمحو النقطة، ورفع النقطة يُسقط أيقونة العلامة.
 *
 * تعذّر رسم الأساس (صورة عبر نطاقٍ آخر تلوّث اللوحة، أو صورة لا تُحمَّل، أو
 * بيئة بلا canvas) لا يُسقط الإشارة: تُستعمل أيقونة نقطةٍ مجرّدة بصيغة SVG.
 */

const ICON_SELECTOR = 'link[rel="icon"]';
const ICON_SIZE = 64;
const PULSE_INTERVAL_MS = 1000;
const DIM_ALPHA = 0.35;
const FALLBACK_DOT_COLOR = 'hsl(221.2 83.2% 53.3%)';
const FALLBACK_RING_COLOR = 'hsl(210 40% 98%)';

type AttentionFrames = { on: string; dim: string };

let baseHref: string | null = null;
let attentionActive = false;
let originalIcons: Element[] | null = null;
let customIconWritten = false;
let frames: AttentionFrames | null = null;
let framesKey: string | null = null;
let composeGeneration = 0;
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseOn = true;
let listenersInstalled = false;

const hasDocument = (): boolean => typeof document !== 'undefined';

const captureOriginalIcons = (): Element[] => {
  if (!originalIcons) {
    originalIcons = Array.from(document.head.querySelectorAll(ICON_SELECTOR));
  }
  return originalIcons;
};

const replaceIconLinks = (href: string | null): void => {
  const originals = captureOriginalIcons();
  document.head.querySelectorAll(ICON_SELECTOR).forEach((node) => node.remove());
  if (href) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = href;
    document.head.appendChild(link);
    customIconWritten = true;
    return;
  }
  originals.forEach((node) => document.head.appendChild(node));
  customIconWritten = false;
};

/** يقرأ رمزاً لونياً من متغيّرات التصميم (‏HSL ثلاثيّ كما في `index.css`). */
const readColorToken = (name: string, fallback: string): string => {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const svgDotIcon = (dot: string, ring: string, alpha: number): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="32" r="26" fill="${dot}" stroke="${ring}" stroke-width="6"`
    + ` opacity="${alpha}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const fallbackFrames = (dot: string, ring: string): AttentionFrames => ({
  on: svgDotIcon(dot, ring, 1),
  dim: svgDotIcon(dot, ring, DIM_ALPHA),
});

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('favicon base image failed to load'));
    image.src = src;
  });

const drawFrame = (
  image: HTMLImageElement,
  dot: string,
  ring: string,
  alpha: number,
): string => {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  // النقطة في الزاوية العليا البعيدة عن النصّ، بحلقةٍ تفصلها عن أي أيقونة أساس.
  const radius = ICON_SIZE * 0.22;
  const center = ICON_SIZE - radius - 2;
  context.globalAlpha = alpha;
  context.beginPath();
  context.arc(center, radius + 2, radius, 0, Math.PI * 2);
  context.fillStyle = dot;
  context.fill();
  context.lineWidth = ICON_SIZE * 0.06;
  context.strokeStyle = ring;
  context.stroke();
  // يرمي SecurityError إن لوّثت صورةٌ عبر نطاقٍ آخر اللوحة — يلتقطه المستدعي.
  return canvas.toDataURL('image/png');
};

const resolveBaseSource = (): string | null => {
  if (baseHref) return baseHref;
  const original = captureOriginalIcons()[0];
  return original?.getAttribute('href') ?? null;
};

const composeFrames = async (source: string | null): Promise<AttentionFrames> => {
  const dot = readColorToken('--primary', FALLBACK_DOT_COLOR);
  const ring = readColorToken('--primary-foreground', FALLBACK_RING_COLOR);
  if (!source) return fallbackFrames(dot, ring);
  try {
    const image = await loadImage(source);
    return {
      on: drawFrame(image, dot, ring, 1),
      dim: drawFrame(image, dot, ring, DIM_ALPHA),
    };
  } catch {
    return fallbackFrames(dot, ring);
  }
};

const stopPulse = (): void => {
  if (pulseTimer !== null) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  pulseOn = true;
};

const shouldPulse = (): boolean =>
  attentionActive && document.hidden === true && !prefersReducedMotion();

const writeAttentionFrame = (): void => {
  if (!frames) return;
  replaceIconLinks(pulseOn ? frames.on : frames.dim);
};

const syncPulse = (): void => {
  if (!hasDocument()) return;
  if (!attentionActive || !frames || !shouldPulse()) {
    stopPulse();
    if (attentionActive && frames) writeAttentionFrame();
    return;
  }
  if (pulseTimer !== null) return;
  pulseOn = true;
  writeAttentionFrame();
  pulseTimer = setInterval(() => {
    pulseOn = !pulseOn;
    writeAttentionFrame();
  }, PULSE_INTERVAL_MS);
};

const installListeners = (): void => {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  document.addEventListener('visibilitychange', syncPulse);
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    query.addEventListener?.('change', syncPulse);
  }
};

const writeBase = (): void => {
  // لا تخصيص ولا انتباه سبق ⇒ أيقونات `index.html` تبقى كما هي دون لمس.
  if (!baseHref && !customIconWritten) return;
  replaceIconLinks(baseHref);
};

const render = (): void => {
  if (!hasDocument()) return;
  if (!attentionActive) {
    composeGeneration += 1;
    stopPulse();
    writeBase();
    return;
  }
  installListeners();
  const source = resolveBaseSource();
  const key = `${source ?? ''}`;
  if (frames && framesKey === key) {
    syncPulse();
    return;
  }
  const generation = ++composeGeneration;
  void composeFrames(source).then((next) => {
    // نتيجةٌ قديمة: تبدّل الأساس أو زال الانتباه أثناء الرسم.
    if (generation !== composeGeneration || !attentionActive) return;
    frames = next;
    framesKey = key;
    stopPulse();
    syncPulse();
  });
};

/**
 * أيقونة الأساس. `null` ⇒ أيقونات `index.html` الأصلية.
 * تُحفظ النقطة إن كانت مرفوعة: تُعاد رسمها فوق الأساس الجديد.
 */
export const setBaseFavicon = (href: string | null): void => {
  const next = href && href.length > 0 ? href : null;
  if (next === baseHref) {
    if (!attentionActive) writeBase();
    return;
  }
  baseHref = next;
  frames = null;
  framesKey = null;
  render();
};

/** يرفع إشارة «ينتظر جوابك» أو يزيلها، ويعيد أيقونة الأساس عند الإزالة. */
export const setFaviconAttention = (active: boolean): void => {
  if (active === attentionActive) return;
  attentionActive = active;
  render();
};

/** للاختبارات فقط: يعيد الحالة إلى ما قبل أي كتابة. */
export const resetFaviconAttentionForTests = (): void => {
  stopPulse();
  baseHref = null;
  attentionActive = false;
  originalIcons = null;
  customIconWritten = false;
  frames = null;
  framesKey = null;
  composeGeneration += 1;
};
