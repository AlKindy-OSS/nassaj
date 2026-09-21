import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { DegradedReason } from '../../../../hooks/useVersionCheck';
import { copyTextToClipboard } from '../../../../utils/clipboard';

type DegradedNoticeProps = {
  /** null when the node is healthy — the component then renders nothing. */
  reason: DegradedReason | null;
  t: TFunction;
};

/**
 * The governed operator command that clears a reason, where one exists.
 * `source_state_unreconciled` (ADR-156 ب.5): the node reopened on the previous
 * generation while the source tree still sits at the target; completing the
 * source rollback is what reconciles it and unblocks the next update. Shown
 * verbatim for the operator to run on the server — the UI never executes it.
 */
const OPERATOR_COMMANDS: Partial<Record<DegradedReason, string>> = {
  source_state_unreconciled: 'npm run doctor -- --reopen-gate --complete-source-rollback --yes',
};

/**
 * ADR-156 WI-6 (T-1718) — the permanent degraded banner.
 *
 * Decision 7 of ADR-156 admits the `degraded` state only if it is visible in
 * the UI as well as on /health, and never opens silently. So this banner has no
 * dismiss control: it stays for as long as /health keeps reporting the state,
 * and disappears only when the condition itself clears. On 2026-09-11 a node
 * sat behind a closed maintenance gate with nothing in the interface saying so.
 *
 * Written with logical properties throughout (border-s, ms/me, text-start) so
 * the accent edge sits on the reading-start side in both Arabic and English.
 */
export default function DegradedNotice({ reason, t }: DegradedNoticeProps) {
  const [copied, setCopied] = useState(false);
  if (!reason) return null;
  const command = OPERATOR_COMMANDS[reason];
  const copyCommand = async () => {
    if (command && await copyTextToClipboard(command)) setCopied(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-s-4 border-amber-300/70 border-s-amber-500 bg-amber-50/90 px-3 py-2 text-start dark:border-amber-900/50 dark:border-s-amber-500 dark:bg-amber-950/30"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-tight text-amber-900 dark:text-amber-200">
          {t('degraded.title')}
        </p>
        <p className="mt-0.5 text-xs leading-tight text-amber-800/80 dark:text-amber-300/70">
          {t(`degraded.reasons.${reason}`, { defaultValue: t('degraded.reasons.unknown') })}
        </p>
        {command && (
          <div className="mt-1.5">
            <p className="text-xs font-medium leading-tight text-amber-900 dark:text-amber-200">
              {t('degraded.operatorAction')}
            </p>
            {/* The command wraps rather than scrolls: at sidebar width a
                scrolling block hid all but its first words, and the operator
                must be able to read the one action this banner asks for. */}
            <div className="mt-1 flex flex-col items-start gap-1">
              <code
                dir="ltr"
                className="block w-full whitespace-normal rounded bg-amber-100/80 px-1.5 py-0.5 text-start font-mono text-[11px] leading-snug text-amber-950 [overflow-wrap:anywhere] dark:bg-amber-900/40 dark:text-amber-100"
              >
                {command}
              </code>
              <button
                type="button"
                onClick={() => void copyCommand()}
                aria-label={t('degraded.copyCommandAria')}
                className="shrink-0 rounded-md border border-amber-400/60 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
              >
                {copied ? t('degraded.copied') : t('degraded.copyCommand')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
