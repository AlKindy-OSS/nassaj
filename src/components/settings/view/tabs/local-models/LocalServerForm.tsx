import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';

import { Button, Input } from '../../../../../shared/view/ui';
import { LOCAL_RUNTIMES, type LocalModel, type LocalRuntime, type LocalServer, type LocalServerInput } from '../../../hooks/useLocalModels';

type Props = { server?: LocalServer; busy: boolean; onSave: (input: LocalServerInput) => Promise<boolean>; onClose: () => void };

/** Associates every form control with a visible label and optional guidance. */
function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-2 text-sm text-foreground">
    <span className="font-medium">{title}</span>{children}
    {hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
  </label>;
}

/** Edits one manually configured model; unknown limits stay absent. */
function ModelFields({ model, onChange, onRemove }: { model: LocalModel; onChange: (model: LocalModel) => void; onRemove: () => void }) {
  const { t } = useTranslation('settings');
  const sizeField = (field: 'contextWindow' | 'maxOutput') => <Field title={t(`localModels.${field}`)}>
    <Input dir="ltr" type="number" min={1} max={field === 'maxOutput' ? model.contextWindow ?? 2097152 : 2097152} step={1}
      value={model[field] ?? ''} placeholder={t('localModels.unknown')}
      onChange={event => onChange({ ...model, [field]: event.target.value ? Number(event.target.value) : undefined })} />
  </Field>;
  return <div className="space-y-3 rounded-lg border border-border p-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field title={t('localModels.modelId')}><Input dir="ltr" required maxLength={200} value={model.id} onChange={event => onChange({ ...model, id: event.target.value })} /></Field>
      <Field title={t('localModels.modelName')}><Input dir="inherit" maxLength={160} value={model.name ?? ''} onChange={event => onChange({ ...model, name: event.target.value || undefined })} /></Field>
      {sizeField('contextWindow')}{sizeField('maxOutput')}
    </div>
    <Button type="button" variant="ghost" className="min-h-11 text-danger" onClick={onRemove}><Trash2 aria-hidden="true" />{t('localModels.removeModel')}</Button>
  </div>;
}

/** Collects connection fields without sending credentials until the explicit save. */
function ConnectionFields({ value, change, hasApiKey }: { value: LocalServerInput; change: (value: LocalServerInput) => void; hasApiKey: boolean }) {
  const { t } = useTranslation('settings');
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field title={t('localModels.name')}><Input autoFocus dir="inherit" required maxLength={100} value={value.name} onChange={e => change({ ...value, name: e.target.value })} /></Field>
      <Field title={t('localModels.runtime')}><select value={value.runtime} onChange={e => change({ ...value, runtime: e.target.value as LocalRuntime })}
        className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {Object.entries(LOCAL_RUNTIMES).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
      </select></Field>
    </div>
    <Field title={t('localModels.baseUrl')} hint={t('localModels.urlHint')}><Input dir="ltr" type="url" required maxLength={2048} placeholder="http://localhost:11434/v1" value={value.baseUrl} onChange={e => change({ ...value, baseUrl: e.target.value })} /></Field>
    <Field title={t('localModels.apiKey')} hint={hasApiKey ? t('localModels.keepKey') : t('localModels.optionalKey')}>
      <Input dir="ltr" type="password" autoComplete="new-password" maxLength={4096} disabled={value.removeApiKey} value={value.apiKey ?? ''} onChange={e => change({ ...value, apiKey: e.target.value })} />
    </Field>
    {hasApiKey && <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" checked={Boolean(value.removeApiKey)} onChange={e => change({ ...value, removeApiKey: e.target.checked, apiKey: '' })} />{t('localModels.removeKey')}
    </label>}
  </div>;
}

/** Saves a server independently of connection testing, retaining input after errors. */
export default function LocalServerForm({ server, busy, onSave, onClose }: Props) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  const [value, setValue] = useState<LocalServerInput>({ name: server?.name ?? '', baseUrl: server?.baseUrl ?? '', runtime: server?.runtime ?? 'ollama', models: server?.models ?? [] });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = { ...value, name: value.name.trim(), baseUrl: value.baseUrl.trim(), models: value.models.map(model => ({ ...model, id: model.id.trim(), name: model.name?.trim() || undefined })) };
    if (await onSave(input)) onClose();
  };
  return <form onSubmit={event => { void submit(event); }} aria-labelledby={titleId} className="space-y-4 rounded-lg border border-border p-4">
    <h3 id={titleId} className="text-lg font-semibold">{t(server ? 'localModels.edit' : 'localModels.add')}</h3>
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <ConnectionFields value={value} change={setValue} hasApiKey={Boolean(server?.hasApiKey)} />
      <h4 className="font-medium">{t('localModels.models')}</h4>
      <p className="text-[13px] text-muted-foreground">{t('localModels.manualHint')}</p>
      {value.models.map((model, index) => <ModelFields key={index} model={model}
        onChange={updated => setValue({ ...value, models: value.models.map((row, i) => i === index ? updated : row) })}
        onRemove={() => setValue({ ...value, models: value.models.filter((_, i) => i !== index) })} />)}
      <Button type="button" variant="outline" className="min-h-11" disabled={value.models.length >= 200} onClick={() => setValue({ ...value, models: [...value.models, { id: '' }] })}><Plus aria-hidden="true" />{t('localModels.addModel')}</Button>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11">{t(busy ? 'localModels.saving' : 'localModels.save')}</Button>
        <Button type="button" variant="ghost" className="min-h-11" onClick={onClose}>{t('localModels.cancel')}</Button>
      </div>
    </fieldset>
  </form>;
}
