import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Link2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../shared/view/ui';
import { api } from '../../../../../utils/api';
import { useAuth } from '../../../../auth';
import SettingsSection from '../../SettingsSection';

import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';

type LinkState = 'loading' | 'unavailable' | 'unlinked' | 'linked';

/** Maps a failed POST /link/self/start to its message key (server text is English-only). */
function startFailureKey(status: number, code: unknown): string {
  if (status === 401) return 'profile.sso.errors.wrongPassword';
  if (status === 429) return 'profile.sso.errors.rateLimited';
  if (status === 409) return 'profile.sso.errors.alreadyLinked';
  if (status === 403 && code === 'password_change_required') {
    return 'profile.sso.errors.passwordChangeRequired';
  }
  return 'profile.sso.errors.failed';
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Member self-link to SSO (T-1939 slice 5), in Profile → Security.
 *
 * Hidden when the server has SSO off (the status call answers 501). Linked
 * accounts see a read-only "linked" state: removing a link is an owner action.
 * Otherwise the button opens a password prompt; the server re-checks the
 * password and returns the IdP URL, and the whole page leaves for the IdP
 * (full navigation, so the transaction cookie set by that response rides
 * along). The member notice says plainly that a linked member stops using the
 * password to sign in — the owner is exempt, so it is not shown to them.
 */
export default function SsoSelfLinkSection() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const [linkState, setLinkState] = useState<LinkState>('loading');
  const [isPrompting, setPrompting] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [isStarting, setStarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: LinkState = 'unavailable';
      try {
        const response = await api.auth.oidc.selfLinkStatus();
        const body = response.ok ? await readJson(response) : null;
        if (typeof body?.linked === 'boolean') next = body.linked ? 'linked' : 'unlinked';
      } catch {
        next = 'unavailable';
      }
      if (!cancelled) setLinkState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentPassword) {
      setFeedback({ kind: 'error', message: t('profile.sso.errors.passwordRequired') });
      return;
    }
    setFeedback(null);
    setStarting(true);
    let response: Response;
    try {
      response = await api.auth.oidc.startSelfLink(currentPassword);
    } catch {
      setStarting(false);
      setFeedback({ kind: 'error', message: t('profile.sso.errors.network') });
      return;
    }
    const body = await readJson(response);
    const authorizationUrl = body?.authorizationUrl;
    if (response.ok && typeof authorizationUrl === 'string' && authorizationUrl.startsWith('https://')) {
      // Leave the SPA; the button stays in its pending state until unload.
      window.location.assign(authorizationUrl);
      return;
    }
    setStarting(false);
    setCurrentPassword('');
    if (response.status === 409) setLinkState('linked');
    setFeedback({ kind: 'error', message: t(startFailureKey(response.status, body?.code)) });
  }, [currentPassword, t]);

  if (linkState === 'loading' || linkState === 'unavailable') {
    return null;
  }

  const cancelPrompt = () => {
    setPrompting(false);
    setCurrentPassword('');
    setFeedback(null);
  };

  return (
    <SettingsSection boxed icon={Link2} title={t('profile.sso.title')} description={t('profile.sso.description')}>
      {linkState === 'linked' ? (
        <div className="space-y-1 py-2">
          <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {t('profile.sso.linked')}
          </p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('profile.sso.linkedDescription')}</p>
          <FeedbackBanner feedback={feedback} />
        </div>
      ) : (
        <div className="space-y-4 py-2">
          {user?.role !== 'owner' && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t('profile.sso.memberNotice')}</p>
          )}
          {isPrompting ? (
            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="profile-sso-current-password" className="block text-sm font-medium text-foreground">
                  {t('profile.sso.passwordLabel')}
                </label>
                <Input
                  id="profile-sso-current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  disabled={isStarting}
                  aria-describedby="profile-sso-password-hint"
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <p id="profile-sso-password-hint" className="text-[13px] leading-relaxed text-muted-foreground">
                  {t('profile.sso.passwordHint')}
                </p>
              </div>
              <FeedbackBanner feedback={feedback} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={isStarting} onClick={cancelPrompt}>
                  {t('profile.sso.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={isStarting}>
                  {isStarting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span className={isStarting ? 'ms-1.5' : undefined}>
                    {isStarting ? t('profile.sso.redirecting') : t('profile.sso.continue')}
                  </span>
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => setPrompting(true)}>
                {t('profile.sso.linkButton')}
              </Button>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
