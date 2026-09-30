import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, Button, Input } from '../../../../../shared/view/ui';
import type { SsoLinkFailure, SsoLinkResult } from '../../../hooks/useUsersAdmin';
import SettingsCard from '../../SettingsCard';

import UserDialogShell from './UserDialogShell';

type SsoIdentityModalProps = {
  // Username of the target account, shown for context.
  username: string;
  // The owner managing their own account: unlink needs the current password.
  isSelf: boolean;
  onClose: () => void;
  onUnlink: (currentPassword?: string) => Promise<SsoLinkResult>;
};

type Outcome = { tone: 'success'; key: string } | { tone: 'error'; key: string } | null;

const FAILURE_KEYS: Readonly<Record<SsoLinkFailure, string>> = {
  wrong_password: 'users.sso.errors.wrongPassword',
  rate_limited: 'users.sso.errors.rateLimited',
  forbidden: 'users.sso.errors.forbidden',
  not_found: 'users.sso.errors.notFound',
  failed: 'users.sso.errors.failed',
  network: 'users.sso.errors.network',
};

/**
 * SSO identity modal (B-728, B-1410). Linking is never done here: an
 * administrator attaching an identity they control to someone else's account
 * is an account takeover, so the link control stays visible but disabled and
 * says linking is done by the member themself. What remains is removing every
 * link — paired server-side with revoking all of the account's sessions, hence
 * the two-step confirm. On the owner's own account the current password is
 * required as well. Password sign-in is untouched either way.
 */
export default function SsoIdentityModal({ username, isSelf, onClose, onUnlink }: SsoIdentityModalProps) {
  const { t } = useTranslation('settings');
  const [currentPassword, setCurrentPassword] = useState('');
  const [isPending, setPending] = useState(false);
  const [isConfirmingUnlink, setConfirmingUnlink] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleUnlink = useCallback(async () => {
    if (isSelf && !currentPassword) {
      setOutcome({ tone: 'error', key: 'users.sso.errors.passwordRequired' });
      return;
    }
    if (!isConfirmingUnlink) {
      setConfirmingUnlink(true);
      return;
    }
    setConfirmingUnlink(false);
    setOutcome(null);
    setPending(true);
    const result = await onUnlink(isSelf ? currentPassword : undefined);
    setPending(false);
    setCurrentPassword('');
    const successKey = isSelf ? 'users.sso.unlinkedSelf' : 'users.sso.unlinked';
    setOutcome(
      result.success
        ? { tone: 'success', key: successKey }
        : { tone: 'error', key: FAILURE_KEYS[result.reason] },
    );
  }, [currentPassword, isConfirmingUnlink, isSelf, onUnlink]);

  let unlinkPrompt = isSelf ? t('users.sso.unlinkSelfDescription') : t('users.sso.unlinkDescription', { username });
  if (isConfirmingUnlink) {
    unlinkPrompt = isSelf ? t('users.sso.unlinkSelfConfirm') : t('users.sso.unlinkConfirm', { username });
  }

  return (
    <UserDialogShell title={t('users.sso.title')} closeLabel={t('users.sso.close')} onClose={onClose}>
      <div className="space-y-4">
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.sso.description', { username })}
          </p>
          <p id="sso-link-disabled-hint" className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.sso.linkDisabledHint')}
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled aria-describedby="sso-link-disabled-hint">
              {t('users.sso.link')}
            </Button>
          </div>
        </div>

        {outcome && (
          <Alert variant={outcome.tone === 'error' ? 'destructive' : 'default'} role={outcome.tone === 'error' ? 'alert' : 'status'}>
            {outcome.tone === 'error' ? <AlertTriangle /> : <CheckCircle2 />}
            <AlertDescription>{t(outcome.key, { username })}</AlertDescription>
          </Alert>
        )}

        <SettingsCard tone="danger">
          <div className="space-y-2">
            <p className="text-[13px] leading-relaxed text-foreground">{unlinkPrompt}</p>
            {isSelf && (
              <div className="space-y-1.5">
                <label htmlFor="sso-current-password" className="block text-sm font-medium text-foreground">
                  {t('users.sso.passwordLabel')}
                </label>
                <Input
                  id="sso-current-password"
                  type="password"
                  value={currentPassword}
                  autoComplete="current-password"
                  disabled={isPending}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              {isConfirmingUnlink && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmingUnlink(false)}>
                  {t('users.sso.cancel')}
                </Button>
              )}
              <Button variant="destructive" size="sm" disabled={isPending} onClick={() => void handleUnlink()}>
                {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                <span className={isPending ? 'ms-1.5' : undefined}>
                  {isPending ? t('users.sso.unlinking') : t('users.sso.unlink')}
                </span>
              </Button>
            </div>
          </div>
        </SettingsCard>
      </div>
    </UserDialogShell>
  );
}
