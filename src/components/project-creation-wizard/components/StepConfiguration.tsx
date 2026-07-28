import { Github, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../shared/view/ui';
import { shouldShowGithubAuthentication } from '../utils/pathUtils';
import type {
  GithubRepository,
  GithubReposErrorCode,
  GithubSourceMode,
  GithubTokenCredential,
  TokenMode,
} from '../types';
import GithubAuthenticationCard from './GithubAuthenticationCard';
import GithubRepoPicker from './GithubRepoPicker';
import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  githubSourceMode: GithubSourceMode;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  hasStoredToken: boolean;
  availableRepos: GithubRepository[];
  loadingRepos: boolean;
  reposError: string | null;
  reposErrorCode: GithubReposErrorCode | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onSourceModeChange: (mode: GithubSourceMode) => void;
  onSelectRepo: (repo: GithubRepository) => void;
  onReloadRepos: () => void;
  onAdvanceToConfirm: () => void;
};

const getSourceTabClassName = (mode: GithubSourceMode, selectedMode: GithubSourceMode) =>
  `flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
    mode === selectedMode
      ? 'bg-blue-500 text-white'
      : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
  }`;

export default function StepConfiguration({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  githubSourceMode,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  hasStoredToken,
  availableRepos,
  loadingRepos,
  reposError,
  reposErrorCode,
  isCreating,
  onWorkspacePathChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onSourceModeChange,
  onSelectRepo,
  onReloadRepos,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);
  const isReposMode = hasStoredToken && githubSourceMode === 'repos';

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>

        {hasStoredToken && (
          <div
            className="mb-3 grid grid-cols-2 gap-2"
            role="tablist"
            aria-label={t('projectWizard.step2.repos.sourceToggleLabel')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={githubSourceMode === 'repos'}
              onClick={() => onSourceModeChange('repos')}
              className={getSourceTabClassName(githubSourceMode, 'repos')}
              disabled={isCreating}
            >
              <Github className="h-4 w-4" aria-hidden />
              {t('projectWizard.step2.repos.fromMyRepos')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={githubSourceMode === 'url'}
              onClick={() => onSourceModeChange('url')}
              className={getSourceTabClassName(githubSourceMode, 'url')}
              disabled={isCreating}
            >
              <Link2 className="h-4 w-4" aria-hidden />
              {t('projectWizard.step2.repos.pasteUrl')}
            </button>
          </div>
        )}

        {isReposMode ? (
          <GithubRepoPicker
            repos={availableRepos}
            loading={loadingRepos}
            error={reposError}
            errorCode={reposErrorCode}
            selectedCloneUrl={githubUrl}
            disabled={isCreating}
            onSelectRepo={onSelectRepo}
            onReload={onReloadRepos}
          />
        ) : (
          <Input
            type="text"
            value={githubUrl}
            onChange={(event) => onGithubUrlChange(event.target.value)}
            placeholder="https://github.com/username/repository"
            className="w-full"
            disabled={isCreating}
          />
        )}

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {isReposMode
            ? t('projectWizard.step2.repos.help')
            : t('projectWizard.step2.githubHelp')}
        </p>
      </div>

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}
