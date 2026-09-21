import type { MainContentHeaderProps } from '../../types/types';
import { useResolvedTabsMode } from '../../../../hooks/useResolvedTabsMode';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import HeaderUsageIndicator from './HeaderUsageIndicator';

export default function MainContentHeader({
  sessionHeaderRef,
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  const tabsMode = useResolvedTabsMode();

  return (
    <div data-app-header-surface style={{ backgroundColor: 'var(--app-header-surface, hsl(var(--background)))' }} className="pwa-header-safe flex-shrink-0 bg-background">
      <div className="app-top-rail flex items-center gap-2 px-3 sm:px-4">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto" data-session-header-scroll>
          <div className="shrink-0">
            <MainContentTitle
              activeTab={activeTab}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
            />
          </div>
          <div ref={sessionHeaderRef} className="flex shrink-0 items-center gap-1.5" data-session-header-content />
        </div>

        <div className="flex shrink-0 items-center gap-1.5" data-header-trailing-controls>
          <HeaderUsageIndicator tabsMode={tabsMode} sessionProvider={selectedSession?.__provider} />
          <div className="shrink-0" data-session-tab-controls>
            <MainContentTabSwitcher activeTab={activeTab} setActiveTab={setActiveTab} sessionTabsOnly />
          </div>
        </div>
      </div>
    </div>
  );
}
