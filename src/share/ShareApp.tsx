import { useCallback, useEffect, useMemo, useState } from 'react';

import { pickLocale, type ViewerStrings } from './i18n';
import { createLiveClient } from './liveClient';
import { loadShare, type LoadResult, type ShareCredentials } from './loadShare';
import { LiveViewer } from './LiveViewer';
import { ShareTranscript } from './ShareTranscript';
import type { LiveMeta } from './types';
import './share.css';

type ViewState = { kind: 'loading' } | { kind: 'live'; meta: LiveMeta } | LoadResult;

function StatusPage({ strings, state, onRetry }: { strings: ViewerStrings; state: Exclude<ViewState, { kind: 'live' }>; onRetry: () => void }) {
  if (state.kind === 'loading') {
    return (
      <main className="share-page share-status" role="status">
        <p>{strings.loading}</p>
      </main>
    );
  }
  const copy = state.kind === 'rate-limited'
    ? { title: strings.rateLimitedTitle, body: strings.rateLimited }
    : state.kind === 'network'
      ? { title: strings.networkTitle, body: strings.network }
      : { title: strings.unavailableTitle, body: strings.unavailable };
  const retryable = state.kind === 'rate-limited' || state.kind === 'network';
  return (
    <main className="share-page share-status" role="alert">
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      {retryable ? <button type="button" className="share-retry" onClick={onRetry}>{strings.retry}</button> : null}
    </main>
  );
}

/** Public viewer root. `credentials` is null when the link has no usable token. */
export function ShareApp({ credentials, language = navigator.language }: { credentials: ShareCredentials | null; language?: string }) {
  const strings = pickLocale(language);
  const [state, setState] = useState<ViewState>(credentials ? { kind: 'loading' } : { kind: 'unavailable' });
  const [attempt, setAttempt] = useState(0);
  const client = useMemo(() => (credentials ? createLiveClient(credentials) : null), [credentials]);

  useEffect(() => {
    document.documentElement.lang = strings.lang;
    document.documentElement.dir = strings.dir;
  }, [strings]);

  useEffect(() => {
    if (!credentials || !client) return undefined;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      const meta = await client.meta(controller.signal);
      if (controller.signal.aborted) return;
      if (!meta.ok) {
        const { failure } = meta;
        setState(failure.kind === 'rate-limited' ? { kind: 'rate-limited' } : failure.kind === 'temporary' ? { kind: 'network' } : { kind: 'unavailable' });
        return;
      }
      if (meta.value.mode === 'live') { setState({ kind: 'live', meta: meta.value.meta }); return; }
      // Legacy snapshot link: read it through the v1 endpoint.
      const result = await loadShare(credentials);
      if (!controller.signal.aborted) setState(result);
    })();
    return () => controller.abort();
  }, [credentials, client, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const unavailable = useCallback(() => setState({ kind: 'unavailable' }), []);
  if (state.kind === 'live') return client ? <LiveViewer client={client} meta={state.meta} strings={strings} onUnavailable={unavailable} /> : null;
  if (state.kind === 'ready') return <ShareTranscript transcript={state.transcript} strings={strings} />;
  return <StatusPage strings={strings} state={state} onRetry={retry} />;
}
