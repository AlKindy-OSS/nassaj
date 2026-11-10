import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Link2, Share2, X } from 'lucide-react';

import { usePaletteOps } from '../../contexts/PaletteOpsContext';
import type { SettingsDeepLink } from '../settings/types/types';
import { isolateBidi } from '../quick-settings-panel/subscriptionHelpers';

import {
  credentialProviderName,
  resolveCredentialDestinations,
  type CredentialNotLinkedInfo,
} from './credentialNotLinked';

type CredentialNotLinkedNoticeProps = {
  info: CredentialNotLinkedInfo;
  /** Runs before settings open — e.g. to close the dialog the notice sits in. */
  onNavigate?: () => void;
  /** When given, a close button hides the notice. */
  onDismiss?: () => void;
  className?: string;
};

const ACTION_CLASS = 'inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 '
  + 'px-2 py-1 text-xs font-medium text-foreground hover:bg-accent '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The CREDENTIAL_NOT_LINKED refusal in words (ADR-152 A1 §3.5, AT1): which
 * provider is not linked to the member's account and the two ways out — link
 * their own account, or ask a member to share theirs (the grant section). For
 * `grantor_not_linked` it names the member whose shared account is gone.
 *
 * Text comes from the code and fields, never from the server sentence, so it
 * follows the UI language. Names are bidi-isolated inside the Arabic sentence.
 */
export default function CredentialNotLinkedNotice({
  info, onNavigate, onDismiss, className = '',
}: CredentialNotLinkedNoticeProps) {
  const { t } = useTranslation('common');
  const { openSettings } = usePaletteOps();
  const titleId = useId();
  const providerName = credentialProviderName(info.provider);
  const { linkOwn, requestShare } = resolveCredentialDestinations(info);

  const title = providerName
    ? t('credential.notLinked.title', { provider: isolateBidi(providerName) })
    : t('credential.notLinked.titleGeneric');
  const body = info.reason === 'grantor_not_linked' && info.grantorUsername
    ? t('credential.grantorNotLinked.body', { grantorUsername: isolateBidi(info.grantorUsername) })
    : t('credential.notLinked.body');

  const go = (destination: SettingsDeepLink) => {
    onNavigate?.();
    openSettings(destination.tab, destination);
  };

  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-testid="credential-not-linked"
      className={`rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground ${className}`}
    >
      <p id={titleId} className="flex items-start gap-2 font-medium">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{title}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('credential.actions.dismiss')}
            className="-my-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </p>
      <p className="mt-1 break-words ps-6 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 ps-6">
        <button type="button" className={ACTION_CLASS} onClick={() => go(linkOwn)}>
          <Link2 className="h-4 w-4" aria-hidden="true" />
          {t('credential.actions.linkOwn')}
        </button>
        {requestShare && (
          <button type="button" className={ACTION_CLASS} onClick={() => go(requestShare)}>
            <Share2 className="h-4 w-4" aria-hidden="true" />
            {t('credential.actions.requestShare')}
          </button>
        )}
      </div>
    </div>
  );
}
