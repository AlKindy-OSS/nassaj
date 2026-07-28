import { Archive, BookOpen, Folder, FolderPlus, Plus, Search, TerminalSquare, X, PanelLeftClose, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';

import { Button, Input, Tooltip } from '../../../../shared/view/ui';
import { IS_PLATFORM } from '../../../../constants/config';
import { cn } from '../../../../lib/utils';
import { useBranding } from '../../../../contexts/BrandingContext';
import { useTheme } from '../../../../contexts/ThemeContext';
import { useAuth } from '../../../auth';
import type { SidebarSearchMode, SidebarSection } from '../../types/types';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  showSidebarSearch: boolean;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  runningTerminalsCount: number;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  showSidebarSearch,
  searchMode,
  onSearchModeChange,
  activeSection,
  onSectionChange,
  runningTerminalsCount,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const { title: brandingTitle, logoUrl, logoDarkUrl, logoOnly: brandingLogoOnly, nodeIconDataUri, nodeIconPosition } = useBranding();
  const { isDarkMode } = useTheme();
  // Terminals are an admin-only surface (ADR-063 amend): the server enforces
  // owner/admin at REST + WS; hiding the toggle here is UX, not the boundary.
  const { user } = useAuth();
  const canUseTerminals = user?.role === 'owner' || user?.role === 'admin';
  // Dark theme prefers the dedicated dark logo and falls back to the main one.
  const brandingLogoUrl = isDarkMode ? (logoDarkUrl ?? logoUrl) : logoUrl;
  const showSearchTools = (projectsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'archived'
    ? t('search.archivedPlaceholder', 'Search archived sessions...')
    : t('projects.searchPlaceholder');

  const displayTitle = brandingTitle ?? t('app.title');

  // Top-level section toggle (T-940): Terminals | Projects. Replaces the former
  // "My projects / Team / All" membership filter. Flex order follows the
  // document direction, so it lays out correctly in RTL without extra handling.
  const sectionOptions: { value: SidebarSection; label: string; icon: LucideIcon }[] = [
    { value: 'projects', label: t('sections.projects'), icon: Folder },
    ...(canUseTerminals
      ? [{ value: 'terminals' as const, label: t('sections.terminals'), icon: TerminalSquare }]
      : []),
  ];

  // With only Projects left (non-admin) a single-option toggle is noise — hide it.
  const sectionToggle = !canUseTerminals ? null : (
    <div className="flex items-center rounded-lg bg-muted/50 p-0.5" role="tablist" aria-label={t('sections.projects')}>
      {sectionOptions.map((option) => {
        const isActive = activeSection === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSectionChange(option.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all whitespace-nowrap',
              isActive ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <option.icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{option.label}</span>
            {option.value === 'terminals' && runningTerminalsCount > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                {runningTerminalsCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  // Archive-only toggle — lives in the Projects controls row (T-940). `heightClass`
  // matches the adjacent search input height (h-9 desktop, h-10 mobile).
  const renderArchiveToggle = (heightClass: string) => (
    <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
      <button
        type="button"
        onClick={() => onSearchModeChange(searchMode === 'archived' ? 'projects' : 'archived')}
        aria-pressed={searchMode === 'archived'}
        aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
        title={t('search.archiveOnlyTooltip', 'Archive only')}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-xl border border-transparent px-3 text-xs font-medium transition-all',
          heightClass,
          searchMode === 'archived'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <Archive className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );

  // Small server-identity badge shown next to the logo (null = hidden).
  const NodeIcon = nodeIconDataUri ? (
    <img
      src={nodeIconDataUri}
      alt=""
      aria-hidden="true"
      className="h-5 w-5 flex-shrink-0 rounded-sm object-contain"
    />
  ) : null;

  // Wordmark mode: a single uploaded logo replaces the icon + title pair. The
  // title still reaches assistive tech through the img alt text.
  const LogoBlock = () => (brandingLogoOnly && brandingLogoUrl) ? (
    <img
      src={brandingLogoUrl}
      alt={displayTitle}
      className="h-8 w-auto max-w-[180px] min-w-0 object-contain object-left rtl:object-right"
    />
  ) : (
    <div className="flex min-w-0 items-center gap-2.5">
      {brandingLogoUrl ? (
        <img
          src={brandingLogoUrl}
          alt={displayTitle}
          className="h-7 w-auto max-w-[140px] flex-shrink-0 object-contain object-left rtl:object-right"
        />
      ) : (
        /* شعار نسّاج الافتراضي في الشريط الجانبي — وعي بالثيم */
        <img
          src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
          alt="نسّاج"
          className="h-6 w-auto flex-shrink-0"
        />
      )}
      {brandingLogoUrl && (
        <h1 className="truncate text-sm font-semibold text-foreground">{displayTitle}</h1>
      )}
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <a
                href="https://cloudcli.ai/dashboard"
                className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
                title={t('tooltips.viewEnvironments')}
              >
                <LogoBlock />
              </a>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label={t('tooltips.goHome', displayTitle)}
                title={t('tooltips.goHome', displayTitle)}
              >
                <LogoBlock />
              </Link>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Tooltip content={t('tooltips.openWiki')} position="bottom">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('tooltips.openWiki')}
                className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                onClick={() => window.open('/wiki', '_blank', 'noopener,noreferrer')}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Section toggle (T-940) — always visible so Terminals is reachable
            even with zero projects. */}
        <div className="mt-2.5">{sectionToggle}</div>

        {/* Projects controls: search + archive toggle (projects section only).
            Rendered only when both the data conditions (showSearchTools) and the
            user preference (showSidebarSearch) allow it. */}
        {activeSection === 'projects' && showSearchTools && showSidebarSearch && (
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 ps-9 pe-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter ? (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : (
                <kbd
                  aria-hidden
                  title={t('tooltips.openCommandPalette')}
                  className="pointer-events-none absolute end-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
                >
                  {MOD_KEY}
                  <span>K</span>
                </kbd>
              )}
            </div>
            {renderArchiveToggle('h-9')}
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <a
                href="https://cloudcli.ai/dashboard"
                className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
                title={t('tooltips.viewEnvironments')}
              >
                <LogoBlock />
              </a>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label={t('tooltips.goHome', displayTitle)}
                title={t('tooltips.goHome', displayTitle)}
              >
                <LogoBlock />
              </Link>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile section toggle (T-940) */}
        <div className="mt-2.5">{sectionToggle}</div>

        {/* Mobile projects controls: search + archive toggle */}
        {activeSection === 'projects' && showSearchTools && (
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 ps-10 pe-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            {renderArchiveToggle('h-10')}
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
