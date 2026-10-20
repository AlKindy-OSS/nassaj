import type { InternalMessage } from './internalSessionChatApi';

type Timed = { timestamp?: string | number | Date };

export type TeamMessagePlacement = {
  /** `before[i]` renders just before chat message `i`. */
  before: InternalMessage[][];
  /** Newer than every visible chat message: rendered after the list. */
  trailing: InternalMessage[];
};

const timeOf = (value: string | number | Date | undefined): number | null => {
  if (value == null) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Places team messages (already in room sequence order) between the visible
 * chat messages by time. When older chat history is still unloaded, team
 * messages older than the first visible message are held back so they appear
 * with that history, not stacked above it.
 */
export function placeTeamMessages(
  chat: Timed[], team: InternalMessage[], olderHistoryHidden: boolean,
): TeamMessagePlacement {
  const before: InternalMessage[][] = chat.map(() => []);
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
