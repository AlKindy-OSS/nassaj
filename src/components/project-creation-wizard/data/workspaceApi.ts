import { api } from '../../../utils/api';
import type {
  BrowseFilesystemResponse,
  CloneProgressEvent,
  CloneTicketResponse,
  CloneWorkspaceErrorCode,
  CreateFolderResponse,
  CreateProjectPayload,
  CreateProjectResponse,
  CredentialsResponse,
  FolderSuggestion,
  GithubReposErrorCode,
  GithubReposResponse,
  TokenMode,
} from '../types';
import { CloneWorkspaceError, GithubReposError } from '../types';

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
  /** Fired once the clone ticket is created (the request body, including any
   * raw PAT, was accepted by the server) so the caller can clear sensitive
   * form fields before the (possibly slow) clone itself finishes. */
  onTicketCreated?: () => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.get('/settings/credentials?type=github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const fetchGithubRepos = async (tokenId?: string) => {
  const endpoint = tokenId
    ? `/github/repos?tokenId=${encodeURIComponent(tokenId)}`
    : '/github/repos';
  const response = await api.get(endpoint);
  const data = await parseJson<GithubReposResponse>(response);

  if (!response.ok) {
    const code = (data.code as GithubReposErrorCode | undefined) ?? null;
    throw new GithubReposError(data.error || 'Failed to load GitHub repositories', code);
  }

  return data.repositories || [];
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

const buildCloneTicketRequestBody = ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
}: CloneWorkspaceParams) => {
  const body: Record<string, unknown> = {
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
  };

  if (tokenMode === 'stored' && selectedGithubToken) {
    const tokenId = Number(selectedGithubToken);
    if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
      throw new CloneWorkspaceError('Invalid stored GitHub token', 'INVALID_CLONE_REQUEST');
    }
    body.githubTokenId = tokenId;
  }

  if (tokenMode === 'new' && newGithubToken.trim()) {
    body.newGithubToken = newGithubToken.trim();
  }

  return body;
};

const KNOWN_CLONE_ERROR_CODES: readonly CloneWorkspaceErrorCode[] = [
  'INVALID_CLONE_REQUEST',
  'INVALID_GITHUB_URL',
  'CLONE_TICKET_LIMIT_REACHED',
  'AUTHENTICATION_REQUIRED',
  'CLONE_TICKET_CREATE_FAILED',
];

const isKnownCloneErrorCode = (value: unknown): value is CloneWorkspaceErrorCode =>
  typeof value === 'string' && (KNOWN_CLONE_ERROR_CODES as readonly string[]).includes(value);

const createCloneTicket = async (params: CloneWorkspaceParams) => {
  // buildCloneTicketRequestBody may throw a CloneWorkspaceError synchronously
  // (invalid stored token id) before any request is made.
  const body = buildCloneTicketRequestBody(params);
  const response = await api.createCloneTicket(body);

  let data: CloneTicketResponse | null = null;
  try {
    data = await parseJson<CloneTicketResponse>(response);
  } catch {
    // Non-JSON body (e.g. a 502 gateway HTML page or a CSRF interstitial):
    // fall through to the generic failure below instead of surfacing the
    // raw parse error / response text to the user.
    data = null;
  }

  if (!response.ok || !data || !data.ticket) {
    const rawCode = data?.error;
    const code = isKnownCloneErrorCode(rawCode) ? rawCode : 'CLONE_TICKET_CREATE_FAILED';
    throw new CloneWorkspaceError(
      (typeof rawCode === 'string' && rawCode) || 'Failed to create clone request',
      code,
    );
  }

  return data.ticket;
};

export const cloneWorkspaceWithProgress = async (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
) => {
  // The ticket carries the workspace path, GitHub URL, and any token, so none
  // of that (nor the raw PAT) ever reaches the SSE URL, browser history, or
  // server access logs. The ticket is single-use (server-enforced), so a
  // reconnect after settlement must not be attempted.
  const ticket = await createCloneTicket(params);
  handlers.onTicketCreated?.();

  return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const eventSource = new EventSource(api.cloneProgressUrl(ticket));
    let settled = false;
    const identityChanging = () => settle(() => reject(new DOMException('Identity changed', 'AbortError')));

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('auth:identity-changing', identityChanging);
      eventSource.removeEventListener('identity_revoked', identityRevoked);
      eventSource.removeEventListener('access_fence', accessFenced);
      eventSource.close();
      callback();
    };
    const identityRevoked = () => settle(() => reject(new DOMException('Identity changed', 'AbortError')));
    // The device-bound stream closes with this event when the connection's
    // device/session access is fenced off mid-clone (account-wallet guard).
    const accessFenced = () => settle(() => reject(new DOMException('Identity changed', 'AbortError')));

    window.addEventListener('auth:identity-changing', identityChanging);
    eventSource.addEventListener('identity_revoked', identityRevoked);
    eventSource.addEventListener('access_fence', accessFenced);

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'complete') {
          settle(() => resolve(payload.project));
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(new Error(payload.message || 'Failed to clone repository')));
        }
      } catch (error) {
        console.error('Error parsing clone progress event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during clone')));
    };
  });
};
