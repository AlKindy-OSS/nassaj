import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Download, FileText, Link2Off, Loader2, LockKeyhole, RefreshCw } from 'lucide-react';

import { useAuth } from '../auth/context/AuthContext';
import AuthScreenLayout from '../auth/view/AuthScreenLayout';

import { useSharingCopy } from './copy';
import { shareLoginPath } from './share-navigation';

type DocumentInfo = { name: string; size: number; modifiedAt: string; downloadPath: string; previewPath?: string; previewScope?: string };
type State = 'loading' | 'unavailable' | 'login' | 'denied' | 'temporary' | 'ready';
const button = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';

/** Map access failures separately from retryable service/network failures. */
function shareResponseState(status: number, members: boolean): State {
  if (status === 401 && members) return 'login';
  if (status === 403 && members) return 'denied';
  return [400, 401, 403, 404, 410].includes(status) ? 'unavailable' : 'temporary';
}

/** Load metadata only after determining the required credential type. */
function useSharedDocument(id: string, members: boolean) {
  const location = useLocation();
  const { user, token, isLoading, logout } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [retry, setRetry] = useState(0);
  const secret = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  const requestKey = `${id}:${members}:${members ? token : secret}:${user?.id ?? ''}`;
  useEffect(() => {
    setDocument(null);
    if (!/^[a-f0-9]{32}$/.test(id)) { setState('unavailable'); return; }
    if (members && isLoading) { setState('loading'); return; }
    if (members && (!user || !token)) { setState('login'); return; }
    if (!members && !/^[A-Za-z0-9_-]{43}$/.test(secret)) { setState('unavailable'); return; }
    const controller = new AbortController();
    setState('loading');
    void fetch(`/api/document-shares/${id}`, { headers: members ? { Authorization: `Bearer ${token}` } : { 'X-Share-Token': secret },
      signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit', redirect: 'error' })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) { setState(shareResponseState(response.status, members)); return; }
        const payload = await response.json();
        if (!payload.document || typeof payload.document.name !== 'string') throw new Error('invalid_response');
        if (!controller.signal.aborted) { setDocument(payload.document); setLoadedKey(requestKey); setState('ready'); }
      }).catch(() => { if (!controller.signal.aborted) setState('temporary'); });
    return () => controller.abort();
  }, [id, members, secret, token, user, isLoading, retry, requestKey]);

  // Never paint the previous recipient's metadata while an effect rechecks a new identity.
  return { state: state === 'ready' && loadedKey !== requestKey ? 'loading' as State : state, setState,
    document: loadedKey === requestKey ? document : null, setDocument, setRetry, user, token, logout, secret };
}

type DocumentAccess = ReturnType<typeof useSharedDocument>;

const PREVIEW_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Fetch only the fixed authenticated preview endpoint, outside conversation state. */
function DocumentPreview({ id, members, access }: { id: string; members: boolean; access: DocumentAccess }) {
  const copy = useSharingCopy();
  const [html, setHtml] = useState('');
  const [warning, setWarning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { token, secret, setState, setDocument } = access;
  useEffect(() => {
    const controller = new AbortController();
    setHtml(''); setWarning(false); setFailed(false);
    void fetch(`/api/document-shares/${id}/preview`, {
      headers: members ? { Authorization: `Bearer ${token}` } : { 'X-Share-Token': secret },
      signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit', redirect: 'error',
    }).then(async response => {
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if ([400, 401, 403, 404, 410].includes(response.status)) {
          setDocument(null); setState(shareResponseState(response.status, members));
        } else setFailed(true);
        return;
      }
      const result = await response.json();
      if (typeof result.html !== 'string' || result.html.length > 36 * 1024 * 1024) throw new Error('invalid_preview');
      if (!controller.signal.aborted) { setHtml(result.html); setWarning(Array.isArray(result.warnings) && result.warnings.length > 0); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id, members, token, secret, retry, setState, setDocument]);
  return <section className="space-y-3" aria-label={copy.preview}>
    <h2 className="text-lg font-medium">{copy.preview}</h2>
    <p className="text-sm text-muted-foreground">{copy.previewLimit}</p>
    {warning && <p role="status" className="text-sm text-muted-foreground">{copy.previewWarning}</p>}
    {failed ? <div role="alert"><p>{copy.previewFailed}</p><button className={button} onClick={() => setRetry(n => n + 1)}>{copy.retry}</button></div>
      : html ? <iframe title={copy.preview} sandbox="" referrerPolicy="no-referrer"
        className="h-[65vh] min-h-80 w-full rounded-md border border-border bg-white"
        srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${html}`} />
        : <p role="status">{copy.loading}</p>}
  </section>;
}

/** Own download cancellation and temporary object-URL cleanup separately from access state. */
function useDocumentDownload(id: string, members: boolean, access: DocumentAccess) {
  const { document, setDocument, setState, token, secret } = access;
  const [downloading, setDownloading] = useState(false);
  const downloads = useRef(new Set<string>());
  const downloadRequest = useRef<AbortController | null>(null);
  const credential = members ? token : secret;
  const requestHeaders = (): HeadersInit => members
    ? { Authorization: `Bearer ${token ?? ''}` } : { 'X-Share-Token': secret };
  useEffect(() => () => {
    downloadRequest.current?.abort();
    for (const url of downloads.current) URL.revokeObjectURL(url);
    downloads.current.clear();
  }, [id, credential]);

  const download = async () => {
    if (!document || downloading) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    try {
      const response = await fetch(`/api/document-shares/${id}/content`, { headers: requestHeaders(),
        signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit', redirect: 'error' });
      if (!response.ok) { setDocument(null); setState(shareResponseState(response.status, members)); return; }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      downloads.current.add(url);
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = document.name; anchor.rel = 'noreferrer'; anchor.click();
      window.setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 10_000);
    } catch { if (!controller.signal.aborted) setState('temporary'); }
    finally { setDownloading(false); }
  };
  return { downloading, download };
}

/** Public document shell; never mounts the private app or WebSocket providers. */
export default function SharedDocumentPage({ members = false }: { members?: boolean }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const copy = useSharingCopy();
  const access = useSharedDocument(id, members);
  const { state, document, setRetry, user, logout } = access;
  const { downloading, download } = useDocumentDownload(id, members, access);
  const signIn = () => {
    if (user) logout();
    navigate(shareLoginPath(`/share/members/${id}`));
  };
  const titles: Record<State, string> = { loading: copy.loading, unavailable: copy.unavailable, login: copy.login,
    denied: copy.denied, temporary: copy.temporary, ready: copy.ready };
  const descriptions: Record<State, string> = { loading: copy.loadingDetail, unavailable: copy.unavailableDetail,
    login: copy.loginDetail, denied: copy.deniedDetail, temporary: copy.temporaryDetail, ready: copy.latest };
  const Icon = state === 'loading' ? Loader2 : state === 'ready' ? FileText : state === 'login' || state === 'denied' ? LockKeyhole : Link2Off;
  return <AuthScreenLayout title={titles[state]} description={descriptions[state]} footerText="" wide={state === 'ready' && Boolean(document?.previewPath)}>
    <div className="space-y-6" aria-live="polite" aria-busy={state === 'loading'}>
      <p className="sr-only">{titles[state]}</p>
      <Icon aria-hidden="true" className={`mx-auto h-10 w-10 text-muted-foreground ${state === 'loading' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      {state === 'ready' && document && <>
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-4 text-start">
          <p className="break-words text-lg font-medium text-foreground"><bdi>{document.name}</bdi></p>
          <p className="text-sm text-muted-foreground">{copy.updated}: <time dateTime={document.modifiedAt}>{new Date(document.modifiedAt).toLocaleString()}</time></p>
          {document.size === 0 && <p className="text-sm text-muted-foreground">{copy.empty}</p>}
        </div>
        {document.previewPath === `/api/document-shares/${id}/preview` && <DocumentPreview key={`${id}:${members ? access.token : access.secret}`} id={id} members={members} access={access} />}
        <button className={button} onClick={() => void download()} disabled={downloading}><Download className="h-4 w-4" aria-hidden="true" />{downloading ? copy.downloading : copy.download}</button>
      </>}
      {(state === 'login' || state === 'denied') && <button className={button} onClick={signIn}>{state === 'denied' ? copy.switchAccount : copy.signIn}</button>}
      {state === 'temporary' && <button className={button} onClick={() => setRetry((value) => value + 1)}><RefreshCw className="h-4 w-4" aria-hidden="true" />{copy.retry}</button>}
      {state !== 'loading' && <Link to="/" className="flex min-h-11 items-center justify-center rounded-md text-sm text-muted-foreground underline underline-offset-4 focus-visible:outline focus-visible:outline-ring">{copy.home}</Link>}
    </div>
  </AuthScreenLayout>;
}
