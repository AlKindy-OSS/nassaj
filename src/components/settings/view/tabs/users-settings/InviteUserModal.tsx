import { useCallback, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';
import type { CreatedInvite, ManagedUserRole } from '../../../hooks/useUsersAdmin';

type InviteUserModalProps = {
  // Whether the current actor may mint admin invites (owner only).
  canInviteAdmin: boolean;
  onClose: () => void;
  onCreate: (
    role: ManagedUserRole,
  ) => Promise<{ success: true; invite: CreatedInvite } | { success: false; error: string }>;
};

// Builds the absolute, openable invite link on the project domain (respecting
// any router basename), per the project rule to hand over real URLs.
function buildInviteUrl(token: string): string {
  const basename = window.__ROUTER_BASENAME__ || '';
  return `${window.location.origin}${basename}/join?token=${encodeURIComponent(token)}`;
}

/**
 * Invite creation modal (C-UI-3). Owner/admin pick an optional role, submit,
 * and receive a one-time invite link with a copy button. The plaintext token is
 * shown once and never persisted in clear text server-side.
 */
export default function InviteUserModal({ canInviteAdmin, onClose, onCreate }: InviteUserModalProps) {
  const { t } = useTranslation('settings');

  const [role, setRole] = useState<ManagedUserRole>('user');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const handleSubmit = useCallback(async () => {
    setError('');
    setIsSubmitting(true);
    const result = await onCreate(role);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setInviteUrl(buildInviteUrl(result.invite.token));
  }, [onCreate, role]);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(inviteUrl);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [inviteUrl]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('users.invite.title')}
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{t('users.invite.title')}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            aria-label={t('users.invite.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!inviteUrl ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="invite-role" className="mb-1 block text-sm font-medium text-foreground">
                {t('users.invite.roleLabel')}
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as ManagedUserRole)}
                disabled={isSubmitting}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="user">{t('users.roles.user')}</option>
                {canInviteAdmin && <option value="admin">{t('users.roles.admin')}</option>}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t('users.invite.roleHint')}</p>
            </div>

            {error && (
              <div className="rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-800 dark:bg-red-900/20">
                <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={isSubmitting}>
                {t('users.invite.cancel')}
              </Button>
              <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? t('users.invite.creating') : t('users.invite.submit')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('users.invite.successHint')}</p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                dir="ltr"
                value={inviteUrl}
                onFocus={(event) => event.target.select()}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-left text-sm text-foreground focus:outline-none"
              />
              <Button
                size="sm"
                onClick={handleCopy}
                className="flex-shrink-0"
                aria-label={t('users.invite.copy')}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ms-1.5">{copied ? t('users.invite.copied') : t('users.invite.copy')}</span>
              </Button>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t('users.invite.done')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
