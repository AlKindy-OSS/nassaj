import { useCallback, useEffect, useState } from 'react';

import { pickLocale, type ViewerStrings } from './i18n';
import { loadShare, type LoadResult, type ShareCredentials } from './loadShare';
import { ShareTranscript } from './ShareTranscript';
import './share.css';

type ViewState = { kind: 'loading' } | LoadResult;

function StatusPage({ strings, state, onRetry }: { strings: ViewerStrings; state: ViewState; onRetry: () => void }) {
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

  useEffect(() => {
    document.documentElement.lang = strings.lang;
    document.documentElement.dir = strings.dir;
  }, [strings]);

  useEffect(() => {
    if (!credentials) return undefined;
    let current = true;
    setState({ kind: 'loading' });
    loadShare(credentials).then((result) => { if (current) setState(result); });
    return () => { current = false; };
  }, [credentials, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  if (state.kind === 'ready') return <ShareTranscript transcript={state.transcript} strings={strings} />;
  return <StatusPage strings={strings} state={state} onRetry={retry} />;
}
