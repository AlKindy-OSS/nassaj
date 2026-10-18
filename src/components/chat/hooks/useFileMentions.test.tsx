/**
 * B-1669: opening a chat requests no file list; the first '@' loads the lean
 * `partial` listing once per project, and a truncated tree still fills the list.
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getFiles: vi.fn() }));

vi.mock('../../../utils/api', () => ({
  api: { getFiles: mocks.getFiles },
}));

import type { Project } from '../../../types/app';

import { useFileMentions } from './useFileMentions';

const TREE = [
  { name: 'src', type: 'directory', path: '/p/src', children: [{ name: 'app.ts', type: 'file', path: '/p/src/app.ts' }] },
  { name: 'README.md', type: 'file', path: '/p/README.md' },
];

function renderMentions(initial: { projectId: string; input: string }) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  return renderHook(
    ({ projectId, input }) => useFileMentions({
      selectedProject: { projectId } as Project,
      input,
      setInput: () => undefined,
      textareaRef,
    }),
    { initialProps: initial },
  );
}

async function typeAt(result: ReturnType<typeof renderMentions>['result'], rerender: ReturnType<typeof renderMentions>['rerender'], projectId: string, input: string) {
  rerender({ projectId, input });
  await act(async () => {
    result.current.setCursorPosition(input.length);
  });
}

beforeEach(() => {
  mocks.getFiles.mockReset();
  mocks.getFiles.mockResolvedValue({ ok: true, status: 200, json: async () => TREE });
});
afterEach(cleanup);

describe('useFileMentions', () => {
  it('requests nothing on open', () => {
    renderMentions({ projectId: 'proj-1', input: '' });
    expect(mocks.getFiles).not.toHaveBeenCalled();
  });

  it('the first @ loads the partial listing once and fills the matches', async () => {
    const { result, rerender } = renderMentions({ projectId: 'proj-1', input: '' });
    await typeAt(result, rerender, 'proj-1', '@app');
    await waitFor(() => expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['src/app.ts']));
    expect(mocks.getFiles).toHaveBeenCalledTimes(1);
    const [projectId, options] = mocks.getFiles.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(options.partial).toBe(true);

    await typeAt(result, rerender, 'proj-1', '@app @READ');
    await waitFor(() => expect(result.current.filteredFiles.map((file) => file.name)).toEqual(['README.md']));
    expect(mocks.getFiles).toHaveBeenCalledTimes(1);
  });

  it('switching project clears the list and waits for the next @', async () => {
    const { result, rerender } = renderMentions({ projectId: 'proj-1', input: '' });
    await typeAt(result, rerender, 'proj-1', '@');
    await waitFor(() => expect(mocks.getFiles).toHaveBeenCalledTimes(1));
    await typeAt(result, rerender, 'proj-2', '');
    expect(result.current.filteredFiles).toEqual([]);
    expect(mocks.getFiles).toHaveBeenCalledTimes(1);
    await typeAt(result, rerender, 'proj-2', '@');
    await waitFor(() => expect(mocks.getFiles).toHaveBeenCalledTimes(2));
    expect(mocks.getFiles.mock.calls[1][0]).toBe('proj-2');
  });
});
