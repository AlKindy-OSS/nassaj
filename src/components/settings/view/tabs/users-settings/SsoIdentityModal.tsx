import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, Button, Input } from '../../../../../shared/view/ui';
import { SSO_SUBJECT_MAX_LENGTH } from '../../../hooks/useUsersAdmin';
import type { SsoLinkFailure, SsoLinkResult } from '../../../hooks/useUsersAdmin';
import SettingsCard from '../../SettingsCard';

import UserDialogShell from './UserDialogShell';

type SsoIdentityModalProps = {
  // Username of the target account, shown for context.
  username: string;
  onClose: () => void;
  onLink: (subject: string) => Promise<SsoLinkResult>;
  onUnlink: () => Promise<SsoLinkResult>;
};

type Outcome = { tone: 'success'; key: string } | { tone: 'error'; key: string } | null;

const FAILURE_KEYS: Readonly<Record<SsoLinkFailure, string>> = {
  invalid: 'users.sso.errors.invalid',
  conflict: 'users.sso.errors.conflict',
  not_found: 'users.sso.errors.notFound',
  not_configured: 'users.sso.errors.notConfigured',
  failed: 'users.sso.errors.failed',
  network: 'users.sso.errors.network',
};

/**
 * SSO identity modal (B-728). Links an existing account to an identity-provider
 * subject (`sub`) so it can sign in with SSO, or removes every link — which the
 * server pairs with revoking all of the account's sessions, hence the
 * two-step confirm. Password sign-in is untouched either way.
 */
export default function SsoIdentityModal({ username, onClose, onLink, onUnlink }: SsoIdentityModalProps) {
  const { t } = useTranslation('settings');
  const [subject, setSubject] = useState('');
  const [pending, setPending] = useState<'link' | 'unlink' | null>(null);
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

  const handleLink = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = subject.trim();
      if (!trimmed) {
        setOutcome({ tone: 'error', key: 'users.sso.errors.required' });
        return;
      }
      setOutcome(null);
      setPending('link');
      const result = await onLink(trimmed);
      setPending(null);
      if (!result.success) {
        setOutcome({ tone: 'error', key: FAILURE_KEYS[result.reason] });
        return;
      }
      setSubject('');
      setOutcome({ tone: 'success', key: 'users.sso.linked' });
    },
    [onLink, subject],
  );

  const handleUnlink = useCallback(async () => {
    if (!isConfirmingUnlink) {
      setConfirmingUnlink(true);
      return;
    }
    setConfirmingUnlink(false);
    setOutcome(null);
    setPending('unlink');
    const result = await onUnlink();
    setPending(null);
    setOutcome(
      result.success
        ? { tone: 'success', key: 'users.sso.unlinked' }
        : { tone: 'error', key: FAILURE_KEYS[result.reason] },
    );
  }, [isConfirmingUnlink, onUnlink]);

  const isBusy = pending !== null;

  return (
    <UserDialogShell title={t('users.sso.title')} closeLabel={t('users.sso.close')} onClose={onClose}>
      <div className="space-y-4">
        <form className="space-y-3" onSubmit={handleLink}>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.sso.description', { username })}
          </p>
          <div className="space-y-1.5">
            <label htmlFor="sso-subject" className="block text-sm font-medium text-foreground">
              {t('users.sso.subjectLabel')}
            </label>
            {/* قيمة تقنية لاتينية: جزيرة ltr معزولة، بلا محاذاة فيزيائية. */}
            <Input
              id="sso-subject"
              dir="ltr"
              value={subject}
              maxLength={SSO_SUBJECT_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="sso-subject-hint"
              disabled={isBusy}
              onChange={(event) => setSubject(event.target.value)}
              className="font-mono"
            />
            <p id="sso-subject-hint" className="text-[13px] leading-relaxed text-muted-foreground">
              {t('users.sso.subjectHint')}
            </p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={isBusy}>
              {pending === 'link' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              <span className={pending === 'link' ? 'ms-1.5' : undefined}>
                {pending === 'link' ? t('users.sso.linking') : t('users.sso.link')}
              </span>
            </Button>
          </div>
        </form>

        {outcome && (
          <Alert variant={outcome.tone === 'error' ? 'destructive' : 'default'} role={outcome.tone === 'error' ? 'alert' : 'status'}>
            {outcome.tone === 'error' ? <AlertTriangle /> : <CheckCircle2 />}
            <AlertDescription>{t(outcome.key, { username })}</AlertDescription>
          </Alert>
        )}

        <SettingsCard tone="danger">
          <div className="space-y-2">
            <p className="text-[13px] leading-relaxed text-foreground">
              {isConfirmingUnlink
                ? t('users.sso.unlinkConfirm', { username })
                : t('users.sso.unlinkDescription', { username })}
            </p>
            <div className="flex justify-end gap-2">
              {isConfirmingUnlink && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmingUnlink(false)}>
                  {t('users.sso.cancel')}
                </Button>
              )}
              <Button variant="destructive" size="sm" disabled={isBusy} onClick={() => void handleUnlink()}>
                {pending === 'unlink' ? t('users.sso.unlinking') : t('users.sso.unlink')}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </div>
    </UserDialogShell>
  );
}
