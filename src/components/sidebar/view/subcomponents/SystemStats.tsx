import { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import type { TFunction } from 'i18next';
import { authenticatedFetch } from '../../../../utils/api';

const POLL_INTERVAL_MS = 5000;

type SystemStats = {
  cpu: { percent: number };
  memory: { usedBytes: number; totalBytes: number; percent: number };
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

/** Expanded-footer variant: two rows (desktop + mobile styles inside). */
export function SystemStatsFooter({ t }: { t: TFunction }) {
  const stats = useSystemStats();

  const cpuText = stats ? `${stats.cpu.percent.toFixed(2)}%` : '—';
  const ramText = stats
    ? `${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${stats.memory.percent.toFixed(1)}%)`
    : '—';

  return (
    <>
      {/* Desktop CPU */}
      <div className="hidden px-2 pt-1.5 md:block">
        <div
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground"
          title={t('systemStats.cpuUsage')}
        >
          <Cpu className="h-3.5 w-3.5 flex-shrink-0" />
          <span dir="ltr" className="truncate text-sm tabular-nums">CPU {cpuText}</span>
        </div>
      </div>

      {/* Desktop RAM */}
      <div className="hidden px-2 md:block">
        <div
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground"
          title={t('systemStats.memoryUsage')}
        >
          <MemoryStick className="h-3.5 w-3.5 flex-shrink-0" />
          <span dir="ltr" className="truncate text-sm tabular-nums">RAM {ramText}</span>
        </div>
      </div>

      {/* Mobile combined card */}
      <div className="px-3 pt-3 md:hidden">
        <div className="flex w-full flex-col justify-center gap-1 rounded-xl bg-muted/40 px-4 py-2.5">
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.cpuUsage')}
          >
            <Cpu className="h-4 w-4 flex-shrink-0" />
            <span dir="ltr" className="text-base tabular-nums">CPU {cpuText}</span>
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.memoryUsage')}
          >
            <MemoryStick className="h-4 w-4 flex-shrink-0" />
            <span dir="ltr" className="text-base tabular-nums">RAM {ramText}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Collapsed-rail variant: two tiny icon+percent stacks; hidden until data. */
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
        <span dir="ltr" className="text-[9px] leading-none tabular-nums">
          {stats.cpu.percent.toFixed(2)}%
        </span>
      </div>
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={`${t('systemStats.memoryUsage')}: ${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${stats.memory.percent.toFixed(1)}%)`}
        aria-label={t('systemStats.memoryUsage')}
      >
        <MemoryStick className="h-3.5 w-3.5" />
        <span dir="ltr" className="text-[9px] leading-none tabular-nums">
          {stats.memory.percent.toFixed(1)}%
        </span>
      </div>
    </>
  );
}
