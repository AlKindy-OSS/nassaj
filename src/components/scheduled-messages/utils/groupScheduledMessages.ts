import type { ScheduledMessage } from '../../chat/hooks/useScheduledMessages';

export type ScheduledMessageGroup = 'failed' | 'today' | 'tomorrow' | 'later';

function nextLocalDay(value: Date, days: number): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days).getTime();
}

/** Group messages by the viewer's local calendar, including DST boundaries. */
export function groupScheduledMessages(
  messages: ScheduledMessage[],
  now = new Date(),
): Record<ScheduledMessageGroup, ScheduledMessage[]> {
  const tomorrow = nextLocalDay(now, 1);
  const afterTomorrow = nextLocalDay(now, 2);
  const groups: Record<ScheduledMessageGroup, ScheduledMessage[]> = { failed: [], today: [], tomorrow: [], later: [] };
  for (const message of messages) {
    if (message.status === 'failed') {
      groups.failed.push(message);
      continue;
    }
    const timestamp = Date.parse(message.scheduledFor);
    if (timestamp < tomorrow) groups.today.push(message);
    else if (timestamp < afterTomorrow) groups.tomorrow.push(message);
    else groups.later.push(message);
  }
  groups.failed.sort((a, b) => Date.parse(b.updatedAt || b.scheduledFor) - Date.parse(a.updatedAt || a.scheduledFor));
  return groups;
}
