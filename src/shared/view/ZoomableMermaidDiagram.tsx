/**
 * ZoomableMermaidDiagram — a Mermaid diagram with a "zoom" button that opens
 * the same diagram in a full-screen dialog (wiki, chat and project board).
 *
 * On mobile (<md) the zoom button is always visible with a 44×44px touch
 * target; on desktop it appears on hover/focus.
 *
 * The overlay is accessible:
 *  - role="dialog" + aria-modal="true" + aria-label
 *  - Closes on Escape and on backdrop click
 *  - Focus moves to the close button on open and back to the zoom button on close
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Maximize2, X } from 'lucide-react';

import MermaidDiagram from './MermaidDiagram';

export type MermaidZoomLabels = {
  zoom: string;
  zoomedAria: string;
  close: string;
};

export type ZoomableMermaidDiagramProps = {
  code: string;
  /** Passed to the inline diagram only; the zoomed copy keeps the default frame. */
  framed?: boolean;
  /** Overrides the default `common:mermaidZoom.*` labels (the wiki is Arabic-only). */
  labels?: MermaidZoomLabels;
  /** Extra attributes on the wrapper around the inline diagram (wiki CSS hooks). */
  inlineWrapperProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  /** Extra class on the zoomed panel (wiki mobile scrolling). */
  overlayClassName?: string;
};

function useDefaultLabels(): MermaidZoomLabels {
  const { t } = useTranslation('common');
  return {
    zoom: t('mermaidZoom.zoom', { defaultValue: 'Zoom diagram' }),
    zoomedAria: t('mermaidZoom.zoomedAria', { defaultValue: 'Zoomed Mermaid diagram' }),
    close: t('mermaidZoom.close', { defaultValue: 'Close' }),
  };
}

/** Open/close state with focus hand-off and a capturing Escape handler. */
function useZoomDialog() {
  const [zoomed, setZoomed] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);

  const open = useCallback(() => setZoomed(true), []);
  const close = useCallback(() => {
    setZoomed(false);
    requestAnimationFrame(() => zoomButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!zoomed) return undefined;
    // Slight delay so the overlay is painted before the focus attempt.
    const id = setTimeout(() => closeButtonRef.current?.focus(), 20);
    return () => clearTimeout(id);
  }, [zoomed]);

  useEffect(() => {
    if (!zoomed) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoomed, close]);

  return { zoomed, open, close, closeButtonRef, zoomButtonRef };
}

const ZOOM_BUTTON_CLASS = [
  'absolute end-2 top-2 rounded transition-colors',
  'bg-muted text-muted-foreground',
  'hover:bg-accent hover:text-foreground',
  'flex items-center justify-center',
  'h-11 w-11 opacity-100 md:h-auto md:w-auto md:p-1',
  'md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100',
].join(' ');

const CLOSE_BUTTON_CLASS = [
  'absolute end-3 top-3 rounded-md p-1.5',
  'text-muted-foreground hover:bg-accent hover:text-foreground',
  'transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50',
].join(' ');

/** Mermaid diagram plus an accessible full-screen zoom dialog. */
export default function ZoomableMermaidDiagram({
  code,
  framed,
  labels,
  inlineWrapperProps,
  overlayClassName,
}: ZoomableMermaidDiagramProps) {
  const defaults = useDefaultLabels();
  const text = labels ?? defaults;
  const { zoomed, open, close, closeButtonRef, zoomButtonRef } = useZoomDialog();

  return (
    <div className="group relative">
      <div {...inlineWrapperProps}>
        <MermaidDiagram code={code} framed={framed} />
      </div>

      <button
        ref={zoomButtonRef}
        type="button"
        onClick={open}
        aria-label={text.zoom}
        className={ZOOM_BUTTON_CLASS}
      >
        <Maximize2 className="h-4 w-4 md:h-3.5 md:w-3.5" aria-hidden="true" />
      </button>

      {/* Portaled to body so a transformed/clipped ancestor (chat bubble, board) can't trap the fixed overlay. */}
      {zoomed && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={text.zoomedAria}
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={close}
            aria-hidden="true"
            data-testid="mermaid-zoom-backdrop"
          />
          <div
            className={[
              overlayClassName,
              'relative z-10 max-h-[90dvh] max-w-[95dvw] overflow-auto rounded-lg border border-border bg-card p-6 shadow-2xl',
            ].filter(Boolean).join(' ')}
          >
            <button
              ref={closeButtonRef}
              type="button"
              onClick={close}
              aria-label={text.close}
              className={CLOSE_BUTTON_CLASS}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="min-w-[min(600px,85dvw)]">
              <MermaidDiagram code={code} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
