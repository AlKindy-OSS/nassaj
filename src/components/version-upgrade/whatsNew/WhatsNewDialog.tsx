import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Sparkles, X } from 'lucide-react';

import { Button } from '../../../shared/view/ui/Button';
import { Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui/Dialog';
import { SOURCE_REPO_NAME, SOURCE_REPO_OWNER, SOURCE_REPO_URL } from '../../../constants/sourceRepo';

interface WhatsNewDialogProps {
  version: string;
  items: readonly string[];
  onDismiss: () => void;
}

/** GitHub release page for `version` on the public repo, or null when the repo is not on GitHub. */
export function releaseNotesUrl(version: string): string | null {
  if (!SOURCE_REPO_OWNER || !SOURCE_REPO_NAME) return null;
  return `${SOURCE_REPO_URL.replace(/\/+$/, '')}/releases/tag/v${encodeURIComponent(version)}`;
}

/**
 * "What's new" popup shown once per version after the node updates. Built on
 * the shared `Dialog` (portal, focus trap, Escape, overlay click); every
 * dismissal path calls `onDismiss`, which records the version as seen.
 */
export function WhatsNewDialog({ version, items, onDismiss }: WhatsNewDialogProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  const okRef = useRef<HTMLButtonElement>(null);
  const notesUrl = releaseNotesUrl(version);

  // `Dialog` focuses its container on the next frame; land on OK one frame later.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => okRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent
        layerClassName="z-[10040]"
        className="w-[calc(100%-2rem)] max-w-md p-5"
        aria-labelledby={titleId}
        data-testid="whats-new-dialog"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle id={titleId} className="not-sr-only text-base font-semibold text-foreground">
              {t('whatsNew.title')}
            </DialogTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('whatsNew.version')} <bdi dir="ltr" className="tabular-nums">{version}</bdi>
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('whatsNew.close')}
            className="-me-1 -mt-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <ul className="mt-4 max-h-[50vh] list-disc space-y-2 overflow-y-auto ps-5 text-sm leading-relaxed text-foreground marker:text-primary">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {notesUrl && (
            <a
              href={notesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="me-auto inline-flex items-center gap-1 rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('whatsNew.fullNotes')}
              <ExternalLink aria-hidden className="size-3.5" />
              <span className="sr-only">{t('whatsNew.opensInNewTab')}</span>
            </a>
          )}
          <Button ref={okRef} type="button" size="sm" onClick={onDismiss}>
            {t('dialog.ok')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
