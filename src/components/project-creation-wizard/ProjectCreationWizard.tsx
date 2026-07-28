import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ErrorBanner from './components/ErrorBanner';
import StepConfiguration from './components/StepConfiguration';
import StepReview from './components/StepReview';
import WizardFooter from './components/WizardFooter';
import WizardProgress from './components/WizardProgress';
import { useGithubTokens } from './hooks/useGithubTokens';
import { useGithubRepos } from './hooks/useGithubRepos';
import { cloneWorkspaceWithProgress, createProjectRequest } from './data/workspaceApi';
import { isCloneWorkflow } from './utils/pathUtils';
import type { GithubRepository, GithubSourceMode, TokenMode, WizardFormState, WizardStep } from './types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
  githubSourceMode: 'url',
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState('');

  // Load tokens whenever step 1 is active (not just when a URL is present), so
  // the wizard can detect token availability and offer the repo-picker mode.
  const shouldLoadTokens = step === 1;

  // Tracks whether the user explicitly chose a source mode; once they do, we
  // stop auto-defaulting it when tokens load/change.
  const userPickedSourceModeRef = useRef(false);

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useGithubTokens({
    shouldLoad: shouldLoadTokens,
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  const hasStoredToken = availableTokens.length > 0;

  // Default to the repo-picker when the user has a stored token, otherwise keep
  // the manual paste-URL behaviour. Only applies until the user picks a mode.
  useEffect(() => {
    if (userPickedSourceModeRef.current || loadingTokens) {
      return;
    }
    const desiredMode: GithubSourceMode = hasStoredToken ? 'repos' : 'url';
    setFormState((previous) =>
      previous.githubSourceMode === desiredMode
        ? previous
        : { ...previous, githubSourceMode: desiredMode },
    );
  }, [hasStoredToken, loadingTokens]);

  const setSourceMode = useCallback((mode: GithubSourceMode) => {
    userPickedSourceModeRef.current = true;
    setFormState((previous) => ({ ...previous, githubSourceMode: mode }));
  }, []);

  // Repositories load when the repo-picker is active and a token is available.
  const shouldLoadRepos = step === 1 && formState.githubSourceMode === 'repos' && hasStoredToken;

  const {
    repos: availableRepos,
    loading: loadingRepos,
    error: reposError,
    errorCode: reposErrorCode,
    reload: reloadRepos,
  } = useGithubRepos({
    shouldLoad: shouldLoadRepos,
    selectedTokenId: formState.selectedGithubToken,
  });

  const handleSelectRepo = useCallback((repo: GithubRepository) => {
    // Selecting a repo fills the clone URL; the existing clone path stays intact.
    setFormState((previous) => ({
      ...previous,
      githubUrl: repo.cloneUrl,
      // A repo from a stored token means we authenticate with that stored token.
      tokenMode: 'stored',
    }));
  }, []);

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      setStep(2);
    }
  }, [formState.workspacePath, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setCloneProgress('');

    try {
      const shouldCloneRepository = isCloneWorkflow(formState.githubUrl);

      if (shouldCloneRepository) {
        const project = await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            githubUrl: formState.githubUrl,
            tokenMode: formState.tokenMode,
            selectedGithubToken: formState.selectedGithubToken,
            newGithubToken: formState.newGithubToken,
          },
          {
            onProgress: setCloneProgress,
          },
        );

        onProjectCreated?.(project);
        onClose();
        return;
      }

      const project = await createProjectRequest({
        path: formState.workspacePath.trim(),
      });

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, t]);

  const shouldCloneRepository = useMemo(
    () => isCloneWorkflow(formState.githubUrl),
    [formState.githubUrl],
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepConfiguration
              workspacePath={formState.workspacePath}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              githubSourceMode={formState.githubSourceMode}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              hasStoredToken={hasStoredToken}
              availableRepos={availableRepos}
              loadingRepos={loadingRepos}
              reposError={reposError}
              reposErrorCode={reposErrorCode}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onGithubUrlChange={(githubUrl) => updateField('githubUrl', githubUrl)}
              onTokenModeChange={updateTokenMode}
              onSelectedGithubTokenChange={(selectedGithubToken) =>
                updateField('selectedGithubToken', selectedGithubToken)
              }
              onNewGithubTokenChange={(newGithubToken) =>
                updateField('newGithubToken', newGithubToken)
              }
              onSourceModeChange={setSourceMode}
              onSelectRepo={handleSelectRepo}
              onReloadRepos={reloadRepos}
              onAdvanceToConfirm={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <StepReview
              formState={formState}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={cloneProgress}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isCloneWorkflow={shouldCloneRepository}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
