import { useCallback, useEffect, useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { OWNER_STEP_UP_EVENT } from '../../../utils/api';
import { startOwnerStepUp } from '../ssoLinkedSession';

type PromptState = 'closed' | 'open' | 'starting' | 'failed';

/**
 * ADR-H20 N2 (ADR-194 A2): the owner entered with no click from an IdP
 * session, and a privileged action (agent turn, terminal, settings, keys,
 * users, server actions) was refused with `owner_step_up_required`. This
 * non-modal prompt offers the passkey step-up (prompt=login at the IdP); the
 * grant then holds for about an hour in this browser only. The refused action
 * is not replayed: the owner repeats it after returning.
 */
export default function OwnerStepUpPrompt() {
  const { t } = useTranslation('auth');
  const [state, setState] = useState<PromptState>('closed');
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const open = () => setState((current) => (current === 'starting' ? current : 'open'));
    window.addEventListener(OWNER_STEP_UP_EVENT, open);
    return () => window.removeEventListener(OWNER_STEP_UP_EVENT, open);
  }, []);

  const start = useCallback(() => {
    setState('starting');
    void startOwnerStepUp().then((navigated) => {
      if (!navigated) setState('failed');
    });
  }, []);

  if (state === 'closed') return null;

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg border border-border bg-background p-4 text-start shadow-lg"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-foreground">
        <KeyRound className="h-4 w-4" aria-hidden />
        {t('sso.ownerStepUp.title')}
      </h2>
      <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
        {t('sso.ownerStepUp.description')}
      </p>
      {state === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('sso.ownerStepUp.failed')}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setState('closed')}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
        >
          {t('sso.ownerStepUp.dismiss')}
        </button>
        <button
          type="button"
          onClick={start}
          disabled={state === 'starting'}
          aria-busy={state === 'starting' || undefined}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {state === 'starting' ? t('sso.ownerStepUp.starting') : t('sso.ownerStepUp.button')}
        </button>
      </div>
    </div>
  );
}
