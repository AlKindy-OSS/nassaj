/**
 * B-1805 — pure geometry for the chat image lightbox. No DOM access here, so
 * every rule the viewer follows (initial fit, limits, focal-point zoom) is
 * unit-tested on plain numbers.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ScrollPosition {
  left: number;
  top: number;
}

export type FitMode = 'width' | 'contain';

/** An image this many times taller (relative to the viewport) reads by scrolling. */
const TALL_IMAGE_RATIO = 2;
/** Upper zoom bound relative to the fit and to the natural (1:1) size. */
const MAX_FIT_MULTIPLE = 4;
const MAX_NATURAL_MULTIPLE = 2;
/** Widths closer than this (px) count as the same zoom level. */
const SAME_WIDTH_TOLERANCE_PX = 1;

/** Bound `value` to the closed range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The initial rendered width. A very tall image (e.g. a full-page screenshot)
 * fills the viewport width and scrolls vertically; anything else is contained
 * inside the viewport minus `gutter` on each side. Never upscales.
 */
export function computeFit(natural: Size, viewport: Size, gutter: number): { mode: FitMode; width: number } {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { mode: 'contain', width: 0 };
  }
  const imageRatio = natural.height / natural.width;
  const viewportRatio = viewport.height / viewport.width;
  if (imageRatio > viewportRatio * TALL_IMAGE_RATIO) {
    return { mode: 'width', width: Math.min(natural.width, viewport.width) };
  }
  const availableWidth = Math.max(1, viewport.width - 2 * gutter);
  const availableHeight = Math.max(1, viewport.height - 2 * gutter);
  const scale = Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
  return { mode: 'contain', width: Math.floor(natural.width * scale) };
}

/** Zoom range in rendered-width pixels: from the fit up to max(4×fit, 2×natural). */
export function zoomLimits(fitWidth: number, naturalWidth: number): { min: number; max: number } {
  return {
    min: fitWidth,
    max: Math.max(MAX_FIT_MULTIPLE * fitWidth, MAX_NATURAL_MULTIPLE * naturalWidth),
  };
}

/** Leading offset of a centred image that is smaller than the viewport on one axis. */
function centredOffset(imageExtent: number, viewportExtent: number): number {
  return Math.max(0, (viewportExtent - imageExtent) / 2);
}

/** Scroll position along one axis that keeps `focal` over the same image point. */
function focalScroll(prev: number, next: number, viewport: number, scroll: number, focal: number): number {
  if (prev <= 0) return 0;
  const fraction = (scroll + focal - centredOffset(prev, viewport)) / prev;
  const target = fraction * next + centredOffset(next, viewport) - focal;
  return clamp(target, 0, Math.max(0, next - viewport));
}

/**
 * New scroll offsets after the rendered width changes from `prevWidth` to
 * `nextWidth`, so the image point under `focal` (viewport coordinates) stays put.
 * `aspect` is naturalHeight / naturalWidth. Assumes physical (LTR) scroll axes.
 */
export function zoomAround(params: {
  prevWidth: number;
  nextWidth: number;
  aspect: number;
  viewport: Size;
  scroll: ScrollPosition;
  focal: Point;
}): ScrollPosition {
  const { prevWidth, nextWidth, aspect, viewport, scroll, focal } = params;
  return {
    left: focalScroll(prevWidth, nextWidth, viewport.width, scroll.left, focal.x),
    top: focalScroll(prevWidth * aspect, nextWidth * aspect, viewport.height, scroll.top, focal.y),
  };
}

/** True when two rendered widths are the same zoom level for UI purposes. */
export function isSameWidth(a: number, b: number): boolean {
  return Math.abs(a - b) < SAME_WIDTH_TOLERANCE_PX;
}

/**
 * Double-tap / double-click target: from the fit to 1:1 (or 2× the fit when the
 * image is not larger than it), and from any other zoom back to the fit.
 */
export function toggleZoomTarget(params: { current: number; fit: number; natural: number; max: number }): number {
  const { current, fit, natural, max } = params;
  if (!isSameWidth(current, fit)) return fit;
  const target = natural > fit + SAME_WIDTH_TOLERANCE_PX ? natural : 2 * fit;
  return Math.min(target, max);
}
