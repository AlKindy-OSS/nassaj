import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Code2, Eye, Play, RotateCcw } from 'lucide-react';

import ZoomableMermaidDiagram from '../../../../../shared/view/ZoomableMermaidDiagram';

import { useFrameSlot } from './frameSlots';
import { MAX_RICH_BLOCK_BYTES, parseSpec, type RichBlockLang } from './richBlockLangs';
import { checkSpecBudget, stripEmbedOptions } from './specGuards';
import VizSandbox from './VizSandbox';

export type RichCodeBlockProps = {
  lang: RichBlockLang;
  source: string;
};

const BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground '
  + 'transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * `near`: the element is within 200px of the viewport right now.
 * `seen`: it has been at least once (a rendered diagram is kept after that, so
 * scrolling never swaps it back to source and shifts the layout).
 */
function useNearViewport<T extends Element>(): [React.RefObject<T>, boolean, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (visible) setSeen(true);
  }, [visible]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, visible, seen || visible];
}


function SourceView({ source }: { source: string }) {
  return (
    <pre
      dir="ltr"
      className="m-0 max-h-96 overflow-auto whitespace-pre p-3 font-mono text-xs leading-relaxed text-foreground"
    >
      <code>{source}</code>
    </pre>
  );
}

type ToolbarProps = {
  lang: RichBlockLang;
  awaitingRun: boolean;
  canToggle: boolean;
  showSource: boolean;
  onRun: () => void;
  onToggle: () => void;
};

function RichBlockToolbar({ lang, awaitingRun, canToggle, showSource, onRun, onToggle }: ToolbarProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
      <span dir="ltr" className="font-mono text-xs font-medium text-muted-foreground">{lang}</span>
      <div className="flex items-center gap-1.5">
        {awaitingRun && (
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={onRun}
            title={t('richBlock.runD3Title', {
              defaultValue: 'Runs the code written in this message inside an isolated frame',
            })}
            aria-description={t('richBlock.runD3Title', {
              defaultValue: 'Runs the code written in this message inside an isolated frame',
            })}
          >
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
            {t('richBlock.runD3', { defaultValue: 'Run D3' })}
          </button>
        )}
        {canToggle && (
          <button type="button" className={BUTTON_CLASS} aria-pressed={showSource} onClick={onToggle}>
            {showSource
              ? <Eye aria-hidden="true" className="h-3.5 w-3.5" />
              : <Code2 aria-hidden="true" className="h-3.5 w-3.5" />}
            {showSource
              ? t('richBlock.render', { defaultValue: 'Render' })
              : t('richBlock.showSource', { defaultValue: 'Show source' })}
          </button>
        )}
      </div>
    </div>
  );
}

function FailureNote({ detail, onRetry }: { detail: string; onRetry?: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <div role="status" className="flex items-center gap-1.5 px-3 pt-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" />
      <span>{t('richBlock.error', { defaultValue: 'This block could not be rendered' })}</span>
      <span dir="ltr" className="min-w-0 flex-1 truncate opacity-80">{detail}</span>
      {onRetry && (
        <button type="button" className={BUTTON_CLASS} onClick={onRetry}>
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          {t('richBlock.retry', { defaultValue: 'Retry' })}
        </button>
      )}
    </div>
  );
}

type PreparedSpec = { spec: Record<string, unknown> } | { error: string } | null;

/** JSON-parses a Vega/Vega-Lite block, drops embed overrides, and applies the compute budget. */
function prepareSpec(lang: RichBlockLang, source: string): PreparedSpec {
  if (lang !== 'vega' && lang !== 'vega-lite') return null;
  const parsed = parseSpec(source);
  if ('error' in parsed) return parsed;
  const budgetError = checkSpecBudget(parsed.spec);
  return budgetError ? { error: budgetError } : { spec: stripEmbedOptions(parsed.spec) };
}

/** Frame errors and D3 consent are tied to the exact source they were about. */
type FrameError = { source: string; message: string };

function Placeholder({ height }: { height: number }) {
  return <div className="animate-pulse rounded-md bg-muted/40" style={{ height }} aria-hidden="true" />;
}

/**
 * A closed `mermaid` / `vega-lite` / `vega` / `d3` fence in an assistant
 * message, rendered as a diagram or chart (ADR-211).
 *
 * - Nothing renders until the block is near the viewport.
 * - Vega/Vega-Lite/D3 run in a sandboxed frame (`VizSandbox`); at most
 *   `MAX_LIVE_FRAMES` frames exist at once.
 * - D3 is code: nothing of it runs until the reader clicks Run.
 * - Any failure, an oversized block, or an invalid spec shows the source.
 */
export default function RichCodeBlock({ lang, source }: RichCodeBlockProps) {
  const [containerRef, nearViewport, seen] = useNearViewport<HTMLDivElement>();
  const [showSource, setShowSource] = useState(false);
  const [frameError, setFrameError] = useState<FrameError | null>(null);
  const [ranSource, setRanSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastHeight = useRef<number | undefined>(undefined);

  const oversized = useMemo(() => new TextEncoder().encode(source).length > MAX_RICH_BLOCK_BYTES, [source]);
  const parsed = useMemo(() => prepareSpec(lang, source), [lang, source]);
  const specError = parsed && 'error' in parsed ? parsed.error : null;
  const error = frameError?.source === source ? frameError.message : null;
  const failure = error ?? specError ?? (oversized ? 'too large' : null);
  const onFrameError = useCallback((message: string) => setFrameError({ source, message }), [source]);
  const retry = useCallback(() => {
    setFrameError(null);
    setAttempt((n) => n + 1);
  }, []);

  const awaitingRun = lang === 'd3' && ranSource !== source;
  const wantsFrame = lang !== 'mermaid' && nearViewport && !showSource && !failure && !awaitingRun;
  const slotGranted = useFrameSlot(wantsFrame);
  const onHeight = useCallback((h: number) => {
    lastHeight.current = h;
  }, []);

  let body: React.ReactNode;
  if (failure || showSource || awaitingRun || (lang === 'mermaid' && !seen)) {
    body = <SourceView source={source} />;
  } else if (lang === 'mermaid') {
    body = <ZoomableMermaidDiagram code={source} framed={false} />;
  } else if (slotGranted) {
    body = (
      <VizSandbox
        key={`${attempt}:${source}`}
        kind={lang}
        spec={parsed && 'spec' in parsed ? parsed.spec : undefined}
        code={lang === 'd3' ? source : undefined}
        initialHeight={lastHeight.current}
        onHeight={onHeight}
        onError={onFrameError}
      />
    );
  } else {
    body = <Placeholder height={lastHeight.current ?? 160} />;
  }

  return (
    <div
      ref={containerRef}
      className="not-prose my-2 overflow-hidden rounded-lg border border-border/60 bg-card"
      data-rich-block={lang}
    >
      <RichBlockToolbar
        lang={lang}
        awaitingRun={awaitingRun && !failure}
        canToggle={!failure && !awaitingRun}
        showSource={showSource}
        onRun={() => setRanSource(source)}
        onToggle={() => setShowSource((v) => !v)}
      />
      {failure && <FailureNote detail={failure} onRetry={error === 'timeout' ? retry : undefined} />}
      {body}
    </div>
  );
}
