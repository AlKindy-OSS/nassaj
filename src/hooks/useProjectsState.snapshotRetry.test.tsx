/**
 * عقد لقطة المشاريع: البيانات المخزنة تظهر فوراً، ثم يعاد الجلب بصمت وبـ
 * backoff ما دام الخادم يقول initializing/stale/error. لا polling لخادم قديم ولا
 * مؤقت ينجو إزالة التطبيق.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { projectsApi } = vi.hoisted(() => ({ projectsApi: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsApi(...args) },
}));

import {
  getProjectsSnapshotRetryDelay,
  readProjectsSnapshotState,
  useProjectsState,
} from './useProjectsState';

const response = (state?: string, body: unknown = []): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: state ? { 'X-Nassaj-Snapshot-State': state } : undefined,
  });

const mount = () =>
  renderHook(() =>
    useProjectsState({
      navigate: vi.fn(),
      latestMessage: null,
      isMobile: false,
      activeSessions: new Set(),
    }),
  );

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  projectsApi.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('عقد رأس اللقطة', () => {
  it('يتسامح مع الخادم القديم والقيم غير المعروفة', () => {
    expect(readProjectsSnapshotState(response())).toBeNull();
    expect(readProjectsSnapshotState(response('future-state'))).toBeNull();
    expect(readProjectsSnapshotState(response(' Stale '))).toBe('stale');
  });

  it('يسقف backoff عند 15 ثانية', () => {
    expect(getProjectsSnapshotRetryDelay(0)).toBe(500);
    expect(getProjectsSnapshotRetryDelay(1)).toBe(1_000);
    expect(getProjectsSnapshotRetryDelay(99)).toBe(15_000);
  });
});

describe('إعادة جلب لقطة المشاريع', () => {
  it('يعيد الجلب بصمت حتى ready ثم يتوقف', async () => {
    projectsApi
      .mockResolvedValueOnce(response('initializing'))
      .mockResolvedValueOnce(response('ready'));
    mount();
    await flush();

    expect(projectsApi).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(projectsApi).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectsApi).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(projectsApi).toHaveBeenCalledTimes(2);
  });

  it('يزيد المهلة عندما تبقى اللقطة stale', async () => {
    projectsApi
      .mockResolvedValueOnce(response('stale'))
      .mockResolvedValueOnce(response('stale'))
      .mockResolvedValueOnce(response('ready'));
    mount();
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectsApi).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(projectsApi).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectsApi).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(projectsApi).toHaveBeenCalledTimes(3);
  });

  it('يعيد المحاولة بعد error حتى تصل ready', async () => {
    projectsApi
      .mockResolvedValueOnce(response('error'))
      .mockResolvedValueOnce(response('ready'));
    mount();
    await flush();
    expect(projectsApi).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(projectsApi).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(projectsApi).toHaveBeenCalledTimes(2);
  });

  it('يستبدل metadata غير المعروفة عندما تصل اللقطة الجاهزة', async () => {
    const project = {
      projectId: 'p-1',
      displayName: 'Nassaj',
      fullPath: '/workspace/nassaj',
      sessions: [],
    };
    projectsApi
      .mockResolvedValueOnce(response('stale', [{ ...project, dirExists: null, metadataCheckedAt: null }]))
      .mockResolvedValueOnce(
        response('ready', [
          { ...project, dirExists: true, metadataCheckedAt: '2026-08-17T10:00:00.000Z' },
        ]),
      );
    const { result } = mount();
    await flush();
    expect(result.current.projects[0]?.dirExists).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.projects[0]?.dirExists).toBe(true);
    expect(result.current.projects[0]?.metadataCheckedAt).toBe('2026-08-17T10:00:00.000Z');
  });

  it('يلغي المؤقت عند unmount', async () => {
    projectsApi.mockResolvedValue(response('initializing'));
    const { unmount } = mount();
    await flush();
    expect(projectsApi).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(30_000);
    expect(projectsApi).toHaveBeenCalledTimes(1);
  });

  it('لا ينشئ polling مع خادم قديم بلا الرأس', async () => {
    projectsApi.mockResolvedValue(response());
    mount();
    await flush();

    expect(projectsApi).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(projectsApi).toHaveBeenCalledTimes(1);
  });
});
