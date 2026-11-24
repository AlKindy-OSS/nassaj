import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';

import { isSameWidth } from './lightboxZoomMath';
import { originalLinkFor } from './lightboxOriginalLink';
import { ZOOM_STEP, useLightboxZoom } from './useLightboxZoom';
import type { ZoomView } from './useLightboxZoom';

interface ImageLightboxProps {
  /** Anything an <img> accepts: a blob:, data: or already-resolved http URL. */
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * Pan in both axes stays native (scroll + inertia); pinch never reaches the
 * browser, so page zoom cannot trigger anywhere on the overlay (B-1805).
 */
const OVERLAY_TOUCH: CSSProperties = { touchAction: 'pan-x pan-y' };
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const CONTROL_CLASS = 'rounded-full p-2 text-white transition-colors hover:bg-white/15 '
  + 'focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40';

/** Move focus to the next / previous enabled control inside `container`, wrapping. */
function cycleFocus(container: HTMLElement, backwards: boolean) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const next = backwards
    ? (index <= 0 ? last : index - 1)
    : (index === -1 || index === last ? 0 : index + 1);
  items[next].focus();
}

interface KeyboardActions {
  close: () => void;
  zoomBy: (factor: number) => void;
  reset: () => void;
}

/** Escape, Tab cycle and the +/-/0 shortcuts. ctrl/meta/alt combos stay the browser's. */
function handleLightboxKey(event: KeyboardEvent, dialog: HTMLElement | null, actions: KeyboardActions) {
  if (event.key === 'Escape') {
    event.preventDefault();
    actions.close();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    if (dialog) cycleFocus(dialog, event.shiftKey);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const shortcuts: Record<string, () => void> = {
    '+': () => actions.zoomBy(ZOOM_STEP),
    '=': () => actions.zoomBy(ZOOM_STEP),
    '-': () => actions.zoomBy(1 / ZOOM_STEP),
    '0': actions.reset,
  };
  const action = shortcuts[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function zoomPercent(view: ZoomView): string {
  return view.ready ? `${Math.round((view.width / view.natural.width) * 100)}%` : '—';
}

interface ToolbarProps {
  src: string;
  view: ZoomView;
  zoomBy: (factor: number) => void;
  reset: () => void;
}

const LightboxToolbar = ({ src, view, zoomBy, reset }: ToolbarProps) => {
  const { t } = useTranslation('chat');
  const original = originalLinkFor(src, window.location.href);
  return (
    <div
      role="toolbar"
      aria-label={t('images.toolbar')}
      style={OVERLAY_TOUCH}
      className="absolute inset-x-4 bottom-4 z-10 mx-auto flex w-fit items-center gap-1 rounded-full bg-black/70 p-1 text-white shadow-lg"
    >
      <button type="button" className={CONTROL_CLASS} aria-label={t('images.zoomOut')}
        disabled={!view.ready || view.width <= view.min + 0.5} onClick={() => zoomBy(1 / ZOOM_STEP)}>
        <ZoomOut className="h-5 w-5" aria-hidden="true" />
      </button>
      <span aria-live="polite" className="min-w-14 text-center text-sm tabular-nums">
        <bdi>{zoomPercent(view)}</bdi>
      </span>
      <button type="button" className={CONTROL_CLASS} aria-label={t('images.zoomIn')}
        disabled={!view.ready || view.width >= view.max - 0.5} onClick={() => zoomBy(ZOOM_STEP)}>
        <ZoomIn className="h-5 w-5" aria-hidden="true" />
      </button>
      <button type="button" className={CONTROL_CLASS} aria-label={t('images.resetZoom')}
        disabled={!view.ready || isSameWidth(view.width, view.fit)} onClick={reset}>
        <Maximize2 className="h-5 w-5" aria-hidden="true" />
      </button>
      {original?.kind === 'open' && (
        <a href={original.href} target="_blank" rel="noopener noreferrer"
          className={CONTROL_CLASS} aria-label={t('images.openOriginal')}>
          <ExternalLink className="h-5 w-5" aria-hidden="true" />
        </a>
      )}
      {original?.kind === 'download' && (
        <a href={original.href} download="" className={CONTROL_CLASS} aria-label={t('images.download')}>
          <Download className="h-5 w-5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
};

/**
 * T-1235 — full-screen preview for a chat image (composer attachment or a
 * picture already sent). B-1805 — zoomable and pannable: a very tall
 * screenshot opens at viewport width and scrolls; pinch, ctrl+wheel, double-tap
 * and the toolbar zoom the image, never the page.
 *
 * Rendered through a portal on <body>: the composer thumbnails live inside a
 * `overflow-hidden rounded-2xl` prompt box, so an in-place overlay would be
 * clipped to a 80×80 square instead of covering the viewport.
 */
const ImageLightbox = ({ src, alt, onClose }: ImageLightboxProps) => {
  const { t } = useTranslation('chat');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const zoom = useLightboxZoom();
  const { overlayRef, scrollerRef, imgRef, didDragRef, view, zoomBy, resetZoom } = zoom;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const actions = { close: () => onCloseRef.current(), zoomBy, reset: resetZoom };
    const onKeyDown = (event: KeyboardEvent) => handleLightboxKey(event, overlayRef.current, actions);
    document.addEventListener('keydown', onKeyDown);
    closeButtonRef.current?.focus();
    // The page behind must not scroll while the overlay is up (touch devices
    // otherwise pan the chat under the picture).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [overlayRef, zoomBy, resetZoom]);

  return createPortal(
    <div
      ref={overlayRef}
      style={OVERLAY_TOUCH}
      className="fixed inset-0 z-[100] select-none bg-black/80 backdrop-blur-sm"
      // Only a click on the backdrop itself closes, and never the click that
      // ends a drag or pinch. This also avoids the close button's bubbling
      // click calling onClose twice.
      onClick={(event) => {
        if (didDragRef.current) return;
        if (event.target === event.currentTarget || event.target === scrollerRef.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('images.previewFallback')}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label={t('images.closePreview')}
        className="absolute end-4 top-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-black/80"
      >
        <X className="h-5 w-5" />
      </button>
      {/* Physical (LTR) scroll axes keep the focal-point math direction-free. */}
      <div
        ref={scrollerRef}
        dir="ltr"
        tabIndex={0}
        style={OVERLAY_TOUCH}
        className="absolute inset-0 flex overflow-auto overscroll-contain [scrollbar-gutter:stable] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt || ''}
          draggable={false}
          onLoad={zoom.handleImageLoad}
          onDoubleClick={zoom.handleDoubleClick}
          style={view.ready ? { width: view.width } : undefined}
          className={view.ready
            ? 'm-auto block h-auto max-w-none flex-none shadow-2xl'
            : 'm-auto block max-h-[90vh] max-w-[95vw] flex-none object-contain shadow-2xl'}
        />
      </div>
      <LightboxToolbar src={src} view={view} zoomBy={zoomBy} reset={resetZoom} />
    </div>,
    document.body,
  );
};

export default ImageLightbox;
