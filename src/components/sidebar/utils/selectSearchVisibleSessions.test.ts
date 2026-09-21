import { describe, expect, it } from 'vitest';

import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';
import { normalizeForSearch, selectSearchVisibleSessions } from './utils';

/**
 * B-332 follow-up: a hit inside one conversation must show THAT conversation,
 * not its whole project. The representative regression case ensures a body hit
 * cannot expand every sibling session under the project.
 */

const project = { projectId: 'p1', displayName: 'sample-project', fullPath: '/workspace/sample-project' } as Project;

const sessions: SessionWithProvider[] = [
  { id: 's1', summary: 'إصلاح شريط المتصلين', __provider: 'claude' },
  { id: 's2', summary: 'Refactor the workflow badge', __provider: 'claude' },
  { id: 's3', summary: 'مراجعة الأرشيف', __provider: 'codex' },
];

const match = (sessionId: string, summary: string, projectId: string | null = 'p1') => ({
  sessionId,
  summary,
  provider: 'claude' as const,
  projectId,
});

const visible = (
  scope: 'all' | 'titles' | 'messages',
  query: string,
  matches: Array<ReturnType<typeof match>> = [],
) =>
  selectSearchVisibleSessions(project, sessions, {
    normalizedSearch: normalizeForSearch(query),
    scope,
    matchBySessionId: new Map(matches.map((entry) => [entry.sessionId, entry])),
  }).map((session) => session.id);

describe('selectSearchVisibleSessions', () => {
  it('returns every session when there is no query', () => {
    expect(visible('all', '')).toEqual(['s1', 's2', 's3']);
  });

  it('keeps only the conversation whose body matched', () => {
    expect(visible('all', 'presence', [match('s2', 'Refactor the workflow badge')])).toEqual(['s2']);
  });

  it('materialises a body match that is not in the loaded page', () => {
    expect(visible('messages', 'presence', [match('s99', 'محادثة قديمة لم تُحمَّل')])).toEqual(['s99']);
  });

  it('ignores body matches owned by another project', () => {
    // Nothing of this project matched → the project itself matched by name, so
    // the full list is the honest answer.
    expect(visible('messages', 'sample', [match('sX', 'elsewhere', 'p2')])).toEqual(['s1', 's2', 's3']);
  });

  it('keeps title matches and drops the rest', () => {
    expect(visible('titles', 'الأرشيف')).toEqual(['s3']);
  });

  it('ignores body matches when the scope is titles-only', () => {
    expect(visible('titles', 'الأرشيف', [match('s2', 'Refactor the workflow badge')])).toEqual(['s3']);
  });

  it('unions title and body matches in the default scope', () => {
    expect(visible('all', 'الأرشيف', [match('s1', 'إصلاح شريط المتصلين')])).toEqual(['s1', 's3']);
  });

  it('falls back to the full list when only the project name matched', () => {
    expect(visible('all', 'sample')).toEqual(['s1', 's2', 's3']);
  });
});
