/**
 * The app's one replacement for the browser's native `confirm`/`alert`
 * (T-2039). A module-level FIFO queue that any code — React or not — can push
 * onto; `<DialogHost/>` renders the head of the queue with the themed
 * `ConfirmDialog`. One dialog is visible at a time; the next one opens when
 * the current one settles.
 *
 * Duplicate guard: while a request with the same kind, title, message and
 * tone is still pending, a second identical request does not queue a second
 * dialog. A duplicate confirm resolves `false` at once (so a double-clicked
 * destructive button runs its action once), a duplicate alert resolves at
 * once. `settleDialog` ignores every id except the visible one, so a double
 * click on a dialog button settles it once and never the next dialog.
 */
import { useSyncExternalStore } from 'react';

export type DialogTone = 'default' | 'danger';
export type DialogKind = 'confirm' | 'alert';

export interface DialogOptions {
  /** Optional heading; without it the message is the dialog's accessible name. */
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` = destructive action: red primary button and focus on Cancel. */
  tone?: DialogTone;
  /**
   * Verbatim text (a command, snippets) shown below the message in an LTR
   * monospace block, never interpreted as markup (T-2037).
   */
  code?: string;
}

export interface DialogRequest extends DialogOptions {
  id: number;
  kind: DialogKind;
  tone: DialogTone;
}

interface QueueEntry {
  request: DialogRequest;
  key: string;
  resolve: (accepted: boolean) => void;
}

type Listener = () => void;

let queue: readonly QueueEntry[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function normalize(options: DialogOptions | string): DialogOptions {
  return typeof options === 'string' ? { message: options } : options;
}

function enqueue(kind: DialogKind, input: DialogOptions | string): Promise<boolean> {
  const options = normalize(input);
  const tone = options.tone ?? 'default';
  const key = JSON.stringify([kind, options.title ?? '', options.message, tone, options.code ?? '']);
  if (queue.some((entry) => entry.key === key)) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const request: DialogRequest = { ...options, id: nextId++, kind, tone };
    queue = [...queue, { request, key, resolve }];
    emit();
  });
}

/** Asks a yes/no question. Resolves `true` only when the user confirms. */
export function confirmDialog(options: DialogOptions | string): Promise<boolean> {
  return enqueue('confirm', options);
}

/** Shows a message with a single OK button. Resolves when it is dismissed. */
export async function alertDialog(options: DialogOptions | string): Promise<void> {
  await enqueue('alert', options);
}

/** Settles the visible dialog. Ignored for any id that is not the visible one. */
export function settleDialog(id: number, accepted: boolean): void {
  const head = queue[0];
  if (!head || head.request.id !== id) return;
  queue = queue.slice(1);
  emit();
  head.resolve(head.request.kind === 'confirm' ? accepted : true);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The visible dialog request, or null when the queue is empty. */
export function getCurrentDialog(): DialogRequest | null {
  return queue[0]?.request ?? null;
}

/** Number of dialogs waiting, the visible one included. */
export function pendingDialogCount(): number {
  return queue.length;
}

/** React view of the queue: the visible request and a settle function. */
export function useDialogs(): { current: DialogRequest | null; settle: typeof settleDialog } {
  const current = useSyncExternalStore(subscribe, getCurrentDialog, getCurrentDialog);
  return { current, settle: settleDialog };
}

/** Test helper: cancels every pending dialog and empties the queue. */
export function resetDialogsForTests(): void {
  const pending = queue;
  queue = [];
  emit();
  for (const entry of pending) entry.resolve(false);
}
