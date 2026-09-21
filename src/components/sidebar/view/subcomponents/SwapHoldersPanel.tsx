/**
 * SwapHoldersPanel — «مَن يحمل الـswap؟» (T-1204).
 *
 * لوحة **عرضٍ فقط** تُفتح من صفّ SWAP في ذيل الشريط الجانبي. لا زرّ قتل فيها
 * ولا أيّ فعل، وهذا قرارٌ لا نقصٌ: زرّ `swapoff` نُقض بفيتو لأنه يحتاج root،
 * ويُسقط الخادم نفسه عبر OOM وهو يُعيد الصفحات إلى ذاكرةٍ ممتلئة، ويعالج
 * **رقماً** لا مشكلة. البديل المعتمد تشخيصٌ يقود المالك إلى العملية الخاملة
 * الصحيحة فيوقفها بنفسه خارج التطبيق.
 *
 * الترتيب مقصود — الأهمّ أوّلاً: `/tmp` ثم الحاملون ثم النظام ثم غير المنسوب.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, HardDrive, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { SwapHoldersState } from './swapHoldersData';
import {
  formatAgoShort,
  formatAgoText,
  formatMbText,
  primaryTmpfs,
  tmpfsPercentOfSize,
} from './systemStatsFormat';

/** أكثر من هذه النسبة من سعة المسار = تحذير: الكتابة على وشك أن تفشل. */
const TMPFS_WARN_PERCENT = 70;

/** أصناف `classifyProcess` الخادمية — و`other` بلا نصّ: لا يضيف شيئاً. */
const KIND_FALLBACK: Record<string, string> = {
  browser: 'متصفّح',
  agent: 'وكيل',
  test: 'اختبار',
  build: 'بناء',
  session: 'جلسة',
  other: '',
};

/** نبضةٌ كلّ ثانية لتبقى «قِيس قبل…» صادقة ما دامت اللوحة مفتوحة. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function uiLocale(): string {
  if (typeof document === 'undefined') return 'ar';
  return document.documentElement.lang === 'en' ? 'en' : 'ar';
}

/** حجمٌ بأرقام لاتينية معزولة الاتجاه — كبقيّة أرقام الذيل. */
function Size({ mb, approximate, title }: { mb: number; approximate?: boolean; title?: string }) {
  return (
    <span
      dir="ltr"
      title={title}
      className="flex-shrink-0 text-xs tabular-nums text-foreground/80"
    >
      {approximate ? '≈' : ''}
      {formatMbText(mb)}
    </span>
  );
}

export function SwapHoldersPanel({
  t,
  state,
  panelId,
}: {
  t: TFunction;
  state: SwapHoldersState;
  panelId: string;
}) {
  const { status, data } = state;
  const now = useSecondTick(status === 'ready');
  const locale = uiLocale();

  const label = t('systemStats.swapHolders.title', { defaultValue: 'مَن يحمل الـswap؟' });

  const shell = (children: ReactNode) => (
    <div
      id={panelId}
      role="region"
      aria-label={label}
      className="mx-2.5 mb-1 mt-0.5 flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2"
    >
      {children}
    </div>
  );

  if (status === 'loading' || (status === 'idle' && data === null)) {
    return shell(
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" aria-hidden="true" />
        <span>{t('systemStats.swapHolders.loading', { defaultValue: 'جارٍ القراءة…' })}</span>
      </div>,
    );
  }

  if (status === 'error') {
    return shell(
      <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        <span>
          {t('systemStats.swapHolders.error', {
            defaultValue: 'تعذّرت قراءة تفصيل الـswap',
          })}
        </span>
      </div>,
    );
  }

  if (data === null || data.available === false) {
    return shell(
      <div className="text-xs text-muted-foreground">
        {t('systemStats.swapHolders.unavailable', {
          defaultValue: 'القراءة غير متاحة على هذا النظام',
        })}
      </div>,
    );
  }

  const tmp = primaryTmpfs(data.tmpfs);
  const tmpPercent = tmp !== null ? tmpfsPercentOfSize(tmp.usedMb, tmp.sizeMb) : null;
  const tmpHeavy = tmpPercent !== null && tmpPercent >= TMPFS_WARN_PERCENT;

  const holders = [...(data.holders ?? [])].sort((a, b) => b.swapMb - a.swapMb);
  const system = data.system ?? null;
  const unattributed = typeof data.unattributedMb === 'number' ? data.unattributedMb : null;

  const approximateHint = t('systemStats.swapHolders.approximateHint', {
    defaultValue: 'قياس تقريبي: قد يَعدّ الصفحة المشتركة بين عمليتين مرّتين',
  });

  return shell(
    <>
      {/* (1) المسار الذي يعيش في الذاكرة — أوّلاً لأنه أكبر حاملٍ مرجَّح */}
      {tmp !== null && (
        <div
          className="flex items-center gap-2"
          title={t('systemStats.swapHolders.tmpfsHint', {
            defaultValue: 'مسار يعيش في الذاكرة — ما يُكتب فيه لا يتحرّر إلا بحذفه',
          })}
        >
          <HardDrive
            className={`h-3 w-3 flex-shrink-0 ${tmpHeavy ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-xs" dir="ltr">
            {tmp.mount}
          </span>
          <span
            dir="ltr"
            className={`flex-shrink-0 text-xs tabular-nums${tmpHeavy ? ' font-medium text-amber-600 dark:text-amber-400' : ' text-foreground/80'}`}
          >
            {formatMbText(tmp.usedMb)}/{formatMbText(tmp.sizeMb)}
            {tmpPercent !== null ? ` (${tmpPercent.toFixed(0)}%)` : ''}
          </span>
        </div>
      )}

      {/* (2) الحاملون — الاسم والمشروع والحجم والعمر، والمعرّف خافتاً آخِراً */}
      {holders.length === 0 && (
        <div className="text-xs text-muted-foreground">
          {t('systemStats.swapHolders.empty', {
            defaultValue: 'لا عملية تحمل swap يُذكر',
          })}
        </div>
      )}
      {holders.map(holder => {
        const approximate = holder.swapSource === 'vmswap';
        // الاسم يُقصّ في عمودٍ ضيّق فلا يُقرأ («‏Ma…»، «‏node…»)، فالتلميح يحمل
        // الاسم كاملاً **ومعه المعرّف**. والمعرّف انتقل إلى هنا من عمودٍ خاصّ به:
        // كان يقتطع ~55 بكسلاً من عرضٍ لا يتجاوز 250، والاسم أولى بها — ومن
        // يحتاج المعرّف يحتاجه مرّةً لينقله إلى طرفيّة، لا في كل نظرة.
        //
        // وحدٌّ صادق: ‏`Name` في النواة **خمسة عشر بايتاً كحدٍّ أقصى**، فالتلميح
        // لا يملك اسماً أطول ممّا في الصفّ — لا يوجد. ولذلك يحمل ما هو متاح
        // فعلاً وأنفع: صنف العملية (`kind`) الذي يقول «بناء» أو «وكيل» حيث لا
        // يقول `MainThread` شيئاً، ثم المعرّف والمشروع.
        const kindText = holder.kind
          ? t(`systemStats.swapHolders.kind.${holder.kind}`, {
              // صنفٌ يضيفه الخادم لاحقاً ولمّا يُترجَم لا يُطبع رمزاً إنجليزياً
              // في تلميح عربي — يُسقَط بصمت.
              defaultValue: KIND_FALLBACK[holder.kind] ?? '',
            })
          : '';
        const nameTitle = [holder.name, kindText, `#${holder.pid}`, holder.project]
          .filter(Boolean)
          .join('  ·  ');
        return (
          <div key={holder.pid} className="flex items-baseline gap-1.5">
            {/* `name` نصّ تكتبه العملية نفسها — نصّاً عادياً يهربه React، ولا
                يُستعمل مفتاحَ ترجمة ولا في أيّ حقن HTML. */}
            <span
              className="min-w-0 flex-1 truncate text-xs text-foreground"
              title={nameTitle}
            >
              {holder.name}
            </span>
            {holder.project ? (
              <span
                className="max-w-20 flex-shrink truncate rounded bg-muted px-1 text-[10px] text-muted-foreground"
                title={holder.project}
              >
                {holder.project}
              </span>
            ) : null}
            <Size
              mb={holder.swapMb}
              approximate={approximate}
              title={approximate ? approximateHint : undefined}
            />
            {typeof holder.ageHours === 'number' && (
              <span
                className="flex-shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
                title={formatAgoText(holder.ageHours * 3600_000, locale)}
              >
                {formatAgoShort(holder.ageHours * 3600_000, locale)}
              </span>
            )}
          </div>
        );
      })}

      {/* (3) النظام مجمَّعاً */}
      {system !== null && (
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {t('systemStats.swapHolders.system', {
              defaultValue: 'نظام وخدمات',
            })}
            {': '}
            <span dir="ltr" className="tabular-nums">
              {system.count}
            </span>{' '}
            {t('systemStats.swapHolders.processes', { defaultValue: 'عملية' })}
          </span>
          <Size mb={system.swapMb} />
        </div>
      )}

      {/* (4) غير المنسوب — مع تلميحٍ يشرح لماذا لا يملكه أحد */}
      {unattributed !== null && (
        <div
          className="flex items-baseline gap-2 text-xs text-muted-foreground"
          title={t('systemStats.swapHolders.unattributedHint', {
            defaultValue:
              'صفحاتُ مساراتٍ تعيش في الذاكرة وكاشٌ لا تملكها عمليةٌ بعينها، فلا يحرّرها إيقافُ أيّ برنامج',
          })}
        >
          <span className="min-w-0 flex-1 truncate">
            {t('systemStats.swapHolders.unattributed', { defaultValue: 'غير منسوب' })}
          </span>
          <Size mb={unattributed} />
        </div>
      )}

      {/* لحظة القياس: رقمٌ بلا زمنه ادّعاءُ آنيّةٍ لا يملكها */}
      {typeof data.measuredAt === 'number' && (
        <div className="pt-0.5 text-[10px] text-muted-foreground/70">
          {t('systemStats.swapHolders.measuredAgo', {
            ago: formatAgoText(now - data.measuredAt, locale),
            defaultValue: 'قِيس {{ago}}',
          })}
        </div>
      )}
    </>,
  );
}
