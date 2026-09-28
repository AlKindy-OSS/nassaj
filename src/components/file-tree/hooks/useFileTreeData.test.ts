import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getFiles: vi.fn() }));

vi.mock('../../../utils/api', () => ({
  api: { getFiles: mocks.getFiles },
}));

import { useFileTreeData } from './useFileTreeData';
import type { Project } from '../../../types/app';

const project = { projectId: 'proj-1' } as Project;

describe('useFileTreeData', () => {
  it('sets error "tooLarge" and captures the limit on a 413 FILE_TREE_TOO_LARGE response', async () => {
    mocks.getFiles.mockResolvedValue({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      json: async () => ({ error: 'Tree too large', code: 'FILE_TREE_TOO_LARGE', limit: 10000 }),
    });

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('tooLarge');
    expect(result.current.limit).toBe(10000);
    expect(result.current.files).toEqual([]);
  });

  it('sets error "loadFailed" on any other non-ok response', async () => {
    mocks.getFiles.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'boom' }),
    });

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('loadFailed');
    expect(result.current.limit).toBeNull();
  });

  it('stays silent (no error) when the fetch is aborted', async () => {
    mocks.getFiles.mockImplementation(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const { result } = renderHook(() => useFileTreeData(project));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.files).toEqual([]);
  });

  it('clears a previous error once a subsequent fetch succeeds', async () => {
    mocks.getFiles.mockResolvedValueOnce({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      json: async () => ({ error: 'Tree too large', code: 'FILE_TREE_TOO_LARGE', limit: 10000 }),
    });

    const { result, rerender } = renderHook(({ p }: { p: Project }) => useFileTreeData(p), {
      initialProps: { p: project },
    });

    await waitFor(() => expect(result.current.error).toBe('tooLarge'));

    mocks.getFiles.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ name: 'a.txt', path: '/a.txt', type: 'file' }],
    });

    rerender({ p: { projectId: 'proj-2' } as Project });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.files).toHaveLength(1);
  });
});
