import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ApiResponse,
  ProviderSkill,
  ProviderSkillCreatePayload,
  ProviderSkillsResponse,
  SkillsProject,
  SkillsProvider,
  SkillsScope,
} from '../types';

type SkillsCacheEntry = {
  skills: ProviderSkill[];
  updatedAt: number;
};

type ProjectTarget = {
  projectId: string;
  displayName: string;
  path: string;
};

const SKILLS_CACHE_TTL_MS = 5 * 60_000;
const skillsCache = new Map<string, SkillsCacheEntry>();

const SKILL_SCOPE_ORDER: Record<SkillsScope, number> = {
  user: 0,
  plugin: 1,
  repo: 2,
  project: 3,
  admin: 4,
  system: 5,
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

/** A failed skills write; `code` is the server's stable code for the view to translate. */
export class ProviderSkillsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderSkillsError';
    this.code = code;
  }
}

const getApiErrorCode = (payload: unknown, status: number): string => {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === 'string' && code) return code;
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  return 'UNKNOWN';
};

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  const details = record.details;
  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  return fallback;
};

const isSkillsScope = (value: unknown): value is SkillsScope => (
  value === 'user'
  || value === 'project'
  || value === 'plugin'
  || value === 'repo'
  || value === 'admin'
  || value === 'system'
);

const normalizeScope = (value: unknown): SkillsScope => (
  isSkillsScope(value) ? value : 'user'
);

const createProjectTargets = (projects: SkillsProject[]): ProjectTarget[] => {
  const seenPaths = new Set<string>();

  return projects.reduce<ProjectTarget[]>((acc, project) => {
    const projectPath = project.fullPath || project.path || '';
    if (!projectPath || seenPaths.has(projectPath)) {
      return acc;
    }

    seenPaths.add(projectPath);
    acc.push({
      projectId: project.projectId,
      displayName: project.displayName || project.projectId,
      path: projectPath,
    });
    return acc;
  }, []);
};

const normalizeSkill = (
  provider: SkillsProvider,
  skill: Partial<ProviderSkill>,
  project?: ProjectTarget,
): ProviderSkill => {
  const scope = normalizeScope(skill.scope);
  const shouldAttachProject = scope === 'project' || scope === 'repo';

  return {
    provider,
    name: String(skill.name ?? ''),
    description: String(skill.description ?? ''),
    command: String(skill.command ?? ''),
    disableModelInvocation: skill.disableModelInvocation === true,
    scope,
    sourcePath: String(skill.sourcePath ?? ''),
    pluginName: typeof skill.pluginName === 'string' ? skill.pluginName : undefined,
    pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : undefined,
    projectDisplayName: shouldAttachProject
      ? project?.displayName ?? skill.projectDisplayName
      : skill.projectDisplayName,
    projectPath: shouldAttachProject
      ? project?.path ?? skill.projectPath
      : skill.projectPath,
    readOnly: skill.readOnly === true,
    origin: skill.origin === 'nassaj-shared' || skill.origin === 'operator-shared' ? skill.origin : undefined,
  };
};

const getSkillIdentity = (skill: ProviderSkill): string => (
  [
    skill.provider,
    skill.scope,
    skill.command,
    skill.sourcePath || 'no-source-path',
    skill.projectPath || 'global',
  ].join(':')
);

const sortSkills = (skills: ProviderSkill[]): ProviderSkill[] => (
  [...skills].sort((left, right) => {
    const scopeDelta = SKILL_SCOPE_ORDER[left.scope] - SKILL_SCOPE_ORDER[right.scope];
    if (scopeDelta !== 0) {
      return scopeDelta;
    }

    const projectDelta = (left.projectDisplayName || '').localeCompare(right.projectDisplayName || '');
    if (projectDelta !== 0) {
      return projectDelta;
    }

    return left.command.localeCompare(right.command);
  })
);

const mergeSkills = (
  existingSkills: ProviderSkill[],
  incomingSkills: ProviderSkill[],
): ProviderSkill[] => {
  const skillsById = new Map<string, ProviderSkill>();
  existingSkills.forEach((skill) => {
    skillsById.set(getSkillIdentity(skill), skill);
  });
  incomingSkills.forEach((skill) => {
    skillsById.set(getSkillIdentity(skill), skill);
  });

  return sortSkills([...skillsById.values()]);
};

const fetchProviderSkills = async (
  provider: SkillsProvider,
  project?: ProjectTarget,
): Promise<ProviderSkill[]> => {
  const params = new URLSearchParams();
  if (project?.path) {
    params.set('workspacePath', project.path);
  }

  const response = await authenticatedFetch(
    `/api/providers/${provider}/skills${params.toString() ? `?${params.toString()}` : ''}`,
  );
  const data = await toResponseJson<ApiResponse<ProviderSkillsResponse>>(response);
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, `Failed to load ${provider} skills`));
  }

  return (data.data.skills || []).map((skill) => normalizeSkill(provider, skill, project));
};

const saveProviderSkills = async (
  provider: SkillsProvider,
  payload: ProviderSkillCreatePayload,
): Promise<ProviderSkill[]> => {
  const response = await authenticatedFetch(`/api/providers/${provider}/skills`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const data = await toResponseJson<ApiResponse<ProviderSkillsResponse>>(response).catch(() => null);
  if (!response.ok || !data || !data.success) {
    throw new ProviderSkillsError(
      getApiErrorCode(data, response.status),
      getApiErrorMessage(data, 'Failed to save skills'),
    );
  }

  return (data.data.skills || []).map((skill) => normalizeSkill(provider, skill));
};

const deleteProviderSkill = async (
  provider: SkillsProvider,
  skillName: string,
): Promise<void> => {
  const response = await authenticatedFetch(
    `/api/providers/${provider}/skills/${encodeURIComponent(skillName)}`,
    { method: 'DELETE' },
  );

  const data = await toResponseJson<ApiResponse<unknown>>(response).catch(() => null);
  if (!response.ok || !data || !data.success) {
    throw new ProviderSkillsError(
      getApiErrorCode(data, response.status),
      getApiErrorMessage(data, 'Failed to delete skill'),
    );
  }
};

const getCacheKey = (provider: SkillsProvider, projects: ProjectTarget[], filesMode: string): string => {
  const projectKey = projects.map((project) => project.path).sort().join('|');
  return `${provider}:${filesMode}:${projectKey}`;
};

const clearProviderSkillCache = (provider: SkillsProvider): void => {
  for (const cacheKey of [...skillsCache.keys()]) {
    if (cacheKey.startsWith(`${provider}:`)) {
      skillsCache.delete(cacheKey);
    }
  }
};

type UseProviderSkillsArgs = {
  selectedProvider: SkillsProvider;
  currentProjects: SkillsProject[];
  /** Effective harness-files mode (ADR-203); a change lists a different store. */
  filesMode?: string;
};

export function useProviderSkills({ selectedProvider, currentProjects, filesMode = 'shared' }: UseProviderSkillsArgs) {
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingProjectScopes, setIsLoadingProjectScopes] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const activeLoadIdRef = useRef(0);

  const projectTargets = useMemo(() => createProjectTargets(currentProjects), [currentProjects]);
  const cacheKey = useMemo(
    () => getCacheKey(selectedProvider, projectTargets, filesMode),
    [filesMode, projectTargets, selectedProvider],
  );

  const refreshSkills = useCallback(async (options: { force?: boolean } = {}) => {
    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;

    const cachedEntry = skillsCache.get(cacheKey);
    const canUseCache = !options.force && cachedEntry && Date.now() - cachedEntry.updatedAt < SKILLS_CACHE_TTL_MS;
    if (canUseCache) {
      setSkills(cachedEntry.skills);
      setIsLoading(false);
      setIsLoadingProjectScopes(false);
      setLoadError(null);
      return;
    }

    if (cachedEntry && !options.force) {
      setSkills(cachedEntry.skills);
    } else {
      setSkills([]);
    }

    setIsLoading(!cachedEntry);
    setIsLoadingProjectScopes(false);
    setLoadError(null);

    let nextSkills = cachedEntry && !options.force ? cachedEntry.skills : [];
    let firstError: string | null = null;

    try {
      const globalSkills = await fetchProviderSkills(selectedProvider);
      if (activeLoadIdRef.current !== loadId) {
        return;
      }

      nextSkills = mergeSkills(nextSkills, globalSkills);
      setSkills(nextSkills);
    } catch (error) {
      firstError = error instanceof Error ? error.message : 'Failed to load skills';
    }

    if (activeLoadIdRef.current !== loadId) {
      return;
    }

    setIsLoading(false);

    if (projectTargets.length === 0) {
      const finalSkills = sortSkills(nextSkills);
      skillsCache.set(cacheKey, { skills: finalSkills, updatedAt: Date.now() });
      setSkills(finalSkills);
      setLoadError(firstError);
      return;
    }

    setIsLoadingProjectScopes(true);

    await Promise.all(projectTargets.map(async (project) => {
      try {
        const projectSkills = await fetchProviderSkills(selectedProvider, project);
        if (activeLoadIdRef.current !== loadId) {
          return;
        }

        nextSkills = mergeSkills(nextSkills, projectSkills);
        setSkills(nextSkills);
      } catch (error) {
        firstError = firstError || (error instanceof Error ? error.message : 'Failed to load skills');
      }
    }));

    if (activeLoadIdRef.current !== loadId) {
      return;
    }

    const finalSkills = sortSkills(nextSkills);
    skillsCache.set(cacheKey, { skills: finalSkills, updatedAt: Date.now() });
    setSkills(finalSkills);
    setLoadError(firstError);
    setIsLoadingProjectScopes(false);
  }, [cacheKey, projectTargets, selectedProvider]);

  const addSkills = useCallback(async (payload: ProviderSkillCreatePayload) => {
    try {
      const createdSkills = await saveProviderSkills(selectedProvider, payload);
      clearProviderSkillCache(selectedProvider);
      await refreshSkills({ force: true });
      setSaveStatus('success');
      return createdSkills;
    } catch (error) {
      setSaveStatus('error');
      throw error;
    }
  }, [refreshSkills, selectedProvider]);

  const deleteSkill = useCallback(async (skillName: string) => {
    await deleteProviderSkill(selectedProvider, skillName);
    clearProviderSkillCache(selectedProvider);
    await refreshSkills({ force: true });
  }, [refreshSkills, selectedProvider]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    setSaveStatus(null);
  }, [selectedProvider]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 6000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    skills,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    saveStatus,
    addSkills,
    deleteSkill,
    refreshSkills,
  };
}
