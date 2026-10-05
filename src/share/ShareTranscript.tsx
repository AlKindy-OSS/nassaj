import type { ReactNode } from 'react';

import { detectDirection } from './direction';
import { displayTitle, formatDate, type ViewerStrings } from './i18n';
import { SafeMarkdown } from './safeMarkdown';
import type { ShareMessage, SharePart, ShareTranscriptData } from './types';

type RedactedPart = Extract<SharePart, { t: 'redacted' }>;

/** Inline marker for removed content. A path keeps its server-provided label text. */
export function RedactionChip({ part, strings }: { part: RedactedPart; strings: ViewerStrings }) {
  const cat = part.cat ?? 'generic';
  const label = strings.redaction[cat];
  return (
    <span className="share-redacted" data-cat={cat}>
      {cat === 'path' && part.text ? (
        <>
          <span className="share-sr-only">{label}: </span>
          <bdi dir="ltr">{part.text}</bdi>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** Consecutive chips share one line; text parts render as markdown blocks. */
function PartsView({ parts, strings }: { parts: SharePart[]; strings: ViewerStrings }) {
  const blocks: Array<{ key: number; node: ReactNode }> = [];
  let chips: RedactedPart[] = [];
  const flush = (key: number) => {
    if (!chips.length) return;
    const run = chips;
    chips = [];
    blocks.push({
      key,
      node: <p className="share-chips">{run.map((part, i) => <RedactionChip key={i} part={part} strings={strings} />)}</p>,
    });
  };
  parts.forEach((part, index) => {
    if (part.t === 'redacted') { chips.push(part); return; }
    flush(index);
    blocks.push({ key: index, node: <SafeMarkdown text={part.text} /> });
  });
  flush(parts.length);
  return <>{blocks.map((block) => <div key={block.key} className="share-block">{block.node}</div>)}</>;
}

function MessageView({ message, strings }: { message: ShareMessage; strings: ViewerStrings }) {
  const text = message.parts.map((part) => (part.t === 'text' ? part.text : '')).join(' ');
  const when = formatDate(message.at, strings, true);
  return (
    <article className="share-message" data-role={message.role}>
      <header className="share-message-head">
        <h3 className="share-author">{message.author === 'owner' ? strings.owner : strings.assistant}</h3>
        {when ? <time dateTime={message.at}>{when}</time> : null}
      </header>
      <div className="share-body" dir={detectDirection(text)}>
        <PartsView parts={message.parts} strings={strings} />
      </div>
    </article>
  );
}

function HeaderMeta({ transcript, strings }: { transcript: ShareTranscriptData; strings: ViewerStrings }) {
  const created = formatDate(transcript.createdAt, strings, false);
  const expires = formatDate(transcript.expiresAt, strings, false);
  const items = [
    transcript.providerLabel,
    created ? strings.createdOn(created) : null,
    transcript.toolCount > 0 ? strings.toolsUsed(transcript.toolCount) : null,
    expires ? strings.expiresOn(expires) : null,
  ].filter(Boolean);
  return items.length ? <p className="share-meta">{items.join(' · ')}</p> : null;
}

export function ShareTranscript({ transcript, strings }: { transcript: ShareTranscriptData; strings: ViewerStrings }) {
  return (
    <main className="share-page">
      <header className="share-header">
        <h1>{displayTitle(transcript.title, strings)}</h1>
        <HeaderMeta transcript={transcript} strings={strings} />
        <p className="share-note">{strings.readOnlyNote}</p>
      </header>
      <section aria-labelledby="share-messages-heading" className="share-messages">
        <h2 id="share-messages-heading" className="share-sr-only">{strings.messagesHeading}</h2>
        {transcript.messages.map((message, index) => (
          <MessageView key={index} message={message} strings={strings} />
        ))}
      </section>
    </main>
  );
}
