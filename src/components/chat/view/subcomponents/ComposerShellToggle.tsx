import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SquareTerminal } from 'lucide-react';

import { PromptInputButton } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { ShellAvailability } from '../../hooks/useComposerShellMode';

type ComposerShellToggleProps = {
  availability: ShellAvailability;
  active: boolean;
  onToggle: () => void;
};

/**
 * T-2037 — the explicit switch into composer shell mode. When the caller may
 * not run commands it stays VISIBLE and focusable but aria-disabled, with the
 * localized reason as its description, so keyboard and screen-reader users
 * learn why (a native `disabled` button would drop out of the tab order).
 */
export default function ComposerShellToggle({ availability, active, onToggle }: ComposerShellToggleProps) {
  const { t } = useTranslation('chat');
  const reasonId = useId();
  const unavailable = !availability.available;
  const reason = unavailable ? t(`shellMode.disabledReason.${availability.reason}`) : null;
  const label = t('shellMode.toggle');

  return (
    <>
      <PromptInputButton
        className={cn(
          'h-8 w-8 shrink-0 rounded-lg [&_svg]:size-4',
          active && 'bg-emerald-600/15 text-emerald-700 hover:bg-emerald-600/20 dark:text-emerald-300',
          unavailable && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        )}
        tooltip={{ content: reason ?? label }}
        aria-label={label}
        aria-pressed={active}
        aria-disabled={unavailable || undefined}
        aria-describedby={reason ? reasonId : undefined}
        data-testid="composer-shell-toggle"
        onClick={() => {
          if (!unavailable) onToggle();
        }}
      >
        <SquareTerminal aria-hidden="true" />
      </PromptInputButton>
      {reason && (
        <span id={reasonId} className="sr-only" data-testid="composer-shell-toggle-reason">
          {reason}
        </span>
      )}
    </>
  );
}
