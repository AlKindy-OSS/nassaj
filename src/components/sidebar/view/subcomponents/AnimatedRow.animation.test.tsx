/**
 * AnimatedRow — enter/exit animation wrapper for session-list rows (T-1711).
 *
 * الحالات المحروسة:
 * - صفّ جديد يبدأ مطوياً (0fr/opacity-0) ثم ينفتح بعد rAF
 * - skipAnimation=true يُبقي الصفّ مفتوحاً من البداية (لا حركة)
 * - صفّ خارج يبقى مُركَّباً حتى transitionend ثم يُزال
 * - prefers-reduced-motion: onExited يُستدعى فوراً بلا انتظار transitionend
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AnimatedRow } from './AnimatedRow';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// rAF stub — lets us control exactly when the enter-animation flip fires.
// ---------------------------------------------------------------------------
let pendingRaf: (() => void) | null = null;

beforeEach(() => {
  pendingRaf = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pendingRaf = () => cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => { pendingRaf = null; });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf() {
  if (pendingRaf) {
    const cb = pendingRaf;
    pendingRaf = null;
    act(() => { cb(); });
  }
}

// matchMedia factory: returns a minimal MediaQueryList stub.
function makeMatchMedia(matches: boolean) {
  return (_query: string): MediaQueryList =>
    ({
      matches,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList);
}

// Helper: find the outermost AnimatedRow grid wrapper via the testid child.
function getWrapper(testId = 'child') {
  return screen.getByTestId(testId).parentElement!.parentElement!;
}

// ---------------------------------------------------------------------------

describe('AnimatedRow — enter animation', () => {
  it('starts at 0fr/opacity-0 before rAF fires', () => {
    render(<AnimatedRow><div data-testid="child">c</div></AnimatedRow>);
    const wrapper = getWrapper();
    expect(wrapper.className).toContain('grid-template-rows:0fr');
    expect(wrapper.className).toContain('opacity-0');
  });

  it('transitions to 1fr/opacity-100 after rAF fires', () => {
    render(<AnimatedRow><div data-testid="child">c</div></AnimatedRow>);
    flushRaf();
    const wrapper = getWrapper();
    expect(wrapper.className).toContain('grid-template-rows:1fr');
    expect(wrapper.className).toContain('opacity-100');
  });

  it('starts open immediately when skipAnimation=true', () => {
    render(
      <AnimatedRow skipAnimation>
        <div data-testid="child">c</div>
      </AnimatedRow>,
    );
    const wrapper = getWrapper();
    expect(wrapper.className).toContain('grid-template-rows:1fr');
    expect(wrapper.className).toContain('opacity-100');
    // No rAF should have been scheduled.
    expect(pendingRaf).toBeNull();
  });
});

describe('AnimatedRow — exit animation', () => {
  it('stays mounted until transitionend fires, then calls onExited', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(false));
    const onExited = vi.fn();

    const { rerender } = render(
      <AnimatedRow skipAnimation isExiting={false} onExited={onExited}>
        <div data-testid="child">row</div>
      </AnimatedRow>,
    );

    // Element is present and not yet exiting.
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(onExited).not.toHaveBeenCalled();

    // Signal exit.
    rerender(
      <AnimatedRow skipAnimation isExiting onExited={onExited}>
        <div data-testid="child">row</div>
      </AnimatedRow>,
    );

    // Still mounted — waiting for transitionend.
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(onExited).not.toHaveBeenCalled();

    // Simulate transitionend on the wrapper element itself.
    const wrapper = getWrapper();
    fireEvent.transitionEnd(wrapper);

    expect(onExited).toHaveBeenCalledOnce();
  });

  it('does NOT call onExited when transitionend bubbles from a child', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(false));
    const onExited = vi.fn();

    const { rerender } = render(
      <AnimatedRow skipAnimation isExiting={false} onExited={onExited}>
        <div data-testid="inner">
          <span data-testid="child">row</span>
        </div>
      </AnimatedRow>,
    );

    rerender(
      <AnimatedRow skipAnimation isExiting onExited={onExited}>
        <div data-testid="inner">
          <span data-testid="child">row</span>
        </div>
      </AnimatedRow>,
    );

    // Fire transitionend on the inner div (not the AnimatedRow wrapper).
    const inner = screen.getByTestId('inner');
    fireEvent.transitionEnd(inner);

    // Should NOT trigger onExited because the event target is not the wrapper.
    expect(onExited).not.toHaveBeenCalled();
  });

  it('calls onExited immediately when prefers-reduced-motion is set', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(true)); // reduced motion ON
    const onExited = vi.fn();

    const { rerender } = render(
      <AnimatedRow skipAnimation isExiting={false} onExited={onExited}>
        <div data-testid="child">row</div>
      </AnimatedRow>,
    );

    rerender(
      <AnimatedRow skipAnimation isExiting onExited={onExited}>
        <div data-testid="child">row</div>
      </AnimatedRow>,
    );

    // onExited called synchronously — no transitionend needed.
    expect(onExited).toHaveBeenCalledOnce();
  });

  it('does NOT call onExited on transitionend when not exiting', () => {
    vi.stubGlobal('matchMedia', makeMatchMedia(false));
    const onExited = vi.fn();

    render(
      <AnimatedRow skipAnimation isExiting={false} onExited={onExited}>
        <div data-testid="child">row</div>
      </AnimatedRow>,
    );

    // Fire transitionend while not exiting (e.g. enter animation finishing).
    const wrapper = getWrapper();
    fireEvent.transitionEnd(wrapper);

    expect(onExited).not.toHaveBeenCalled();
  });
});
