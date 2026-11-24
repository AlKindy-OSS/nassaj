/**
 * T-2095: hand-off from a chat turn chip to the git panel's "Turn changes" tab.
 * The chip lives deep inside the message list, the panel beside it in
 * MainContent; one pending target plus subscribers joins them without prop
 * drilling. The panel takes the target once it has applied it.
 */

export type TurnChangesTarget = { sessionId: string; turnSeq: number };

type Listener = (target: TurnChangesTarget) => void;

let pending: TurnChangesTarget | null = null;
const listeners = new Set<Listener>();

/** Asks the app to show one session turn in the git panel. */
export function openTurnChanges(target: TurnChangesTarget): void {
  pending = { ...target };
  for (const listener of listeners) listener(pending);
}

/** Subscribes to turn requests; returns the unsubscribe function. */
export function subscribeTurnChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The latest unapplied target, left in place. */
export function peekTurnChangesTarget(): TurnChangesTarget | null {
  return pending;
}

/** The latest unapplied target, cleared so it is applied once. */
export function takeTurnChangesTarget(): TurnChangesTarget | null {
  const target = pending;
  pending = null;
  return target;
}
