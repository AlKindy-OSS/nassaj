import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';

import {
  clamp,
  computeFit,
  isSameWidth,
  toggleZoomTarget,
  zoomAround,
  zoomLimits,
} from './lightboxZoomMath';
import type { Point, Size } from './lightboxZoomMath';

/** B-1805 — zoom and pan state for ImageLightbox, driven by native scrolling. */

/** Space kept around a contained (not width-fitted) image. */
const CONTAIN_GUTTER_PX = 16;
/** Movement beyond this marks the gesture as a drag (its trailing click is ignored). */
const DRAG_THRESHOLD_PX = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 10;
/** Exponential ctrl+wheel response; per-event delta is capped so one notch stays gentle. */
const WHEEL_SENSITIVITY = 0.004;
const WHEEL_DELTA_CAP = 100;
const WHEEL_LINE_PX = 16;
const WHEEL_COMMIT_DELAY_MS = 150;
/** Factor of one toolbar / keyboard zoom step. */
export const ZOOM_STEP = 1.25;

export interface ZoomView {
  ready: boolean;
  width: number;
  fit: number;
  min: number;
  max: number;
  natural: Size;
}

const EMPTY_VIEW: ZoomView = { ready: false, width: 0, fit: 0, min: 0, max: 0, natural: { width: 0, height: 0 } };

interface TrackedPointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/** Shared imperative core: everything a gesture needs, all stable across renders. */
interface ZoomCore {
  overlayRef: RefObject<HTMLDivElement>;
  scrollerRef: RefObject<HTMLDivElement>;
  imgRef: RefObject<HTMLImageElement>;
  live: MutableRefObject<ZoomView>;
  pointers: MutableRefObject<Map<number, TrackedPointer>>;
  didDragRef: MutableRefObject<boolean>;
  lastPointerTypeRef: MutableRefObject<string>;
  toLocal: (clientX: number, clientY: number) => Point;
  applyWidth: (nextWidth: number, focal: Point) => void;
  scheduleWidth: (nextWidth: number, focal: Point) => void;
  commit: () => void;
  toggleAt: (clientX: number, clientY: number) => void;
  setGestureActive: (active: boolean) => void;
}

function useZoomCore(): { core: ZoomCore; view: ZoomView; refit: (reset: boolean) => void } {
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const live = useRef<ZoomView>(EMPTY_VIEW);
  const pointers = useRef(new Map<number, TrackedPointer>());
  const didDragRef = useRef(false);
  const lastPointerTypeRef = useRef('mouse');
  const frame = useRef<{ id: number; width: number; focal: Point } | null>(null);
  const [view, setView] = useState<ZoomView>(EMPTY_VIEW);

  const toLocal = useCallback((clientX: number, clientY: number): Point => {
    const rect = scrollerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const applyWidth = useCallback((nextWidth: number, focal: Point) => {
    const scroller = scrollerRef.current;
    const img = imgRef.current;
    const state = live.current;
    if (!scroller || !img || !state.ready) return;
    const width = clamp(nextWidth, state.min, state.max);
    const prevWidth = state.width;
    img.style.width = `${width}px`;
    const next = zoomAround({
      prevWidth,
      nextWidth: width,
      aspect: state.natural.height / state.natural.width,
      viewport: { width: scroller.clientWidth, height: scroller.clientHeight },
      scroll: { left: scroller.scrollLeft, top: scroller.scrollTop },
      focal,
    });
    scroller.scrollLeft = next.left;
    scroller.scrollTop = next.top;
    live.current = { ...state, width };
  }, []);

  /** Coalesce gesture updates to one DOM write per animation frame. */
  const scheduleWidth = useCallback((nextWidth: number, focal: Point) => {
    if (frame.current) {
      frame.current.width = nextWidth;
      frame.current.focal = focal;
      return;
    }
    const pending = { id: 0, width: nextWidth, focal };
    pending.id = requestAnimationFrame(() => {
      frame.current = null;
      applyWidth(pending.width, pending.focal);
    });
    frame.current = pending;
  }, [applyWidth]);

  const commit = useCallback(() => {
    if (frame.current) {
      cancelAnimationFrame(frame.current.id);
      applyWidth(frame.current.width, frame.current.focal);
      frame.current = null;
    }
    setView(live.current);
  }, [applyWidth]);

  const refit = useCallback((reset: boolean) => {
    const scroller = scrollerRef.current;
    const img = imgRef.current;
    if (!scroller || !img || img.naturalWidth <= 0) return;
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const viewport = { width: scroller.clientWidth, height: scroller.clientHeight };
    const fit = computeFit(natural, viewport, CONTAIN_GUTTER_PX).width;
    const limits = zoomLimits(fit, natural.width);
    const prev = live.current;
    const keepFit = reset || !prev.ready || isSameWidth(prev.width, prev.fit);
    live.current = { ready: true, width: prev.ready ? prev.width : fit, fit, natural, ...limits };
    applyWidth(keepFit ? fit : prev.width, { x: viewport.width / 2, y: viewport.height / 2 });
    if (reset) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    }
    commit();
  }, [applyWidth, commit]);

  const toggleAt = useCallback((clientX: number, clientY: number) => {
    const state = live.current;
    if (!state.ready) return;
    const target = toggleZoomTarget({
      current: state.width, fit: state.fit, natural: state.natural.width, max: state.max,
    });
    applyWidth(target, toLocal(clientX, clientY));
    commit();
  }, [applyWidth, commit, toLocal]);

  const setGestureActive = useCallback((active: boolean) => {
    if (scrollerRef.current) scrollerRef.current.style.willChange = active ? 'scroll-position' : '';
    if (imgRef.current) imgRef.current.style.willChange = active ? 'width' : '';
  }, []);

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current.id);
  }, []);

  // Every member is a ref or a stable callback, so this object is created once.
  const core = useMemo<ZoomCore>(() => ({
    overlayRef, scrollerRef, imgRef, live, pointers, didDragRef, lastPointerTypeRef,
    toLocal, applyWidth, scheduleWidth, commit, toggleAt, setGestureActive,
  }), [toLocal, applyWidth, scheduleWidth, commit, toggleAt, setGestureActive]);

  return { core, view, refit };
}

/** True when the pointer went down on a control, which must keep its own click. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a') !== null;
}

function pointerDistance(points: TrackedPointer[]): number {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

interface GestureState {
  pinch: { distance: number; width: number } | null;
  drag: { x: number; y: number; left: number; top: number; captured: boolean } | null;
  hadPinch: boolean;
  lastTap: { time: number; x: number; y: number } | null;
}

function startPinch(core: ZoomCore, gesture: GestureState) {
  const points = [...core.pointers.current.values()];
  gesture.pinch = { distance: Math.max(1, pointerDistance(points)), width: core.live.current.width };
  gesture.hadPinch = true;
  gesture.drag = null;
  gesture.lastTap = null;
  core.didDragRef.current = true;
  core.setGestureActive(true);
  const overlay = core.overlayRef.current;
  core.pointers.current.forEach((_, id) => overlay?.setPointerCapture?.(id));
}

function onPointerDown(core: ZoomCore, gesture: GestureState, event: PointerEvent) {
  const map = core.pointers.current;
  if (map.size === 0) {
    core.didDragRef.current = false;
    gesture.hadPinch = false;
  }
  core.lastPointerTypeRef.current = event.pointerType;
  map.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
  if (map.size === 2 && core.live.current.ready) {
    startPinch(core, gesture);
    return;
  }
  const scroller = core.scrollerRef.current;
  const canPan = scroller !== null
    && (scroller.scrollWidth > scroller.clientWidth || scroller.scrollHeight > scroller.clientHeight);
  if (event.pointerType === 'mouse' && event.button === 0 && canPan && !isInteractiveTarget(event.target)) {
    event.preventDefault();
    gesture.drag = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, captured: false };
  }
}

function dragTo(core: ZoomCore, gesture: GestureState, event: PointerEvent) {
  const drag = gesture.drag;
  const scroller = core.scrollerRef.current;
  if (!drag || !scroller || !core.didDragRef.current) return;
  if (!drag.captured) {
    scroller.setPointerCapture?.(event.pointerId);
    drag.captured = true;
  }
  scroller.scrollLeft = drag.left - (event.clientX - drag.x);
  scroller.scrollTop = drag.top - (event.clientY - drag.y);
}

function onPointerMove(core: ZoomCore, gesture: GestureState, event: PointerEvent) {
  const tracked = core.pointers.current.get(event.pointerId);
  if (!tracked) return;
  tracked.x = event.clientX;
  tracked.y = event.clientY;
  if (Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY) > DRAG_THRESHOLD_PX) {
    core.didDragRef.current = true;
  }
  if (gesture.pinch && core.pointers.current.size >= 2) {
    const points = [...core.pointers.current.values()].slice(0, 2);
    const ratio = pointerDistance(points) / gesture.pinch.distance;
    const midpoint = core.toLocal((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
    core.scheduleWidth(gesture.pinch.width * ratio, midpoint);
    return;
  }
  dragTo(core, gesture, event);
}

/** Manual double-tap for touch / pen (mouse uses dblclick), on the image only. */
function detectDoubleTap(core: ZoomCore, gesture: GestureState, event: PointerEvent) {
  const isTap = event.pointerType !== 'mouse' && core.pointers.current.size === 1
    && !gesture.hadPinch && !core.didDragRef.current && event.target === core.imgRef.current;
  if (!isTap) return;
  const now = event.timeStamp || performance.now();
  const last = gesture.lastTap;
  if (last && now - last.time < DOUBLE_TAP_MS
    && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_DISTANCE_PX) {
    gesture.lastTap = null;
    core.toggleAt(event.clientX, event.clientY);
    return;
  }
  gesture.lastTap = { time: now, x: event.clientX, y: event.clientY };
}

function onPointerEnd(core: ZoomCore, gesture: GestureState, event: PointerEvent) {
  if (!core.pointers.current.has(event.pointerId)) return;
  if (event.type === 'pointerup') detectDoubleTap(core, gesture, event);
  core.pointers.current.delete(event.pointerId);
  if (gesture.pinch && core.pointers.current.size < 2) {
    gesture.pinch = null;
    core.setGestureActive(false);
    core.commit();
  }
  if (core.pointers.current.size === 0) gesture.drag = null;
}

/** Pinch, mouse drag-to-pan and touch double-tap, all on the whole overlay. */
function usePointerGestures(core: ZoomCore) {
  useEffect(() => {
    const overlay = core.overlayRef.current;
    if (!overlay) return undefined;
    const gesture: GestureState = { pinch: null, drag: null, hadPinch: false, lastTap: null };
    const down = (event: PointerEvent) => onPointerDown(core, gesture, event);
    const move = (event: PointerEvent) => onPointerMove(core, gesture, event);
    const end = (event: PointerEvent) => onPointerEnd(core, gesture, event);
    // Two fingers belong to our pinch, never to the browser (one finger keeps
    // native scrolling and inertia untouched).
    const multiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const listeners: Array<[string, EventListener, AddEventListenerOptions?]> = [
      ['pointerdown', down as EventListener],
      ['pointermove', move as EventListener],
      ['pointerup', end as EventListener],
      ['pointercancel', end as EventListener],
      ['lostpointercapture', end as EventListener],
      ['touchmove', multiTouch as EventListener, { passive: false }],
    ];
    listeners.forEach(([type, fn, options]) => overlay.addEventListener(type, fn, options));
    return () => listeners.forEach(([type, fn, options]) => overlay.removeEventListener(type, fn, options));
  }, [core]);
}

/** ctrl+wheel (also Chrome's trackpad pinch) zooms around the cursor; plain wheel scrolls. */
function useCtrlWheelZoom(core: ZoomCore) {
  useEffect(() => {
    const overlay = core.overlayRef.current;
    if (!overlay) return undefined;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (!core.live.current.ready) return;
      const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : 1;
      const delta = clamp(event.deltaY * unit, -WHEEL_DELTA_CAP, WHEEL_DELTA_CAP);
      core.applyWidth(core.live.current.width * Math.exp(-delta * WHEEL_SENSITIVITY), core.toLocal(event.clientX, event.clientY));
      clearTimeout(commitTimer);
      commitTimer = setTimeout(core.commit, WHEEL_COMMIT_DELAY_MS);
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      overlay.removeEventListener('wheel', onWheel);
      clearTimeout(commitTimer);
    };
  }, [core]);
}

interface SafariGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Safari (iOS and macOS) fires its own gesture events and would zoom the page.
 * Block them; on macOS (no touch pointers down) the trackpad pinch drives our zoom.
 */
function useSafariGestures(core: ZoomCore) {
  useEffect(() => {
    const overlay = core.overlayRef.current;
    if (!overlay) return undefined;
    let startWidth: number | null = null;
    const onStart = (event: Event) => {
      event.preventDefault();
      startWidth = core.pointers.current.size === 0 && core.live.current.ready ? core.live.current.width : null;
    };
    const onChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      if (startWidth !== null) core.scheduleWidth(startWidth * gesture.scale, core.toLocal(gesture.clientX, gesture.clientY));
    };
    const onEnd = (event: Event) => {
      event.preventDefault();
      if (startWidth !== null) core.commit();
      startWidth = null;
    };
    const listeners: Array<[string, EventListener]> = [
      ['gesturestart', onStart], ['gesturechange', onChange], ['gestureend', onEnd],
    ];
    listeners.forEach(([type, fn]) => overlay.addEventListener(type, fn, { passive: false }));
    return () => listeners.forEach(([type, fn]) => overlay.removeEventListener(type, fn));
  }, [core]);
}

/** Recompute the fit on resize / orientation change, once per frame. */
function useViewportRefit(refit: (reset: boolean) => void) {
  useEffect(() => {
    let id = 0;
    const onResize = () => {
      cancelAnimationFrame(id);
      id = requestAnimationFrame(() => refit(false));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [refit]);
}

/**
 * Zoom/pan controller for the lightbox. The rendered image width is the zoom;
 * native scrolling is the pan, so inertia and scrollbars keep working.
 */
export function useLightboxZoom() {
  const { core, view, refit } = useZoomCore();
  usePointerGestures(core);
  useCtrlWheelZoom(core);
  useSafariGestures(core);
  useViewportRefit(refit);

  const centre = useCallback((): Point => {
    const scroller = core.scrollerRef.current;
    return { x: (scroller?.clientWidth ?? 0) / 2, y: (scroller?.clientHeight ?? 0) / 2 };
  }, [core]);

  const zoomBy = useCallback((factor: number) => {
    if (!core.live.current.ready) return;
    core.applyWidth(core.live.current.width * factor, centre());
    core.commit();
  }, [core, centre]);

  const resetZoom = useCallback(() => refit(true), [refit]);

  /** Fit as soon as the bitmap is known, including a cached image already complete on mount. */
  useEffect(() => {
    const img = core.imgRef.current;
    if (img?.complete && img.naturalWidth > 0) refit(true);
  }, [core, refit]);

  const handleDoubleClick = useCallback((event: { clientX: number; clientY: number }) => {
    if (core.lastPointerTypeRef.current === 'mouse') core.toggleAt(event.clientX, event.clientY);
  }, [core]);

  return {
    overlayRef: core.overlayRef,
    scrollerRef: core.scrollerRef,
    imgRef: core.imgRef,
    didDragRef: core.didDragRef,
    view,
    zoomBy,
    resetZoom,
    handleImageLoad: resetZoom,
    handleDoubleClick,
  };
}
