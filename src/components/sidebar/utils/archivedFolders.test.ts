import { describe, expect, it } from 'vitest';

import type { ArchivedProjectListItem, ArchivedSessionListItem } from '../types/types';

import { buildArchivedFolders, formatCompactArchivedAge } from './archivedFolders';

const archivedProject = (projectId: string, sessions: Array<Record<string, unknown>> = []): ArchivedProjectListItem => ({
  projectId,
  name: projectId,
  displayName: `Project ${projectId}`,
  fullPath: `/work/${projectId}`,
  isArchived: true,
  sessions,
} as unknown as ArchivedProjectListItem);

const archivedSession = (overrides: Partial<ArchivedSessionListItem>): ArchivedSessionListItem => ({
  sessionId: 's',
  provider: 'claude',
  projectId: 'p-live',
  projectPath: '/work/p-live',
  projectDisplayName: 'Live project',
  sessionTitle: 'Title',
  createdAt: null,
  updatedAt: null,
  lastActivity: '2026-10-01T00:00:00.000Z',
  isProjectArchived: false,
  ...overrides,
});

describe('buildArchivedFolders', () => {
  it('shows an archived project without sessions as an empty archived folder', () => {
    const [folder] = buildArchivedFolders([archivedProject('p1')], []);
    expect(folder).toMatchObject({ key: 'p1', displayName: 'Project p1', isProjectArchived: true, sessions: [] });
  });

  it('nests an archived project sessions inside its folder (newest first), open-only', () => {
    const project = archivedProject('p1', [
      { id: 'a', summary: 'First', lastActivity: '2026-10-02T00:00:00.000Z' },
      { id: 'b', name: '  ', created_at: '2026-10-03T00:00:00.000Z' },
    ]);
    const [folder] = buildArchivedFolders([project], []);
    expect(folder.sessions.map((s) => [s.sessionId, s.sessionTitle, s.isSessionArchived])).toEqual([
      ['b', 'b', false],
      ['a', 'First', false],
    ]);
    expect(folder.latestActivity).toBe('2026-10-03T00:00:00.000Z');
  });

  it('merges explicitly archived sessions into their archived project folder without duplicates', () => {
    const project = archivedProject('p1', [{ id: 'a', summary: 'First' }]);
    const sessions = [archivedSession({ sessionId: 'a', projectId: 'p1', isProjectArchived: true })];
    const folders = buildArchivedFolders([project], sessions);
    expect(folders).toHaveLength(1);
    expect(folders[0].sessions).toHaveLength(1);
    expect(folders[0].sessions[0].isSessionArchived).toBe(true);
  });

  it('groups sessions of a non-archived project into a normal folder', () => {
    const folders = buildArchivedFolders([], [
      archivedSession({ sessionId: 'x' }),
      archivedSession({ sessionId: 'y', lastActivity: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ key: 'p-live', isProjectArchived: false, latestActivity: '2026-10-05T00:00:00.000Z' });
    expect(folders[0].sessions.every((s) => s.isSessionArchived)).toBe(true);
  });

  it('falls back to path or session key and sorts folders by newest activity', () => {
    const folders = buildArchivedFolders([archivedProject('old')], [
      archivedSession({ sessionId: 'n', projectId: null, projectPath: '/x', lastActivity: '2026-10-09T00:00:00.000Z' }),
      archivedSession({ sessionId: 'o', projectId: null, projectPath: null }),
    ]);
    expect(folders.map((f) => f.key)).toEqual(['/x', 'session:o', 'old']);
  });
});

describe('formatCompactArchivedAge', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  it.each([
    [null, ''],
    ['not a date', ''],
    ['2026-10-10T11:59:30.000Z', '<1m'],
    ['2026-10-10T11:15:00.000Z', '45m'],
    ['2026-10-10T09:00:00.000Z', '3hr'],
    ['2026-10-08T12:00:00.000Z', '2d'],
  ])('%s -> %s', (input, expected) => {
    expect(formatCompactArchivedAge(input, now)).toBe(expected);
  });
});
