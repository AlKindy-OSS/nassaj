/**
 * B-1668 items 1 and 5: a fresh first page reconciles with the rows loaded
 * before it, and the "load more" offset counts server-paged rows only.
 */
import { describe, expect, it } from 'vitest';

import type { Project, ProjectSession } from '../types/app';

import {
  addDeepLinkedRow,
  applyWindowRefresh,
  computeNextSessionOffset,
  computeWindowRefreshRequest,
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  tagServerPage,
  wasSessionRemoved,
} from './projectSessionPaging';

/** Row `n` minutes after a fixed start, so a larger n is more recent. */
const row = (id: string, minute: number, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: id,
  lastActivity: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  ...extra,
});

const project = (sessions: ProjectSession[], meta: Project['sessionMeta'] = {}): Project => ({
  projectId: 'p1',
  displayName: 'p1',
  fullPath: '/w/p1',
  sessions,
  sessionMeta: meta,
} as Project);

const ids = (target: Project): string[] => ((target.sessions as ProjectSession[]) ?? []).map((s) => s.id);

/** Rows r40..r21 (page one) and r20..r1 (page two), newest first. */
const pageOneRows = Array.from({ length: 20 }, (_, index) => row(`r${40 - index}`, 40 - index));
const pageTwoRows = Array.from({ length: 20 }, (_, index) => row(`r${20 - index}`, 20 - index));

/** Page one plus a "load more" page, as the client holds them. */
const loadedTwoPages = (hasMoreAfter: boolean): Project =>
  mergeProjectSessionPage(
    tagServerPage(project(pageOneRows, { total: 41, hasMore: true })),
    { sessions: pageTwoRows, sessionMeta: { total: 41, hasMore: hasMoreAfter } },
  );

describe('mergeExpandedSessionPages (item 1)', () => {
  it('drops a page-one row the fresh page no longer carries, keeps deeper rows and their hasMore', () => {
    const previous = loadedTwoPages(true);
    // r35 was deleted: the fresh page one shifts r20 up into it.
    const freshRows = [...pageOneRows.filter((s) => s.id !== 'r35'), row('r20', 20)];
    const { projects, deeperProjectIds } = mergeExpandedSessionPages(
      [previous],
      [project(freshRows, { total: 40, hasMore: true })],
    );

    expect(ids(projects[0])).not.toContain('r35');
    expect(ids(projects[0])).toContain('r1');
    expect(projects[0].sessionMeta?.hasMore).toBe(true);
    expect(deeperProjectIds).toEqual(['p1']);
  });

  it('keeps nothing beyond page one once the server says no more exist', () => {
    const previous = loadedTwoPages(false);
    // Twenty-two sessions were all loaded; two were deleted and page one now holds the rest.
    const freshRows = pageOneRows.slice(0, 20);
    const { projects, deeperProjectIds } = mergeExpandedSessionPages(
      [previous],
      [project(freshRows, { total: 20, hasMore: false })],
    );

    expect(ids(projects[0])).toEqual(freshRows.map((s) => s.id));
    expect(deeperProjectIds).toEqual([]);
  });

  it('drops a previously starred row the fresh page lacks', () => {
    const previous = tagServerPage(project([row('star', 1, { starred: true }), ...pageOneRows], { hasMore: true }));
    const { projects } = mergeExpandedSessionPages([previous], [project(pageOneRows, { hasMore: true })]);
    expect(ids(projects[0])).not.toContain('star');
  });

  it('keeps the deep-linked row, which the server page does not carry', () => {
    const previous = addDeepLinkedRow(tagServerPage(project(pageOneRows, { hasMore: true })), 'sessions', row('old', 0));
    const { projects, deeperProjectIds } = mergeExpandedSessionPages(
      [previous],
      [project(pageOneRows, { hasMore: true })],
    );
    expect(ids(projects[0])).toContain('old');
    expect(deeperProjectIds).toEqual([]);
  });

  it('takes renamed page-one rows from the fresh payload', () => {
    const previous = tagServerPage(project(pageOneRows, { hasMore: false }));
    const renamed = pageOneRows.map((s) => (s.id === 'r40' ? { ...s, summary: 'renamed' } : s));
    const { projects } = mergeExpandedSessionPages([previous], [project(renamed, { hasMore: false })]);
    expect((projects[0].sessions as ProjectSession[])[0].summary).toBe('renamed');
  });
});

describe('computeNextSessionOffset (item 5)', () => {
  it('does not count a deep-linked older row', () => {
    const loaded = addDeepLinkedRow(tagServerPage(project(pageOneRows, { hasMore: true })), 'sessions', row('old', 0));
    expect(computeNextSessionOffset(loaded)).toBe(20);
  });

  it('counts the deep-linked row once a server page carries it', () => {
    const loaded = addDeepLinkedRow(tagServerPage(project(pageOneRows, { hasMore: true })), 'sessions', row('r20', 20));
    const merged = mergeProjectSessionPage(loaded, { sessions: pageTwoRows, sessionMeta: { hasMore: false } });
    const linked = (merged.sessions as ProjectSession[]).find((s) => s.id === 'r20');
    expect(linked?.__deepLinked).toBeFalsy();
    expect(computeNextSessionOffset(merged)).toBe(40);
  });

  it('starring a loaded row leaves the offset unchanged', () => {
    const starredFirst = pageOneRows.map((s, index) => (index === 5 ? { ...s, starred: true } : s));
    const loaded = tagServerPage(project(starredFirst, { hasMore: true }));
    expect(computeNextSessionOffset(loaded)).toBe(20);
  });

  it('a row unstarred while older than the paged window does not shift the offset', () => {
    // Starred row from page one, much older than the unstarred window, now unstarred.
    const loaded = tagServerPage(project([row('was-starred', 0, { starred: true }), ...pageOneRows], { hasMore: true }));
    const unstarred = {
      ...loaded,
      sessions: (loaded.sessions as ProjectSession[]).map((s) => (s.id === 'was-starred' ? { ...s, starred: false } : s)),
    } as Project;
    expect(computeNextSessionOffset(unstarred)).toBe(20);
  });

  it('a row unstarred inside the window counts as an unstarred row', () => {
    const loaded = tagServerPage(project([row('was-starred', 30, { starred: true }), ...pageOneRows.slice(0, 19)]));
    const unstarred = {
      ...loaded,
      sessions: (loaded.sessions as ProjectSession[]).map((s) => (s.id === 'was-starred' ? { ...s, starred: false } : s)),
    } as Project;
    // 19 paged rows + the one newer than the boundary; the server pages 20 unstarred at offset 20 - 0.
    expect(computeNextSessionOffset(unstarred)).toBe(20);
  });
});

describe('mergeProjectSessionPage', () => {
  it('takes hasMore from the server, never from a loaded count', () => {
    const loaded = tagServerPage(project(pageOneRows, { total: 99, hasMore: true }));
    const merged = mergeProjectSessionPage(loaded, { sessions: pageTwoRows, sessionMeta: { total: 99, hasMore: false } });
    expect(merged.sessionMeta?.hasMore).toBe(false);
  });

  it('keeps the loaded copy of a row over a late page copy', () => {
    const loaded = tagServerPage(project([row('a', 5, { summary: 'new title' })]));
    const merged = mergeProjectSessionPage(loaded, { sessions: [row('a', 5, { summary: 'old title' })] });
    expect((merged.sessions as ProjectSession[])[0].summary).toBe('new title');
  });
});

describe('window refresh', () => {
  it('requests every loaded unstarred row after the starred prefix', () => {
    const loaded = mergeProjectSessionPage(
      tagServerPage(project([row('s', 0, { starred: true }), ...pageOneRows], { hasMore: true })),
      { sessions: pageTwoRows, sessionMeta: { hasMore: true } },
    );
    expect(computeWindowRefreshRequest(loaded)).toEqual({ limit: 40, offset: 1 });
    expect(computeWindowRefreshRequest(project([]))).toBeNull();
  });

  it('replaces the paged rows wholesale, keeping starred and deep-linked rows', () => {
    const loaded = addDeepLinkedRow(
      tagServerPage(project([row('s', 0, { starred: true }), row('a', 3), row('gone', 2)])),
      'sessions',
      row('linked', 0),
    );
    const refreshed = applyWindowRefresh(loaded, {
      sessions: [row('a', 3, { summary: 'renamed', closed: true })],
      sessionMeta: { hasMore: false },
    });
    expect(ids(refreshed).sort()).toEqual(['a', 'linked', 's']);
    expect((refreshed.sessions as ProjectSession[]).find((s) => s.id === 'a')?.closed).toBe(true);
  });
});

describe('wasSessionRemoved (B-290)', () => {
  it('is true only for a row listed before and absent after', () => {
    const before = [project([row('a', 1)])];
    const after = [project([])];
    expect(wasSessionRemoved(before, after, 'p1', 'a')).toBe(true);
    expect(wasSessionRemoved(after, after, 'p1', 'brand-new')).toBe(false);
  });
});
