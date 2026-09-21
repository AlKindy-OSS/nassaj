import { useCallback, useRef, useState } from 'react';

import { publishRestartSignal } from '../utils/restartSignal';

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
  startPolling: (expectedServerBuildId?: string | null) => void;
  stopPolling: () => void;
  reset: () => void;
};

type RestartHealth = {
  restartRequired?: boolean;
  serverLoadedBuildId?: string;
  serverBuildIdOnDisk?: string;
};

type BuildReceiptRetryOptions = {
  attempts?: number;
  retryDelayMs?: number;
};

const SERVER_BUILD_ID = /^[a-f0-9]{64}$/;
const DEFAULT_RECEIPT_ATTEMPTS = 5;
const DEFAULT_RECEIPT_RETRY_DELAY_MS = 500;

/**
 * A generation-bound restart is complete only when the running server and the
 * immutable artifact on disk both carry the generation the owner approved.
 * `restartRequired=false` alone can describe a different generation and is not
 * a sufficient receipt for an OID activation.
 */
export function isRestartComplete(
  health: RestartHealth | null,
  expectedServerBuildId: string | null = null,
): boolean {
  if (!health) return false;
  if (expectedServerBuildId) {
    return health.serverLoadedBuildId === expectedServerBuildId
      && health.serverBuildIdOnDisk === expectedServerBuildId;
  }
  return health.restartRequired === false;
}

/** Read the public health receipt without reusing a potentially cached response. */
export async function isExpectedServerBuildLoaded(expectedServerBuildId: string): Promise<boolean> {
  if (!SERVER_BUILD_ID.test(expectedServerBuildId)) return false;
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) return false;
    const health = (await response.json().catch(() => null)) as RestartHealth | null;
    return isRestartComplete(health, expectedServerBuildId);
  } catch {
    return false;
  }
}

/**
 * Reconcile the short connection gap around process replacement. The bound is
 * intentional: this is a receipt check after a terminal restart response, not
 * another unbounded restart watcher.
 */
export async function waitForExpectedServerBuildLoaded(
  expectedServerBuildId: string,
  options: BuildReceiptRetryOptions = {},
): Promise<boolean> {
  const requestedAttempts = options.attempts ?? DEFAULT_RECEIPT_ATTEMPTS;
  const requestedDelayMs = options.retryDelayMs ?? DEFAULT_RECEIPT_RETRY_DELAY_MS;
  const attempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.min(10, Math.trunc(requestedAttempts)))
    : DEFAULT_RECEIPT_ATTEMPTS;
  const retryDelayMs = Number.isFinite(requestedDelayMs)
    ? Math.max(0, Math.min(5_000, Math.trunc(requestedDelayMs)))
    : DEFAULT_RECEIPT_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isExpectedServerBuildLoaded(expectedServerBuildId)) return true;
    if (attempt + 1 < attempts) {
      await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

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

  const startPolling = useCallback((expectedServerBuildId: string | null = null) => {
    setIsRestarting(true);
    setIsSuccess(false);

    const schedule = () => {
      pollingRef.current = setTimeout(async () => {
        try {
          const res = await fetch('/health');
          if (res.ok) {
            const data = (await res.json().catch(() => null)) as RestartHealth | null;
            if (isRestartComplete(data, expectedServerBuildId)) {
              setIsSuccess(true);
              // T-1296: أسقِط اللافتة في كل مكان فوراً — في هذا التبويب وفي
              // غيره — بدل انتظار دورة الستين ثانية في useVersionCheck. اللافتة
              // الباقية بعد نجاح إعادة التشغيل تُقرأ «لم يُنفَّذ طلبي» فتُنتج
              // ضغطةً ثانية وإعادةَ تشغيل مهدورة.
              publishRestartSignal('completed');
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
