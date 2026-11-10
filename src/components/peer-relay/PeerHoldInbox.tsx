import { useEffect, useMemo, useState } from 'react';
import { MailQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../shared/view/ui';

import PeerHoldCard from './PeerHoldCard';
import { loadPeerHoldInbox, selectPeerHoldInbox, usePeerHolds, type PeerHoldView } from './peerHoldStore';

/** How often the inbox re-reads the server while the page is visible (frames reach open sessions only). */
const INBOX_REFRESH_MS = 60_000;

/** Escape inside an open deliver/reject step leaves the step first; the next Escape closes the dialog. */
const keepOpenDuringStep = (event: KeyboardEvent) => {
  const target = event.target as Element | null;
  if (target?.closest?.('[data-peer-hold-step]')) event.preventDefault();
};

/**
 * The caller's held holds, kept honest against the server: a hold the last
 * inbox read did not return was decided elsewhere, unless it arrived by frame
 * after that read.
 */
function useInboxHolds(userId: number | null): PeerHoldView[] {
  const all = usePeerHolds();
  const [server, setServer] = useState<{ ids: ReadonlySet<string>; at: number } | null>(null);
  useEffect(() => {
    if (userId === null) return undefined;
    let alive = true;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const at = Date.now();
      void loadPeerHoldInbox().then((ids) => { if (alive && ids) setServer({ ids: new Set(ids), at }); });
    };
    refresh();
    const timer = window.setInterval(refresh, INBOX_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [userId]);
  return useMemo(() => selectPeerHoldInbox(all, userId)
    .filter((h) => !server || server.ids.has(h.id) || h.updatedAt > server.at), [all, userId, server]);
}

/**
 * ADR-219 P2a-min (T-2074) — sidebar entry for messages waiting on the
 * signed-in member's approval. Hidden while nothing waits, like the pending
 * actions banner. The dialog keeps a card the owner just decided visible (with
 * its new state) until it closes.
 */
export default function PeerHoldInbox({ userId }: { userId: number | null }) {
  const { t } = useTranslation('chat');
  const waiting = useInboxHolds(userId);
  const all = usePeerHolds();
  const [openIds, setOpenIds] = useState<string[] | null>(null);
  // Closing after the last decision: the entry stays (as "none waiting") until focus,
  // which the dialog returns to it, moves on, so focus is never dropped to <body>.
  const [lingering, setLingering] = useState(false);
  const shown = useMemo(() => {
    if (!openIds) return [];
    const extra = waiting.filter((h) => !openIds.includes(h.id));
    return [...extra, ...openIds.map((id) => all.get(id)).filter((h): h is PeerHoldView => Boolean(h))];
  }, [openIds, waiting, all]);

  const close = () => {
    if (waiting.length === 0) setLingering(true);
    setOpenIds(null);
  };
  const empty = waiting.length === 0;
  if (userId === null || (empty && !openIds && !lingering)) return null;
  const label = empty ? t('peerRelay.inbox.empty') : t('peerRelay.inbox.button');
  return (
    <>
      <div className="px-3 py-0.5">
        <button
          type="button"
          onClick={() => { setLingering(false); setOpenIds(waiting.map((h) => h.id)); }}
          onBlur={() => { if (empty && !openIds) setLingering(false); }}
          aria-label={empty ? label : t('peerRelay.inbox.buttonAria', { label, count: waiting.length })}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg bg-[color:var(--session-peer-surface)] px-2 text-start text-xs font-medium text-[color:var(--session-peer-accent)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-peer-accent)]"
          data-peer-hold-inbox
        >
          <MailQuestion className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {!empty && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--session-peer-accent)] px-1 text-[9px] font-bold text-background" aria-hidden="true">
            {waiting.length}
          </span>}
        </button>
        <span role="status" className="sr-only">{lingering && empty ? t('peerRelay.inbox.emptyAnnounce') : ''}</span>
      </div>
      <Dialog open={openIds !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto p-0" onEscapeKeyDown={keepOpenDuringStep}>
          <DialogTitle className="not-sr-only px-5 pt-5 text-base font-semibold text-foreground">{t('peerRelay.inbox.title')}</DialogTitle>
          <DialogDescription className="px-5 pt-1 text-sm text-muted-foreground">{t('peerRelay.inbox.description')}</DialogDescription>
          <ul className="space-y-3 p-5" aria-label={t('peerRelay.inbox.title')}>
            {shown.length === 0 && <li className="text-sm text-muted-foreground">{t('peerRelay.inbox.empty')}</li>}
            {shown.map((hold) => (
              <li key={hold.id}>
                <PeerHoldCard hold={hold} currentSessionId={null} viewerUserId={userId} />
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
