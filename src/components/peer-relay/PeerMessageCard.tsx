import { ArrowUpRight, Check, CircleAlert, Clock, Loader2, MessagesSquare, Send, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveTextDirection } from '../../utils/textDirection';

import { peerDisplayState, type PeerDisplayState } from './peerDisplay';
import type { PeerMessageView } from './peerMessageStore';

/** Causes on a delivered row that do not change its meaning (a repair confirmed delivery). */
const NEUTRAL_DELIVERED_CAUSES = new Set(['repaired']);

const STATE_ICON: Record<PeerDisplayState, LucideIcon> = {
  queued: Clock,
  deferred: Clock,
  delivering: Loader2,
  delivered: Check,
  refused: XCircle,
  failed: CircleAlert,
};

const PROBLEM_STATES = new Set<PeerDisplayState>(['refused', 'failed']);

const timeOf = (ms: number, locale: string): string | null => {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
};

export interface PeerMessageCardProps {
  message: PeerMessageView;
  /** The session this chat shows; decides inbound (bubble) vs outbound (status card). */
  currentSessionId: string;
  /** Display name of the target session, when the viewer's session list knows it. */
  targetName?: string | null;
  /** Present only when the viewer can open the other session. */
  onOpenSession?: (sessionId: string) => void;
}

function useStateLabel(message: PeerMessageView) {
  const { t } = useTranslation('chat');
  const state = peerDisplayState(message);
  const label = t(`peerRelay.state.${state}`);
  const cause = message.cause && !(state === 'delivered' && NEUTRAL_DELIVERED_CAUSES.has(message.cause))
    ? t(`peerRelay.cause.${message.cause}`, { defaultValue: t('peerRelay.cause.unknown', { code: message.cause }) })
    : null;
  return { state, label, cause: state === 'queued' ? null : cause };
}

function StatusChip({ state, label }: { state: PeerDisplayState; label: string }) {
  const Icon = STATE_ICON[state];
  const tone = PROBLEM_STATES.has(state) ? 'text-[color:var(--session-peer-problem)]' : 'text-[color:var(--session-peer-accent)]';
  return (
    <span className={`ms-auto inline-flex flex-shrink-0 items-center gap-1 ${tone}`} data-peer-state={state}>
      <Icon className={`h-3 w-3 ${state === 'delivering' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Session name as a link when the viewer can open it, plain text otherwise. */
function SessionName({ name, sessionId, onOpenSession, linkLabel }: {
  name: string; sessionId: string; onOpenSession?: (sessionId: string) => void; linkLabel: string;
}) {
  if (!onOpenSession) return <bdi className="font-semibold">{name}</bdi>;
  return (
    <button
      type="button"
      onClick={() => onOpenSession(sessionId)}
      aria-label={linkLabel}
      className="inline-flex min-w-0 items-center gap-0.5 rounded-sm font-semibold underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-peer-accent)]"
    >
      <bdi className="truncate">{name}</bdi>
      <ArrowUpRight className="h-3 w-3 flex-shrink-0 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}

/**
 * ADR-219 S1 (T-2072) — one cross-session message in the chat timeline.
 *
 * In the TARGET session: an inbound bubble «رسالة من جلسة أخرى · <name>»,
 * never styled as the user (no user-bubble token, start-aligned margin rule on
 * the fixed --session-peer-* tokens). In the SENDER session: an outbound status
 * card with the target and a live state. Name, direction and state come from
 * the frame fields only; the body is plain text (React text node, no markup,
 * no auto-links).
 */
export default function PeerMessageCard({ message, currentSessionId, targetName, onOpenSession }: PeerMessageCardProps) {
  const { t, i18n } = useTranslation('chat');
  const { state, label, cause } = useStateLabel(message);
  const inbound = message.toSessionId === currentSessionId;
  const time = timeOf(message.createdAt, i18n.language);
  const dir = resolveTextDirection(message.body) ?? undefined;

  if (inbound) {
    const name = message.fromName || t('peerRelay.unknownSession');
    return (
      <div className="px-3 sm:px-0">
        <article
          className="w-full rounded-e-md border-s-[3px] border-[color:var(--session-peer-rule)] bg-[color:var(--session-peer-surface)] pb-2 pe-3 ps-3 pt-1.5"
          data-peer-message="inbound"
          aria-label={t('peerRelay.inbound.ariaLabel', { name })}
        >
          <header className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <MessagesSquare className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--session-peer-accent)]" aria-hidden="true" />
            <span className="inline-flex min-w-0 items-center gap-1 text-[color:var(--session-peer-accent)]">
              <span className="font-semibold">{t('peerRelay.inbound.heading')}</span>
              <span aria-hidden="true">·</span>
              <SessionName
                name={name}
                sessionId={message.fromSessionId}
                onOpenSession={onOpenSession}
                linkLabel={t('peerRelay.openSession', { name })}
              />
            </span>
            {time && <span aria-hidden="true">·</span>}
            {time && <time dateTime={new Date(message.createdAt).toISOString()}>{time}</time>}
            <StatusChip state={state} label={label} />
          </header>
          <div className="whitespace-pre-wrap break-words text-sm text-foreground" dir={dir} data-peer-body>
            {message.body}
          </div>
          {cause && <p className="mt-1 text-xs text-muted-foreground">{cause}</p>}
        </article>
      </div>
    );
  }

  const target = targetName || t('peerRelay.unknownSession');
  const preview = message.summary || message.body;
  const previewDir = resolveTextDirection(preview) ?? undefined;
  return (
    <div className="px-3 sm:px-0">
      <article
        className="ms-auto w-full max-w-md rounded-md border border-[color:var(--session-peer-rule)] bg-[color:var(--session-peer-surface)] px-3 py-2"
        data-peer-message="outbound"
        aria-label={t('peerRelay.outbound.ariaLabel', { name: target, state: label })}
      >
        <header className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <Send className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--session-peer-accent)] rtl:-scale-x-100" aria-hidden="true" />
          <span className="inline-flex min-w-0 items-center gap-1 text-[color:var(--session-peer-accent)]">
            <span className="font-semibold">{t('peerRelay.outbound.heading')}</span>
            <SessionName
              name={target}
              sessionId={message.toSessionId}
              onOpenSession={onOpenSession}
              linkLabel={t('peerRelay.openSession', { name: target })}
            />
          </span>
          {time && <span aria-hidden="true">·</span>}
          {time && <time dateTime={new Date(message.createdAt).toISOString()}>{time}</time>}
          <span role="status" aria-live="polite" className="ms-auto inline-flex">
            <StatusChip state={state} label={label} />
          </span>
        </header>
        <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-foreground" dir={previewDir} data-peer-body>
          {preview}
        </p>
        {cause && (
          <p className={`mt-1 text-xs ${PROBLEM_STATES.has(state) ? 'text-[color:var(--session-peer-problem)]' : 'text-muted-foreground'}`} data-peer-cause>
            {cause}
          </p>
        )}
      </article>
    </div>
  );
}
