import { useCallback, useEffect, useRef, useState } from 'react';

import { approvePeerHold, rejectPeerHold } from './peerHoldActions';
import type { PeerHoldView } from './peerHoldStore';

export type PeerHoldDecisionPhase = 'idle' | 'confirmDeliver' | 'confirmReject' | 'sending';
export type PeerHoldDecisionAction = 'deliver' | 'reject';

export type PeerHoldDecision = {
  phase: PeerHoldDecisionPhase;
  /** The button that opened the current or last step (focus returns to it on cancel). */
  origin: PeerHoldDecisionAction | null;
  reason: string;
  /** Server refusal code of the last attempt, cleared by the next step. */
  error: string | null;
  /** Bumps once per finished request (success or refusal), for focus handling. */
  settled: number;
  setReason: (reason: string) => void;
  askDeliver: () => void;
  askReject: () => void;
  cancel: () => void;
  confirm: () => Promise<void>;
};

/**
 * ADR-219 P2a-min — the owner's two-step decision on one held message.
 * Deliver and reject each need a confirm step; one request per confirm, and
 * a refusal returns to `idle` with its code (the card has already been
 * refreshed from the server's fresh hold), never a silent retry.
 */
export function usePeerHoldDecision(hold: PeerHoldView): PeerHoldDecision {
  const [phase, setPhase] = useState<PeerHoldDecisionPhase>('idle');
  const [origin, setOrigin] = useState<PeerHoldDecisionAction | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // A newer version is a different card: an open confirm step must not carry over to it.
  useEffect(() => {
    setPhase((current) => (current === 'sending' ? current : 'idle'));
  }, [hold.holdVersion]);

  const ask = useCallback((next: PeerHoldDecisionAction) => {
    setOrigin(next);
    setError(null);
    setPhase(next === 'deliver' ? 'confirmDeliver' : 'confirmReject');
  }, []);
  const cancel = useCallback(() => {
    setPhase((current) => (current === 'sending' ? current : 'idle'));
  }, []);

  const confirm = useCallback(async () => {
    if (phase !== 'confirmDeliver' && phase !== 'confirmReject') return;
    const action: PeerHoldDecisionAction = phase === 'confirmDeliver' ? 'deliver' : 'reject';
    setPhase('sending');
    const result = action === 'deliver' ? await approvePeerHold(hold) : await rejectPeerHold(hold, reason);
    if (!mounted.current) return;
    setPhase('idle');
    setError(result.ok ? null : result.code);
    if (result.ok) setReason('');
    setSettled((n) => n + 1);
  }, [hold, phase, reason]);

  return {
    phase, origin, reason, error, settled, setReason, cancel, confirm,
    askDeliver: () => ask('deliver'),
    askReject: () => ask('reject'),
  };
}
