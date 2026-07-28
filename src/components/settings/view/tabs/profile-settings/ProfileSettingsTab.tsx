import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Loader2, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Pill, PillBar } from '../../../../../shared/view/ui';
import { useAuth } from '../../../../auth';
import { MIN_PASSWORD_LENGTH } from '../../../../auth/constants';
import SettingsSection from '../../SettingsSection';

import AvatarIdentitySection from './AvatarIdentitySection';
import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';
import PasskeysSection from './PasskeysSection';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';

type ProfileInnerTab = 'identity' | 'security';

/**
 * Profile settings tab (F-1).
 *
 * Self-service sections, available to every signed-in role, grouped into two
 * inner tabs (PillBar pattern, same as the agents settings) so the page opens
 * compact instead of one long vertical stack:
 *  - Identity: avatar style (upload / gallery / colour) + change username.
 *  - Security: change password + passkeys (WebAuthn, C-PK-3).
 *
 * Both panels stay mounted (the inactive one is `hidden`) so in-progress form
 * input and the fetched passkeys list survive switching tabs.
 *
 * Form state lives here; the actual mutations are delegated to the auth context
 * (which owns token persistence), keeping this component free of business logic.
 */
export default function ProfileSettingsTab() {
  const { t } = useTranslation('settings');
  const { user, changeUsername, changePassword } = useAuth();

  const currentUsername = user?.username ?? '';

  const [activeTab, setActiveTab] = useState<ProfileInnerTab>('identity');

  // Username section state.
  const [newUsername, setNewUsername] = useState('');
  const [usernameFeedback, setUsernameFeedback] = useState<Feedback>(null);
  const [isSavingUsername, setIsSavingUsername] = useState(false);

  // Password section state.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const handleUsernameSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setUsernameFeedback(null);

      const next = newUsername.trim();
      if (!next) {
        setUsernameFeedback({ kind: 'error', message: t('profile.username.errors.required') });
        return;
      }
      if (next === currentUsername) {
        setUsernameFeedback({ kind: 'error', message: t('profile.username.errors.unchanged') });
        return;
      }

      setIsSavingUsername(true);
      const result = await changeUsername(next);
      setIsSavingUsername(false);

      if (!result.success) {
        setUsernameFeedback({ kind: 'error', message: result.error });
        return;
      }
      setUsernameFeedback({ kind: 'success', message: t('profile.username.success') });
      setNewUsername('');
    },
    [changeUsername, currentUsername, newUsername, t],
  );

  const handlePasswordSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPasswordFeedback(null);

      if (!currentPassword || !newPassword || !confirmPassword) {
        setPasswordFeedback({ kind: 'error', message: t('profile.password.errors.required') });
        return;
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setPasswordFeedback({
          kind: 'error',
          message: t('profile.password.errors.short', { min: MIN_PASSWORD_LENGTH }),
        });
        return;
      }
      if (newPassword !== confirmPassword) {
        setPasswordFeedback({ kind: 'error', message: t('profile.password.errors.mismatch') });
        return;
      }

      setIsSavingPassword(true);
      const result = await changePassword(currentPassword, newPassword);
      setIsSavingPassword(false);

      if (!result.success) {
        setPasswordFeedback({ kind: 'error', message: result.error });
        return;
      }
      setPasswordFeedback({ kind: 'success', message: t('profile.password.success') });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
    [changePassword, confirmPassword, currentPassword, newPassword, t],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('profile.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('profile.subtitle')}</p>
      </div>

      {/* Inner tabs: identity vs security, so the page opens compact. */}
      <PillBar className="w-full sm:w-auto" role="tablist" aria-label={t('profile.title')}>
        <Pill
          isActive={activeTab === 'identity'}
          onClick={() => setActiveTab('identity')}
          className="min-w-0 flex-1 justify-center sm:flex-initial"
          role="tab"
          id="profile-tab-identity"
          aria-selected={activeTab === 'identity'}
          aria-controls="profile-panel-identity"
        >
          <UserRound className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{t('profile.tabs.identity')}</span>
        </Pill>
        <Pill
          isActive={activeTab === 'security'}
          onClick={() => setActiveTab('security')}
          className="min-w-0 flex-1 justify-center sm:flex-initial"
          role="tab"
          id="profile-tab-security"
          aria-selected={activeTab === 'security'}
          aria-controls="profile-panel-security"
        >
          <KeyRound className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{t('profile.tabs.security')}</span>
        </Pill>
      </PillBar>

      {/* Identity: avatar + username. Kept mounted while hidden so unsaved
          input survives switching tabs. */}
      <div
        id="profile-panel-identity"
        role="tabpanel"
        aria-labelledby="profile-tab-identity"
        hidden={activeTab !== 'identity'}
        className="space-y-8"
      >
        {/* Avatar identity: upload / gallery / colour (C-MU-UX-AVATAR-PICK) */}
        <AvatarIdentitySection t={t} />

        {/* Change username */}
        <SettingsSection
          title={t('profile.username.title')}
          description={t('profile.username.description')}
        >
          <form onSubmit={handleUsernameSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="profile-current-username"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.username.currentLabel')}
              </label>
              <input
                id="profile-current-username"
                type="text"
                value={currentUsername}
                readOnly
                dir="ltr"
                className={`${inputClass} bg-muted text-left`}
              />
            </div>

            <div>
              <label
                htmlFor="profile-new-username"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.username.newLabel')}
              </label>
              <input
                id="profile-new-username"
                type="text"
                name="username"
                autoComplete="username"
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                placeholder={t('profile.username.placeholder')}
                disabled={isSavingUsername}
                dir="ltr"
                className={`${inputClass} text-left`}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('profile.username.hint')}</p>
            </div>

            <FeedbackBanner feedback={usernameFeedback} />

            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={isSavingUsername}>
                {isSavingUsername && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className={isSavingUsername ? 'ms-1.5' : undefined}>
                  {isSavingUsername ? t('profile.saving') : t('profile.username.save')}
                </span>
              </Button>
            </div>
          </form>
        </SettingsSection>
      </div>

      {/* Security: password + passkeys. */}
      <div
        id="profile-panel-security"
        role="tabpanel"
        aria-labelledby="profile-tab-security"
        hidden={activeTab !== 'security'}
        className="space-y-8"
      >
        {/* Change password */}
        <SettingsSection
          title={t('profile.password.title')}
          description={t('profile.password.description')}
        >
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="profile-current-password"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.password.currentLabel')}
              </label>
              <input
                id="profile-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder={t('profile.password.currentPlaceholder')}
                disabled={isSavingPassword}
                className={inputClass}
              />
            </div>

            <div>
              <label
                htmlFor="profile-new-password"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.password.newLabel')}
              </label>
              <input
                id="profile-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder={t('profile.password.newPlaceholder')}
                disabled={isSavingPassword}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('profile.password.hint', { min: MIN_PASSWORD_LENGTH })}
              </p>
            </div>

            <div>
              <label
                htmlFor="profile-confirm-password"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.password.confirmLabel')}
              </label>
              <input
                id="profile-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder={t('profile.password.confirmPlaceholder')}
                disabled={isSavingPassword}
                className={inputClass}
              />
            </div>

            <FeedbackBanner feedback={passwordFeedback} />

            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={isSavingPassword}>
                {isSavingPassword && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className={isSavingPassword ? 'ms-1.5' : undefined}>
                  {isSavingPassword ? t('profile.saving') : t('profile.password.save')}
                </span>
              </Button>
            </div>
          </form>
        </SettingsSection>

        {/* Passkeys (C-PK-3) */}
        <PasskeysSection />
      </div>
    </div>
  );
}
