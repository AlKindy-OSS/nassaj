import { useEffect, useSyncExternalStore } from 'react';

/**
 * The quick-settings panel is mounted once for the whole authenticated app,
 * so it no longer receives the open chat's provider as a prop. The chat view
 * publishes it here while it is mounted; every other page reads `null`, which
 * the usage section resolves to its default (Claude) account view.
 */
let currentProvider: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return currentProvider;
}

function setProvider(next: string | null): void {
  if (next === currentProvider) return;
  currentProvider = next;
  listeners.forEach((listener) => listener());
}

/** Reads the provider of the chat currently on screen, or null off-chat. */
export function useQuickSettingsSessionProvider(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Publishes `provider` while the calling component is mounted. */
export function usePublishQuickSettingsSessionProvider(provider: string | null | undefined): void {
  useEffect(() => {
    setProvider(provider ?? null);
  }, [provider]);
  useEffect(() => () => setProvider(null), []);
}
