import type { Project } from '../../types/app';

export type ProjectTool = 'board' | 'git' | 'files';

/** Builds the query for one atomic router navigation to a project tool. */
export const projectToolSearch = (search: string, projectId: string, tool: ProjectTool): string => {
  const params = new URLSearchParams(search);
  params.set('projectId', projectId);
  params.set('projectTool', tool);
  return `?${params.toString()}`;
};

/** Performs exactly one router navigation for a project-tool button click. */
export const navigateToProjectTool = (
  navigate: (destination: { pathname: string; search: string }) => void,
  search: string,
  projectId: string,
  tool: ProjectTool,
) => {
  navigate({ pathname: '/', search: projectToolSearch(search, projectId, tool) });
};

export const readProjectToolDestination = (search: string): { projectId: string; tool: ProjectTool } | null => {
  const params = new URLSearchParams(search);
  const projectId = params.get('projectId');
  const tool = params.get('projectTool');
  if (!projectId || (tool !== 'board' && tool !== 'git' && tool !== 'files')) return null;
  return { projectId, tool };
};

/** Resolves a project-tool URL only after the authoritative project list loads. */
export const resolveProjectToolDestination = (projects: Project[], search: string) => {
  const destination = readProjectToolDestination(search);
  if (!destination) return null;
  const project = projects.find((item) => item.projectId === destination.projectId);
  return project ? { project, tool: destination.tool } : null;
};

/** Prevents cleanup from deleting a newly navigated tool URL before its state settles. */
export const shouldClearProjectToolDestination = (
  destination: { projectId: string; tool: ProjectTool } | null,
  selectedProjectId: string | undefined,
  activeTab: string,
  isRestoring: boolean,
) => {
  if (!destination) return false;
  if (isRestoring) return false;
  return selectedProjectId !== destination.projectId || activeTab !== destination.tool;
};

/** Clears only the project-tool destination after leaving its owning surface. */
export const clearProjectToolDestination = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete('projectId');
  url.searchParams.delete('projectTool');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
};
