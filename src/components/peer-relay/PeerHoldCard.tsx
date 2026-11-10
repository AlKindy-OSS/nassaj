import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Ban, Check, CircleAlert, Hourglass, Loader2, MailQuestion, Send, XCircle, type LucideIcon } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { resolveTextDirection } from '../../utils/textDirection';

import { PeerChip, SessionName } from './PeerMessageCard';
import { timeOf } from './peerDisplay';
import { holdTimeLeft, peerHoldDisplayState, splitVisibleBody, type PeerHoldDisplayState } from './peerHoldDisplay';
import { REJECT_REASON_MAX } from './peerHoldActions';
import type { PeerHoldView } from './peerHoldStore';
import type { PeerMessageView } from './peerMessageStore';
import { usePeerHoldDecision, type PeerHoldDecision } from './usePeerHoldDecision';

const STATE_ICON: Record<PeerHoldDisplayState, LucideIcon> = {
  held: Hourglass, approved: Loader2, delivered: Check, failed: CircleAlert,
  rejected: XCircle, expired: Hourglass, cancelled: Ban,
};
const PROBLEM = new Set<PeerHoldDisplayState>(['failed', 'rejected', 'expired', 'cancelled']);
const MUTED = 'text-[color:var(--session-peer-muted)]';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-peer-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-background';
const BUTTON = `inline-flex h-[var(--control-height-compact)] items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS}`;
const PRIMARY = `${BUTTON} bg-[color:var(--session-peer-accent)] text-background hover:opacity-90`;
const SECONDARY = `${BUTTON} border border-[color:var(--session-peer-rule)] bg-background text-foreground hover:bg-muted`;
const DANGER = `${BUTTON} border border-[color:var(--session-peer-problem)] bg-background text-[color:var(--session-peer-problem)] hover:bg-muted`;

export interface PeerHoldCardProps {
  hold: PeerHoldView;
  /** The peer message the server created on approval, when this client has it. */
  linked?: PeerMessageView | null;
  /** The session this chat shows; null in the inbox. Decides sender vs decision card. */
  currentSessionId: string | null;
  /** The signed-in member; only the hold's target owner gets the buttons. */
  viewerUserId: number | null;
  onOpenSession?: (sessionId: string) => void;
}

/** Re-renders every `intervalMs` while `active`, for the expiry countdown. */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** The plain-words cause line of a hold, or null. */
function useCauseLine(hold: PeerHoldView, state: PeerHoldDisplayState, linked: PeerMessageView | null): string | null {
  const { t } = useTranslation('chat');
  if (state === 'failed' && linked?.cause) {
    return t(`peerRelay.cause.${linked.cause}`, { defaultValue: t('peerRelay.cause.unknown', { code: linked.cause }) });
  }
  if (!hold.cause || state === 'approved' || state === 'delivered') return null;
  return t(`peerRelay.hold.cause.${hold.cause}`, { defaultValue: t('peerRelay.cause.unknown', { code: hold.cause }) });
}

/** Live state chip; `who` (sender or target) prefixes it for screen readers so announcements name the card. */
function HoldChip({ state, label, who }: { state: PeerHoldDisplayState; label: string; who: string }) {
  return (
    <span role="status" aria-live="polite" className="ms-auto inline-flex">
      <span className="sr-only">{who}: </span>
      <PeerChip icon={STATE_ICON[state]} label={label} state={state} problem={PROBLEM.has(state)} spin={state === 'approved'} />
    </span>
  );
}

/** Time left before the 72 h expiry, in full locale words (plural-aware units). */
function TimeLeft({ expiresAt }: { expiresAt: number }) {
  const { t, i18n } = useTranslation('chat');
  const now = useNow(30_000, true);
  const left = holdTimeLeft(expiresAt, now);
  if (!left) return <p className={`text-xs ${MUTED}`} data-peer-hold-time>{t('peerRelay.hold.timeUp')}</p>;
  const unit = (value: number, name: 'hour' | 'minute') =>
    new Intl.NumberFormat(i18n.language, { style: 'unit', unit: name, unitDisplay: 'long' }).format(value);
  const text = left.hours > 0
    ? t('peerRelay.hold.timeLeft', { hours: unit(left.hours, 'hour'), minutes: unit(left.minutes, 'minute') })
    : t('peerRelay.hold.timeLeftMinutes', { minutes: unit(left.minutes, 'minute') });
  return <p className={`text-xs ${MUTED}`} data-peer-hold-time>{text}</p>;
}

/** Sender, session and the last run mode: every value from server fields, never the body. */
function HoldFacts({ hold, showTarget, onOpenSession }: {
  hold: PeerHoldView; showTarget: boolean; onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const member = hold.fromMemberName || t('peerRelay.hold.unknownMember');
  const session = hold.fromName || t('peerRelay.unknownSession');
  const target = hold.toName || t('peerRelay.unknownSession');
  const mode = hold.targetMode;
  // Per-mode words with the raw id kept in parentheses; an unknown id shows raw.
  const modeName = mode === null ? '' : t(`peerRelay.hold.modes.${mode}`, { defaultValue: '' });
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt className={MUTED}>{t('peerRelay.hold.from')}</dt>
      <dd className="min-w-0 text-foreground" data-peer-hold-from>
        <bdi className="font-semibold">{member}</bdi>
        <span aria-hidden="true"> · </span>
        <span className={MUTED}>{t('peerRelay.hold.sessionWord')} </span>
        <SessionName name={session} sessionId={hold.fromSessionId} onOpenSession={onOpenSession}
          linkLabel={t('peerRelay.openSession', { name: session })} />
      </dd>
      {showTarget && <dt className={MUTED}>{t('peerRelay.hold.to')}</dt>}
      {showTarget && <dd className="min-w-0 text-foreground"><bdi className="font-semibold">{target}</bdi></dd>}
      <dt className={MUTED}>{t('peerRelay.hold.modeLabel')}</dt>
      <dd className="min-w-0 text-foreground" data-peer-hold-mode>
        {mode === null && t('peerRelay.hold.modeUnknown')}
        {mode !== null && modeName && <span className="font-semibold">{modeName} </span>}
        {mode !== null && (modeName ? <>(<bdi className="font-mono">{mode}</bdi>)</> : <bdi className="font-mono font-semibold">{mode}</bdi>)}
        {' '}<span className={MUTED}>{t('peerRelay.hold.modeNote')}</span>
      </dd>
    </dl>
  );
}

/**
 * The full body exactly as the server rendered it, no clamp, no markup. Each
 * `⟨U+XXXX⟩` token is isolated LTR (so runs of tokens never reverse) and read
 * out as "hidden character U+XXXX".
 */
function HoldBody({ hold }: { hold: PeerHoldView }) {
  const { t } = useTranslation('chat');
  const captionId = useId();
  return (
    <figure className="m-0">
      <div
        role="group"
        aria-label={t('peerRelay.hold.bodyLabel')}
        aria-describedby={captionId}
        className="whitespace-pre-wrap break-words rounded border border-[color:var(--session-peer-rule)] bg-background px-2 py-1.5 text-sm text-foreground"
        dir={resolveTextDirection(hold.bodyVisible) ?? undefined}
        data-peer-hold-body
      >
        {splitVisibleBody(hold.bodyVisible).map((part, index) => (part.token
          ? (
            <bdi key={index} dir="ltr" data-peer-hold-token={part.code}>
              <span aria-hidden="true">{part.text}</span>
              <span className="sr-only">{t('peerRelay.hold.hiddenChar', { code: part.code })}</span>
            </bdi>
          )
          : part.text))}
      </div>
      <figcaption id={captionId} className={`mt-0.5 text-[11px] ${MUTED}`}>
        {/* The token is LTR inside RTL prose; isolate it so ⟨U+…⟩ is not reordered. */}
        <Trans t={t} i18nKey="peerRelay.hold.bodyNote" components={{ token: <bdi dir="ltr" className="font-mono" /> }} />
      </figcaption>
    </figure>
  );
}

/** Moves focus into each step, and back to the button that opened it on cancel. */
function useStepFocus(decision: PeerHoldDecision, refs: {
  deliver: RefObject<HTMLButtonElement | null>; reject: RefObject<HTMLButtonElement | null>;
  confirm: RefObject<HTMLButtonElement | null>; reason: RefObject<HTMLTextAreaElement | null>;
}) {
  const previous = useRef(decision.phase);
  useEffect(() => {
    const prev = previous.current;
    previous.current = decision.phase;
    if (decision.phase === 'confirmDeliver') refs.confirm.current?.focus();
    else if (decision.phase === 'confirmReject') refs.reason.current?.focus();
    else if (decision.phase === 'idle' && (prev === 'confirmDeliver' || prev === 'confirmReject')) {
      (decision.origin === 'reject' ? refs.reject : refs.deliver).current?.focus();
    }
  }, [decision.phase, decision.origin, refs]);
}

/** Deliver / reject with a confirm step; rendered only for the target owner while held. */
function HoldActions({ decision }: { decision: PeerHoldDecision }) {
  const { t } = useTranslation('chat');
  const reasonId = useId();
  const promptId = useId();
  const [refs] = useState(() => ({
    deliver: { current: null as HTMLButtonElement | null }, reject: { current: null as HTMLButtonElement | null },
    confirm: { current: null as HTMLButtonElement | null }, reason: { current: null as HTMLTextAreaElement | null },
  }));
  useStepFocus(decision, refs);
  const sending = decision.phase === 'sending';
  const inStep = decision.phase === 'confirmDeliver' || decision.phase === 'confirmReject';
  const rejecting = decision.phase === 'confirmReject' || (sending && decision.origin === 'reject');
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && inStep) { event.preventDefault(); decision.cancel(); }
  };
  return (
    <div className="mt-2 space-y-2" data-peer-hold-actions data-peer-hold-step={inStep || sending ? '' : undefined} onKeyDown={onKeyDown}>
      {(inStep || sending) && (
        <p id={promptId} className="text-xs text-foreground" data-peer-hold-confirm={rejecting ? 'reject' : 'deliver'}>
          {t(rejecting ? 'peerRelay.hold.confirmRejectPrompt' : 'peerRelay.hold.confirmDeliverPrompt')}
        </p>
      )}
      {rejecting && (
        <div className="space-y-1">
          <label htmlFor={reasonId} className={`block text-xs ${MUTED}`}>{t('peerRelay.hold.reasonLabel')}</label>
          <textarea
            id={reasonId} ref={refs.reason} value={decision.reason} maxLength={REJECT_REASON_MAX} rows={2}
            readOnly={sending} onChange={(event) => decision.setReason(event.target.value)}
            className={`w-full resize-y rounded-md border border-[color:var(--session-peer-rule)] bg-background px-2 py-1 text-sm text-foreground ${FOCUS}`}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {decision.phase === 'idle' && <>
          <button type="button" ref={refs.deliver} className={PRIMARY} onClick={decision.askDeliver}>{t('peerRelay.hold.deliver')}</button>
          <button type="button" ref={refs.reject} className={DANGER} onClick={decision.askReject}>{t('peerRelay.hold.reject')}</button>
        </>}
        {(inStep || sending) && <>
          <button type="button" ref={refs.confirm} className={rejecting ? DANGER : PRIMARY}
            aria-describedby={promptId} aria-disabled={sending || undefined} aria-busy={sending || undefined}
            onClick={() => { if (!sending) void decision.confirm(); }}>
            {sending && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {sending ? t('peerRelay.hold.sending')
              : t(rejecting ? 'peerRelay.hold.confirmReject' : 'peerRelay.hold.confirmDeliver')}
          </button>
          <button type="button" className={SECONDARY} aria-disabled={sending || undefined}
            onClick={() => { if (!sending) decision.cancel(); }}>{t('peerRelay.hold.cancel')}</button>
        </>}
      </div>
    </div>
  );
}

/** After each finished request: focus the error when refused, else the card heading. */
function useOutcomeFocus(decision: PeerHoldDecision, heading: RefObject<HTMLElement | null>, error: RefObject<HTMLElement | null>) {
  const seen = useRef(decision.settled);
  useEffect(() => {
    if (decision.settled === seen.current) return;
    seen.current = decision.settled;
    (decision.error ? error : heading).current?.focus();
  }, [decision.settled, decision.error, heading, error]);
}

/** Target session timeline and inbox: the owner's approval card, read-only for everyone else. */
function DecisionCard({ hold, linked, currentSessionId, viewerUserId, onOpenSession }: PeerHoldCardProps) {
  const { t } = useTranslation('chat');
  const state = peerHoldDisplayState(hold, linked ?? null);
  const label = t(`peerRelay.hold.state.${state}`);
  const cause = useCauseLine(hold, state, linked ?? null);
  const decision = usePeerHoldDecision(hold);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  useOutcomeFocus(decision, headingRef, errorRef);
  const isOwner = viewerUserId !== null && viewerUserId === hold.toUserId;
  const held = state === 'held';
  return (
    <article
      className="w-full rounded-e-md border-s-[3px] border-[color:var(--session-peer-rule)] bg-[color:var(--session-peer-surface)] pb-2 pe-3 ps-3 pt-1.5"
      data-peer-hold="decision" data-peer-hold-id={hold.id} aria-labelledby={headingId}
    >
      <header className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <MailQuestion className="size-3.5 flex-shrink-0 text-[color:var(--session-peer-accent)]" aria-hidden="true" />
        <h3 id={headingId} ref={headingRef} tabIndex={-1}
          className={`rounded-sm text-xs font-semibold text-[color:var(--session-peer-accent)] ${FOCUS}`}>
          {t(held ? 'peerRelay.hold.headingHeld' : 'peerRelay.hold.heading')}
        </h3>
        <HoldChip state={state} label={label} who={hold.fromMemberName || t('peerRelay.hold.unknownMember')} />
      </header>
      <div className="space-y-1.5">
        <HoldFacts hold={hold} showTarget={currentSessionId !== hold.toSessionId} onOpenSession={onOpenSession} />
        {held && <TimeLeft expiresAt={hold.expiresAt} />}
        <HoldBody hold={hold} />
        {cause && <p className={`text-xs ${MUTED}`} data-peer-hold-cause>{cause}</p>}
        {state === 'rejected' && hold.rejectReason && (
          <p className={`text-xs ${MUTED}`} data-peer-hold-reason>
            {t('peerRelay.hold.reasonShown')} <bdi>{hold.rejectReason}</bdi>
          </p>
        )}
      </div>
      {decision.error && (
        <p ref={errorRef} tabIndex={-1} role="alert" data-peer-hold-error={decision.error}
          className={`mt-2 rounded-sm text-xs text-[color:var(--session-peer-problem)] ${FOCUS}`}>
          {t(`peerRelay.hold.error.${decision.error}`, { defaultValue: t('peerRelay.hold.error.unknown', { code: decision.error }) })}
        </p>
      )}
      {held && isOwner && <HoldActions decision={decision} />}
      {held && !isOwner && (
        <p className={`mt-2 text-xs ${MUTED}`} data-peer-hold-readonly>{t('peerRelay.hold.readOnly')}</p>
      )}
    </article>
  );
}

/** Sender session: the outbound card's notice states while the other member decides. */
function OutboundCard({ hold, onOpenSession }: PeerHoldCardProps) {
  const { t, i18n } = useTranslation('chat');
  const state = peerHoldDisplayState(hold, null);
  const label = t(`peerRelay.hold.outbound.${state}`, { defaultValue: t(`peerRelay.hold.state.${state}`) });
  const cause = useCauseLine(hold, state, null);
  const target = hold.toName || t('peerRelay.unknownSession');
  const time = timeOf(hold.createdAt, i18n.language);
  const preview = hold.summary || hold.bodyVisible;
  return (
    <article
      className="ms-auto w-full max-w-md rounded-md border border-[color:var(--session-peer-rule)] bg-[color:var(--session-peer-surface)] px-3 py-2"
      data-peer-hold="outbound" data-peer-hold-id={hold.id}
      aria-label={t('peerRelay.outbound.ariaLabel', { name: target, state: label })}
    >
      <header className={`flex flex-wrap items-center gap-1.5 text-[11px] ${MUTED}`}>
        <Send className="size-3.5 flex-shrink-0 text-[color:var(--session-peer-accent)] rtl:-scale-x-100" aria-hidden="true" />
        <span className="inline-flex min-w-0 items-center gap-1 text-[color:var(--session-peer-accent)]">
          <span className="font-semibold">{t('peerRelay.outbound.heading')}</span>
          <SessionName name={target} sessionId={hold.toSessionId} onOpenSession={onOpenSession}
            linkLabel={t('peerRelay.openSession', { name: target })} />
        </span>
        {time && <span aria-hidden="true">·</span>}
        {time && <time dateTime={new Date(hold.createdAt).toISOString()}>{time}</time>}
        <HoldChip state={state} label={label} who={target} />
      </header>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-foreground"
        dir={resolveTextDirection(preview) ?? undefined} data-peer-body>
        {preview}
      </p>
      <p className={`mt-1 text-xs ${PROBLEM.has(state) ? 'text-[color:var(--session-peer-problem)]' : MUTED}`} data-peer-cause>
        {state === 'held' ? t('peerRelay.hold.outbound.heldNote') : cause}
      </p>
    </article>
  );
}

/**
 * ADR-219 P2a-min (T-2074) — one cross-member message held for the target
 * owner's decision. In the SENDER session it is the outbound status card
 * («بانتظار الموافقة», rejected, expired, cancelled). In the TARGET session and
 * the inbox it is the approval card: sender, full body (hidden characters
 * visible), last run mode, time left, and — for the target owner only, while
 * held — «تسليم» / «رفض» with a confirm step. Every label comes from server
 * fields; the body is a React text node and is never parsed.
 */
export default function PeerHoldCard(props: PeerHoldCardProps) {
  const outbound = props.currentSessionId !== null
    && props.hold.fromSessionId === props.currentSessionId
    && props.hold.toSessionId !== props.currentSessionId;
  return (
    <div className="px-3 sm:px-0">
      {outbound ? <OutboundCard {...props} /> : <DecisionCard {...props} />}
    </div>
  );
}
