import { describe, expect, it } from 'vitest';

import type { SessionWithProvider } from '../types/types';

import { selectClosedVisibleSessions } from './utils';

/**
 * The hide-closed sidebar filter. Owner asked for two things about closed rows:
 * fainter (that lives in SidebarSessionItem, guarded by its own test) and
 * hideable — this is the hideable half.
 *
 * The rules worth pinning are the ones a future refactor would quietly drop:
 * closure is read through `Boolean` because SQLite hands booleans back as 0/1
 * and legacy rows carry no field at all, and the session currently being read
 * survives the filter so the sidebar never yanks the open conversation out from
 * under its reader.
 */
const sessions: SessionWithProvider[] = [
  { id: 's1', summary: 'مفتوحة', __provider: 'claude' },
  { id: 's2', summary: 'مغلقة', closed: true, __provider: 'claude' },
  { id: 's3', summary: 'مغلقة من SQLite', closed: 1, __provider: 'codex' },
  { id: 's4', summary: 'مفتوحة صراحةً', closed: 0, __provider: 'codex' },
] as unknown as SessionWithProvider[];

const ids = (list: SessionWithProvider[]) => list.map((session) => session.id);

describe('selectClosedVisibleSessions', () => {
  it('returns the list untouched while the filter is off', () => {
    const result = selectClosedVisibleSessions(sessions, { hideClosed: false });
    // Identity, not just equality: an unfiltered list must not cost the row list
    // a new array (and a re-render) on every keystroke elsewhere in the sidebar.
    expect(result).toBe(sessions);
  });

  it('drops closed rows — including the 0/1 SQLite shape — while it is on', () => {
    const result = selectClosedVisibleSessions(sessions, { hideClosed: true });
    expect(ids(result)).toEqual(['s1', 's4']);
  });

  it('keeps the conversation the user is currently reading', () => {
    const result = selectClosedVisibleSessions(sessions, { hideClosed: true, keepSessionId: 's2' });
    expect(ids(result)).toEqual(['s1', 's2', 's4']);
  });

  it('returns the same array when the filter removes nothing', () => {
    const open = sessions.filter((session) => !session.closed);
    expect(selectClosedVisibleSessions(open, { hideClosed: true })).toBe(open);
  });

  it('can empty a project entirely — an all-closed project shows no rows', () => {
    const allClosed = sessions.filter((session) => Boolean(session.closed));
    expect(selectClosedVisibleSessions(allClosed, { hideClosed: true })).toEqual([]);
  });
});
