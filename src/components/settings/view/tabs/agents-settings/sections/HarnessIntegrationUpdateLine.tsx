import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { HarnessIntegrationUpdate } from '../../../../../../../shared/harness-update.contract';
import { Button } from '../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../utils/api';

/**
 * T-2091: the reasons a staged dsh update can be held, each with plain ar/en
 * copy under `harnessVersion.integrationUpdate.code.<code>`. An unlisted code
 * reads as a generic "a check before switching failed" — never the raw code.
 */
export const INTEGRATION_UPDATE_CODES: ReadonlySet<string> = new Set([
  'dsh_update_held_disk',
  'dsh_update_busy',
  'dsh_update_version_not_pinned',
  'dsh_update_channel_mismatch',
  'dsh_update_install_failed',
  'dsh_update_contract_failed',
  'dsh_update_registry_unavailable',
  'dsh_plugin_engines_incompatible',
  'dsh_tool_lost',
  'dsh_tool_schema_changed',
  'dsh_cap_security_rows',
  'dsh_contract_conformance_failed',
  'dsh_contract_test_layer_invalid',
  'dsh_update_too_new',
  'dsh_update_signature_failed',
  'dsh_update_interrupted',
]);

const CLEAR_ROUTE = '/api/providers/dsh/integration-hold/clear';
type ClearOutcome = 'idle' | 'pending' | 'cleared' | 'failed';

/** Owner-only clear of a held candidate (rate-limited server-side); reports its outcome. */
function useClearHold(version: string | null, onCleared?: () => void) {
  const [outcome, setOutcome] = useState<ClearOutcome>('idle');
  const clear = async () => {
    setOutcome('pending');
    try {
      const response = await authenticatedFetch(CLEAR_ROUTE, {
        method: 'POST', body: JSON.stringify(version ? { version } : {}),
      });
      const body = response.ok ? await response.json() as { cleared?: unknown } : null;
      const cleared = body?.cleared === true;
      setOutcome(cleared ? 'cleared' : 'failed');
      if (cleared) onCleared?.();
    } catch {
      setOutcome('failed');
    }
  };
  return { outcome, clear };
}

type LineProps = {
  update: HarnessIntegrationUpdate | undefined;
  /** Only the owner may clear a hold; members see the status alone. */
  isOwner?: boolean;
  /** Called after a successful clear, e.g. to re-read the version status. */
  onCleared?: () => void;
};

/** A version token isolated inside the sentence. */
const Version = ({ value }: { value: string }) => <bdi dir="ltr" className="font-mono">{value}</bdi>;

/**
 * One status line for the dsh update pipeline at the harness update control:
 * checking the candidate, held (with the plain reason; the current version
 * keeps working), switched, or rolled back. Nothing for `installed` or absent.
 */
export default function HarnessIntegrationUpdateLine({ update, isOwner = false, onCleared }: LineProps) {
  const { t } = useTranslation('settings');
  const { outcome, clear } = useClearHold(update?.candidateVersion ?? null, onCleared);
  if (!update || update.state === 'installed') return null;
  const canClear = isOwner && update.state === 'held' && update.clearable === true;
  const candidate = update.candidateVersion;
  const reason = update.code && INTEGRATION_UPDATE_CODES.has(update.code)
    ? t(`harnessVersion.integrationUpdate.code.${update.code}`)
    : t('harnessVersion.integrationUpdate.codeUnknown');

  const line = (
    <p data-testid="harness-integration-update" aria-live="polite" className="text-[13px] leading-relaxed text-foreground">
      {update.state === 'checking' && (
        <>
          {t('harnessVersion.integrationUpdate.checking')}
          {candidate && <>{' '}<Version value={candidate} /></>}
        </>
      )}
      {update.state === 'held' && (
        <>
          {t('harnessVersion.integrationUpdate.held')}{' '}
          {reason}{' '}
          {t('harnessVersion.integrationUpdate.keepsWorking')}
        </>
      )}
      {update.state === 'switched' && (
        <>
          {t('harnessVersion.integrationUpdate.switched')}
          {candidate && <>{' '}<Version value={candidate} /></>}
        </>
      )}
      {update.state === 'rolled_back' && t('harnessVersion.integrationUpdate.rolledBack')}
    </p>
  );
  if (!canClear) return line;
  return (
    <div className="space-y-2">
      {line}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={outcome === 'pending'}
          aria-busy={outcome === 'pending'}
          onClick={() => void clear()}
        >
          {t('harnessVersion.integrationUpdate.retry')}
        </Button>
        <span role="status" className={`text-[13px] ${outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {outcome === 'cleared' && t('harnessVersion.integrationUpdate.retryCleared')}
          {outcome === 'failed' && t('harnessVersion.integrationUpdate.retryFailed')}
        </span>
      </div>
    </div>
  );
}
