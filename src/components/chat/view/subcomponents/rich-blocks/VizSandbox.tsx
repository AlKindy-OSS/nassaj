import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../../contexts/ThemeContext';

import {
  buildFrameDocument, clampFrameHeight, FRAME_CHANNEL, MIN_FRAME_HEIGHT, READY_AFTER_LOAD_MS, READY_TIMEOUT_MS,
  RENDER_TIMEOUT_MS, type FrameKind,
} from './frameDocument';
import { loadVizLibraries } from './vizLibraries';


function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type VizSandboxProps = {
  kind: 'vega-lite' | 'vega' | 'd3';
  /** Parsed spec (Vega/Vega-Lite) — sent as data, never as code. */
  spec?: unknown;
  /** D3 only: the block's source, run as a function body after the user clicked Run. */
  code?: string;
  /** Last known height, so a re-mounted frame does not jump. */
  initialHeight?: number;
  onHeight?: (height: number) => void;
  onError: (message: string) => void;
};

/**
 * One sandboxed chart frame. See `frameDocument.ts` for the security model.
 *
 * Only messages whose `source` is this frame's own window and that carry this
 * mount's nonce are read; the frame can only ever change its own height or
 * report an error.
 *
 * Inputs are fixed per mount: the host keys this component by its source, so a
 * changed spec or code builds a fresh frame instead of re-arming this one.
 *
 * Self-navigation guard: a srcdoc frame fires `load` exactly once. Any further
 * `load` means it navigated itself (script or clicked link) to another page
 * that runs without our CSP — the frame is dropped at once and reported.
 */
export default function VizSandbox({ kind, spec, code, initialHeight, onHeight, onError }: VizSandboxProps) {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [height, setHeight] = useState(initialHeight ?? MIN_FRAME_HEIGHT * 2);
  const nonceRef = useRef(randomNonce());
  const callbacks = useRef({ onError, onHeight });
  callbacks.current = { onError, onHeight };
  const frameKind: FrameKind = kind === 'd3' ? 'd3' : 'vega';
  const [navigated, setNavigated] = useState(false);
  const loadCount = useRef(0);
  const afterLoad = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadVizLibraries(frameKind).then(
      ({ scripts, fontCss }) => {
        if (cancelled) return;
        setSrcDoc(buildFrameDocument({
          kind: frameKind, nonce: nonceRef.current, libraries: scripts, fontCss, userCode: code,
        }));
      },
      () => {
        if (!cancelled) callbacks.current.onError('chart libraries failed to load');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [frameKind, code]);

  useEffect(() => {
    if (!srcDoc) return undefined;
    let ready = false;
    let finished = false;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      callbacks.current.onError(message);
    };
    const readyTimer = setTimeout(() => {
      if (!ready) fail('timeout');
    }, READY_TIMEOUT_MS);
    let loadReadyTimer: ReturnType<typeof setTimeout> | undefined;
    const armAfterLoad = () => {
      clearTimeout(loadReadyTimer);
      loadReadyTimer = setTimeout(() => {
        if (!ready) fail('timeout');
      }, READY_AFTER_LOAD_MS);
    };
    // The first load may already have happened before this effect attached.
    if (loadCount.current === 1) armAfterLoad();
    afterLoad.current = armAfterLoad;

    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const data = event.data as { channel?: unknown; nonce?: unknown; type?: unknown; height?: unknown; message?: unknown };
      if (!data || data.channel !== FRAME_CHANNEL || data.nonce !== nonceRef.current) return;
      if (data.type === 'ready' && !ready) {
        ready = true;
        clearTimeout(readyTimer);
        clearTimeout(loadReadyTimer);
        renderTimer = setTimeout(() => fail('timeout'), RENDER_TIMEOUT_MS);
        frameWindow.postMessage({
          channel: FRAME_CHANNEL,
          nonce: nonceRef.current,
          type: 'render',
          mode: kind,
          spec,
          theme: isDarkMode ? 'dark' : 'light',
          width: frameRef.current?.clientWidth ?? 600,
        }, '*');
      } else if (data.type === 'rendered') {
        clearTimeout(renderTimer);
      } else if (data.type === 'height') {
        const next = clampFrameHeight(data.height);
        if (next !== null) {
          setHeight(next);
          callbacks.current.onHeight?.(next);
        }
      } else if (data.type === 'error') {
        clearTimeout(renderTimer);
        fail(typeof data.message === 'string' ? data.message.slice(0, 300) : 'error');
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      finished = true;
      afterLoad.current = null;
      clearTimeout(readyTimer);
      clearTimeout(loadReadyTimer);
      clearTimeout(renderTimer);
      window.removeEventListener('message', onMessage);
    };
    // The frame is rebuilt (new srcDoc) whenever inputs change; theme is applied at render.
  }, [srcDoc, kind, spec, isDarkMode]);

  // Counted here, not in the effect, so no load can slip past before the effect attaches.
  const onLoad = useCallback(() => {
    loadCount.current += 1;
    if (loadCount.current > 1) {
      setNavigated(true);
      callbacks.current.onError('navigated');
      return;
    }
    afterLoad.current?.();
  }, []);
  // A new iframe element (theme remount) starts its own count.
  const attachFrame = useCallback((el: HTMLIFrameElement | null) => {
    frameRef.current = el;
    if (el) loadCount.current = 0;
  }, []);

  if (navigated) return null;

  if (!srcDoc) {
    return <div className="animate-pulse rounded-md bg-muted/40" style={{ height }} aria-hidden="true" />;
  }

  return (
    <iframe
      // Remounting on theme change re-renders the chart in the new palette.
      key={isDarkMode ? 'dark' : 'light'}
      ref={attachFrame}
      title={t('richBlock.render', { defaultValue: 'Render' }) + ` (${kind})`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={onLoad}
      loading="eager"
      className="block w-full rounded-md border-0"
      style={{ height, colorScheme: isDarkMode ? 'dark' : 'light' }}
    />
  );
}
