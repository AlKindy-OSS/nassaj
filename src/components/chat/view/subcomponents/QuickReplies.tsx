import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';

type QuickRepliesProps = {
  /** Options from `parseChoices` — plain text, rendered as React text nodes only. */
  choices: string[];
  /** Fills the composer. Present only for the single eligible message. */
  onSelect?: (option: string) => void;
};

const CHIP_BASE = 'max-w-full rounded-2xl border text-start leading-snug [overflow-wrap:anywhere]';

/**
 * T-2027 (ADR-209) — quick replies under an assistant message.
 *
 * Interactive (with `onSelect`): real buttons that FILL the composer, never
 * send. Static (without it): the same options as a plain list so older history
 * keeps the context of the user's later reply.
 * Each label carries `dir="auto"` on its own text only: options are
 * independent strings whose direction can differ from the message's.
 */
export default function QuickReplies({ choices, onSelect }: QuickRepliesProps) {
  const { t } = useTranslation('chat');
  const [selected, setSelected] = useState<string | null>(null);
  const label = t('quickReplies.label', { defaultValue: 'Suggested replies' });

  if (!onSelect) {
    return (
      <ul
        data-quick-replies="static"
        aria-label={t('quickReplies.staticLabel', { defaultValue: 'Options offered in this reply' })}
        className="mt-2 flex list-none flex-wrap gap-2 p-0"
      >
        {choices.map((option) => (
          <li key={option} className={cn(CHIP_BASE, 'm-0 border-border/60 px-2.5 py-0.5 text-xs text-muted-foreground')}>
            <span dir="auto">{option}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div data-quick-replies="interactive" role="group" aria-label={label} className="mt-2 flex flex-wrap gap-2">
      {choices.map((option) => {
        const isSelected = selected === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isSelected}
            onClick={() => { setSelected(option); onSelect(option); }}
            className={cn(
              CHIP_BASE,
              'inline-flex min-h-11 items-center px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent',
            )}
          >
            <span dir="auto">{option}</span>
          </button>
        );
      })}
    </div>
  );
}
