import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import {
  useVendorBackups,
  type BackupHarness,
  type RestoreMode,
  type RestoreOutcome,
} from '../../../../provider-auth/hooks/useVendorBackups';
import { isolateBidi } from '../../../../quick-settings-panel/subscriptionHelpers';
import SettingsCollapsible from '../../SettingsCollapsible';
import SettingsConfirmDialog from '../../SettingsConfirmDialog';

import { harnessName } from './vendorFeeds';

const HARNESSES: readonly BackupHarness[] = ['claude', 'codex', 'opencode'];

type PendingRestore = { harness: BackupHarness; mode: RestoreMode };

/** The line a finished restore leaves under its row. */
function outcomeLines(outcome: RestoreOutcome, t: (key: string, vars?: Record<string, unknown>) => string): string[] {
  if (outcome.restored) {
    return [
      t('vendors.restore.done'),
      ...outcome.skipped
        .filter((entry) => entry.outcome === 'login_present')
        .map((entry) => t('vendors.restore.skippedLogin', { target: isolateBidi(entry.target) })),
    ];
  }
  if (outcome.failure.code === 'VENDOR_BACKUP_UNAVAILABLE') return [t('vendors.restore.unavailable')];
  if (outcome.failure.code === 'VENDOR_BACKUP_SHARED_SCOPE') return [t('vendors.restore.sharedScope')];
  if (outcome.failure.code === 'VENDOR_KEY_RATE_LIMITED') return [t('vendors.link.error.rateLimited')];
  return [outcome.failure.message];
}

function isDisabledOutcome(outcome: RestoreOutcome | undefined): boolean {
  return Boolean(outcome && !outcome.restored
    && (outcome.failure.code === 'VENDOR_BACKUP_UNAVAILABLE'
      || outcome.failure.code === 'VENDOR_BACKUP_SHARED_SCOPE'));
}

/** Keys-only is the default; full is a danger dialog that wants the acknowledgement ticked. */
function RestoreDialog({ pending, busy, onConfirm, onCancel }: {
  pending: PendingRestore;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const [acknowledged, setAcknowledged] = useState(false);
  const full = pending.mode === 'full';
  return (
    <SettingsConfirmDialog
      title={t('vendors.restore.dialogTitle', { harness: isolateBidi(harnessName(pending.harness)) })}
      confirmLabel={t('vendors.restore.confirm')}
      cancelLabel={t('vendors.link.cancel')}
      destructive={full}
      confirmDisabled={full && !acknowledged}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{full ? t('vendors.restore.fullBody') : t('vendors.restore.keysBody')}</p>
      {!full && pending.harness === 'claude' && (
        <p className="text-warning">{t('vendors.restore.claudeBilling')}</p>
      )}
      {full && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>{t('vendors.restore.fullAck')}</span>
        </label>
      )}
    </SettingsConfirmDialog>
  );
}

/**
 * «استرجاع ملفات الأجساد» (ADR-200 §3 rollback, brief §4): one row per harness
 * file the migration backed up. Always listed, flag or not, because the backup
 * exists independently of the fan-out switch.
 */
export default function BackupRestoreSection() {
  const { t } = useTranslation('settings');
  const { busy, restore } = useVendorBackups();
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [outcomes, setOutcomes] = useState<Partial<Record<BackupHarness, RestoreOutcome>>>({});

  const confirm = async () => {
    if (!pending) return;
    const outcome = await restore(pending.harness, pending.mode);
    setOutcomes((previous) => ({ ...previous, [pending.harness]: outcome }));
    setPending(null);
  };

  return (
    <SettingsCollapsible summary={t('vendors.restore.title')}>
      <ul className="space-y-2">
        {HARNESSES.map((harness) => {
          const outcome = outcomes[harness];
          return (
            <li key={harness} className="space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-28 text-[15px] font-medium text-foreground">
                  <bdi>{harnessName(harness)}</bdi>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || isDisabledOutcome(outcome)}
                  onClick={() => setPending({ harness, mode: 'keys' })}
                >
                  {t('vendors.restore.button')}
                </Button>
                <button
                  type="button"
                  disabled={busy !== null || isDisabledOutcome(outcome)}
                  onClick={() => setPending({ harness, mode: 'full' })}
                  className="min-h-6 rounded-sm text-[13px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {t('vendors.restore.fullLink')}
                </button>
              </div>
              {outcome && (
                <ul className="text-[13px] leading-relaxed text-muted-foreground" aria-live="polite">
                  {outcomeLines(outcome, t).map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {pending && (
        <RestoreDialog
          pending={pending}
          busy={busy !== null}
          onConfirm={() => { void confirm(); }}
          onCancel={() => setPending(null)}
        />
      )}
    </SettingsCollapsible>
  );
}
