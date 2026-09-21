/**
 * Hook for GitHub PAT credential management (git-settings tab).
 *
 * Why a dedicated hook rather than consuming useCredentialsSettings from both
 * tabs: each hook owns a single data domain (`github_token` here, `api_keys`
 * in useCredentialsSettings). Sharing the combined hook across tabs would
 * cause two independent fetches of both endpoints on every mount, or create
 * hidden coupling between unrelated settings tabs. Splitting avoids that.
 *
 * ADR-076 Wave-1b — moved from api-settings to git-settings (2026-07-28).
 */
import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type {
  GithubCredentialItem,
  GithubCredentialsResponse,
} from '../view/tabs/api-settings/types';

type UseGithubCredentialsArgs = {
  confirmDeleteText: string;
};

const getApiError = (payload: { error?: string } | undefined, fallback: string) =>
  payload?.error || fallback;

export function useGithubCredentials({ confirmDeleteText }: UseGithubCredentialsArgs) {
  const [githubCredentials, setGithubCredentials] = useState<GithubCredentialItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewGithubForm, setShowNewGithubForm] = useState(false);
  const [newGithubName, setNewGithubName] = useState('');
  const [newGithubToken, setNewGithubToken] = useState('');
  const [newGithubDescription, setNewGithubDescription] = useState('');
  const [showToken, setShowToken] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch('/api/settings/credentials?type=github_token');
      const payload = await response.json() as GithubCredentialsResponse;
      setGithubCredentials(payload.credentials || []);
    } catch (error) {
      console.error('Error fetching GitHub credentials:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const createGithubCredential = useCallback(async () => {
    if (!newGithubName.trim() || !newGithubToken.trim()) {
      return;
    }
    try {
      const response = await authenticatedFetch('/api/settings/credentials', {
        method: 'POST',
        body: JSON.stringify({
          credentialName: newGithubName.trim(),
          credentialType: 'github_token',
          credentialValue: newGithubToken,
          description: newGithubDescription.trim(),
        }),
      });
      const payload = await response.json() as GithubCredentialsResponse;
      if (!response.ok || !payload.success) {
        console.error(
          'Error creating GitHub credential:',
          getApiError(payload, 'Failed to create GitHub credential'),
        );
        return;
      }
      setNewGithubName('');
      setNewGithubToken('');
      setNewGithubDescription('');
      setShowNewGithubForm(false);
      setShowToken((prev) => ({ ...prev, new: false }));
      await fetchData();
    } catch (error) {
      console.error('Error creating GitHub credential:', error);
    }
  }, [fetchData, newGithubDescription, newGithubName, newGithubToken]);

  const deleteGithubCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteText)) {
      return;
    }
    try {
      const response = await authenticatedFetch(`/api/settings/credentials/${credentialId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error(
          'Error deleting GitHub credential:',
          getApiError(payload, 'Failed to delete GitHub credential'),
        );
        return;
      }
      await fetchData();
    } catch (error) {
      console.error('Error deleting GitHub credential:', error);
    }
  }, [confirmDeleteText, fetchData]);

  const toggleGithubCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      const response = await authenticatedFetch(
        `/api/settings/credentials/${credentialId}/toggle`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive: !isActive }),
        },
      );
      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error(
          'Error toggling GitHub credential:',
          getApiError(payload, 'Failed to toggle GitHub credential'),
        );
        return;
      }
      await fetchData();
    } catch (error) {
      console.error('Error toggling GitHub credential:', error);
    }
  }, [fetchData]);

  const cancelNewGithubForm = useCallback(() => {
    setShowNewGithubForm(false);
    setNewGithubName('');
    setNewGithubToken('');
    setNewGithubDescription('');
    setShowToken((prev) => ({ ...prev, new: false }));
  }, []);

  const toggleNewGithubTokenVisibility = useCallback(() => {
    setShowToken((prev) => ({ ...prev, new: !prev.new }));
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    githubCredentials,
    loading,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  };
}
