import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plug, Trash2 } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import { LOCAL_RUNTIMES, type LocalServer } from '../../../hooks/useLocalModels';

type Props = { server: LocalServer; busy: boolean; enabled: boolean; connected: boolean; onEdit: () => void; onConnect: () => void; onRemove: () => Promise<boolean> };

/** Displays configured models without inventing unreported capabilities or context. */
function ModelList({ server }: { server: LocalServer }) {
  const { t } = useTranslation('settings');
  return <details className="text-sm">
    <summary className="min-h-11 cursor-pointer py-3 font-medium">{t('localModels.models')} ({server.models.length})</summary>
    {server.models.length === 0 ? <p className="text-muted-foreground">{t(server.owned ? 'localModels.noModels' : 'localModels.noSharedModels')}</p> :
      <ul className="space-y-3">{server.models.map(model => <li key={model.id} className="space-y-1">
        <p className="break-words"><bdi dir="ltr">{model.id}</bdi>{model.name && <span> · {model.name}</span>}</p>
        <p className="text-[13px] text-muted-foreground">{t('localModels.contextWindow')}: {model.contextWindow ?? t('localModels.unknown')} · {t('localModels.maxOutput')}: {model.maxOutput ?? t('localModels.unknown')}</p>
      </li>)}</ul>}
  </details>;
}

/** Shows ownership, saved configuration and an explicit destructive confirmation. */
export default function LocalServerRow({ server, busy, enabled, connected, onEdit, onConnect, onRemove }: Props) {
  const { t } = useTranslation('settings');
  const [confirming, setConfirming] = useState(false);
  return <article className="space-y-3 py-3" aria-label={server.name}>
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-medium">{server.name}</h3><span className="text-[13px] text-muted-foreground">{LOCAL_RUNTIMES[server.runtime]}</span></div>
    <p className="break-all text-sm"><bdi dir="ltr">{server.baseUrl}</bdi></p>
    <p className="text-[13px] text-muted-foreground">{t(connected ? 'localModels.connected' : 'localModels.unchecked')} · {t(server.hasApiKey ? 'localModels.keySaved' : 'localModels.noKey')}</p>
    {!server.owned && <p className="text-[13px] text-muted-foreground">{t('localModels.sharedBy', { owner: server.ownerId })}</p>}
    <ModelList server={server} />
    {server.owned && <div className="flex flex-wrap gap-2">
      <Button variant="outline" className="min-h-11" disabled={busy || !enabled} onClick={onEdit}><Pencil aria-hidden="true" />{t('localModels.edit')}</Button>
      <Button variant="outline" className="min-h-11" disabled={busy || !enabled} onClick={onConnect}><Plug aria-hidden="true" />{t('localModels.test')}</Button>
      <Button variant="ghost" className="min-h-11 text-danger" disabled={busy} onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" />{t('localModels.delete')}</Button>
    </div>}
    {confirming && <div className="space-y-3 rounded-lg border border-danger/30 bg-danger/10 p-4" role="group" aria-label={t('localModels.delete')}>
      <p className="text-sm">{t('localModels.deleteConfirm', { name: server.name })}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" className="min-h-11" disabled={busy} onClick={() => { void onRemove().then(ok => { if (ok) setConfirming(false); }); }}>{t('localModels.delete')}</Button>
        <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => setConfirming(false)}>{t('localModels.cancel')}</Button>
      </div>
    </div>}
  </article>;
}
