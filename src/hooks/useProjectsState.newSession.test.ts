/**
 * useProjectsState.newSession.test.ts — B-290
 *
 * محادثة جديدة لم تكن تظهر في الشريط الجانبي إلا بعد تحديث الصفحة.
 *
 * الجذر: مع `session_created` تدخل الجلسة في `activeSessions` وتُختار مبدئياً
 * (نائبة من الـURL) قبل أن يفهرس المراقب ملف الـJSONL. وقتها كان
 * `isUpdateAdditive` يرى الجلسة المختارة **غائبة عن القائمة الحالية** فيُرجع
 * false، فيُسقط المستهلك بثّ `projects_updated` كاملاً — وبما أن الجلسة لا تدخل
 * القائمة أبداً، يتكرّر الإسقاط في كل بثّ لاحق (دورة مغلقة).
 *
 * يغطّي:
 * (أ) الجلسة المختارة غائبة عن الحالية وحاضرة في القادمة ⇒ إضافي (يمرّ).
 * (ب) غائبة عن الاثنتين (بثّ سبق الفهرسة) ⇒ إضافي أيضاً: لا شيء يُستبدل.
 * (ج) حاضرة في الحالية وغائبة عن القادمة (حذف فعلي) ⇒ ليس إضافياً (يُحجب).
 * (د) حاضرة في الاثنتين بتغيّر عنوان/طابع زمني ⇒ ليس إضافياً (السلوك الأصلي).
 * (هـ) حارس مسح الاختيار: يميّز «حُذفت» عن «لم تُفهرس بعد».
 *
 * Runner: vitest
 * تشغيل: NODE_ENV=test npx vitest run src/hooks/useProjectsState.newSession.test.ts
 */

import { describe, expect, it } from 'vitest';

import { isSessionListedInProjects, isUpdateAdditive } from './useProjectsState';
import type { Project, ProjectSession } from '../types/app';

const PROJECT_ID = 'p-1';

function session(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id,
    title: `session ${id}`,
    created_at: '2026-07-29T10:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
    ...overrides,
  } as ProjectSession;
}

function project(sessions: ProjectSession[]): Project {
  return {
    projectId: PROJECT_ID,
    displayName: 'nassaj-dev',
    fullPath: '/workspace/nassaj-dev',
    sessions,
  } as Project;
}

describe('B-290 — a just-minted conversation must not block projects_updated', () => {
  const oldSession = session('s-old');
  const freshSession = session('s-fresh');
  const current = [project([oldSession])];

  it('treats the arrival of the selected (not-yet-listed) session as additive', () => {
    const updated = [project([oldSession, freshSession])];
    expect(isUpdateAdditive(current, updated, current[0], freshSession)).toBe(true);
  });

  it('stays additive when the broadcast lands before the session is indexed', () => {
    // A broadcast triggered by ANOTHER file: the fresh session is in neither
    // list. Nothing about it is being replaced, so the update must still apply
    // (otherwise every other project's update is collateral damage).
    const updated = [project([oldSession, session('s-other')])];
    expect(isUpdateAdditive(current, updated, current[0], freshSession)).toBe(true);
  });

  it('still blocks a genuine disappearance of the selected session', () => {
    const updated = [project([session('s-other')])];
    expect(isUpdateAdditive(current, updated, current[0], oldSession)).toBe(false);
  });

  it('still blocks a non-additive rewrite of the selected session', () => {
    const updated = [project([session('s-old', { title: 'renamed' })])];
    expect(isUpdateAdditive(current, updated, current[0], oldSession)).toBe(false);
  });

  it('keeps the untouched-session case additive', () => {
    const updated = [project([oldSession, session('s-other')])];
    expect(isUpdateAdditive(current, updated, current[0], oldSession)).toBe(true);
  });
});

describe('B-290 — clearing the selection distinguishes deleted from unindexed', () => {
  const listed = session('s-old');
  const projects = [project([listed])];

  it('reports a listed session as listed (deletion may clear the selection)', () => {
    expect(isSessionListedInProjects(projects, PROJECT_ID, 's-old')).toBe(true);
  });

  it('reports a never-indexed session as not listed (selection must survive)', () => {
    expect(isSessionListedInProjects(projects, PROJECT_ID, 's-fresh')).toBe(false);
  });

  it('is false for a missing project or session id', () => {
    expect(isSessionListedInProjects(projects, 'p-other', 's-old')).toBe(false);
    expect(isSessionListedInProjects(projects, PROJECT_ID, null)).toBe(false);
    expect(isSessionListedInProjects(projects, null, 's-old')).toBe(false);
  });

  it('finds sessions carried on a non-claude provider list', () => {
    const codexProject = {
      ...project([]),
      codexSessions: [session('s-codex')],
    } as Project;
    expect(isSessionListedInProjects([codexProject], PROJECT_ID, 's-codex')).toBe(true);
  });
});
