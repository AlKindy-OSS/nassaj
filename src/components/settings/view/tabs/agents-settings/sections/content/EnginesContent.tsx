import { useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Lock, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../../shared/view/ui';
import { useProviderApiKey } from '../../../../../../provider-auth/hooks/useProviderApiKey';
import { VENDOR_PROVIDER_META, type VendorProvider } from '../../../../../../provider-auth/vendorProviders';
import {
  ENGINE_AXIS_HOST,
  ENGINE_AXIS_LABEL,
  bodyEngineCells,
  engineHasStorableKey,
  type BodyEngineCell,
  type BodyEngineStatus,
} from '../../../../../../../../shared/bodyEngineMatrix';
import type { AgentProvider } from '../../../../../types/types';

/**
 * EnginesContent — the ENGINE axis, rendered inside the body it belongs to.
 *
 * It replaces the top-level "Engines" tab. That tab was right about the axis and
 * wrong about the place: it listed engines as a flat catalogue with no body in
 * sight, next to an Agents tab that listed bodies with no engine in sight, so the
 * one question the two axes exist to answer — *what can THIS agent actually run
 * on?* — was asked by neither and had to be reassembled by the reader. Two tabs,
 * each holding half of one fact.
 *
 * The axes are still not merged; the ORDER of the questions is. You open an agent
 * (a body: its CLI, tools, permissions, sessions) and its engines are one of its
 * tabs, the way its permissions are. An engine is still not a body and never
 * appears in the agent bar — the confusion the 2026-07-26 fold removed does not
 * come back.
 *
 * Three rules this panel keeps, inherited from the surface it replaces:
 *
 *   1. It names the ENDPOINT each engine is really called on. Z.AI's own guide
 *      sells the opposite ("see a Claude model in the UI while GLM answers"); a
 *      tool whose whole job is knowing which vendor ran your prompt may never be
 *      coy about it.
 *   2. It claims only what the key store can back — "a key is stored", never
 *      "connected". Whether a key is valid is known only from a run.
 *   3. It shows a cell's EVIDENCE (ADR-073): measured on this machine, or merely
 *      inferred from a vendor's documentation. A pair that has never been run is
 *      labelled unverified rather than quietly rendered like one that has.
 *
 * SCOPE — this panel adds no capability. It states the matrix and stores keys,
 * exactly as the tab it replaces did. Choosing an engine for a run still happens
 * only in the chat model picker, and still only for bodies that already had it.
 * ADR-073 §4 forbids launching a non-Claude body on a custom engine before that
 * body's config guard exists, and nothing here crosses that line.
 */
export default function EnginesContent({ agent }: { agent: AgentProvider }) {
  const { t } = useTranslation('settings');
  const cells = bodyEngineCells(agent);

  if (cells.length === 0) {
    return null;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {t('engines.title', { defaultValue: 'Engines' })}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('engines.description', {
            defaultValue:
              'An engine is the endpoint that generates the tokens. The agent system (body) — its tools, permissions and sessions — stays exactly the same; only the model provider behind it changes.',
          })}
        </p>
        <EngineSwitchHint agent={agent} />
      </div>

      <div className="space-y-3">
        {cells.map((cell) => (
          <EngineRow key={`${agent}-${cell.engine}`} cell={cell} />
        ))}
      </div>
    </div>
  );
}

/**
 * Where the switch is actually made, for the bodies where it is user-reachable
 * today. Silent for the rest: inventing a "how to" for a path that does not
 * exist is the same lie as a green badge on an untested one.
 */
function EngineSwitchHint({ agent }: { agent: AgentProvider }) {
  const { t } = useTranslation('settings');

  if (agent === 'claude') {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {t('engines.usageHint', {
          defaultValue:
            'Once a key is stored, pick "Claude engine on <engine>" from the model picker in a chat. The chat shows which engine it is running on.',
        })}
      </p>
    );
  }

  if (agent === 'opencode') {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {t('engines.usageHintOpenCode', {
          defaultValue:
            'Once a key is stored, pick the engine\'s model (for example a "glm/…" entry) from the model picker in a chat.',
        })}
      </p>
    );
  }

  return null;
}

/** Badge palette per status. Green is spent only on a pair that actually runs. */
const STATUS_CLASS: Record<BodyEngineStatus, string> = {
  native: 'bg-green-500/10 text-green-600 dark:text-green-400',
  available: 'bg-green-500/10 text-green-600 dark:text-green-400',
  blocked_by_owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  blocked_by_us: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  closed_at_vendor: 'bg-muted text-muted-foreground',
  unverified: 'bg-muted text-muted-foreground',
};

function EngineRow({ cell }: { cell: BodyEngineCell }) {
  const { t } = useTranslation('settings');
  const name = ENGINE_AXIS_LABEL[cell.engine];
  const host = ENGINE_AXIS_HOST[cell.engine];

  const statusLabel = t(`engines.status.${cell.status}`, {
    defaultValue: {
      native: 'Its own engine',
      available: 'Runs today',
      blocked_by_owner: 'Needs a key',
      blocked_by_us: 'Not landed yet',
      closed_at_vendor: 'Not offered by the vendor',
      unverified: 'Unverified',
    }[cell.status],
  });

  const evidenceLabel = cell.evidence === 'none'
    ? null
    : t(`engines.evidence.${cell.evidence}`, {
      defaultValue: cell.evidence === 'measured' ? 'measured' : 'inferred',
    });

  // The key entry appears only where a key is THE actual remaining barrier and
  // this app is the thing that stores it.
  //
  // `blocked_by_us` is deliberately excluded even though those engines do have a
  // storable key: the barrier there is our own unlanded code (the Kimi body's
  // config guard) or an owner decision not to enable the engine at all
  // (DeepSeek). A key box on such a cell invites the operator to pay for a key,
  // store it, and watch nothing change — the "I entered the key and it did not
  // work" confusion the design doc names as a direct cost of scattered key
  // surfaces. The store is one per user (ADR-073 §5), so the key is still
  // enterable wherever that engine is actually usable.
  const wantsKey =
    engineHasStorableKey(cell.engine)
    && (cell.status === 'available' || cell.status === 'blocked_by_owner');

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-foreground">{name}</span>
        {host && (
          <span
            className="font-mono text-xs text-muted-foreground"
            title={t('engines.endpointLabel', {
              defaultValue: 'Endpoint this engine is called on',
            })}
          >
            {host}
          </span>
        )}
        {evidenceLabel && (
          <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {evidenceLabel}
          </span>
        )}
        <span className={`ms-auto rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[cell.status]}`}>
          {statusLabel}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        {t(`engines.cell.${cell.note}`, { defaultValue: cell.noteDefault })}
      </p>

      {wantsKey ? (
        <EngineKeyEntry engine={cell.engine as VendorProvider} name={name} />
      ) : null}
    </section>
  );
}

/**
 * Key entry for one engine. Unchanged in behaviour from the standalone tab: one
 * encrypted per-user record, write-only, existence reported and never the value.
 */
function EngineKeyEntry({ engine, name }: { engine: VendorProvider; name: string }) {
  const { t } = useTranslation('settings');
  const apiKeyUrl = VENDOR_PROVIDER_META[engine]?.apiKeyUrl;
  const { configured, loading, saving, error, saveKey, deleteKey } = useProviderApiKey(engine);

  const [draftKey, setDraftKey] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const inputId = `engine-api-key-${engine}`;

  const handleSave = async () => {
    setFeedback(null);
    const result = await saveKey(draftKey);
    if (result.success) {
      setDraftKey('');
      setFeedback(t('engines.saved', { defaultValue: 'Engine key saved.' }));
    }
  };

  const handleDelete = async () => {
    setFeedback(null);
    const result = await deleteKey();
    if (result.success) {
      setFeedback(t('engines.removed', { defaultValue: 'Engine key removed.' }));
    }
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        {configured ? (
          <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {loading
          ? t('engines.status.checking', { defaultValue: 'Checking…' })
          : configured
            ? t('engines.status.stored', { defaultValue: 'A key is stored' })
            : t('engines.status.missing', { defaultValue: 'No key stored' })}
        {typeof apiKeyUrl === 'string' && !configured && (
          <a
            href={apiKeyUrl}
            target="_blank"
            rel="noreferrer"
            className="ms-1 inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('engines.getKey', { defaultValue: 'Get a key' })}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <label className="sr-only" htmlFor={inputId}>
        {t('engines.inputLabel', { provider: name, defaultValue: '{{provider}} API key' })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draftKey}
          disabled={saving || loading}
          onChange={(event) => setDraftKey(event.target.value)}
          placeholder={
            configured
              ? t('engines.placeholderConfigured', { defaultValue: '•••••••• (a key is stored)' })
              : t('engines.placeholder', { defaultValue: 'Paste API key' })
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || loading || draftKey.trim().length === 0}
          aria-label={t('engines.save', { provider: name, defaultValue: 'Save {{provider}} key' })}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          <span className="ms-1.5">{t('engines.saveShort', { defaultValue: 'Save' })}</span>
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDelete}
            disabled={saving || loading}
            aria-label={t('engines.remove', { provider: name, defaultValue: 'Remove {{provider}} key' })}
            className="text-red-600 hover:text-red-700 dark:text-red-400"
          >
            <Trash2 className="h-4 w-4" />
            <span className="ms-1.5">{t('engines.removeShort', { defaultValue: 'Remove' })}</span>
          </Button>
        )}
      </div>

      <div className="mt-2 min-h-5 text-sm" aria-live="polite">
        {error ? (
          <span className="text-red-600 dark:text-red-400">{error}</span>
        ) : feedback ? (
          <span className="text-green-600 dark:text-green-400">{feedback}</span>
        ) : configured ? (
          <span className="text-muted-foreground">
            {t('engines.storedNote', {
              defaultValue: 'Stored encrypted for your account only. Replace it by saving a new one.',
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
