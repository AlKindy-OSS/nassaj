import { Folder, Loader2, Search } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { LoadingProgress } from '../../../../types/app';
import type { SidebarSearchScope } from '../../types/types';

type SidebarProjectsStateProps = {
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  projectsCount: number;
  filteredProjectsCount: number;
  isSearchActive?: boolean;
  searchScope?: SidebarSearchScope;
  isMessageSearching?: boolean;
  t: TFunction;
};

/**
 * The empty search result, worded for what was searched (B-1668): while the
 * conversation scan is still streaming it says so instead of "no results",
 * and a search that includes message bodies reports conversations, not
 * projects.
 */
function SearchEmptyState({ scope, isMessageSearching, t }: {
  scope: SidebarSearchScope;
  isMessageSearching: boolean;
  t: TFunction;
}) {
  const searchesConversations = scope !== 'titles';
  const title = isMessageSearching && searchesConversations
    ? t('projects.searchingConversations')
    : searchesConversations ? t('projects.noMatchingConversations') : t('projects.noMatchingProjects');
  const Icon = isMessageSearching && searchesConversations ? Loader2 : Search;

  return (
    <div className="px-4 py-12 text-center md:py-8" role="status" data-sidebar-search-empty>
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
        <Icon className={isMessageSearching && searchesConversations ? 'h-6 w-6 animate-spin text-muted-foreground' : 'h-6 w-6 text-muted-foreground'} />
      </div>
      <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{title}</h3>
      {!isMessageSearching && <p className="text-sm text-muted-foreground">{t('projects.tryDifferentSearch')}</p>}
    </div>
  );
}

export default function SidebarProjectsState({
  isLoading,
  loadingProgress,
  projectsCount,
  filteredProjectsCount,
  isSearchActive = false,
  searchScope = 'all',
  isMessageSearching = false,
  t,
}: SidebarProjectsStateProps) {
  if (isLoading) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.loadingProjects')}</h3>
        {loadingProgress && loadingProgress.total > 0 ? (
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {loadingProgress.current}/{loadingProgress.total} {t('projects.projects')}
            </p>
            {loadingProgress.currentProject && (
              <p
                className="mx-auto max-w-[200px] truncate text-xs text-muted-foreground/70"
                title={loadingProgress.currentProject}
              >
                {loadingProgress.currentProject.split('-').slice(-2).join('/')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('projects.fetchingProjects')}</p>
        )}
      </div>
    );
  }

  if (projectsCount === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <Folder className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.noProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.runClaudeCli')}</p>
      </div>
    );
  }

  if (filteredProjectsCount === 0 && isSearchActive) {
    return <SearchEmptyState scope={searchScope} isMessageSearching={isMessageSearching} t={t} />;
  }

  if (filteredProjectsCount === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <Search className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.noMatchingProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.tryDifferentSearch')}</p>
      </div>
    );
  }

  return null;
}
