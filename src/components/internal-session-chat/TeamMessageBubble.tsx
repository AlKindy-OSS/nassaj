import { useTranslation } from 'react-i18next';
import { LockKeyhole, Users } from 'lucide-react';

import { resolveTextDirection } from '../../utils/textDirection';

import type { InternalMessage } from './internalSessionChatApi';

type Props = { message: InternalMessage };

const MENTION_RE = /@[^\s@]+/g;

/** Splits a body into plain text and `@username` tokens (same pattern as the send path). */
export function splitMentions(body: string): Array<{ text: string; mention: boolean }> {
  const parts: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: body.slice(last, start), mention: false });
    parts.push({ text: match[0], mention: true });
    last = start + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

const timeOf = (createdAt: string, locale: string): string | null => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
};

/**
 * ADR-187 team message shown inline in the conversation timeline. Same
 * "margin rule" shape as SteerBubble but on --session-internal-accent, with a
 * lock label: it lives only in the team room and never reaches the model.
 */
export default function TeamMessageBubble({ message }: Props) {
  const { t, i18n } = useTranslation('chat');
  const author = message.authorName ?? t('internalChat.unknownAuthor');
  const time = timeOf(message.createdAt, i18n.language);
  // One base direction per message, by majority: a leading Latin @mention must
  // not flip an Arabic message to LTR (same rule as chat rows).
  const dir = resolveTextDirection(message.body) ?? undefined;
  return (
    <div className="px-3 sm:px-0" data-internal-message="true">
      <article
        className="w-full border-s-[3px] border-[color:var(--session-internal-accent)] pb-1.5 ps-3 pt-1.5"
        aria-label={t('internalChat.bubbleAria', { name: author })}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Users className="size-3.5 shrink-0 text-[color:var(--session-internal-accent)]" aria-hidden="true" />
          <span className="font-semibold text-foreground"><bdi>{author}</bdi></span>
          {time && <span aria-hidden="true">·</span>}
          {time && <time dateTime={message.createdAt}>{time}</time>}
          <span className="ms-auto inline-flex shrink-0 items-center gap-1">
            <LockKeyhole className="size-3" aria-hidden="true" />
            {t('internalChat.inlineLabel')}
          </span>
        </div>
        <div className="whitespace-pre-wrap break-words text-sm text-foreground" dir={dir}>
          {/* Isolate each mention LTR so "@sara" never renders as "sara@" in RTL. */}
          {splitMentions(message.body).map((part, i) =>
            part.mention ? <bdi key={i} dir="ltr">{part.text}</bdi> : part.text,
          )}
        </div>
      </article>
    </div>
  );
}
