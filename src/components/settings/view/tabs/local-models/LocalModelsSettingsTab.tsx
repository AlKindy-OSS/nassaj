import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Server } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import { useLocalModels, type LocalServer } from '../../../hooks/useLocalModels';
import SettingsSection from '../../SettingsSection';
import SettingsRow from '../../SettingsRow';
import SettingsToggle from '../../SettingsToggle';

import LocalServerForm from './LocalServerForm';
import LocalServerRow from './LocalServerRow';

type Controller = ReturnType<typeof useLocalModels>;

/** Admin activation records explicit acknowledgement of the current disclosure. */
function Activation({ control }: { control: Controller }) {
  const { t } = useTranslation('settings');
  const [consent, setConsent] = useState(false);
  const feature = control.overview?.feature;
  if (!feature) return null;
  return <SettingsSection title={t('localModels.activation')}>
    <p className="text-[13px] text-muted-foreground">{t('localModels.disclosure')}</p>
    {feature.canManage ? <>
      {!feature.enabled && <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={control.busy} />{t('localModels.consent')}
      </label>}
      <SettingsRow label={t('localModels.enable')}>
        <SettingsToggle checked={feature.enabled} disabled={control.busy || (!feature.enabled && !consent)} ariaLabel={t('localModels.enable')}
          onChange={value => { void control.setEnabled(value).then(ok => { if (ok) setConsent(false); }); }} />
      </SettingsRow>
    </> : <p className="text-sm">{t(feature.enabled ? 'localModels.enabled' : 'localModels.disabled')}</p>}
  </SettingsSection>;
}

/** Loading and request failures remain readable without hiding the navigation entry. */
function Feedback({ control }: { control: Controller }) {
  const { t } = useTranslation('settings');
  return <div className="space-y-2" aria-live="polite" aria-atomic="true">
    {(control.loading || control.busy) && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t(control.busy ? 'localModels.working' : 'localModels.loading')}</p>}
    {control.message && <p className="text-sm text-success">{t(`localModels.${control.message}`)}</p>}
    {control.error && <div className="space-y-2"><p className="text-sm text-danger">{t(`localModels.${control.error}`)}</p>
      {control.error === 'loadFailed' && <Button variant="outline" className="min-h-11" disabled={control.loading || control.busy} onClick={() => { void control.refresh(); }}>{t('localModels.retry')}</Button>}</div>}
  </div>;
}

/** Pages the bounded server endpoint rather than silently dropping extra servers. */
function Pagination({ control }: { control: Controller }) {
  const { t } = useTranslation('settings');
  const { overview, offset, setOffset } = control;
  if (!overview || overview.total <= overview.limit) return null;
  return <div className="flex flex-wrap items-center gap-3">
    <Button variant="outline" disabled={control.loading || control.busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - overview.limit))}>{t('localModels.previous')}</Button>
    <span className="text-sm">{t('localModels.page', { from: offset + 1, to: Math.min(offset + overview.limit, overview.total), total: overview.total })}</span>
    <Button variant="outline" disabled={control.loading || control.busy || offset + overview.limit >= overview.total} onClick={() => setOffset(offset + overview.limit)}>{t('localModels.next')}</Button>
  </div>;
}

/** The local-model settings entry remains visible even while manager activation is off. */
export default function LocalModelsSettingsTab({ onOpenSharing }: { onOpenSharing: () => void }) {
  const { t } = useTranslation('settings');
  const control = useLocalModels();
  const [editing, setEditing] = useState<LocalServer | 'new' | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const opener = useRef<HTMLElement | null>(null);
  const close = () => { setEditing(null); requestAnimationFrame(() => opener.current?.focus()); };
  const open = (server: LocalServer | 'new') => { opener.current = document.activeElement as HTMLElement; setEditing(server); };
  const enabled = control.overview?.feature.enabled ?? false;
  return <div className="space-y-8">
    <SettingsSection icon={Server} level="page" title={t('localModels.title')} description={t('localModels.description')}><Feedback control={control} /></SettingsSection>
    <Activation control={control} />
    {control.overview && <SettingsSection title={t('localModels.servers')}>
      <div className="space-y-4">
        <Button className="min-h-11" disabled={!enabled || control.busy || editing !== null} onClick={() => open('new')}><Plus aria-hidden="true" />{t('localModels.add')}</Button>
        {editing !== null && enabled && <LocalServerForm key={editing === 'new' ? 'new' : editing.id} server={editing === 'new' ? undefined : editing} busy={control.busy} onClose={close}
          onSave={async input => { const ok = await control.save(input, editing === 'new' ? undefined : editing.id); if (ok) setConnected({}); return ok; }} />}
        {control.overview.servers.length === 0 && !control.loading && <p className="text-sm text-muted-foreground">{t('localModels.empty')}</p>}
        {control.overview.servers.map(server => <LocalServerRow key={server.id} server={server} busy={control.busy || editing !== null} enabled={enabled} connected={Boolean(connected[server.id])}
          onEdit={() => open(server)} onRemove={() => control.remove(server.id)}
          onConnect={() => { setConnected(previous => ({ ...previous, [server.id]: false })); void control.connect(server.id).then(ok => { if (ok) setConnected(previous => ({ ...previous, [server.id]: true })); }); }} />)}
        <Pagination control={control} />
        <p className="text-[13px] text-muted-foreground">{t('localModels.sharingDisclosure')}</p>
        <Button variant="link" className="min-h-11 px-0" onClick={onOpenSharing}>{t('localModels.sharing')}</Button>
      </div>
    </SettingsSection>}
  </div>;
}
