import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The neutral "couldn't verify this model's capacity" line of the model-switch
 * context guard (T-2087, ADR-223). Shown at most once per session and model,
 * cleared when the conversation changes or the user dismisses it.
 */
export function useContextFitNotice(sessionId: string | null) {
  const [notice, setNotice] = useState<string | null>(null);
  const shown = useRef(new Set<string>());

  useEffect(() => { setNotice(null); }, [sessionId]);

  /** Shows `line` unless the same `key` (session and model) was already shown. */
  const show = useCallback((key: string, line: string) => {
    if (shown.current.has(key)) return;
    shown.current.add(key);
    setNotice(line);
  }, []);

  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, show, dismiss };
}
