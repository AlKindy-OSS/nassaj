import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject, TouchEvent, WheelEvent } from 'react';

/** Distance from the bottom (px) still treated as "at the latest message". */
export const NEAR_BOTTOM_PX = 50;
/** A scroll that moved up but stays within this distance is the browser clamping, not the user. */
const CLAMP_TOLERANCE_PX = 2;
/**
 * After a session opens (or the arrow is pressed) late layout — images, code
 * highlighting, rich blocks — keeps re-pinning for this long even when the
 * user turned live follow off. Live follow itself is governed by `follow`.
 */
export const PIN_WINDOW_MS = 10_000;

export interface StickToBottomOptions {
  scrollRef: RefObject<HTMLElement | null>;
  /** Wrapper around the rendered messages; its growth is what re-pins. */
  contentRef: RefObject<HTMLElement | null>;
  sessionKey: string | null;
  /** Messages are rendered and the history load has settled. */
  ready: boolean;
  /** The user's "auto scroll to bottom" preference: keep following new content. */
  follow: boolean;
  /** While true (search-hit navigation) nothing is pinned. */
  suppressRef?: RefObject<boolean>;
}

export interface StickToBottom {
  /** Single source for the scroll-to-bottom arrow. */
  isScrolledUp: boolean;
  /** Jump to the bottom and keep it there across late layout growth. */
  pin: () => void;
  /** Stop pinning (the user asked for older content). */
  release: () => void;
  onScroll: () => void;
  onWheel: (event: WheelEvent) => void;
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
}

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * One controller for "stay at the latest message" (B-1665). A ResizeObserver on
 * the message wrapper and on the scroll box re-pins while `stick` holds, so
 * content that grows after first paint (images, a streaming row whose length
 * never changes, a keyboard shrinking the viewport) cannot leave the view short.
 * Only the user clears `stick`: scrolling up (scrollTop decreased while not
 * clamped at the bottom), a wheel-up or a finger pulling the list down.
 */
export function useStickToBottom(options: StickToBottomOptions): StickToBottom {
  const { scrollRef, contentRef, sessionKey, ready, follow, suppressRef } = options;
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const pinUntilRef = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const syncScrolledUp = useCallback(() => {
    const el = scrollRef.current;
    if (el) setIsScrolledUp(distanceFromBottom(el) >= NEAR_BOTTOM_PX);
  }, [scrollRef]);

  const writeBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [scrollRef]);

  const handleResize = useCallback(() => {
    const pinning = followRef.current || Date.now() < pinUntilRef.current;
    if (stickRef.current && pinning && !suppressRef?.current) writeBottom();
    syncScrolledUp();
  }, [suppressRef, syncScrolledUp, writeBottom]);

  useResizePin(scrollRef, contentRef, handleResize, sessionKey);
  useInitialPin({ sessionKey, ready, suppressRef, stickRef, pinUntilRef, writeBottom, setIsScrolledUp });
  const gestures = useStickGestures(scrollRef, stickRef, lastTopRef, syncScrolledUp);

  const pin = useCallback(() => {
    stickRef.current = true;
    pinUntilRef.current = Date.now() + PIN_WINDOW_MS;
    writeBottom();
    setIsScrolledUp(false);
  }, [writeBottom]);

  const release = useCallback(() => { stickRef.current = false; }, []);

  return { isScrolledUp, pin, release, ...gestures };
}

function useResizePin(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  onResize: () => void,
  sessionKey: string | null,
) {
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => onResize());
    if (scrollRef.current) observer.observe(scrollRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [scrollRef, contentRef, onResize, sessionKey]);
}

interface InitialPinArgs {
  sessionKey: string | null;
  ready: boolean;
  suppressRef?: RefObject<boolean>;
  stickRef: { current: boolean };
  pinUntilRef: { current: number };
  writeBottom: () => void;
  setIsScrolledUp: (value: boolean) => void;
}

/** Opening a session always lands on the latest message, whatever `follow` says. */
function useInitialPin({ sessionKey, ready, suppressRef, stickRef, pinUntilRef, writeBottom, setIsScrolledUp }: InitialPinArgs) {
  const pinnedForRef = useRef<string | null | undefined>(undefined);

  useLayoutEffect(() => {
    stickRef.current = true;
    pinUntilRef.current = 0;
    pinnedForRef.current = undefined;
    setIsScrolledUp(false);
  }, [sessionKey, stickRef, pinUntilRef, setIsScrolledUp]);

  useLayoutEffect(() => {
    if (!ready || pinnedForRef.current === sessionKey) return;
    pinnedForRef.current = sessionKey;
    if (suppressRef?.current) { stickRef.current = false; return; }
    pinUntilRef.current = Date.now() + PIN_WINDOW_MS;
    writeBottom();
  }, [ready, sessionKey, suppressRef, stickRef, pinUntilRef, writeBottom]);
}

function useStickGestures(
  scrollRef: RefObject<HTMLElement | null>,
  stickRef: { current: boolean },
  lastTopRef: { current: number },
  syncScrolledUp: () => void,
) {
  const touchYRef = useRef<number | null>(null);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = distanceFromBottom(el);
    if (top < lastTopRef.current && distance > CLAMP_TOLERANCE_PX) stickRef.current = false;
    else if (distance < NEAR_BOTTOM_PX) stickRef.current = true;
    lastTopRef.current = top;
    syncScrolledUp();
  }, [scrollRef, stickRef, lastTopRef, syncScrolledUp]);

  const onWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) stickRef.current = false;
  }, [stickRef]);

  const onTouchStart = useCallback((event: TouchEvent) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback((event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    if (touchYRef.current != null && y > touchYRef.current) stickRef.current = false;
    touchYRef.current = y;
  }, [stickRef]);

  return { onScroll, onWheel, onTouchStart, onTouchMove };
}
