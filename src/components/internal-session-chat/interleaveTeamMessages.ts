import type { InternalMessage } from './internalSessionChatApi';

type Timed = { timestamp?: string | number | Date };

export type TimelinePlacement<T> = {
  /** `before[i]` renders just before chat message `i`. */
  before: T[][];
  /** Newer than every visible chat message: rendered after the list. */
  trailing: T[];
};

export type TeamMessagePlacement = TimelinePlacement<InternalMessage>;

const timeOf = (value: string | number | Date | undefined): number | null => {
  if (value == null) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Places side-timeline items (team messages, ADR-219 peer messages), already in
 * time order, between the visible chat messages by `createdAt`. When older chat
 * history is still unloaded, items older than the first visible message are
 * held back so they appear with that history, not stacked above it.
 */
export function placeTeamMessages<T extends { createdAt?: string | number }>(
  chat: Timed[], team: T[], olderHistoryHidden: boolean,
): TimelinePlacement<T> {
  const before: T[][] = chat.map(() => []);
  let next = 0;
  if (olderHistoryHidden) {
    const first = chat.map((message) => timeOf(message.timestamp)).find((ms) => ms !== null) ?? null;
    if (first !== null) {
      while (next < team.length && (timeOf(team[next].createdAt) ?? Infinity) < first) next += 1;
    }
  }
  chat.forEach((message, index) => {
    const at = timeOf(message.timestamp);
    if (at === null) return;
    while (next < team.length && (timeOf(team[next].createdAt) ?? Infinity) < at) {
      before[index].push(team[next]);
      next += 1;
    }
  });
  return { before, trailing: team.slice(next) };
}
