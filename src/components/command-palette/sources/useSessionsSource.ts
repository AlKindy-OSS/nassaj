import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider, ProjectSession } from '../../../types/app';

import { useApiSource } from './useApiSource';
import {
  SESSION_BUCKET_KEYS,
  type SessionBuckets,
} from '../../../../shared/sessionBuckets';

export type SessionResult = {
  id: string;
  label: string;
  provider?: LLMProvider;
};

/** Every provider's session bucket, straight off the sessions-page payload. */
type SessionsResponse = Partial<SessionBuckets<ProjectSession>>;

export function useSessionsSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<SessionResult, SessionsResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => {
      const params = new URLSearchParams({ limit: '50', offset: '0' });
      return authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId!)}/sessions?${params.toString()}`,
        { signal },
      );
    },
    parse: (data) => {
      // Iterating the shared bucket list keeps late-added providers (hermes,
      // kimi, glm) searchable instead of silently absent (B-598).
      const all: ProjectSession[] = SESSION_BUCKET_KEYS.flatMap((key) => data[key] ?? []);
      return all.map<SessionResult>((s) => ({
        id: s.id,
        label: (s.title || s.summary || s.name || s.id) as string,
        provider: s.__provider,
      }));
    },
  });
}
