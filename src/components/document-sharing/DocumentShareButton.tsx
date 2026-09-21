import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Link2, ShieldCheck } from 'lucide-react';

import { useAuth } from '../auth/context/AuthContext';
import { Dialog, DialogContent, DialogTitle, DialogTrigger, useDialog } from '../../shared/view/ui/Dialog';

import { useSharingCopy } from './copy';
import { pageAssetScope, validCreatedShareUrl } from './share-contract';

type Share = { id: string; relativePath: string; audience: 'members' | 'client'; expiresAt: string | null; revokedAt: string | null; sourceMissing?: boolean };
type CopyText = ReturnType<typeof useSharingCopy>;
const control = 'min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50';

/** The server remains authoritative; this only avoids offering unsupported file formats. */
function shareableFileName(filePath: string) {
  return /\.(?:pdf|docx|xlsx|txt|md|csv|html?|xhtml)$/i.test(filePath);
}

function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ShareRow({ row, copy, busy, onRevoke, onSave }: {
  row: Share; copy: CopyText; busy: boolean;
  onRevoke: () => void; onSave: (relativePath: string, expiresAt: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [relativePath, setRelativePath] = useState(row.relativePath);
  const [expiresAt, setExpiresAt] = useState(localDate(row.expiresAt));
  const fieldId = useId();
  const inactive = Boolean(row.revokedAt || row.sourceMissing) || Boolean(row.expiresAt && Date.parse(row.expiresAt) <= Date.now());
  return <li className="space-y-3 rounded-md border border-border p-3">
    <p className="break-words text-sm font-medium"><bdi>{row.relativePath}</bdi></p>
    <p className="text-sm text-muted-foreground">{row.audience === 'members' ? copy.members : copy.client} · {row.revokedAt ? copy.revoked : row.sourceMissing ? copy.unavailable : inactive ? copy.expired : copy.active}</p>
    <div className="flex flex-wrap gap-2">
      {!row.revokedAt && <>
        <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-3 text-sm focus-visible:outline focus-visible:outline-ring" onClick={() => setEditing(!editing)}>{copy.edit}</button>
        <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-3 text-sm focus-visible:outline focus-visible:outline-ring" onClick={onRevoke}>{copy.revoke}</button>
      </>}
      {row.audience === 'members' && !inactive && <a className="flex min-h-11 items-center rounded-md px-3 text-sm underline" href={`/share/members/${row.id}`} target="_blank" rel="noreferrer">{copy.share}</a>}
    </div>
    {editing && !row.revokedAt && <div className="space-y-2">
      <label htmlFor={`${fieldId}-path`} className="block text-sm">{copy.path}</label>
      <input id={`${fieldId}-path`} className={control} value={relativePath} onChange={(event) => setRelativePath(event.target.value)} />
      <p className="text-sm text-muted-foreground">{copy.pathHint}</p>
      {pageAssetScope(relativePath) && <p className="text-sm text-muted-foreground">{copy.assetScope}: <bdi>{pageAssetScope(relativePath)}/</bdi>. {copy.previewLimit}</p>}
      <label htmlFor={`${fieldId}-expiry`} className="block text-sm">{copy.expires}</label>
      <input id={`${fieldId}-expiry`} className={control} type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      <button type="button" disabled={busy} className={action} onClick={() => onSave(relativePath, expiresAt)}>{busy ? copy.saving : copy.save}</button>
    </div>}
  </li>;
}

/** File-scoped entry point with project-wide revoke/relink management for administrators. */
export default function DocumentShareButton({ projectId, filePath, showLabel = false }: { projectId?: string; filePath: string; showLabel?: boolean }) {
  const { user, token } = useAuth();
  const copy = useSharingCopy();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const canManage = Boolean(token && user && ['owner', 'admin'].includes(user.role ?? ''));
  if (!projectId || !canManage || !shareableFileName(filePath)) return null;
  return <Dialog open={open} onOpenChange={(value) => {
    setOpen(value);
    if (!value) requestAnimationFrame(() => trigger.current?.focus());
  }}>
    <DialogTrigger ref={trigger} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-ring" title={copy.share} aria-label={copy.share}>
      <Link2 className="h-4 w-4" aria-hidden="true" />
      {showLabel && <span className="px-2 text-sm">{copy.share}</span>}
    </DialogTrigger>
    {open && <ShareManager key={`${projectId}:${filePath}:${user?.id}:${token}`} projectId={projectId} filePath={filePath} token={token!} copy={copy} />}
  </Dialog>;
}

type ShareListState = ReturnType<typeof useShareList>;

function useShareList(base: string, token: string, filePath: string, failure: string) {
  const [shares, setShares] = useState<Share[]>([]);
  const [relativePath, setRelativePath] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReady(false); setError('');
    void fetch(base, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(async (response) => {
        if (!response.ok) throw new Error('failed');
        const payload = await response.json();
        if (controller.signal.aborted) return;
        setShares(payload.shares);
        const prefix = `${payload.projectPath}/`;
        setRelativePath(filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath);
        setReady(true);
      }).catch(() => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [base, token, filePath, revision, failure]);
  return { shares, relativePath, ready, error, setError, setRevision };
}

function useShareMutations(base: string, token: string, copy: CopyText, list: ShareListState) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);
  const mutate = async (suffix: string, method: string, body?: object) => {
    if (inFlight.current) return;
    inFlight.current = true;
    request.current = new AbortController();
    setBusy(true); list.setError('');
    try {
      const response = await fetch(base + suffix, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: request.current.signal, cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!active.current) return;
      if (!response.ok) { list.setError(response.status === 400 ? copy.invalid : copy.failed); return; }
      if (response.status !== 204) {
        const payload = await response.json();
        if (!active.current) return;
        if (method === 'POST' && !suffix) {
          if (!validCreatedShareUrl(payload.shareUrl, window.location.origin)) throw new Error('invalid_response');
          setLink(payload.shareUrl);
          try { await navigator.clipboard.writeText(payload.shareUrl); setCopyStatus(copy.copied); }
          catch { setCopyStatus(copy.copyFailed); }
        }
      }
      if (method !== 'POST' || suffix) setLink('');
      list.setRevision((value) => value + 1);
    } catch { if (active.current) list.setError(method === 'POST' && !suffix ? copy.uncertain : copy.failed); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return { link, busy, mutate, copyStatus };
}

function expiryValue(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('invalid');
  return date.toISOString();
}

type CreationFormProps = {
  copy: CopyText; audience: 'members' | 'client'; setAudience: (value: 'members' | 'client') => void;
  expiresAt: string; setExpiresAt: (value: string) => void; busy: boolean; list: ShareListState; create: () => void;
};

function ShareCreationForm({ copy, audience, setAudience, expiresAt, setExpiresAt, busy, list, create }: CreationFormProps) {
  const id = useId();
  return <>
    <fieldset className="space-y-2" disabled={busy}>
      <legend className="mb-2 text-sm font-medium">{copy.audience}</legend>
      {(['members', 'client'] as const).map((kind) => <label key={kind} className="flex min-h-11 items-center gap-3 rounded-md border border-border p-3">
        <input type="radio" name={`${id}-audience`} value={kind} checked={audience === kind} onChange={() => setAudience(kind)} />
        <span>{kind === 'members' ? copy.members : copy.client}</span>
      </label>)}
    </fieldset>
    <p className="text-sm text-muted-foreground">{audience === 'members' ? copy.membersHint : copy.bearer}</p>
    <div className="space-y-2">
      <label htmlFor={`${id}-expires`} className="block text-sm font-medium">{copy.expires}</label>
      <input id={`${id}-expires`} className={control} type="datetime-local" value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} />
      {!expiresAt && <p className="text-sm text-muted-foreground">{copy.noExpiry}</p>}
    </div>
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" /><p>{copy.warning}</p>
    </div>
    <p className="text-sm text-muted-foreground">{copy.size}</p>
    {list.error && <p role="alert" className="text-sm text-destructive">{list.error}</p>}
    {!list.ready && list.error && <button type="button" className={action} onClick={() => list.setRevision((value) => value + 1)}>{copy.retry}</button>}
    <button type="button" className={`${action} w-full`} disabled={busy || !list.ready} onClick={create}>{busy ? copy.creating : copy.create}</button>
  </>;
}

function CreatedShareLink({ link, copy, status }: { link: string; copy: CopyText; status: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setCopied(false); } // The selectable field supports browsers without clipboard permission.
  };
  return <div className="space-y-2 rounded-md border border-border p-3" role="status">
    <label htmlFor={id} className="block text-sm font-medium">{copy.created}</label>
    <input id={id} className={control} dir="ltr" style={{ unicodeBidi: 'isolate' }} readOnly value={link} onFocus={(event) => event.target.select()} />
    <p aria-live="polite" className="text-sm">{copied ? copy.copied : status}</p>
    <button type="button" className={action} onClick={() => void copyLink()}><Copy className="h-4 w-4" aria-hidden="true" />{copied ? copy.copied : copy.copy}</button>
    {link.includes('#token=') && <p className="text-sm text-muted-foreground">{copy.oneTime}</p>}
  </div>;
}

function ShareManager({ projectId, filePath, token, copy }: { projectId: string; filePath: string; token: string; copy: CopyText }) {
  const { onOpenChange } = useDialog();
  const [audience, setAudience] = useState<'members' | 'client'>('members');
  const [expiresAt, setExpiresAt] = useState('');
  const id = useId();
  const base = `/api/projects/${encodeURIComponent(projectId)}/document-shares`;
  const list = useShareList(base, token, filePath, copy.failed);
  const { link, busy, mutate, copyStatus } = useShareMutations(base, token, copy, list);
  const save = (suffix: string, method: string, value: string, date: string) => {
    try { void mutate(suffix, method, { relativePath: value, expiresAt: expiryValue(date), ...(method === 'POST' ? { audience } : {}) }); }
    catch { list.setError(copy.invalid); }
  };
  // The existing full-screen editor is z-9999; the nested dialog sits immediately above it.
  return <DialogContent data-document-share-dialog layerClassName="z-[10000]" aria-labelledby={`${id}-title`} className="max-h-[85dvh] max-w-lg overflow-y-auto p-6 text-start">
    <DialogTitle id={`${id}-title`} className="not-sr-only text-xl font-semibold">{copy.share}</DialogTitle>
    <div className="mt-4 space-y-4">
      <p className="break-words text-sm text-muted-foreground">{copy.path}: <bdi>{list.relativePath || filePath}</bdi></p>
      {pageAssetScope(list.relativePath || filePath) && <p className="text-sm text-muted-foreground">{copy.assetScope}: <bdi>{pageAssetScope(list.relativePath || filePath)}/</bdi>. {copy.previewLimit}</p>}
      <ShareCreationForm copy={copy} audience={audience} setAudience={setAudience} expiresAt={expiresAt} setExpiresAt={setExpiresAt}
        busy={busy} list={list} create={() => save('', 'POST', list.relativePath, expiresAt)} />
      {link && <CreatedShareLink key={link} link={link} copy={copy} status={copyStatus} />}
      <h3 className="border-t border-border pt-4 text-base font-semibold">{copy.existing}</h3>
      {list.ready && list.shares.length === 0 && <p className="text-sm text-muted-foreground">{copy.none}</p>}
      <ul className="space-y-3">{list.shares.map((row) => <ShareRow key={`${row.id}-${row.relativePath}-${row.expiresAt}`} row={row} copy={copy} busy={busy}
        onRevoke={() => void mutate(`/${row.id}/revoke`, 'POST')}
        onSave={(value, date) => save(`/${row.id}`, 'PATCH', value, date)} />)}</ul>
      <button type="button" className="min-h-11 w-full rounded-md border border-border px-4 text-sm" onClick={() => onOpenChange(false)}>{copy.close}</button>
    </div>
  </DialogContent>;
}
