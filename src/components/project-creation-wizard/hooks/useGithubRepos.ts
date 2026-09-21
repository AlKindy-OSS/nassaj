import { useCallback, useEffect, useState } from 'react';
import { fetchGithubRepos } from '../data/workspaceApi';
import { GithubReposError } from '../types';
import type { GithubRepository, GithubReposErrorCode } from '../types';

type UseGithubReposParams = {
  /** When false the hook stays idle (no fetch, cleared state). */
  shouldLoad: boolean;
  /** Stored token id whose repositories should be listed. Empty = active token. */
  selectedTokenId: string;
};

type UseGithubReposResult = {
  repos: GithubRepository[];
  loading: boolean;
  error: string | null;
  errorCode: GithubReposErrorCode | null;
  reload: () => void;
};

/**
 * Loads the repositories accessible to the user's selected/active GitHub token.
 *
 * Re-fetches whenever the selected token changes or the consumer toggles
 * `shouldLoad` on. Exposes loading / error (with machine-readable code) / empty
 * states so the UI can render actionable feedback.
 */
export const useGithubRepos = ({
  shouldLoad,
  selectedTokenId,
}: UseGithubReposParams): UseGithubReposResult => {
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<GithubReposErrorCode | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!shouldLoad) {
      setRepos([]);
      setError(null);
      setErrorCode(null);
      setLoading(false);
      return;
    }

    let isDisposed = false;

    const loadRepos = async () => {
      setLoading(true);
      setError(null);
      setErrorCode(null);

      try {
        const repositories = await fetchGithubRepos(selectedTokenId || undefined);
        if (isDisposed) {
          return;
        }
        setRepos(repositories);
      } catch (caught) {
        if (isDisposed) {
          return;
        }
        setRepos([]);
        if (caught instanceof GithubReposError) {
          setError(caught.message);
          setErrorCode(caught.code);
        } else {
          setError(caught instanceof Error ? caught.message : 'Failed to load GitHub repositories');
          setErrorCode(null);
        }
      } finally {
        if (!isDisposed) {
          setLoading(false);
        }
      }
    };

    loadRepos();

    return () => {
      isDisposed = true;
    };
  }, [shouldLoad, selectedTokenId, reloadToken]);

  return { repos, loading, error, errorCode, reload };
};
