import type { TFunction } from 'i18next';

import type { ChatMessage } from '../../types/types';

/** B-1699: reasons a scheduled wake-up hold closes (server WAKEUP_HOLD_CLOSE_REASONS). */
const WAKEUP_CLOSED_REASONS: ReadonlySet<string> = new Set([
  'expired', 'cap', 'total_cap', 'drain', 'listeners_gone', 'quota', 'disabled',
]);

/** T-2113: disk errors the CLI names on `session_writes_lost`. */
const WRITES_LOST_REASONS: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT']);

/** T-2113: the cause, then one sentence per kind of write that was lost. */
function writesLostText(message: Pick<ChatMessage, 'noticeReason' | 'lostWrites'>, t: TFunction): string {
  const reason = WRITES_LOST_REASONS.has(message.noticeReason ?? '') ? message.noticeReason : 'unknown';
  const lost = message.lostWrites ?? [];
  return [
    t(`chatNotice.sessionWritesLost.${reason}`),
    ...(lost.includes('transcript') ? [t('chatNotice.sessionWritesLost.transcript')] : []),
    ...(lost.includes('global_config') ? [t('chatNotice.sessionWritesLost.globalConfig')] : []),
  ].join(' ');
}

/**
 * Text of a neutral notice row: known notice codes render translated, everything
 * else shows the server text as sent (B-1624).
 */
export function noticeText(
  message: Pick<ChatMessage, 'content' | 'noticeCode' | 'noticeReason' | 'lostWrites'>,
  t: TFunction,
): string {
  if (message.noticeCode === 'scheduled_wakeup') return t('chatNotice.scheduledWakeup');
  if (message.noticeCode === 'hook_no_verdict') {
    return t(`chatNotice.hookNoVerdict.${message.noticeReason === 'timed_out' ? 'timed_out' : 'no_answer'}`);
  }
  if (message.noticeCode === 'hook_failed') return t('chatNotice.hookFailed');
  if (message.noticeCode === 'session_writes_lost') return writesLostText(message, t);
  if (message.noticeCode === 'scheduled_wakeup_closed' && WAKEUP_CLOSED_REASONS.has(message.noticeReason ?? '')) {
    return t(`chatNotice.wakeupClosed.${message.noticeReason}`);
  }
  return typeof message.content === 'string' ? message.content : '';
}

/** T-2113: a notice with `audienceUserId` (the run owner) shows to that signed-in user only. */
export function isNoticeForUser(message: Pick<ChatMessage, 'audienceUserId'>,
  userId: number | string | null | undefined): boolean {
  return message.audienceUserId === undefined || String(message.audienceUserId) === String(userId ?? '');
}
