import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import type { TFunction } from 'i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { useOptionalAuth } from '../../../auth';

import { SwapHoldersPanel } from './SwapHoldersPanel';
import { useSwapHolders } from './swapHoldersData';
import {
  formatMbText,
  heaviestTmpfs,
  resolveLoadLevel,
  tmpfsPercentOfRam,
  swapPercentOfTotal,
  type LoadLevel,
} from './systemStatsFormat';
import { SystemStatsSparkline, type SparkSeries } from './SystemStatsSparkline';

/**
 * حالة الطيّ محفوظة محلياً: الذيل يُطوى ليوفّر مساحة، ولو عاد مفتوحاً بعد كل
 * تحديث صفحة لضاعت الفائدة. والافتراضي **مطوي** — سطرٌ واحد يكفي ما لم يُرِد
 * القارئ التفصيل.
 */
const COLLAPSE_KEY = 'nassaj.systemStats.collapsed';

const readCollapsed = (): boolean => {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
};

/** لون النقطة لكل حالة — ومعها **نصّ** دائماً: اللون وحده لا يحمل معنى. */
const LEVEL_DOT: Record<LoadLevel, string> = {
  low: 'bg-emerald-500',
  medium: 'bg-amber-500',
  high: 'bg-red-500',
};

/** ألوان النسب تطابق أشرطة الاستخدام، دون تلوين الاسم أو السعة. */
const LEVEL_TEXT: Record<LoadLevel, string> = {
  low: 'text-emerald-500',
  medium: 'text-amber-500',
  high: 'text-red-500',
};

/** اعزل الرقم وعلامة النسبة فقط مع إبقاء النص واتجاهه في الغلاف القائم. */
function colorUsagePercent(text: string, level: LoadLevel) {
  return text.split(/(\d+(?:\.\d+)?%)/).map((part, index) =>
    part.endsWith('%') ? <span key={index} className={LEVEL_TEXT[level]}>{part}</span> : part,
  );
}

const POLL_INTERVAL_MS = 5000;

/** معرّف لوحة حاملي الـswap — غلاف موحَّد الآن، معرّف واحد. */
const DESKTOP_PANEL_ID = 'nassaj-swap-holders-desktop';

type SystemStats = {
  cpu: { percent: number };
  memory: { usedBytes: number; totalBytes: number; percent: number };
  /** مساحة قرص المشروع/الخادم؛ يغيب عند الاتصال بخادم أقدم. */
  storage?: { usedBytes: number; totalBytes: number; percent: number } | null;
  /**
   * ‏swap وأنظمة الملفات التي تعيش في الذاكرة — اختياريان في العقد: خادم أقدم
   * من المسار الموسَّع لا يرسلهما، فتُخفى صفوفهما بدل طباعة أصفار ملفَّقة.
   *
   * وُجدا بعد حادثة 29–31 يوليو 2026: نما المحجوز من الذاكرة 2.7GB وبقي خمساً
   * وأربعين ساعة، وswap ظلّ ممتلئاً 100% منذ 36 ساعة — ولم يكن أيٌّ من الرقمين
   * معروضاً. وصفّ swap تحديداً كان سيُنذر **قبل السقوط بسبع ساعات** (قياس
   * 94.8% في 28 يوليو 16:25). أمّا فاعل نموّ الذاكرة المشتركة فغير محدَّد بعد.
   */
  swap?: { usedMb: number; totalMb: number } | null;
  tmpfs?: Array<{ mount: string; usedMb: number; sizeMb: number }>;
};


function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Polls GET /api/system/stats every 5s. Polling pauses while the tab is
 * hidden (document.hidden) and resumes with an immediate fetch on return.
 * A 404 (live server predates the route) stops polling permanently and the
 * widgets render a graceful em-dash / nothing — no console noise.
 */
export function useSystemStats(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    // Effect-scoped state (NOT refs): every mount — including a StrictMode
    // remount — gets its own isolated closure, so a previous mount's in-flight
    // poll can never re-arm THIS mount's timer (the bug the old cancelledRef
    // guard could not prevent, since refs persist across the remount).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsupported = false; // 404 → route absent → stop permanently
    let stopped = false;     // unmounted → stop everything
    let inFlight = false;    // a request is awaiting → never overlap

    const controller = new AbortController();

    const schedule = () => {
      if (stopped || unsupported) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const poll = async () => {
      if (stopped || unsupported || inFlight) return;
      if (document.hidden) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const res = await authenticatedFetch('/api/system/stats', { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (!stopped) setStats(data);
        } else if (res.status === 404) {
          unsupported = true;
          return; // finally still runs; the schedule() below is skipped
        }
      } catch {
        // Network hiccup or abort-on-unmount: keep the last value.
      } finally {
        inFlight = false;
      }
      schedule();
    };

    const onVisibility = () => {
      if (!document.hidden) poll();
    };

    poll();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return stats;
}

/** Expanded-footer variant: optional resource rows inside one compact card. */
export function SystemStatsFooter({ t }: { t: TFunction }) {
  const stats = useSystemStats();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  /**
   * لوحة «مَن يحمل الـswap؟» (T-1204) — **للمالك وحده**.
   *
   * الدور يُقرأ من سياق المصادقة القائم لا بإطلاق الطلب وقراءة 403: ذاك طلبٌ
   * ضائع في كل ذيلٍ يُفتح، ووميضُ زرٍّ يظهر ثم يختفي. و`useOptionalAuth` لا
   * `useAuth` كي لا يسقط الذيل حين يُركَّب خارج المزوّد (اختبارات ولقطات).
   */
  const auth = useOptionalAuth();
  const isOwner = auth?.user?.role === 'owner';
  const [swapOpen, setSwapOpen] = useState(false);
  const swapHolders = useSwapHolders(isOwner && swapOpen);

  const cpuText = stats ? `${stats.cpu.percent.toFixed(2)}%` : '—';
  const ramText = stats
    ? `${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${stats.memory.percent.toFixed(1)}%)`
    : '—';
  const storage = stats?.storage ?? null;
  const storageText = storage
    ? `${formatGb(storage.usedBytes)}/${formatGb(storage.totalBytes)}GB (${storage.percent.toFixed(1)}%)`
    : '';

  const swap = stats?.swap ?? null;
  const swapPercent = swap !== null ? swapPercentOfTotal(swap.usedMb, swap.totalMb) : null;
  const swapText = swap !== null
    ? `${formatMbText(swap.usedMb)}/${formatMbText(swap.totalMb)}${swapPercent !== null ? ` (${swapPercent.toFixed(1)}%)` : ''}`
    : '—';
  const tmp = heaviestTmpfs(stats?.tmpfs);
  // المقام ذاكرة الجهاز لا سعة المسار — الشرح في systemStatsFormat.
  const tmpPercent =
    tmp !== null && stats ? tmpfsPercentOfRam(tmp.usedMb, stats.memory.totalBytes / 1024 ** 2) : null;
  const tmpText =
    tmp !== null
      ? `${tmp.mount} ${formatMbText(tmp.usedMb)}${tmpPercent !== null ? ` (${tmpPercent.toFixed(1)}%)` : ''}`
      : '';

  const level = resolveLoadLevel({
    cpuPercent: stats?.cpu.percent ?? null,
    memPercent: stats?.memory.percent ?? null,
    swapUsedMb: swap?.usedMb ?? null,
    swapTotalMb: swap?.totalMb ?? null,
    tmpfsPercent: tmpPercent,
    storagePercent: storage?.percent ?? null,
  });
  const levelText = t(`systemStats.load.${level}`, {
    defaultValue: { low: 'آمن', medium: 'متوسط', high: 'عالٍ' }[level],
  });

  /**
   * خطوط المؤشّر المصغَّر. المقياس 0..1 لكلٍّ بمقامه الصادق: النِّسَب المئوية
   * على 100، أمّا المسار الذي يعيش في الذاكرة فعلى **20%** من ذاكرة الجهاز —
   * مقامٌ مضغوط عمداً لأن عتبة الخطر هناك 10% لا 100%، ولو قُسم على مئة لبقي
   * الخطّ ملتصقاً بالقاع وهو في طريقه إلى إسقاط الجهاز.
   */
  const sparkSeries: SparkSeries[] = [
    {
      key: 'cpu',
      value: stats ? stats.cpu.percent / 100 : null,
      // مستوى كل مسرب بعتباته هو، من نفس دالّة الحالة العامّة: تُستدعى بمقياسٍ
      // واحد والبقيةُ `null`، فتُرجع حكم ذلك المقياس وحده. عتبةٌ ثانية هنا كانت
      // ستنفصل عن النقطة العامّة أوّل مرّة تُعدَّل واحدةٌ منهما.
      level: resolveLoadLevel({ cpuPercent: stats?.cpu.percent ?? null, memPercent: null }),
      title: `${t('systemStats.cpuUsage')}: ${cpuText}`,
    },
    {
      key: 'mem',
      value: stats ? stats.memory.percent / 100 : null,
      level: resolveLoadLevel({ cpuPercent: null, memPercent: stats?.memory.percent ?? null }),
      title: `${t('systemStats.memoryUsage')}: ${ramText}`,
    },
    {
      key: 'storage',
      value: storage ? storage.percent / 100 : null,
      level: resolveLoadLevel({
        cpuPercent: null,
        memPercent: null,
        storagePercent: storage?.percent ?? null,
      }),
      title: `${t('systemStats.storageUsage', { defaultValue: 'Disk usage' })}: ${storageText || '—'}`,
    },
    {
      key: 'swap',
      value: swapPercent !== null ? swapPercent / 100 : null,
      level: resolveLoadLevel({
        cpuPercent: null,
        memPercent: null,
        swapUsedMb: swap?.usedMb ?? null,
        swapTotalMb: swap?.totalMb ?? null,
      }),
      title: `${t('systemStats.swapUsage', { defaultValue: 'استهلاك swap' })}: ${swapText}`,
    },
    {
      key: 'tmpfs',
      value: tmpPercent !== null ? tmpPercent / 20 : null,
      level: resolveLoadLevel({ cpuPercent: null, memPercent: null, tmpfsPercent: tmpPercent }),
      title: `${t('systemStats.tmpfsUsage', {
        defaultValue: 'مسار يعيش في الذاكرة — النسبة من ذاكرة الجهاز',
      })}: ${tmpText}`,
    },
  ];

  const resourceText = (text: string, key: string) =>
    colorUsagePercent(text, sparkSeries.find(series => series.key === key)!.level);

  const swapHoldersLabel = t('systemStats.swapHolders.toggle', {
    defaultValue: 'مَن يحمل الـswap؟',
  });
  const toggleSwapPanel = () => setSwapOpen(open => !open);

  const toggle = () => {
    setCollapsed(next => {
      const value = !next;
      try {
        localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
      } catch {
        /* تخزين محلي معطّل — الطيّ يبقى للجلسة وحدها */
      }
      return value;
    });
  };

  // الصفّ المطوي: حالة واحدة بنقطة ملوّنة **ونصّ**، وهو نفسه زرّ الفتح.
  const summaryRow = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={t('systemStats.toggle', { defaultValue: 'استهلاك العتاد' })}
      className="flex h-[var(--control-height-touch)] w-full items-center gap-1.5 rounded-lg px-2 text-start text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center">
        <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[level]}`} />
      </span>
      {/* التلميح على النصّ لا على الزرّ: لو حمل الزرّ `title` لغطّى تلميحاتِ
          مسارب المؤشّر داخله في بعض المتصفّحات. */}
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium"
        title={t('systemStats.toggle', { defaultValue: 'استهلاك العتاد' })}
      >
        {t('systemStats.loadLabel', { defaultValue: 'العتاد' })}: {stats ? levelText : '—'}
      </span>
      <SystemStatsSparkline series={sparkSeries} />
      {collapsed ? (
        <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      ) : (
        <ChevronUp className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      )}
    </button>
  );

  /* بطاقة العتاد — غلاف موحَّد على كل المقاسات (نمط الجوّال) */
  const statsPanel = (
    <div
      className={`flex w-full flex-col justify-center rounded-lg bg-muted/40 ${
        collapsed ? '' : 'gap-0.5 px-2 pb-1'
      }`}
    >
      {summaryRow}
      {!collapsed && (
        <>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.cpuUsage')}
          >
            <Cpu className="h-3.5 w-3.5 flex-shrink-0" />
            <span dir="ltr" className="text-[11px] tabular-nums">CPU {resourceText(cpuText, 'cpu')}</span>
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.memoryUsage')}
          >
            <MemoryStick className="h-3.5 w-3.5 flex-shrink-0" />
            <span dir="ltr" className="text-[11px] tabular-nums">RAM {resourceText(ramText, 'mem')}</span>
          </div>
          {storage !== null && (
            <div
              className="flex items-center gap-2 text-muted-foreground"
              title={t('systemStats.storageUsage', { defaultValue: 'Disk usage' })}
            >
              <HardDrive className="h-3.5 w-3.5 flex-shrink-0" />
              <span dir="ltr" className="text-[11px] tabular-nums">DISK {resourceText(storageText, 'storage')}</span>
            </div>
          )}
          {swap !== null &&
            (isOwner ? (
              <>
                <button
                  type="button"
                  onClick={toggleSwapPanel}
                  aria-expanded={swapOpen}
                  aria-controls={swapOpen ? DESKTOP_PANEL_ID : undefined}
                  title={swapHoldersLabel}
                  className="flex w-full items-center gap-2 text-start text-muted-foreground"
                >
                  <MemoryStick className="h-3.5 w-3.5 flex-shrink-0" />
                  <span
                    dir="ltr"
                    className="text-[11px] tabular-nums"
                  >
                    SWAP {resourceText(swapText, 'swap')}
                  </span>
                  <span className="flex-1" aria-hidden="true" />
                  {swapOpen ? (
                    <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  )}
                </button>
                {swapOpen && (
                  <SwapHoldersPanel t={t} state={swapHolders} panelId={DESKTOP_PANEL_ID} />
                )}
              </>
            ) : (
              <div
                className="flex items-center gap-2 text-muted-foreground"
                title={t('systemStats.swapUsage', { defaultValue: 'استهلاك swap' })}
              >
                <MemoryStick className="h-3.5 w-3.5 flex-shrink-0" />
                <span
                  dir="ltr"
                  className="text-[11px] tabular-nums"
                >
                  SWAP {resourceText(swapText, 'swap')}
                </span>
              </div>
            ))}
          {tmp !== null && (
            <div
              className="flex items-center gap-2 text-muted-foreground"
              title={t('systemStats.tmpfsUsage', {
                defaultValue:
                  'مسار يعيش في الذاكرة — النسبة من ذاكرة الجهاز، وما يُكتب فيه لا يتحرّر إلا بحذفه',
              })}
            >
              <HardDrive className="h-3.5 w-3.5 flex-shrink-0" />
              <span
                dir="ltr"
                className="text-[11px] tabular-nums"
              >
                {resourceText(tmpText, 'tmpfs')}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="px-3 py-0.5">
      {statsPanel}
    </div>
  );
}

/** Collapsed-rail variant: tiny icon+percent stacks; hidden until data. */
export function SystemStatsCollapsed({ t }: { t: TFunction }) {
  const stats = useSystemStats();

  if (!stats) return null;

  return (
    <>
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={`${t('systemStats.cpuUsage')}: ${stats.cpu.percent.toFixed(2)}%`}
        aria-label={t('systemStats.cpuUsage')}
      >
        <Cpu className="h-3.5 w-3.5" />
        <span dir="ltr" className={`text-[9px] tabular-nums leading-none ${LEVEL_TEXT[resolveLoadLevel({ cpuPercent: stats.cpu.percent, memPercent: null })]}`}>
          {stats.cpu.percent.toFixed(2)}%
        </span>
      </div>
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={`${t('systemStats.memoryUsage')}: ${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${stats.memory.percent.toFixed(1)}%)`}
        aria-label={t('systemStats.memoryUsage')}
      >
        <MemoryStick className="h-3.5 w-3.5" />
        <span dir="ltr" className={`text-[9px] tabular-nums leading-none ${LEVEL_TEXT[resolveLoadLevel({ cpuPercent: null, memPercent: stats.memory.percent })]}`}>
          {stats.memory.percent.toFixed(1)}%
        </span>
      </div>
      {stats.storage != null && (
        <div
          className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
          title={`${t('systemStats.storageUsage', { defaultValue: 'Disk usage' })}: ${formatGb(stats.storage.usedBytes)}/${formatGb(stats.storage.totalBytes)}GB (${stats.storage.percent.toFixed(1)}%)`}
          aria-label={`${t('systemStats.storageUsage', { defaultValue: 'Disk usage' })}: ${formatGb(stats.storage.usedBytes)}/${formatGb(stats.storage.totalBytes)}GB (${stats.storage.percent.toFixed(1)}%)`}
        >
          <HardDrive className="h-3.5 w-3.5" />
          <span dir="ltr" className={`text-[9px] tabular-nums leading-none ${LEVEL_TEXT[resolveLoadLevel({ cpuPercent: null, memPercent: null, storagePercent: stats.storage.percent })]}`}>
            {stats.storage.percent.toFixed(1)}%
          </span>
        </div>
      )}
    </>
  );
}
