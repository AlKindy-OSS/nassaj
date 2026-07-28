/**
 * WikiMermaidDiagram — thin wrapper around MermaidDiagram that adds a
 * "zoom" button exclusive to the wiki context.
 *
 * Deliberately isolated inside src/components/wiki/ so MermaidDiagram.tsx
 * (shared with project-board) is never touched.
 *
 * البند 3: على الجوال (<md):
 *  - الـSVG يُعرض بحجمه الطبيعي داخل حاوية overflow-x-auto (لا تقليص)
 *  - زر التكبير ظاهر دائماً بهدف لمس 44×44px
 *  - داخل الـoverlay: -webkit-overflow-scrolling: touch
 *
 * The overlay is accessible:
 *  - role="dialog" + aria-modal="true"
 *  - aria-label
 *  - Closes on Escape and on backdrop click
 *  - Focus is moved to the close button when the overlay opens
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Maximize2, X } from 'lucide-react';
import MermaidDiagram from '../../project-board/view/MermaidDiagram';

type WikiMermaidDiagramProps = {
  code: string;
};

export default function WikiMermaidDiagram({ code }: WikiMermaidDiagramProps) {
  const [zoomed, setZoomed] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const zoomBtnRef = useRef<HTMLButtonElement>(null);

  const openZoom = useCallback(() => setZoomed(true), []);
  const closeZoom = useCallback(() => {
    setZoomed(false);
    // إعادة التركيز لزر التكبير عند الإغلاق
    requestAnimationFrame(() => zoomBtnRef.current?.focus());
  }, []);

  // Move focus to close button when overlay opens
  useEffect(() => {
    if (zoomed) {
      // Slight delay so the overlay is painted before focus attempt
      const id = setTimeout(() => closeButtonRef.current?.focus(), 20);
      return () => clearTimeout(id);
    }
  }, [zoomed]);

  // Escape key closes the overlay (does not bubble — handled locally)
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeZoom();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoomed, closeZoom]);

  return (
    <div className="group relative">
      {/*
        البند 3: الحاوية الداخلية للـSVG.
        على الجوال (<md): نتجاوز [&_svg]:max-w-full الموروثة من MermaidDiagram
        باستخدام data-wiki-mermaid لرفع الخصوصية في wiki-panel.css،
        فيعرض الـSVG بحجمه الطبيعي داخل حاوية overflow-x-auto.
        على الديسكتوب (md+): لا تأثير — [&_svg]:max-w-full تعمل كالمعتاد.
      */}
      <div data-wiki-mermaid="true">
        <MermaidDiagram code={code} />
      </div>

      {/*
        زر التكبير:
        - على الجوال: ظاهر دائماً (opacity-100) + هدف لمس 44×44px
        - على الديسكتوب: سلوكه الأصلي (يظهر عند hover/focus فقط)
      */}
      <button
        ref={zoomBtnRef}
        type="button"
        onClick={openZoom}
        aria-label="تكبير المخطط"
        className={[
          'absolute end-2 top-2 rounded transition-colors',
          'bg-muted text-muted-foreground',
          'hover:bg-accent hover:text-foreground',
          // الجوال: ظاهر دائماً + هدف لمس 44×44px
          'flex items-center justify-center',
          'h-11 w-11 opacity-100 md:h-auto md:w-auto md:p-1',
          // الديسكتوب: يظهر عند hover/focus فقط
          'md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100',
        ].join(' ')}
      >
        <Maximize2 className="h-4 w-4 md:h-3.5 md:w-3.5" aria-hidden="true" />
      </button>

      {/* Full-screen overlay */}
      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="مخطط Mermaid مكبَّر"
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeZoom}
            aria-hidden="true"
          />

          {/* Diagram panel */}
          {/* البند 3: overflow-auto مع -webkit-overflow-scrolling: touch للجوال */}
          <div
            className="wiki-mermaid-overlay relative z-10 max-h-[90dvh] max-w-[95dvw] overflow-auto rounded-lg border border-border bg-card p-6 shadow-2xl"
          >
            {/* Close button */}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeZoom}
              aria-label="إغلاق"
              className={[
                'absolute end-3 top-3 rounded-md p-1.5',
                'text-muted-foreground hover:bg-accent hover:text-foreground',
                'transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50',
              ].join(' ')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            {/* Re-render the diagram at full size */}
            <div className="min-w-[min(600px,85dvw)]">
              <MermaidDiagram code={code} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
