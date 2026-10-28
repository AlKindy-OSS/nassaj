import type { TFunction } from 'i18next';

import type { ChatMessage } from '../../types/types';

/** B-1699: reasons a scheduled wake-up hold closes (server WAKEUP_HOLD_CLOSE_REASONS). */
const WAKEUP_CLOSED_REASONS: ReadonlySet<string> = new Set([
  'expired', 'cap', 'total_cap', 'drain', 'listeners_gone', 'quota', 'disabled',
]);

/**
 * Text of a neutral notice row: known notice codes render translated, everything
 * else shows the server text as sent (B-1624).
 */
export function noticeText(message: Pick<ChatMessage, 'content' | 'noticeCode' | 'noticeReason'>,
  t: TFunction): string {
  if (message.noticeCode === 'scheduled_wakeup') return t('chatNotice.scheduledWakeup');
  if (message.noticeCode === 'scheduled_wakeup_closed' && WAKEUP_CLOSED_REASONS.has(message.noticeReason ?? '')) {
    return t(`chatNotice.wakeupClosed.${message.noticeReason}`);
  }
  return typeof message.content === 'string' ? message.content : '';
}
