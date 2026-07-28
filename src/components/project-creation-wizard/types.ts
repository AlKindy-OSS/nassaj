export type WizardStep = 1 | 2;

export type TokenMode = 'stored' | 'new' | 'none';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

export type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

export type GithubRepository = {
  name: string;
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
};

export type GithubReposResponse = {
  repositories?: GithubRepository[];
  code?: string;
  error?: string;
};

export type GithubReposErrorCode = 'no_token' | 'invalid_token' | 'forbidden' | 'github_error';

export class GithubReposError extends Error {
  code: GithubReposErrorCode | null;

  constructor(message: string, code: GithubReposErrorCode | null) {
    super(message);
    this.name = 'GithubReposError';
    this.code = code;
  }
}

export type GithubSourceMode = 'repos' | 'url';

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type CreateProjectPayload = {
  path: string;
  customName?: string;
};

export type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

export type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  /** Whether the user picks a repo from their account or pastes a URL. */
  githubSourceMode: GithubSourceMode;
};
