import type { ArchivedProjectListItem, ArchivedSessionListItem, SessionWithProvider } from '../types/types';

import { getAllSessions } from './utils';

/** One archived conversation row; `isSessionArchived` gates restore/delete. */
export type ArchivedFolderSession = ArchivedSessionListItem & { isSessionArchived: boolean };

/** One project folder in the archive view, shaped like a sidebar project. */
export type ArchivedFolder = {
  key: string;
  projectId: string | null;
  displayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedFolderSession[];
  latestActivity: string | null;
};

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/** Maps a session loaded inside an archived project to an archive row. */
export function toArchivedSessionItem(
  project: ArchivedProjectListItem,
  session: SessionWithProvider,
): ArchivedFolderSession {
  const createdAt = textOrNull(session.created_at);
  const updatedAt = textOrNull(session.updated_at);
  return {
    sessionId: String(session.id),
    provider: session.__provider,
    projectId: project.projectId,
    projectPath: project.fullPath,
    projectDisplayName: project.displayName,
    sessionTitle: nonEmpty(session.summary) ?? nonEmpty(session.name) ?? String(session.id),
    createdAt,
    updatedAt,
    lastActivity: textOrNull(session.lastActivity) ?? updatedAt ?? createdAt,
    isProjectArchived: true,
    isSessionArchived: false,
  };
}

const folderKey = (projectId: string | null, projectPath: string | null, sessionId: string): string =>
  projectId ?? projectPath ?? `session:${sessionId}`;

const newerOf = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
};

function addSession(folder: ArchivedFolder, session: ArchivedFolderSession): void {
  const existing = folder.sessions.findIndex((item) => item.sessionId === session.sessionId);
  if (existing >= 0) {
    // An explicitly archived row wins: it carries restore/delete.
    if (session.isSessionArchived) folder.sessions[existing] = session;
    return;
  }
  folder.sessions.push(session);
  folder.latestActivity = newerOf(folder.latestActivity, session.lastActivity);
}

function folderForProject(project: ArchivedProjectListItem): ArchivedFolder {
  const folder: ArchivedFolder = {
    key: project.projectId,
    projectId: project.projectId,
    displayName: project.displayName,
    projectPath: project.fullPath,
    isProjectArchived: true,
    sessions: [],
    latestActivity: null,
  };
  getAllSessions(project).forEach((session) => addSession(folder, toArchivedSessionItem(project, session)));
  return folder;
}

function folderForSession(session: ArchivedSessionListItem, key: string): ArchivedFolder {
  return {
    key,
    projectId: session.projectId,
    displayName: session.projectDisplayName,
    projectPath: session.projectPath,
    isProjectArchived: session.isProjectArchived,
    sessions: [],
    latestActivity: null,
  };
}

/**
 * Builds the archive view as project folders, mirroring the active list:
 * archived projects become folders (even when empty), and archived sessions
 * join their project's folder — archived or not. Newest activity first.
 */
export function buildArchivedFolders(
  archivedProjects: ArchivedProjectListItem[],
  archivedSessions: ArchivedSessionListItem[],
): ArchivedFolder[] {
  const folders = new Map<string, ArchivedFolder>();
  archivedProjects.forEach((project) => folders.set(project.projectId, folderForProject(project)));

  for (const session of archivedSessions) {
    const key = folderKey(session.projectId, session.projectPath, session.sessionId);
    const folder = folders.get(key) ?? folderForSession(session, key);
    folders.set(key, folder);
    addSession(folder, { ...session, isSessionArchived: true });
  }

  return [...folders.values()].sort((a, b) => (b.latestActivity ?? '').localeCompare(a.latestActivity ?? ''));
}

/** Short relative age ("5m", "3hr", "2d") matching the active session rows. */
export function formatCompactArchivedAge(dateString: string | null, now: number = Date.now()): string {
  if (!dateString) return '';
  const time = new Date(dateString).getTime();
  if (Number.isNaN(time)) return '';

  const diffInMinutes = Math.floor(Math.max(0, now - time) / (1000 * 60));
  if (diffInMinutes < 1) return '<1m';
  if (diffInMinutes < 60) return `${diffInMinutes}m`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}hr`;
  return `${Math.floor(diffInHours / 24)}d`;
}
