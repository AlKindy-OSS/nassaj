import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewMessage, PreviewPart, ShareCounts, ShareRedactionCategory } from './sessionShareApi';

const PAGE_SIZE = 60;

const CATEGORY_CLASS: Record<ShareRedactionCategory, string> = {
  secret: 'bg-danger/15 text-danger ring-danger/40',
  path: 'bg-warning/15 text-warning ring-warning/40',
  image: 'bg-primary/10 text-primary ring-primary/30',
  network: 'bg-warning/15 text-warning ring-warning/40',
  system: 'bg-muted text-muted-foreground ring-border',
};

const SUMMARY_ORDER = ['secret', 'path', 'image', 'network', 'system', 'tools', 'thinking', 'other'] as const;

/** Counts of everything removed, in display order, zero entries dropped. */
function summaryEntries(counts: ShareCounts): Array<{ key: (typeof SUMMARY_ORDER)[number]; n: number }> {
  const value = (key: (typeof SUMMARY_ORDER)[number]) => (key === 'tools' ? counts.toolCount : counts[key]);
  return SUMMARY_ORDER.map((key) => ({ key, n: value(key) })).filter((entry) => entry.n > 0);
}

export function RedactionSummary({ counts }: { counts: ShareCounts }) {
  const { t } = useTranslation('chat');
  const entries = summaryEntries(counts);
  return (
    <section aria-labelledby="share-summary-title" className="space-y-1">
      <h3 id="share-summary-title" className="text-sm font-semibold text-foreground">{t('sessionShare.summaryTitle')}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('sessionShare.summaryNone')}</p>
      ) : (
        <p className="text-sm text-foreground">
          {t('sessionShare.summaryPrefix', {
            items: entries.map((entry) => t(`sessionShare.summary.${entry.key}`, { n: entry.n })).join('، '),
          })}
        </p>
      )}
    </section>
  );
}

function Part({ part }: { part: PreviewPart }) {
  const { t } = useTranslation('chat');
  if (part.t === 'text') return <>{part.text}</>;
  const label = t(`sessionShare.category.${part.cat}`);
  return (
    <mark
      data-redaction={part.cat}
      className={`mx-0.5 inline-block rounded px-1.5 py-0.5 align-baseline text-xs font-medium ring-1 ring-inset ${CATEGORY_CLASS[part.cat] ?? CATEGORY_CLASS.system}`}
    >
      <span aria-hidden>▮ </span>{label}
    </mark>
  );
}

function Message({ message }: { message: PreviewMessage }) {
  const { t } = useTranslation('chat');
  const user = message.role === 'user';
  return (
    <li className={user ? 'rounded-md bg-accent/50 p-2' : 'p-2'}>
      <p className="mb-1 text-xs font-semibold text-muted-foreground">
        {t(user ? 'sessionShare.roleUser' : 'sessionShare.roleAssistant')}
      </p>
      <div dir="auto" className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {message.parts.map((part, index) => <Part key={index} part={part} />)}
      </div>
    </li>
  );
}

/** Redacted transcript exactly as the public reader gets it; every removal is highlighted. */
export default function SharePreviewTranscript({ messages }: { messages: PreviewMessage[] }) {
  const { t } = useTranslation('chat');
  const [shown, setShown] = useState(PAGE_SIZE);
  const remaining = messages.length - shown;
  return (
    <section aria-labelledby="share-preview-title" className="space-y-2">
      <h3 id="share-preview-title" className="text-sm font-semibold text-foreground">
        {t('sessionShare.previewTitle')} <span className="font-normal text-muted-foreground">({t('sessionShare.messageCount', { n: messages.length })})</span>
      </h3>
      <ul
        tabIndex={0}
        aria-labelledby="share-preview-title"
        className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {messages.slice(0, shown).map((message, index) => <Message key={index} message={message} />)}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          className="min-h-9 rounded-md border border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setShown((current) => current + PAGE_SIZE)}
        >
          {t('sessionShare.previewMore', { n: remaining })}
        </button>
      )}
    </section>
  );
}
