import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDeviceSettings } from './useDeviceSettings';

type DisplayState = Record<string, boolean>;

function installMatchMedia(state: DisplayState) {
  const listeners = new Map<string, Set<() => void>>();
  window.matchMedia = vi.fn((query: string) => {
    const queryListeners = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, queryListeners);
    return {
      matches: Boolean(state[query]),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => queryListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => queryListeners.delete(listener),
      addListener: (listener: () => void) => queryListeners.add(listener),
      removeListener: (listener: () => void) => queryListeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  });
  return (query: string) => listeners.get(query)?.forEach((listener) => listener());
}

afterEach(cleanup);

describe('useDeviceSettings PWA display modes', () => {
  it('recognises fullscreen as an installed PWA', () => {
    installMatchMedia({ '(display-mode: fullscreen)': true });
    const { result } = renderHook(() => useDeviceSettings({ trackMobile: false }));
    expect(result.current.isPWA).toBe(true);
  });

  it('reacts when fullscreen display mode changes', () => {
    const state = { '(display-mode: fullscreen)': false };
    const dispatch = installMatchMedia(state);
    const { result } = renderHook(() => useDeviceSettings({ trackMobile: false }));

    state['(display-mode: fullscreen)'] = true;
    act(() => dispatch('(display-mode: fullscreen)'));
    expect(result.current.isPWA).toBe(true);
  });
});
