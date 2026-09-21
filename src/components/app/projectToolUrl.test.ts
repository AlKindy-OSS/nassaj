import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../types/app';

import {
  clearProjectToolDestination,
  navigateToProjectTool,
  projectToolSearch,
  readProjectToolDestination,
  resolveProjectToolDestination,
  shouldClearProjectToolDestination,
} from './projectToolUrl';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('project tool URL destination', () => {
  it('rejects an incomplete or unsupported tool destination', () => {
    expect(readProjectToolDestination('?projectId=one')).toBeNull();
    expect(readProjectToolDestination('?projectId=one&projectTool=terminal')).toBeNull();
  });

  it('clears a stale project tool without disturbing other destinations', () => {
    window.history.replaceState(null, '', '/session/two?settings=agents&projectId=old&projectTool=git');

    clearProjectToolDestination();

    expect(window.location.pathname).toBe('/session/two');
    expect(window.location.search).toBe('?settings=agents');
    expect(readProjectToolDestination(window.location.search)).toBeNull();
  });

  it('builds one router-search payload with the project and tool together', () => {
    expect(projectToolSearch('?settings=agents', 'project-two', 'files')).toBe(
      '?settings=agents&projectId=project-two&projectTool=files',
    );
  });

  it('opens a non-active project with one atomic navigation and restores the same target', () => {
    const navigate = vi.fn();
    navigateToProjectTool(navigate, '?settings=agents', 'project-two', 'files');

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/',
      search: '?settings=agents&projectId=project-two&projectTool=files',
    });
    const restored = resolveProjectToolDestination(
      [{ projectId: 'project-two', displayName: 'Two' }] as Project[],
      navigate.mock.calls[0][0].search,
    );
    expect(restored?.project.projectId).toBe('project-two');
    expect(restored?.tool).toBe('files');
  });

  it('keeps a newly navigated destination while the old project/chat state is settling', () => {
    const destination = { projectId: 'project-b', tool: 'files' as const };
    expect(shouldClearProjectToolDestination(destination, 'project-a', 'chat', true)).toBe(false);
    expect(shouldClearProjectToolDestination(destination, 'project-a', 'chat', false)).toBe(true);
    expect(shouldClearProjectToolDestination(destination, 'project-b', 'files', false)).toBe(false);
  });
});
