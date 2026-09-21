import { TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Panel empty state (T-939): no terminal is selected/open. Chrome is RTL by
// inheritance; text alignment follows the document direction via `text-align`.
export default function TerminalsEmptyState() {
  const { t } = useTranslation('terminals');

  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-sm text-muted-foreground">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <TerminalSquare className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        </div>
        <h3 className="mb-1.5 text-base font-semibold text-foreground">{t('panel.empty')}</h3>
        <p className="text-sm leading-relaxed">{t('panel.emptyHint')}</p>
      </div>
    </div>
  );
}
