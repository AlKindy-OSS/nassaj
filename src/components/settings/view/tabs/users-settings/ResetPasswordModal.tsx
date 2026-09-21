import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';

import UserDialogShell from './UserDialogShell';

type ResetPasswordModalProps = {
  // Username of the target, shown for confirmation context.
  username: string;
  onClose: () => void;
  // Performs the reset and resolves with the one-time temporary password.
  onReset: () => Promise<{ success: true; tempPassword: string } | { success: false; error: string }>;
};

/**
 * Admin password-reset modal (F-3).
 *
 * Mirrors InviteUserModal: confirm the reset, then reveal the generated
 * temporary password ONCE with a copy button. The plaintext is never persisted
 * client-side beyond this modal's lifetime and is shown a single time.
 */
export default function ResetPasswordModal({ username, onClose, onReset }: ResetPasswordModalProps) {
  const { t } = useTranslation('settings');
  const titleId = useId();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const handleSubmit = useCallback(async () => {
    setError('');
    setIsSubmitting(true);
    const result = await onReset();
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setTempPassword(result.tempPassword);
  }, [onReset]);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(tempPassword);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [tempPassword]);

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
      title={t('users.reset.title')}
      closeLabel={t('users.reset.close')}
      onClose={onClose}
    >
      {!tempPassword ? (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.reset.confirm', { username })}
          </p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.reset.warning')}
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={isSubmitting}>
              {t('users.reset.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <span className={isSubmitting ? 'ms-1.5' : undefined}>
                {isSubmitting ? t('users.reset.resetting') : t('users.reset.submit')}
              </span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.reset.successHint')}
          </p>
          <div className="flex items-center gap-2">
            {/* design-ok: `text-left` فيزيائي عمداً — جزيرة `dir="ltr"` تحمل
                كلمة مرور مؤقتة، والإزاحة المنطقية داخل جزر ltr فخّ مرصود
                (STYLE_LOCK §5). */}
            <input
              readOnly
              dir="ltr"
              value={tempPassword}
              onFocus={(event) => event.target.select()}
              aria-label={t('users.reset.tempPasswordLabel')}
              className="w-full rounded-md border border-input bg-muted px-3 py-2 text-left font-mono text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              onClick={handleCopy}
              className="flex-shrink-0"
              aria-label={t('users.reset.copy')}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ms-1.5">{copied ? t('users.reset.copied') : t('users.reset.copy')}</span>
            </Button>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('users.reset.done')}
            </Button>
          </div>
        </div>
      )}
    </UserDialogShell>
  );
}
