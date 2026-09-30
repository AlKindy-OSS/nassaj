import { CheckCircle2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface UpdateCompletionBannerProps {
  targetVersion: string;
  onDismiss: () => void;
}

/**
 * The success signal a closed/away update dialog never showed (owner defect,
 * a fleet node, 2026-09). Mounted at the app shell so it survives the
 * modal being closed across the restart; see `useUpdateCompletionNotice`.
 */
export function UpdateCompletionBanner({ targetVersion, onDismiss }: UpdateCompletionBannerProps) {
  const { t } = useTranslation('common');

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800/50 dark:bg-green-950/30 dark:text-green-200"
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
      <p className="min-w-0 flex-1">
        {t('versionUpdate.completionNotice.message', { version: targetVersion })}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('versionUpdate.completionNotice.dismiss')}
        className="shrink-0 rounded-md p-1 text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/40"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
