import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';

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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('users.reset.title')}
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{t('users.reset.title')}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            aria-label={t('users.reset.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!tempPassword ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('users.reset.confirm', { username })}
            </p>
            <p className="text-sm text-muted-foreground">{t('users.reset.warning')}</p>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-800 dark:bg-red-900/20"
              >
                <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              </div>
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
            <p className="text-sm text-muted-foreground">{t('users.reset.successHint')}</p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                dir="ltr"
                value={tempPassword}
                onFocus={(event) => event.target.select()}
                aria-label={t('users.reset.tempPasswordLabel')}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-left font-mono text-sm text-foreground focus:outline-none"
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
      </div>
    </div>
  );
}
