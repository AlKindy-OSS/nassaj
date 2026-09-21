import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';
import type { CreatedInvite, ManagedUserRole } from '../../../hooks/useUsersAdmin';

import UserDialogShell from './UserDialogShell';

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
  const titleId = useId();

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

  // Allow Escape to dismiss the dialog.
  // Registered on `document` (not window) so this fires BEFORE Settings' document handler
  // (React child effects run before parent effects → child registers first).
  // Calling preventDefault signals Settings not to close itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <UserDialogShell
      titleId={titleId}
      title={t('users.invite.title')}
      closeLabel={t('users.invite.close')}
      onClose={onClose}
    >
      {!inviteUrl ? (
        <div className="space-y-4">
          <div>
            <label htmlFor="invite-role" className="mb-1 block text-sm font-medium text-foreground">
              {t('users.invite.roleLabel')}
            </label>
            {/* `border-input` لا `border-border`: حدّ التحكّم مطلوب بـWCAG 1.4.11
                وليس طبقةً من طبقات السطح، وكتابته برمز السطح داخل لوحٍ حدُّه
                بنفس الرمز أنتج حدّاً داخل حدٍّ بلونٍ واحد. */}
            <select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as ManagedUserRole)}
              disabled={isSubmitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="user">{t('users.roles.user')}</option>
              {canInviteAdmin && <option value="admin">{t('users.roles.admin')}</option>}
            </select>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('users.invite.roleHint')}
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
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
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.invite.successHint')}
          </p>
          <div className="flex items-center gap-2">
            {/* design-ok: `text-left` فيزيائي عمداً — الحقل جزيرة `dir="ltr"`
                تحمل رابطاً لاتينياً، و`text-start` فيها كان سيتبع اتجاه الجزيرة
                فيعطي النتيجة نفسها بينما الإزاحة المنطقية داخل جزر ltr فخّ
                مرصود (STYLE_LOCK §5). */}
            <input
              readOnly
              dir="ltr"
              value={inviteUrl}
              onFocus={(event) => event.target.select()}
              className="w-full rounded-md border border-input bg-muted px-3 py-2 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    </UserDialogShell>
  );
}
