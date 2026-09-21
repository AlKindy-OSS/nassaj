import type { LoadLevel } from './systemStatsFormat';

/**
 * SystemStatsSparkline — خطوط أفقية بارتفاع سطر واحد داخل زرّ العتاد.
 *
 * الخطوط **مصفوفة بعضها فوق بعض**، كلٌّ لمقياس: المعالج والذاكرة والتخزين
 * وswap والمسار الذي يعيش في الذاكرة. و**طول الخطّ هو القراءة**: يمتدّ حين
 * يرتفع الاستهلاك ويتقلّص حين ينخفض، في مكانه، بلا شريطٍ يزحف عرضاً وبلا تاريخ.
 *
 * سقط شريط التاريخ عمداً بعد محاولتين: القراءة تصل كل خمس ثوانٍ، وعشرون منها
 * على سبعين بكسلاً تُنتج خطّاً متعرّجاً يقرؤه العين حركةً دائمة لا حالةً.
 * والمطلوب حالةٌ تُلمح في نصف ثانية: أين يقف كل مقياس الآن. والتاريخ ليس
 * مفقوداً — الذيل المفتوح يحمل الأرقام، والتلميح يحمل القراءة الدقيقة.
 *
 * والمؤشّر **رفيقٌ للنقطة والنصّ لا بديلٌ عنهما**: الشكل وحده لا يحمل معنى
 * لقارئ الشاشة، فيبقى `aria-hidden` وتبقى الحالة مكتوبةً بجانبه.
 */

/** أقصى طول للخطّ (100%) بوحدات viewBox. */
const FULL_W = 26;
const VIEW_H = 20;
/** سماكة الخطّ. */
const BAR_H = 2;
/**
 * أدنى طولٍ ظاهر. صفرٌ حرفيّ يمحو الخطّ فيبدو المقياس **مفقوداً** لا خاملاً —
 * وهما حالتان مختلفتان تماماً هنا: المفقود يُسقَط عمداً في `lanes` أدناه.
 */
const MIN_SCALE = 0.08;

/**
 * ألوان الحالة — **نفس دلالة النقطة العامّة** في الزرّ: أخضر آمن، كهرماني
 * متوسّط، أحمر عالٍ. لا لون خاصّاً بمقياس يميّزه عن جيرانه، لأن اللون هنا
 * معلومةٌ لا زينة: أربعة ألوان ثابتة تجعل الأحمر مجرّد «لون swap».
 */
const LEVEL_FILL: Record<LoadLevel, string> = {
  low: 'fill-emerald-500',
  medium: 'fill-amber-500',
  high: 'fill-red-500',
};

export type SparkSeries = {
  key: string;
  /** القيمة الحاليّة مُسوّاة على 0..1، أو null إن لم يرسلها الخادم بعد. */
  value: number | null;
  /** مستوى هذه القراءة بعتباتها هي — مصدره `resolveLoadLevel` نفسها. */
  level: LoadLevel;
  /** نصّ التلميح عند الإشارة على الخطّ — القراءة الفعليّة بوحدتها. */
  title: string;
};

/**
 * القيمة → طولها على المحور، بجذرٍ تربيعي لا خطّياً.
 *
 * المقياس الخطّي يمحو الحياة اليومية كلّها: جهازٌ معالجه 3% يرسم خطّاً طوله
 * أقلّ من بكسل، فيبدو المؤشّر ميّتاً بينما هو صادق. والجذر يفرد الطرف المنخفض
 * حيث تقع الحركة الفعلية (‏3% ← 17% من الطول، و9% ← 30%) ويضغط الطرف العالي
 * الذي تحكمه العتبات واللون أصلاً. والترتيب محفوظ: الأكبر يبقى أطول دائماً،
 * والرقم الدقيق في التلميح.
 */
export function displayHeight(value: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, value)));
}

export function SystemStatsSparkline({ series }: { series: SparkSeries[] }) {
  const lanes = series.filter(item => item.value !== null);

  if (lanes.length === 0) return null;

  const rowH = VIEW_H / lanes.length;

  return (
    <svg
      viewBox={`0 0 ${FULL_W} ${VIEW_H}`}
      width={FULL_W}
      height={VIEW_H}
      className="flex-shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      {lanes.map((item, index) => {
        const y = index * rowH + (rowH - BAR_H) / 2;
        const scale = Math.max(MIN_SCALE, displayHeight(item.value ?? 0));

        return (
          <g key={item.key}>
            {/* مسار الخطّ: يُظهر المدى كلّه فيصير الطول مقروءاً بلا مقارنة بالجيران. */}
            <rect
              x={0}
              y={y}
              width={FULL_W}
              height={BAR_H}
              rx={BAR_H / 2}
              className="fill-current opacity-10"
            />
            {/*
              الطول يتغيّر بـ`scaleX` لا بـ`width`: انتقال خصائص الهندسة في SVG
              غير مدعوم في كل المتصفّحات، أمّا `transform` فمدعوم في كلّها.
              و`transform-box: fill-box` يجعل الأصل حافّةَ الخطّ نفسه، فينمو من
              بدايته لا من أصل الإطار.
            */}
            <rect
              x={0}
              y={y}
              width={FULL_W}
              height={BAR_H}
              rx={BAR_H / 2}
              className={LEVEL_FILL[item.level]}
              style={{
                transformBox: 'fill-box',
                transformOrigin: 'left center',
                transform: `scaleX(${scale.toFixed(3)})`,
                transition: 'transform 600ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            />
            {/* مساحة الإشارة تغطّي صفّ الخطّ كلّه لا الجزء الممتلئ وحده. */}
            <rect
              x={0}
              y={index * rowH}
              width={FULL_W}
              height={rowH}
              fill="transparent"
              style={{ pointerEvents: 'all' }}
            >
              <title>{item.title}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
