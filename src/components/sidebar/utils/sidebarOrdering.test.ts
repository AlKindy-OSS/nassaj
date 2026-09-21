import { describe, expect, it } from 'vitest';

import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

import {
  compareProjects,
  compareSidebarSessions,
  getAllSessions,
  getProjectSortTime,
  sortProjects,
} from './utils';

/**
 * Deterministic sidebar ordering (owner report: "projects and conversations
 * move around at random").
 *
 * Two causes, both pinned here:
 *  - conversations were ordered by timestamp alone, so equal timestamps left
 *    the order to whatever the last payload happened to serialise;
 *  - projects were ordered by LAST ACTIVITY, which advances on every message,
 *    so the project being typed in climbed over its neighbours mid-sentence.
 *
 * The intended behaviour that must NOT change: a conversation keeps its place
 * while it is being worked on, i.e. ordering reads creation time, never
 * activity time.
 */
const session = (
  overrides: Partial<SessionWithProvider> & { id: string },
): SessionWithProvider => ({ __provider: 'claude', ...overrides }) as SessionWithProvider;

const ids = (list: SessionWithProvider[]) => list.map((entry) => entry.id);

const project = (overrides: Partial<Project> & { projectId: string }): Project =>
  ({
    displayName: overrides.projectId,
    fullPath: `/tmp/${overrides.projectId}`,
    ...overrides,
  }) as Project;

describe('compareSidebarSessions', () => {
  it('floats starred conversations above the rest', () => {
    const list = [
      session({ id: 'a', created_at: '2026-01-03T00:00:00Z' }),
      session({ id: 'b', created_at: '2026-01-01T00:00:00Z', starred: true }),
    ];
    expect(ids([...list].sort(compareSidebarSessions))).toEqual(['b', 'a']);
  });

  it('orders by creation time, newest first', () => {
    const list = [
      session({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      session({ id: 'new', created_at: '2026-03-01T00:00:00Z' }),
    ];
    expect(ids([...list].sort(compareSidebarSessions))).toEqual(['new', 'old']);
  });

  it('ignores last activity, so a conversation keeps its place while worked on', () => {
    const idle = session({ id: 'idle', created_at: '2026-03-01T00:00:00Z', lastActivity: '2026-03-01T00:00:00Z' });
    const busy = session({ id: 'busy', created_at: '2026-01-01T00:00:00Z', lastActivity: '2026-09-01T00:00:00Z' });
    expect(ids([idle, busy].sort(compareSidebarSessions))).toEqual(['idle', 'busy']);
  });

  it('breaks equal timestamps by id descending, whatever the input order', () => {
    const stamp = '2026-02-02T10:00:00Z';
    const forward = [
      session({ id: 's1', created_at: stamp }),
      session({ id: 's2', created_at: stamp }),
      session({ id: 's3', created_at: stamp }),
    ];
    const shuffled = [forward[1], forward[2], forward[0]];

    expect(ids([...forward].sort(compareSidebarSessions))).toEqual(['s3', 's2', 's1']);
    expect(ids([...shuffled].sort(compareSidebarSessions))).toEqual(['s3', 's2', 's1']);
  });

  it('keeps rows with no created_at deterministic instead of shuffling them', () => {
    const noDates = [
      session({ id: 'b' }),
      session({ id: 'c' }),
      session({ id: 'a' }),
    ];
    expect(ids([...noDates].sort(compareSidebarSessions))).toEqual(['c', 'b', 'a']);
  });

  it('treats an unparseable created_at as 0 rather than NaN', () => {
    const list = [
      session({ id: 'broken', created_at: 'not-a-date' }),
      session({ id: 'valid', created_at: '2026-01-01T00:00:00Z' }),
    ];
    // NaN would make every comparison false and leave the order to chance.
    expect(ids([...list].sort(compareSidebarSessions))).toEqual(['valid', 'broken']);
  });

  it('falls back to last activity only when no creation timestamp exists', () => {
    const list = [
      session({ id: 'legacy', lastActivity: '2026-05-01T00:00:00Z' }),
      session({ id: 'made', created_at: '2026-04-01T00:00:00Z' }),
    ];
    expect(ids([...list].sort(compareSidebarSessions))).toEqual(['legacy', 'made']);
  });
});

describe('getAllSessions parity', () => {
  it('sorts exactly as the shared comparator does, across provider buckets', () => {
    const stamp = '2026-02-02T10:00:00Z';
    const withSessions = project({
      projectId: 'p',
      sessions: [
        { id: 'claude-1', created_at: stamp },
        { id: 'claude-2', created_at: stamp },
      ],
      codexSessions: [{ id: 'codex-1', created_at: stamp }],
    } as unknown as Partial<Project> & { projectId: string });

    const fromHelper = getAllSessions(withSessions);
    const manual = [...fromHelper].sort(compareSidebarSessions);

    expect(ids(fromHelper)).toEqual(ids(manual));
    // Ids descending across buckets — the bucket a row came from must not
    // decide its position.
    expect(ids(fromHelper)).toEqual(['codex-1', 'claude-2', 'claude-1']);
  });

  it('is idempotent: re-sorting an already sorted list changes nothing', () => {
    const stamp = '2026-02-02T10:00:00Z';
    const list = [
      session({ id: 'x', created_at: stamp }),
      session({ id: 'y', created_at: stamp, starred: true }),
      session({ id: 'z' }),
    ];
    const once = [...list].sort(compareSidebarSessions);
    const twice = [...once].sort(compareSidebarSessions);
    expect(ids(twice)).toEqual(ids(once));
  });
});

describe('getProjectSortTime', () => {
  it('is the newest CREATION time, not the newest activity', () => {
    const target = project({
      projectId: 'p',
      sessions: [
        { id: 's1', created_at: '2026-01-01T00:00:00Z', lastActivity: '2026-09-09T00:00:00Z' },
        { id: 's2', created_at: '2026-02-01T00:00:00Z' },
      ],
    } as unknown as Partial<Project> & { projectId: string });

    expect(getProjectSortTime(target)).toBe(Date.parse('2026-02-01T00:00:00Z'));
  });

  it('scores a project with no sessions at 0 instead of throwing', () => {
    expect(getProjectSortTime(project({ projectId: 'empty' }))).toBe(0);
  });
});

describe('compareProjects', () => {
  const starred = project({ projectId: 'zeta', displayName: 'زيتا', isStarred: true });
  const alpha = project({ projectId: 'alpha', displayName: 'alpha' });
  const beta = project({ projectId: 'beta', displayName: 'beta' });

  it('floats starred projects to the top in both modes', () => {
    expect(ids2(sortProjects([alpha, beta, starred], 'name'))).toEqual(['zeta', 'alpha', 'beta']);
    expect(ids2(sortProjects([alpha, beta, starred], 'date'))).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('breaks an identical display name by projectId in name mode', () => {
    const first = project({ projectId: 'a-id', displayName: 'نفس الاسم' });
    const second = project({ projectId: 'b-id', displayName: 'نفس الاسم' });
    expect(ids2(sortProjects([second, first], 'name'))).toEqual(['a-id', 'b-id']);
    expect(ids2(sortProjects([first, second], 'name'))).toEqual(['a-id', 'b-id']);
  });

  it('does not move a project when one of its conversations gets a new message', () => {
    const quiet = project({
      projectId: 'quiet',
      displayName: 'quiet',
      sessions: [{ id: 'q1', created_at: '2026-05-01T00:00:00Z' }],
    } as unknown as Partial<Project> & { projectId: string });
    const busyBefore = project({
      projectId: 'busy',
      displayName: 'busy',
      sessions: [{ id: 'b1', created_at: '2026-01-01T00:00:00Z', lastActivity: '2026-01-01T00:00:00Z' }],
    } as unknown as Partial<Project> & { projectId: string });
    const busyAfter = project({
      projectId: 'busy',
      displayName: 'busy',
      sessions: [{ id: 'b1', created_at: '2026-01-01T00:00:00Z', lastActivity: '2026-09-03T12:00:00Z' }],
    } as unknown as Partial<Project> & { projectId: string });

    expect(ids2(sortProjects([busyBefore, quiet], 'date'))).toEqual(['quiet', 'busy']);
    expect(ids2(sortProjects([busyAfter, quiet], 'date'))).toEqual(['quiet', 'busy']);
  });

  it('keeps a project put when older pages of its sessions arrive', () => {
    const firstPage = project({
      projectId: 'paged',
      displayName: 'paged',
      sessions: [{ id: 'p2', created_at: '2026-06-01T00:00:00Z' }],
    } as unknown as Partial<Project> & { projectId: string });
    const secondPage = project({
      projectId: 'paged',
      displayName: 'paged',
      sessions: [
        { id: 'p2', created_at: '2026-06-01T00:00:00Z' },
        { id: 'p1', created_at: '2025-01-01T00:00:00Z' },
      ],
    } as unknown as Partial<Project> & { projectId: string });
    const other = project({
      projectId: 'other',
      displayName: 'other',
      sessions: [{ id: 'o1', created_at: '2026-07-01T00:00:00Z' }],
    } as unknown as Partial<Project> & { projectId: string });

    expect(ids2(sortProjects([firstPage, other], 'date'))).toEqual(['other', 'paged']);
    expect(ids2(sortProjects([secondPage, other], 'date'))).toEqual(['other', 'paged']);
  });

  it('orders session-less projects by name then id instead of at random', () => {
    const empties = [
      project({ projectId: 'c', displayName: 'same' }),
      project({ projectId: 'a', displayName: 'same' }),
      project({ projectId: 'b', displayName: 'same' }),
    ];
    expect(ids2(sortProjects(empties, 'date'))).toEqual(['a', 'b', 'c']);
    expect(ids2(sortProjects([...empties].reverse(), 'date'))).toEqual(['a', 'b', 'c']);
  });

  it('is used by sortProjects itself (parity guard)', () => {
    const list = [beta, starred, alpha];
    for (const order of ['name', 'date'] as const) {
      const manual = [...list].sort((a, b) => compareProjects(a, b, order));
      expect(ids2(sortProjects(list, order))).toEqual(ids2(manual));
    }
  });

  it('does not mutate the array it was given', () => {
    const list = [beta, alpha];
    sortProjects(list, 'name');
    expect(ids2(list)).toEqual(['beta', 'alpha']);
  });
});

function ids2(list: Project[]): string[] {
  return list.map((entry) => entry.projectId);
}
