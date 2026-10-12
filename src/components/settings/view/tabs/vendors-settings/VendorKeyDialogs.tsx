import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isolateBidi } from '../../../../quick-settings-panel/subscriptionHelpers';
import SettingsCard from '../../SettingsCard';
import SettingsConfirmDialog from '../../SettingsConfirmDialog';
import SettingsToggle from '../../SettingsToggle';

import type { FeedItem } from './vendorFeeds';

const REMOVED_STATES = new Set(['linked', 'stale', 'failed', 'tombstone']);

function HarnessList({ items }: { items: readonly FeedItem[] }) {
  return (
    <ul className="list-disc space-y-0.5 ps-5">
      {items.map((item) => <li key={item.vendorId}><bdi>{item.harness}</bdi></li>)}
    </ul>
  );
}

type DeleteDialogProps = {
  company: string;
  /** Every harness slot that has something to say, and whether the unified key exists. */
  items: readonly FeedItem[];
  foreign: readonly FeedItem[];
  hasUnifiedKey: boolean;
  busy: boolean;
  onConfirm: (removeForeignKey: boolean) => void;
  onCancel: () => void;
};

/**
 * Vendor-wide delete (ADR-200 §6, brief §2). Names its blast radius: every
 * harness the key feeds, and the unified engine-pin key. Keys nassaj did not
 * write are listed apart and removed only when the toggle is switched on; it
 * starts off, and it is the one switch allowed on the page because it confirms
 * a deletion rather than choosing a placement.
 */
export function DeleteVendorKeyDialog({
  company, items, foreign, hasUnifiedKey, busy, onConfirm, onCancel,
}: DeleteDialogProps) {
  const { t } = useTranslation('settings');
  const [removeForeign, setRemoveForeign] = useState(false);
  const removed = items.filter((item) => REMOVED_STATES.has(item.state));

  return (
    <SettingsConfirmDialog
      title={t('vendors.link.delete.title', { company: isolateBidi(company) })}
      confirmLabel={t('vendors.link.delete.confirm')}
      cancelLabel={t('vendors.link.cancel')}
      destructive
      busy={busy}
      onConfirm={() => onConfirm(removeForeign)}
      onCancel={onCancel}
    >
      {(removed.length > 0 || hasUnifiedKey) && (
        <div className="space-y-1">
          <p className="font-medium">{t('vendors.link.delete.removedFrom')}</p>
          <HarnessList items={removed} />
          {hasUnifiedKey && (
            <ul className="list-disc ps-5"><li>{t('vendors.link.delete.unifiedKey')}</li></ul>
          )}
        </div>
      )}
      <p className="text-muted-foreground">{t('vendors.link.delete.fixedLine')}</p>
      {foreign.length > 0 && (
        <SettingsCard tone="warning">
          <div className="space-y-2">
            <p className="font-medium text-warning">{t('vendors.link.delete.foreignTitle')}</p>
            <HarnessList items={foreign} />
            <div className="flex items-center gap-3">
              <SettingsToggle
                checked={removeForeign}
                onChange={setRemoveForeign}
                ariaLabel={t('vendors.link.delete.foreignToggle')}
                disabled={busy}
              />
              <span>{t('vendors.link.delete.foreignToggle')}</span>
            </div>
          </div>
        </SettingsCard>
      )}
    </SettingsConfirmDialog>
  );
}

type ReplaceDialogProps = {
  company: string;
  harnesses: readonly string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirm before a Save replaces a key nassaj did not write (it is billed right now). */
export function ReplaceForeignDialog({ company, harnesses, busy, onConfirm, onCancel }: ReplaceDialogProps) {
  const { t } = useTranslation('settings');
  return (
    <SettingsConfirmDialog
      title={t('vendors.link.replaceDialog.title')}
      confirmLabel={t('vendors.link.replaceDialog.confirm')}
      cancelLabel={t('vendors.link.cancel')}
      destructive
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>
        {t('vendors.link.replaceDialog.body', {
          harness: isolateBidi(harnesses.join(', ')),
          company: isolateBidi(company),
        })}
      </p>
    </SettingsConfirmDialog>
  );
}
