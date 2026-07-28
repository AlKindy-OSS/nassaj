import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import StandaloneShell from '../../../../../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../../../../../constants/config';

/** The approved registration command. agy has no separate `agy login`
 *  subcommand: running `agy` interactively launches its OAuth flow whenever no
 *  valid token exists under the (isolated) HOME, writing the credential into the
 *  caller's per-user directory. */
const AGY_LOGIN_COMMAND = 'agy';

/** Provider key passed into the terminal init message. The backend maps this to
 *  the 'agy' credential-isolation policy (resolveProviderEnv → isolated HOME).
 *  Without it, a command-driven plain shell would report 'plain-shell' and the
 *  agy OAuth token would be written to the shared/operator HOME instead of the
 *  current user's isolated tree. */
const AGY_PROVIDER = 'agy';

type AgySetupModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Called when the interactive `agy` process exits, so the caller can
   *  re-check the connection status. */
  onComplete?: (exitCode: number) => void;
};

/**
 * Guided onboarding for linking the current user's own Antigravity (agy)
 * subscription. Mirror of `ClaudeSetupTokenModal`.
 *
 * Reuses the existing terminal stack (`StandaloneShell` → `Shell`). The shell
 * auto-runs `agy`, which (when no valid token is present) opens the OAuth flow
 * and writes the credential into the user's isolated directory. Critically, it
 * passes `provider="agy"` so the backend applies per-user credential isolation
 * for the PTY — without it the token would land in the shared HOME. On process
 * exit we surface a "verify" affordance via `onComplete` so the parent can
 * refresh the status indicator.
 *
 * The terminal itself is LTR (CLI output is English/ANSI); the surrounding
 * chrome and instructions are RTL Arabic.
 */
export default function AgySetupModal({ isOpen, onClose, onComplete }: AgySetupModalProps) {
  const { t } = useTranslation('settings');

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-card shadow-xl max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-semibold text-foreground">
            {t('agyConnection.modal.title')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('agyConnection.modal.close')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Instructions */}
        <div className="flex-shrink-0 border-b border-border bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {t('agyConnection.modal.instructions')}{' '}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {AGY_LOGIN_COMMAND}
            </code>
            {'. '}
            {t('agyConnection.modal.afterComplete')}
          </p>
        </div>

        {/* Terminal — LTR, runs `agy` with explicit provider for isolation */}
        <div className="min-h-0 flex-1" dir="ltr">
          <StandaloneShell
            project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
            command={AGY_LOGIN_COMMAND}
            provider={AGY_PROVIDER}
            onComplete={onComplete}
            minimal
          />
        </div>
      </div>
    </div>
  );
}
