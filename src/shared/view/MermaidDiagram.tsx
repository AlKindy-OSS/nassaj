import { useEffect, useRef, useState } from 'react';

import { useTheme } from '../../contexts/ThemeContext';

/**
 * Renders a single Mermaid code block (project board, wiki and chat).
 *
 * The mermaid library (~1.5MB) is imported lazily so no screen pays for it until
 * a diagram is actually on screen. Render failures degrade to the raw source in
 * a <pre> — a broken diagram must never take its host view down with it.
 *
 * Security: `securityLevel: 'strict'` (DOMPurify over the SVG, no click
 * callbacks) and `htmlLabels: false` (labels are SVG text, never HTML inside a
 * foreignObject). Mermaid's default `maxTextSize`/`maxEdges` stay in force.
 */

let mermaidLoader: Promise<typeof import('mermaid')> | null = null;

function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid');
  }
  return mermaidLoader;
}

/**
 * `mermaid.initialize` is global state: two diagrams rendering at once with
 * different themes (board in one pane, chat in another) would otherwise race and
 * paint one with the other's theme. Every initialize+render pair runs through
 * this single promise chain, so they never interleave.
 *
 * Each task is skipped if its diagram unmounted while queued, and is abandoned
 * after `RENDER_TIMEOUT_MS` so one hung render cannot block every later diagram.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

let diagramSequence = 0;

const RENDER_TIMEOUT_MS = 15000;

/** Keys a `%%{init: …}%%` directive inside a diagram may never change (mermaid deletes them at any depth). */
const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels'];

class RenderCancelled extends Error {}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('mermaid render timed out')), RENDER_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Renders `code` to an SVG string, serialized with every other diagram. */
function renderMermaidSvg(code: string, isDarkMode: boolean, isCancelled: () => boolean): Promise<string> {
  const job = renderQueue.then(async () => {
    if (isCancelled()) throw new RenderCancelled();
    const mermaid = (await loadMermaid()).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: SECURE_KEYS,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: isDarkMode ? 'dark' : 'default',
    });
    diagramSequence += 1;
    const { svg } = await withTimeout(mermaid.render(`nassaj-mermaid-${diagramSequence}`, code));
    return svg;
  });
  // A failed, cancelled or timed-out render must not poison the chain for the next diagram.
  renderQueue = job.catch(() => undefined);
  return job;
}

type MermaidDiagramProps = {
  code: string;
  /** false when the host already draws a card around the diagram (chat rich blocks). */
  framed?: boolean;
};

export default function MermaidDiagram({ code, framed = true }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRenderFailed(false);

    renderMermaidSvg(code, isDarkMode, () => cancelled).then(
      (svg) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      },
      () => {
        if (!cancelled) {
          setRenderFailed(true);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode]);

  if (renderFailed) {
    return (
      <pre
        dir="ltr"
        className="my-2 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
      >
        {code}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      // Mermaid output is LTR diagram markup; keep direction stable inside RTL pages.
      dir="ltr"
      className={`flex justify-center overflow-x-auto p-3 [&_svg]:max-w-full ${
        framed ? 'my-3 rounded-lg border border-border/60 bg-card' : ''
      }`}
    />
  );
}
