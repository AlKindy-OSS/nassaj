export const SCHEDULED_MESSAGES_CHANGED_EVENT = 'nassaj:scheduled-messages-changed';

/** Notify metadata and list consumers after a successful local mutation. */
export function announceScheduledMessagesChanged(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULED_MESSAGES_CHANGED_EVENT));
}
