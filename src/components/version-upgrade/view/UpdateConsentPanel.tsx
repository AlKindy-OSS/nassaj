/**
 * UpdateConsentPanel — Phase 1 of T-1730 consent gate.
 *
 * Shown when the owner clicks "Update Now". The owner must explicitly confirm
 * before `activateWhenIdle: true` is sent to the server. This is the ONLY
 * place in the UI that emits `activateWhenIdle`.
 *
 * Contract assumptions for backend-dev (server/):
 *   POST /api/system/update/jobs accepts
 *     { expectedVersion, activateWhenIdle: true, consent: { version: string } }
 *   409 update_consent_mismatch — if consent.version !== expectedVersion.
 */

import { useTranslation } from "react-i18next";
import { ShieldCheck, Sparkles, Wrench, Bug } from "lucide-react";
import type { ReleaseInfo } from "../../../types/sharedTypes";
import { extractReleaseHighlights } from "../releaseNotesHighlights";
import type { HighlightCategory } from "../releaseNotesHighlights";

interface UpdateConsentPanelProps {
  /** The version whose release notes are displayed; also sent in `consent.version`. */
  targetVersion: string;
  releaseInfo: ReleaseInfo | null;
  /** Called when the owner confirms. The panel itself does not call the API. */
  onConfirm: () => void;
  onCancel: () => void;
}

/** أيقونة صغيرة بحسب فئة البند */
function CategoryDot({ category }: { category: HighlightCategory }) {
  if (category === 'feature') {
    return (
      <Sparkles
        aria-hidden="true"
        className="mt-0.5 h-3 w-3 shrink-0 text-blue-500 dark:text-blue-400"
      />
    );
  }
  if (category === 'improvement') {
    return (
      <Wrench
        aria-hidden="true"
        className="mt-0.5 h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400"
      />
    );
  }
  if (category === 'fix') {
    return (
      <Bug
        aria-hidden="true"
        className="mt-0.5 h-3 w-3 shrink-0 text-green-500 dark:text-green-400"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
    />
  );
}

export function UpdateConsentPanel({
  targetVersion,
  releaseInfo,
  onConfirm,
  onCancel,
}: UpdateConsentPanelProps) {
  const { t } = useTranslation('common');

  const highlights = releaseInfo?.body
    ? extractReleaseHighlights(releaseInfo.body, 6)
    : [];
  const hasHighlights = highlights.length > 0;

  return (
    <div
      role="region"
      aria-labelledby="consent-panel-title"
      className="space-y-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-800/50 dark:bg-blue-950/20"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40"
        >
          <ShieldCheck className="h-4 w-4 text-blue-700 dark:text-blue-300" />
        </span>
        <div className="min-w-0">
          <h3
            id="consent-panel-title"
            className="text-sm font-semibold text-foreground"
          >
            {t('versionUpdate.consent.title')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('versionUpdate.consent.targetVersionLabel')}{' '}
            <span dir="ltr" className="font-mono tabular-nums">
              {targetVersion}
            </span>
          </p>
        </div>
      </div>

      {/* Release highlights — structured bullet list */}
      {hasHighlights ? (
        <div className="rounded-md border border-border bg-card px-3 py-2 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground mb-1">
            {t('versionUpdate.consent.highlights.sectionTitle')}
          </p>
          <ul aria-label={t('versionUpdate.consent.highlights.sectionTitle')} className="space-y-1.5">
            {highlights.map((item, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2 text-xs text-foreground leading-relaxed"
              >
                <CategoryDot category={item.category} />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          {releaseInfo?.htmlUrl && (
            <a
              href={releaseInfo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('versionUpdate.consent.highlights.viewFullLabel')}
            </a>
          )}
        </div>
      ) : releaseInfo?.htmlUrl ? (
        /* ملاحظات موجودة لكن بلا بنود منظّمة — رابط مباشر */
        <p className="text-xs text-muted-foreground">
          <a
            href={releaseInfo.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('versionUpdate.consent.highlights.viewFullLabel')}
          </a>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('versionUpdate.consent.noReleaseNotes')}
        </p>
      )}

      {/* What the owner is agreeing to — three explicit guarantees */}
      <ul
        aria-label={t('versionUpdate.consent.termsAriaLabel')}
        className="space-y-1.5 rounded-md border border-border bg-card px-3 py-2"
      >
        <li className="flex items-start gap-2 text-xs text-foreground">
          <span aria-hidden="true" className="mt-0.5 h-1.5 w-1.5 shrink-0 translate-y-0.5 rounded-full bg-blue-500" />
          <span>{t('versionUpdate.consent.term.safeRestart')}</span>
        </li>
        <li className="flex items-start gap-2 text-xs text-foreground">
          <span aria-hidden="true" className="mt-0.5 h-1.5 w-1.5 shrink-0 translate-y-0.5 rounded-full bg-blue-500" />
          <span>{t('versionUpdate.consent.term.noSessionsKilled')}</span>
        </li>
        <li className="flex items-start gap-2 text-xs text-foreground">
          <span aria-hidden="true" className="mt-0.5 h-1.5 w-1.5 shrink-0 translate-y-0.5 rounded-full bg-blue-500" />
          <span>{t('versionUpdate.consent.term.timeout24h')}</span>
        </li>
      </ul>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          {t('buttons.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          aria-label={t('versionUpdate.consent.confirmAriaLabel', { version: targetVersion })}
        >
          {t('versionUpdate.consent.confirmButton')}
        </button>
      </div>
    </div>
  );
}
