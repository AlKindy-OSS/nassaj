import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronsUpDown, GitBranch, Loader2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../shared/view/ui';
import type { GithubRepository, GithubReposErrorCode } from '../types';

type GithubRepoPickerProps = {
  repos: GithubRepository[];
  loading: boolean;
  error: string | null;
  errorCode: GithubReposErrorCode | null;
  selectedCloneUrl: string;
  disabled?: boolean;
  onSelectRepo: (repo: GithubRepository) => void;
  onReload: () => void;
};

export default function GithubRepoPicker({
  repos,
  loading,
  error,
  errorCode,
  selectedCloneUrl,
  disabled = false,
  onSelectRepo,
  onReload,
}: GithubRepoPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedRepo = repos.find((repo) => repo.cloneUrl === selectedCloneUrl) || null;

  // Close on outside click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t('projectWizard.step2.repos.loading')}
      </div>
    );
  }

  if (error) {
    const message =
      errorCode === 'invalid_token'
        ? t('projectWizard.step2.repos.invalidToken')
        : errorCode === 'no_token'
          ? t('projectWizard.step2.repos.noToken')
          : errorCode === 'forbidden'
            ? t('projectWizard.step2.repos.forbidden')
            : t('projectWizard.step2.repos.loadError');

    return (
      <div
        className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
        role="alert"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          <div className="flex-1 space-y-2">
            <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onReload}
                className="text-xs font-medium text-red-700 underline hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
              >
                {t('projectWizard.step2.repos.retry')}
              </button>
              <a
                href="/settings"
                className="text-xs font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
              >
                {t('projectWizard.step2.repos.manageTokens')}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('projectWizard.step2.repos.empty')}
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('projectWizard.step2.repos.ariaLabel')}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-start text-sm text-gray-900 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:hover:border-gray-500"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selectedRepo ? (
            <>
              <span className="truncate">{selectedRepo.fullName}</span>
              {selectedRepo.private && (
                <Badge variant="secondary" className="flex-shrink-0 gap-1">
                  <Lock className="h-3 w-3" aria-hidden />
                  {t('projectWizard.step2.repos.private')}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">
              {t('projectWizard.step2.repos.placeholder')}
            </span>
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden />
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <Command
            label={t('projectWizard.step2.repos.ariaLabel')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeAndFocusTrigger();
              }
            }}
          >
            <CommandInput
              autoFocus
              placeholder={t('projectWizard.step2.repos.searchPlaceholder')}
              aria-label={t('projectWizard.step2.repos.searchAriaLabel')}
            />
            <CommandList>
              <CommandEmpty>{t('projectWizard.step2.repos.noMatch')}</CommandEmpty>
              <CommandGroup>
                {repos.map((repo) => (
                  <CommandItem
                    key={repo.fullName}
                    value={repo.fullName}
                    onSelect={() => {
                      onSelectRepo(repo);
                      closeAndFocusTrigger();
                    }}
                  >
                    <Check
                      className={`h-4 w-4 flex-shrink-0 ${
                        repo.cloneUrl === selectedCloneUrl ? 'opacity-100' : 'opacity-0'
                      }`}
                      aria-hidden
                    />
                    <span className="truncate">{repo.fullName}</span>
                    {repo.private && (
                      <Badge variant="secondary" className="ms-auto flex-shrink-0 gap-1">
                        <Lock className="h-3 w-3" aria-hidden />
                        {t('projectWizard.step2.repos.private')}
                      </Badge>
                    )}
                    {repo.defaultBranch && (
                      <span
                        className={`flex flex-shrink-0 items-center gap-1 text-xs text-gray-400 ${
                          repo.private ? '' : 'ms-auto'
                        }`}
                      >
                        <GitBranch className="h-3 w-3" aria-hidden />
                        {repo.defaultBranch}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
