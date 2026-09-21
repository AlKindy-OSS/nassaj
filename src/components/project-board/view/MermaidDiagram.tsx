import { useEffect, useRef, useState } from 'react';

import { useTheme } from '../../../contexts/ThemeContext';

/**
 * Renders a single Mermaid code block.
 *
 * The mermaid library (~1.5MB) is imported lazily so the board (and the main
 * bundle) pays nothing until a diagram is actually on screen. Render failures
 * degrade to the raw source in a <pre> — a broken diagram must never take the
 * architecture tab down with it.
 */

let mermaidLoader: Promise<typeof import('mermaid')> | null = null;

function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid');
  }
  return mermaidLoader;
}

let diagramSequence = 0;

type MermaidDiagramProps = {
  code: string;
};

export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRenderFailed(false);

    const render = async () => {
      try {
        const mermaid = (await loadMermaid()).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkMode ? 'dark' : 'default',
        });
        diagramSequence += 1;
        const { svg } = await mermaid.render(`project-board-diagram-${diagramSequence}`, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled) {
          setRenderFailed(true);
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode]);

  if (renderFailed) {
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        {code}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      // Mermaid output is LTR diagram markup; keep direction stable inside RTL pages.
      dir="ltr"
      className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border/60 bg-card p-3 [&_svg]:max-w-full"
    />
  );
}
