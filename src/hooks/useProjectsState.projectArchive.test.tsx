/**
 * useProjectsState.projectArchive.test.tsx — T-1756
 *
 * يثبّت أن أرشفة المشروع:
 * (أ) تحذف المشروع من القائمة.
 * (ب) لا تصفّر selectedProject ولا selectedSession.
 * (ج) لا تستدعي navigate('/').
 *
 * Runner: vitest
 * تشغيل: TMPDIR=/var/tmp npx vitest run src/hooks/useProjectsState.projectArchive.test.tsx
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const { projectsApi, sessionContextApi } = vi.hoisted(() => ({
  projectsApi: vi.fn(),
  sessionContextApi: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsApi(...args),
    sessionContext: (...args: unknown[]) => sessionContextApi(...args),
  },
}));

import { useProjectsState } from './useProjectsState';

const PROJECT_A: Project = {
  projectId: 'project-a',
  displayName: 'مشروع ألفا',
  fullPath: '/workspace/alpha',
  sessions: [{ id: 'session-1', title: 'جلسة 1' }],
} as Project;

const PROJECT_B: Project = {
  projectId: 'project-b',
  displayName: 'مشروع باء',
  fullPath: '/workspace/beta',
  sessions: [],
} as Project;

const response = (projects: Project[] = [PROJECT_A, PROJECT_B]): Response =>
  new Response(JSON.stringify(projects), {
    status: 200,
    headers: { 'X-Nassaj-Snapshot-State': 'ready' },
  });

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockResolvedValue(response());
  sessionContextApi.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/session/session-1');
});

afterEach(() => cleanup());

describe('T-1756 — أرشفة المشروع', () => {
  it('تحذف المشروع من القائمة بعد استدعاء handleProjectArchive', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useProjectsState({
        sessionId: 'session-1',
        navigate,
        latestMessage: null,
        isMobile: false,
        activeSessions: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    act(() => {
      result.current.handleProjectArchive('project-b');
    });

    expect(result.current.projects.map((p) => p.projectId)).toEqual(['project-a']);
  });

  it('لا تصفّر selectedProject ولا تستدعي navigate عند أرشفة مشروع غير محدَّد', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useProjectsState({
        sessionId: 'session-1',
        navigate,
        latestMessage: null,
        isMobile: false,
        activeSessions: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe('project-a'));

    act(() => {
      result.current.handleProjectArchive('project-b');
    });

    // selectedProject يبقى على project-a، لا ينعدم
    expect(result.current.selectedProject?.projectId).toBe('project-a');
    // selectedSession يبقى سليماً
    expect(result.current.selectedSession?.id).toBe('session-1');
    // navigate لا تُنادَى
    expect(navigate).not.toHaveBeenCalledWith('/');
  });
});
