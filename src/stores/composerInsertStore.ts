/**
 * T-2037 — hands text to the chat composer from anywhere in the app (the Shell
 * tab's run strip attaches command output this way). It only ever INSERTS into
 * the draft: the user reviews, edits, sends or deletes it — nothing here sends.
 *
 * One consumer at a time (the mounted composer). Text offered while no composer
 * is mounted waits and is delivered on the next registration.
 */

type InsertConsumer = (text: string) => void;

let consumer: InsertConsumer | null = null;
const pending: string[] = [];
const insertListeners = new Set<() => void>();

/**
 * Notified on every offered insert (delivered now or queued). The composer's shell mode listens and
 * switches itself off: attached output must be reviewed as a chat draft, never
 * be one Enter away from running as a command.
 */
export function subscribeComposerInserts(listener: () => void): () => void {
  insertListeners.add(listener);
  return () => {
    insertListeners.delete(listener);
  };
}

/** Offers text to the composer draft. Returns true if a composer took it now. */
export function requestComposerInsert(text: string): boolean {
  if (!text) return false;
  for (const listener of insertListeners) listener();
  if (consumer) {
    consumer(text);
    return true;
  }
  pending.push(text);
  return false;
}

/**
 * Registers the composer as the consumer, delivering anything that waited.
 * Returns the unregister function.
 */
export function registerComposerInsertConsumer(next: InsertConsumer): () => void {
  consumer = next;
  while (pending.length > 0) {
    next(pending.shift() as string);
  }
  return () => {
    if (consumer === next) consumer = null;
  };
}

// Whether the composer is in shell mode. The draft autosave reads it: a shell
// command must never be restored after a reload as chat text (qa T-2037).
let shellModeActive = false;

export function setComposerShellModeActive(active: boolean): void {
  shellModeActive = active;
}

export function isComposerShellModeActive(): boolean {
  return shellModeActive;
}

/** Test helper. */
export function resetComposerInsertForTests(): void {
  consumer = null;
  pending.length = 0;
  insertListeners.clear();
  shellModeActive = false;
}
