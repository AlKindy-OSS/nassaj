import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AtSign, LockKeyhole, MessageCircle, Send, Users, X } from 'lucide-react';

import { useOptionalAuth } from '../auth/context/AuthContext';
import { cn } from '../../lib/utils';

import {
  createInternalRoom, getInternalMessages, getInternalRoom, markInternalRead, sendInternalMessage,
  type InternalMember, type InternalMessage, type InternalRoom,
} from './internalSessionChatApi';
import { clearInternalSessionChatState, setInternalMentionCount } from './internalSessionChatStore';
import { useInternalSessionChatRealtime, type InternalChatFrame } from './useInternalSessionChatRealtime';

type Props = { sessionId: string | null | undefined; enabled: boolean };
type Mode = 'provider' | 'internal';

const ACCENT_BUTTON = 'border-[color:var(--session-internal-accent)]/40 bg-[color:var(--session-internal-accent)]/15';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const bySequence = (list: InternalMessage[]) => [...list].sort((a, b) => a.sequence - b.sequence);
const upsert = (list: InternalMessage[], message: InternalMessage) =>
  bySequence([...list.filter((item) => item.id !== message.id), message]);

/** Message list; the author name comes from the server projection (ADR-187 DTO). */
function MessageList({ messages }: { messages: InternalMessage[] }) {
  const { t } = useTranslation('chat');
  if (messages.length === 0) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{t('internalChat.empty')}</div>;
  }
  return (
    <>
      {messages.map((message) => (
        <article
          key={message.id}
          className="border-[color:var(--session-internal-accent)]/20 bg-[color:var(--session-internal-accent)]/12 mb-3 max-w-[88%] rounded-xl border px-3 py-2 text-sm text-foreground"
        >
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {message.authorName ?? t('internalChat.unknownAuthor')}
          </p>
          <p className="whitespace-pre-wrap">{message.body}</p>
        </article>
      ))}
    </>
  );
}

type ComposerProps = {
  draft: string;
  setDraft: (value: string) => void;
  members: InternalMember[];
  canSend: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  onFocus: () => void;
  onSend: () => void;
};

/** Internal-mode composer: `@` completes ROOM members only, never files or provider context. */
function InternalComposer({ draft, setDraft, members, canSend, inputRef, onFocus, onSend }: ComposerProps) {
  const { t } = useTranslation('chat');
  const draftId = useId();
  const suggestions = useMemo(() => {
    const beforeCursor = draft.slice(0, inputRef.current?.selectionStart ?? draft.length);
    const query = beforeCursor.match(/@([^\s@]*)$/)?.[1]?.toLocaleLowerCase() ?? null;
    if (query === null) return [];
    return members.filter((member) => member.username.toLocaleLowerCase().includes(query)).slice(0, 6);
  }, [draft, members, inputRef]);
  const select = (member: InternalMember) => {
    const cursor = inputRef.current?.selectionStart ?? draft.length;
    setDraft(`${draft.slice(0, cursor).replace(/@[^\s@]*$/, `@${member.username} `)}${draft.slice(cursor)}`);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  return (
    <>
      <label className="sr-only" htmlFor={draftId}>{t('internalChat.draftLabel')}</label>
      <div className="relative">
        <textarea
          id={draftId}
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={onFocus}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); }
          }}
          placeholder={t('internalChat.placeholder')}
          className="min-h-20 w-full resize-none rounded-lg border border-border bg-muted/30 p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {suggestions.length > 0 && (
          <ul role="listbox" className="absolute bottom-full mb-1 w-full rounded-lg border border-border bg-popover p-1 shadow-lg">
            {suggestions.map((member) => (
              <li key={String(member.userId)} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(event) => { event.preventDefault(); select(member); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted"
                >
                  <AtSign className="size-3.5" aria-hidden />{member.username}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t('internalChat.notSentNote')}</span>
        <button
          type="button"
          disabled={!draft.trim() || !canSend}
          onClick={onSend}
          className={cn(ACCENT_BUTTON, 'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50')}
        >
          <Send className="size-3.5" aria-hidden />{t('internalChat.send')}
        </button>
      </div>
    </>
  );
}

/** Room state, REST snapshot and realtime frames for one session. */
function useInternalRoom(sessionId: string | null | undefined, enabled: boolean) {
  const [room, setRoom] = useState<InternalRoom | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  useEffect(() => {
    setRoom(null); setMessages([]);
    if (!enabled || !sessionId) return;
    const abort = new AbortController();
    void getInternalRoom(sessionId, abort.signal).then((next) => {
      if (!next) return;
      setRoom(next); setInternalMentionCount(sessionId, next.unreadMentionCount);
    });
    return () => abort.abort();
  }, [enabled, sessionId]);
  const snapshot = useCallback(async () => {
    if (!sessionId) return;
    const [nextRoom, nextMessages] = await Promise.all([getInternalRoom(sessionId), getInternalMessages(sessionId)]);
    if (!nextRoom) return;
    setRoom(nextRoom); setMessages(bySequence(nextMessages));
    setInternalMentionCount(sessionId, nextRoom.unreadMentionCount);
  }, [sessionId]);
  const onFrame = useCallback((frame: InternalChatFrame) => {
    if (!sessionId) return;
    if (frame.type === 'internal-chat.message.created') setMessages((current) => upsert(current, frame.message));
    if (frame.type === 'internal-chat.mention-state.changed') setInternalMentionCount(sessionId, frame.unreadMentionCount);
    if (frame.type === 'internal-chat.membership_revoked') {
      clearInternalSessionChatState(sessionId); setRoom(null); setMessages([]);
    }
  }, [sessionId]);
  // Connect only while this user holds a room; non-members never open a socket.
  useInternalSessionChatRealtime({ sessionId, enabled: enabled && room !== null, onFrame, onSnapshot: snapshot });
  return { room, setRoom, messages, setMessages };
}

/**
 * Isolated human-only room UI. It never receives or invokes the provider composer
 * callbacks, and renders NOTHING while the server capability is off (ADR-187 §4).
 */
export default function InternalSessionChat({ sessionId, enabled }: Props) {
  const { t } = useTranslation('chat');
  const auth = useOptionalAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('provider');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogLabel = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { room, setRoom, messages, setMessages } = useInternalRoom(sessionId, enabled);

  useEffect(() => { setOpen(false); setMode('provider'); setDraft(''); setError(null); }, [sessionId]);
  useEffect(() => { if (!room) setOpen(false); }, [room]);

  if (!sessionId || !enabled) return null;
  const members = room?.members ?? [];
  const isWriter = members.some((member) => String(member.userId) === String(auth?.user?.id) && member.role !== 'viewer');
  const openRoom = async () => {
    setOpen(true); setError(null);
    if (room) return;
    const next = await createInternalRoom(sessionId);
    if (!next) { setError(t('internalChat.createFailed')); return; }
    setRoom(next); setInternalMentionCount(sessionId, next.unreadMentionCount);
  };
  const loadMessages = async () => {
    const ordered = bySequence(await getInternalMessages(sessionId));
    setMessages(ordered);
    const highest = ordered.reduce((max, message) => Math.max(max, message.sequence), 0);
    if (highest && await markInternalRead(sessionId, highest)) setInternalMentionCount(sessionId, 0);
  };
  const send = async () => {
    const body = draft.trim();
    if (!body || !isWriter || sending) return;
    const ids = [...body.matchAll(/@([^\s@]+)/g)]
      .flatMap((match) => members.filter((member) => member.username === match[1]).map((member) => member.userId));
    setSending(true); setError(null);
    const created = await sendInternalMessage(sessionId, body, ids);
    setSending(false);
    if (!created) { setError(t('internalChat.sendFailed')); return; }
    setMessages((current) => upsert(current, created)); setDraft('');
  };
  // Shown with or without a room: a failed room creation must be visible too.
  const errorAlert = error ? <p role="alert" className="px-4 pb-2 pt-3 text-sm text-destructive">{error}</p> : null;
  const toggleMode = () => {
    setMode((current) => (current === 'internal' ? 'provider' : 'internal'));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <>
      <button
        type="button"
        onClick={openRoom}
        aria-haspopup="dialog"
        className={cn(FOCUS_RING, 'border-[color:var(--session-internal-accent)]/40 bg-[color:var(--session-internal-accent)]/10 inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium text-foreground')}
      >
        <MessageCircle className="size-3.5" aria-hidden />{t('internalChat.button')}
      </button>
      {open && (
        <div role="presentation" className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-5" onMouseDown={() => setOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogLabel}
            className="flex h-[min(42rem,92dvh)] w-full max-w-xl flex-col rounded-t-2xl bg-background shadow-2xl sm:rounded-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 id={dialogLabel} className="flex items-center gap-2 font-semibold">
                  <Users className="size-4 text-[color:var(--session-internal-accent)]" aria-hidden />{t('internalChat.title')}
                </h2>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <LockKeyhole className="size-3" aria-hidden />{t('internalChat.privacyNote')}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className={cn(FOCUS_RING, 'rounded p-2 hover:bg-muted')} aria-label={t('internalChat.close')}>
                <X className="size-4" aria-hidden />
              </button>
            </header>
            {!room && (
              <>
                {errorAlert}
                <div className="m-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('internalChat.unavailable')}</div>
              </>
            )}
            {room && (
              <>
                <div className="flex-1 overflow-y-auto p-4" aria-live="polite"><MessageList messages={messages} /></div>
                {errorAlert}
                <div className="border-t border-border p-3">
                  <button
                    type="button"
                    aria-pressed={mode === 'internal'}
                    onClick={toggleMode}
                    className={cn(FOCUS_RING, 'mb-2 rounded-md px-2 py-1 text-xs font-medium', mode === 'internal' ? 'bg-[color:var(--session-internal-accent)]/20 text-foreground' : 'bg-muted text-muted-foreground')}
                  >
                    {t('internalChat.modeToggle')}
                  </button>
                  {mode === 'internal' && (
                    <InternalComposer
                      draft={draft}
                      setDraft={setDraft}
                      members={members}
                      canSend={isWriter && !sending}
                      inputRef={inputRef}
                      onFocus={() => void loadMessages()}
                      onSend={() => void send()}
                    />
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
