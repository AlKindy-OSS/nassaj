import { useCallback, useRef, useState } from 'react';

/**
 * useRestartWatch — T-947 F2
 *
 * يُجرّد منطق الاستطلاع بعد إعادة التشغيل المُستخرَج من PendingActionsPanel.
 * يستطلع /health حتى يصبح restartRequired=false ثم يُعيد تحميل الصفحة.
 *
 * الاستخدام:
 *   const { isRestarting, isSuccess, startPolling, stopPolling, reset } = useRestartWatch();
 *   // عند outcome.status === 'restarting': startPolling()
 *   // عند إغلاق مكوّن: reset()
 */

const POLL_INTERVAL_MS = 3_000;

export type RestartWatchReturn = {
  isRestarting: boolean;
  isSuccess: boolean;
  startPolling: () => void;
  stopPolling: () => void;
  reset: () => void;
};

export function useRestartWatch(): RestartWatchReturn {
  const [isRestarting, setIsRestarting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    setIsRestarting(true);
    setIsSuccess(false);

    const schedule = () => {
      pollingRef.current = setTimeout(async () => {
        try {
          const res = await fetch('/health');
          if (res.ok) {
            const data = (await res.json().catch(() => null)) as
              | { restartRequired?: boolean }
              | null;
            if (data?.restartRequired === false) {
              setIsSuccess(true);
              // Brief pause so the user sees the success state before reload
              setTimeout(() => window.location.reload(), 1_500);
              return;
            }
          }
        } catch {
          // Expected while server is restarting — keep polling silently
        }
        schedule();
      }, POLL_INTERVAL_MS);
    };

    schedule();
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setIsRestarting(false);
    setIsSuccess(false);
  }, [stopPolling]);

  return { isRestarting, isSuccess, startPolling, stopPolling, reset };
}
