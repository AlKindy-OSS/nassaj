/**
 * B-1665: stick-to-bottom controller. jsdom has no layout, so the scroll box
 * gets mutable metrics with real clamping, and ResizeObserver is faked so the
 * test decides when "content grew after paint".
 */
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PIN_WINDOW_MS, useStickToBottom, type StickToBottom } from './useStickToBottom';

type Metrics = { scrollHeight: number; clientHeight: number };

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: () => void) { FakeResizeObserver.instances.push(this); }
  observe() {}
  disconnect() { FakeResizeObserver.instances = FakeResizeObserver.instances.filter((o) => o !== this); }
  fire() { this.callback(); }
}

let latest: StickToBottom;
let metrics: Metrics;
let now = 1_000_000;

function attachMetrics(el: HTMLElement) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { get: () => metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => metrics.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); },
    configurable: true,
  });
}

interface HarnessProps { ready: boolean; follow: boolean; sessionKey?: string; suppress?: boolean }

function Harness({ ready, follow, sessionKey = 's1', suppress = false }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suppressRef = useRef(suppress);
  suppressRef.current = suppress;
  latest = useStickToBottom({ scrollRef, contentRef, sessionKey, ready, follow, suppressRef });
  return (
    <div
      data-testid="scroller"
      ref={(el) => { if (el && !('__m' in el)) { attachMetrics(el); Object.assign(el, { __m: true }); } (scrollRef as any).current = el; }}
      onScroll={latest.onScroll}
      onWheel={latest.onWheel}
      onTouchStart={latest.onTouchStart}
      onTouchMove={latest.onTouchMove}
    >
      <div ref={contentRef} />
    </div>
  );
}

const scroller = () => screen.getByTestId('scroller');
const grow = (scrollHeight: number) => {
  metrics.scrollHeight = scrollHeight;
  act(() => { FakeResizeObserver.instances.forEach((o) => o.fire()); });
};
const userScrollTo = (top: number) => {
  scroller().scrollTop = top;
  fireEvent.scroll(scroller());
};
const gap = () => metrics.scrollHeight - scroller().scrollTop - metrics.clientHeight;

function open(props: Omit<HarnessProps, 'ready'>) {
  const view = render(<Harness ready={false} {...props} />);
  view.rerender(<Harness ready {...props} />);
  return view;
}

beforeEach(() => {
  metrics = { scrollHeight: 1000, clientHeight: 400 };
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  FakeResizeObserver.instances = [];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useStickToBottom: opening a session', () => {
  it('lands on the bottom and re-pins when content grows after the first paint', () => {
    open({ follow: true });
    expect(gap()).toBe(0);
    grow(1600); // images finished loading
    expect(gap()).toBe(0);
    expect(latest.isScrolledUp).toBe(false);
  });

  it('with auto-scroll OFF still lands on the bottom after late image growth', () => {
    open({ follow: false });
    grow(1400);
    now += 3_000;
    grow(1900);
    expect(gap()).toBeLessThanOrEqual(2);
  });

  it('with auto-scroll OFF stops following once the opening window ends', () => {
    open({ follow: false });
    now += PIN_WINDOW_MS + 1;
    grow(1500); // a streamed reply
    expect(gap()).toBe(500);
    expect(latest.isScrolledUp).toBe(true);
  });

  it('a search-hit navigation suppresses the opening pin and later growth', () => {
    open({ follow: true, suppress: true });
    expect(scroller().scrollTop).toBe(0);
    grow(1500);
    expect(scroller().scrollTop).toBe(0);
  });

  it('switching sessions re-arms the pin even after the user had scrolled up', () => {
    const view = open({ follow: true });
    fireEvent.wheel(scroller(), { deltaY: -120 });
    userScrollTo(100);
    view.rerender(<Harness ready={false} follow sessionKey="s2" />);
    view.rerender(<Harness ready follow sessionKey="s2" />);
    expect(gap()).toBe(0);
    expect(latest.isScrolledUp).toBe(false);
  });
});

describe('useStickToBottom: live follow', () => {
  it('a streaming row that grows without a new message re-pins', () => {
    open({ follow: true });
    grow(1050);
    grow(1120);
    expect(gap()).toBe(0);
  });

  it('content growing under a user who never scrolled keeps the stick (no false "scrolled up")', () => {
    open({ follow: true });
    metrics.scrollHeight = 1300;
    fireEvent.scroll(scroller()); // a scroll event can land before the observer callback
    grow(1300);
    expect(gap()).toBe(0);
    expect(latest.isScrolledUp).toBe(false);
  });

  it('a container resize (mobile keyboard, composer growth) re-pins', () => {
    open({ follow: true });
    metrics.clientHeight = 250;
    grow(1000);
    expect(gap()).toBe(0);
  });

  it('a clamp from content shrinking at the bottom is not read as scrolling up', () => {
    open({ follow: true });
    metrics.scrollHeight = 800;
    scroller().scrollTop = scroller().scrollTop; // browser clamp
    fireEvent.scroll(scroller());
    grow(1200);
    expect(gap()).toBe(0);
  });
});

describe('useStickToBottom: user gestures', () => {
  it('wheel up stops re-pinning; scrolling back near the bottom re-sticks', () => {
    open({ follow: true });
    fireEvent.wheel(scroller(), { deltaY: -100 });
    userScrollTo(500);
    grow(1200);
    expect(scroller().scrollTop).toBe(500);
    expect(latest.isScrolledUp).toBe(true);
    userScrollTo(790);
    grow(1300);
    expect(gap()).toBe(0);
  });

  it('a small upward scroll still inside the 50px band is honoured (no yank back)', () => {
    open({ follow: true });
    userScrollTo(580);
    grow(1100);
    expect(scroller().scrollTop).toBe(580);
  });

  it('a finger pulling the list down releases the stick', () => {
    open({ follow: true });
    fireEvent.touchStart(scroller(), { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(scroller(), { touches: [{ clientY: 160 }] });
    grow(1300);
    expect(scroller().scrollTop).toBe(600);
  });

  it('short content: wheel up then a prepended page is not yanked to the bottom', () => {
    metrics = { scrollHeight: 300, clientHeight: 400 };
    open({ follow: true });
    fireEvent.wheel(scroller(), { deltaY: -60 });
    scroller().scrollTop = 0;
    grow(900); // pagination restore keeps the top
    expect(scroller().scrollTop).toBe(0);
  });

  it('release() (load older / load all) keeps the restored position', () => {
    open({ follow: true });
    act(() => latest.release());
    grow(2000);
    expect(scroller().scrollTop).toBe(600);
  });

  it('pin() (the arrow) pins and stays pinned across lazy growth even with follow OFF', () => {
    open({ follow: false });
    now += PIN_WINDOW_MS + 1;
    userScrollTo(100);
    act(() => latest.pin());
    expect(gap()).toBe(0);
    grow(1700);
    now += 4_000;
    grow(2100);
    expect(gap()).toBe(0);
    expect(latest.isScrolledUp).toBe(false);
  });
});
