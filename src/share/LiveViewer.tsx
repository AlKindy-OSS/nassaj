import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AttachmentStore } from './attachmentStore';
import { FileAttachment, ImageAttachment } from './attachments';
import { detectDirection } from './direction';
import { displayTitle, formatDate, type ViewerStrings } from './i18n';
import type { LiveClient } from './liveClient';
import { PartsView, type AttachmentRenderer } from './ShareTranscript';
import type { LiveMessage, LiveMeta } from './types';
import { useLiveFeed } from './useLiveFeed';

const NEAR_BOTTOM_PX = 120;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const scrollToBottom = (smooth: boolean) => {
  if (typeof window.scrollTo !== 'function') return;
  const top = document.documentElement.scrollHeight;
  window.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
};

const authorLabel = (message: LiveMessage, strings: ViewerStrings) =>
  message.author === 'owner' ? strings.owner : message.author === 'member' ? strings.member : strings.assistant;

function LiveMessageView({ message, strings, render }: { message: LiveMessage; strings: ViewerStrings; render: AttachmentRenderer }) {
  const text = message.parts.map((part) => (part.t === 'text' ? part.text : '')).join(' ');
  const when = formatDate(message.at, strings, true);
  return (
    <article className="live-msg" data-author={message.author} data-k={message.k}>
      <header className="live-msg-head">
        <h3 className="live-author">{authorLabel(message, strings)}</h3>
        {when ? <time dateTime={message.at}>{when}</time> : null}
      </header>
      <div className="live-bubble">
        <div className="share-body" dir={detectDirection(text)}>
          <PartsView parts={message.parts} strings={strings} renderAttachment={render} />
        </div>
      </div>
    </article>
  );
}

function useAttachmentRenderer(client: LiveClient, strings: ViewerStrings): AttachmentRenderer {
  const [store] = useState(() => new AttachmentStore(client));
  useEffect(() => () => store.dispose(), [store]);
  return useCallback<AttachmentRenderer>((part) => {
    if (part.t === 'image') return <ImageAttachment part={part} store={store} strings={strings} />;
    if (part.t === 'file') return <FileAttachment part={part} store={store} strings={strings} />;
    const text = part.t === 'attachment-unavailable' && part.kind === 'image'
      ? strings.attachment.unavailableImage
      : strings.attachment.unavailableFile;
    return <span className="share-redacted" data-cat="attachment">{text}</span>;
  }, [store, strings]);
}

/** Scroll behaviour: follow the tail when the reader is there, otherwise offer a pill. */
function useScrollFollow(messages: LiveMessage[]) {
  const [unseen, setUnseen] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const previous = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      atBottom.current = entries.some((entry) => entry.isIntersecting);
      if (atBottom.current) setUnseen(0);
    }, { rootMargin: `0px 0px ${NEAR_BOTTOM_PX}px 0px` });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const first = messages[0]?.k;
    const last = messages.at(-1)?.k;
    const before = previous.current;
    const height = document.documentElement.scrollHeight;
    if (!before.last) {
      if (last) scrollToBottom(false);
    } else if (last !== before.last) {
      const oldLastAt = messages.findIndex((m) => m.k === before.last);
      const added = oldLastAt < 0 ? messages.length : messages.length - 1 - oldLastAt;
      if (atBottom.current) scrollToBottom(false);
      else setUnseen((count) => count + added);
    } else if (first !== before.first && typeof window.scrollBy === 'function') {
      // Older page prepended: keep the reader's place instead of jumping to the top.
      window.scrollBy(0, height - before.height);
    }
    previous.current = { first, last, height: document.documentElement.scrollHeight };
  }, [messages]);

  const jump = useCallback(() => { scrollToBottom(true); setUnseen(0); }, []);
  return { sentinel, unseen, jump };
}

function useOlderSentinel(enabled: boolean, onReach: () => void, depth: number) {
  const node = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = node.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onReach();
    }, { rootMargin: '300px 0px 0px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, onReach, depth]);
  return node;
}

export function LiveViewer({ client, meta, strings, onUnavailable }: {
  client: LiveClient;
  meta: LiveMeta;
  strings: ViewerStrings;
  onUnavailable: () => void;
}) {
  const { state, loadOlder, retryNow } = useLiveFeed(client);
  const render = useAttachmentRenderer(client, strings);
  const { sentinel, unseen, jump } = useScrollFollow(state.messages);
  const ended = state.status === 'ended';
  const olderRef = useOlderSentinel(state.moreBefore && !state.loadingOlder && !state.olderFailed, () => { void loadOlder(); }, state.messages.length);
  const live = strings.live;

  useEffect(() => { if (ended && !state.messages.length) onUnavailable(); }, [ended, state.messages.length, onUnavailable]);

  const expires = formatDate(meta.expiresAt, strings, false);
  const metaLine = [meta.providerLabel, expires ? strings.expiresOn(expires) : null].filter(Boolean).join(' · ');
  const notice = ended ? null
    : state.notice === 'rate-limited' ? live.rateLimitedNotice
    : state.notice === 'temporary' ? live.retrying
    : state.stale ? live.stale : null;

  return (
    <main className="live-page">
      <header className="live-header">
        <div className="live-title-row">
          <h1>{displayTitle(meta.title, strings)}</h1>
          <span className="live-badge" data-state={ended ? 'ended' : 'live'}>
            <span className="live-dot" aria-hidden="true" />
            {ended ? live.badgeEnded : live.badgeLive}
          </span>
        </div>
        {metaLine ? <p className="share-meta">{metaLine}</p> : null}
        <p className="share-note">{live.readOnlyNote}</p>
      </header>

      <div className="live-notices" role="status" aria-live="polite">
        {notice ? (
          <p className="live-notice" data-tone="warn">
            {notice}{' '}
            {state.status === 'loading' ? <button type="button" className="live-link" onClick={retryNow}>{strings.retry}</button> : null}
          </p>
        ) : null}
      </div>

      {state.status === 'loading' && !notice ? <p className="share-status" role="status">{strings.loading}</p> : null}

      <section className="live-messages" aria-label={live.conversationLabel}>
        <h2 className="share-sr-only">{strings.messagesHeading}</h2>
        {state.moreBefore ? <div ref={olderRef} className="live-older">
          {state.loadingOlder ? <span role="status">{live.loadingOlder}</span> : null}
          {state.olderFailed ? (
            <>
              <span>{live.olderFailed}</span>{' '}
              <button type="button" className="live-link" onClick={() => { void loadOlder(); }}>{live.loadOlder}</button>
            </>
          ) : null}
        </div> : null}
        {state.status === 'ready' && !state.messages.length ? <p className="live-empty">{live.empty}</p> : null}
        {state.messages.map((message) => (
          <LiveMessageView key={message.k} message={message} strings={strings} render={render} />
        ))}
        {state.running && !ended ? <p className="live-working" role="status">{live.working}</p> : null}
        {ended && state.messages.length ? (
          <div className="live-ended" role="alert">
            <strong>{live.endedTitle}</strong>
            <p>{live.ended}</p>
          </div>
        ) : null}
        <div ref={sentinel} className="live-bottom" />
      </section>

      {unseen > 0 ? (
        <button type="button" className="live-pill" onClick={jump}>
          {live.newMessages(unseen)}
        </button>
      ) : null}
    </main>
  );
}
