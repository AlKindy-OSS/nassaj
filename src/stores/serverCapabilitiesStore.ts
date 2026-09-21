import { useSyncExternalStore } from 'react';

export type LightHistoryCapability = Readonly<{
  resolved: boolean;
  enabled: boolean;
}>;

// Existing hook tests mount the chat without the application shell that owns
// `/health`; keep those isolated harnesses on the legacy path. Production waits
// for the real shared health receipt before choosing a payload.
let lightHistory: LightHistoryCapability = {
  resolved: import.meta.env.MODE === 'test',
  enabled: false,
};
const listeners = new Set<() => void>();

function emit(next: LightHistoryCapability) {
  if (next.resolved === lightHistory.resolved && next.enabled === lightHistory.enabled) return;
  lightHistory = next;
  listeners.forEach((listener) => listener());
}

/** Publish the capability from the application's existing `/health` read. */
export function publishServerCapabilities(health: unknown): void {
  const candidate = (health as { capabilities?: { lightHistory?: unknown } } | null)
    ?.capabilities?.lightHistory as Record<string, unknown> | undefined;
  emit({
    resolved: true,
    enabled: candidate?.supported === true && candidate.enabled === true && candidate.schema === 1,
  });
}

/** Resolve an unavailable first health read to the legacy/full path. */
export function resolveServerCapabilitiesUnavailable(): void {
  if (!lightHistory.resolved) emit({ resolved: true, enabled: false });
}

export function useLightHistoryCapability(): LightHistoryCapability {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lightHistory,
    () => ({ resolved: true, enabled: false }),
  );
}

/** Test-only reset; production never needs to forget an advertised capability. */
export function resetServerCapabilitiesForTests(): void {
  lightHistory = { resolved: false, enabled: false };
  listeners.forEach((listener) => listener());
}
