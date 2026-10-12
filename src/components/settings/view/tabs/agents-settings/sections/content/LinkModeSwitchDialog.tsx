import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isolateBidi } from '../../../../../../quick-settings-panel/subscriptionHelpers';
import type { LinkMode } from '../../../../../../provider-auth/hooks/vendorKeyApi';
import type { SwitchRequest } from '../../../../../../provider-auth/hooks/useLinkMode';
import SettingsConfirmDialog from '../../../../SettingsConfirmDialog';

type LinkModeSwitchDialogProps = {
  harnessName: string;
  mode: LinkMode;
  /** The switch also removes the key nassaj did not write (the billing-warning action). */
  removeForeignKey: boolean;
  /** Members running on this account through an accepted grant: they change billing too. */
  granteeCount: number;
  /** Offer to also delete the `setup-token` from settings (Claude, token-sourced mode). */
  offerSetupToken: boolean;
  busy: boolean;
  onConfirm: (request: SwitchRequest) => void;
  onCancel: () => void;
};

/**
 * The confirm the server's `LINK_MODE_CONFIRM_REQUIRED` gate stands for (brief
 * §5). Switching to API key moves billing to usage, and every member running on
 * this account through a grant moves with it, so the dialog says how many.
 */
export default function LinkModeSwitchDialog({
  harnessName, mode, removeForeignKey, granteeCount, offerSetupToken, busy, onConfirm, onCancel,
}: LinkModeSwitchDialogProps) {
  const { t } = useTranslation('settings');
  const [removeSetupToken, setRemoveSetupToken] = useState(false);
  const harness = isolateBidi(harnessName);
  const toKey = mode === 'api_key';

  return (
    <SettingsConfirmDialog
      title={t('linkMode.confirm.title', { harness })}
      confirmLabel={t('linkMode.confirm.confirm')}
      cancelLabel={t('vendors.link.cancel')}
      destructive={toKey || removeForeignKey}
      busy={busy}
      onConfirm={() => onConfirm({
        mode,
        ...(removeForeignKey ? { removeForeignKey: true } : {}),
        ...(toKey && removeSetupToken ? { removeSetupToken: true } : {}),
      })}
      onCancel={onCancel}
    >
      <p>
        {toKey
          ? t('linkMode.confirm.toKey', { harness })
          : t(removeForeignKey ? 'linkMode.confirm.toSubscriptionForeign' : 'linkMode.confirm.toSubscription', { harness })}
      </p>
      {toKey && granteeCount > 0 && (
        <p className="font-medium text-warning">
          {t('linkMode.confirm.grantees', { count: granteeCount })}
        </p>
      )}
      {toKey && offerSetupToken && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={removeSetupToken}
            onChange={(event) => setRemoveSetupToken(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>{t('linkMode.confirm.removeSetupToken')}</span>
        </label>
      )}
    </SettingsConfirmDialog>
  );
}
