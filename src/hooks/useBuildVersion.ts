import { useState, useEffect, useRef } from 'react'

/**
 * useBuildVersion — detects when the server has a newer client build.
 *
 * Mechanism: polls /version.json (emitted by the nassaj-build-id Vite plugin)
 * and compares the response's buildId against __BUILD_ID__ baked into this
 * bundle at compile time. When they differ the hook flips updateReady to true
 * and stops polling — a page reload will fetch the new bundle.
 *
 * HOW THIS DIFFERS FROM useVersionCheck
 * - useVersionCheck  → queries GitHub Releases API for a newer *app version*
 *   (semver string from package.json) and proposes a server-side npm/git upgrade.
 * - useBuildVersion  → queries /version.json for a newer *client build* (git SHA)
 *   and proposes a browser reload. No server changes involved.
 * Never combine or conflate these two mechanisms.
 */
export function useBuildVersion(intervalMs = 60_000): { updateReady: boolean } {
  const [updateReady, setUpdateReady] = useState(false)

  // Keep a stable ref so the interval callback doesn't close over stale state.
  const updateReadyRef = useRef(false)
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Baseline: the BUILD_ID compiled into this bundle.
    const baseline = __BUILD_ID__

    const check = async () => {
      // Skip fetch when the tab is not visible — saves network, avoids waking
      // sleeping tabs unnecessarily.
      if (document.visibilityState !== 'visible') return
      // Already flagged — no further polling needed.
      if (updateReadyRef.current) return

      try {
        const res = await fetch('/version.json', { cache: 'no-store' })
        if (!res.ok) return

        const data: unknown = await res.json()

        // Guard: only proceed when buildId is a non-empty string.
        if (
          typeof data !== 'object' ||
          data === null ||
          !('buildId' in data) ||
          typeof (data as Record<string, unknown>).buildId !== 'string' ||
          !(data as Record<string, string>).buildId
        ) {
          return
        }

        const fetched = (data as { buildId: string }).buildId

        // First load: baseline === fetched → same build, no banner.
        if (fetched !== baseline) {
          updateReadyRef.current = true
          setUpdateReady(true)

          // Stop polling — state is terminal.
          if (intervalIdRef.current !== null) {
            clearInterval(intervalIdRef.current)
            intervalIdRef.current = null
          }
        }
      } catch {
        // Network errors are silently ignored; the next interval will retry.
      }
    }

    // Kick off immediately for early detection.
    void check()

    intervalIdRef.current = setInterval(() => {
      void check()
    }, intervalMs)

    // Also check when the user returns to the tab after being away.
    const handleVisibility = () => {
      void check()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      if (intervalIdRef.current !== null) {
        clearInterval(intervalIdRef.current)
        intervalIdRef.current = null
      }
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [intervalMs])

  return { updateReady }
}
