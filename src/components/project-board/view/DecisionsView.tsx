import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';

import type { BoardDecision, ProjectBoardState } from '../types';

type DecisionRowProps = {
  decision: BoardDecision;
  onFileOpen?: (filePath: string) => void;
};

function DecisionRow({ decision, onFileOpen }: DecisionRowProps) {
  const { t } = useTranslation('projectBoard');
  const { link } = decision;

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{decision.id}</span>
        <span className="text-sm font-medium text-foreground">{decision.title}</span>
      </div>
      {link &&
        // No host callback (e.g. standalone embedding) → keep the plain text.
        (onFileOpen ? (
          <button
            type="button"
            onClick={() => onFileOpen(link)}
            title={t('decisions.openLink', { id: decision.id })}
            aria-label={t('decisions.openLink', { id: decision.id })}
            className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            <FileText className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span
              dir="ltr"
              className="break-all text-start font-mono text-[11px] underline decoration-border underline-offset-2 hover:decoration-current"
            >
              {link}
            </span>
          </button>
        ) : (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <FileText className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span dir="ltr" className="break-all font-mono text-[11px]">
              {link}
            </span>
          </p>
        ))}
    </div>
  );
}

type DecisionsViewProps = {
  state: ProjectBoardState;
  /** Opens a project file (root-relative path) in the app's editor sidebar. */
  onFileOpen?: (filePath: string) => void;
};

/**
 * "Decisions" tab — the ADR record. Newest first: a decision log is read to
 * answer "what did we settle recently", and the oldest entries are the ones
 * already absorbed into the architecture.
 */
export default function DecisionsView({ state, onFileOpen }: DecisionsViewProps) {
  const { t } = useTranslation('projectBoard');
  const decisions = [...(state.decisions ?? [])].reverse();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('decisions.title')}</h3>
        {decisions.length ? (
          <div className="space-y-2">
            {decisions.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} onFileOpen={onFileOpen} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t('decisions.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
