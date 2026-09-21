import { MessageSquare, Terminal, Folder, GitBranch, KanbanSquare, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { useResolvedTabsMode } from '../../../../hooks/useResolvedTabsMode';

type MainContentTabSwitcherProps = {
  hideProjectTools?: boolean;
  sessionTabsOnly?: boolean;
  excludeSessionTabs?: boolean;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
};

type TabDefinition = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const BASE_TABS: TabDefinition[] = [
  { id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
  { id: 'board', labelKey: 'tabs.board', icon: KanbanSquare },
];

export default function MainContentTabSwitcher({
  sessionTabsOnly = false,
  excludeSessionTabs = false,
  activeTab,
  hideProjectTools = false,
  setActiveTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  // الوضع المعروض فعلاً، لا القيمة المخزَّنة. كان النصّ ملفوفاً بـ`hidden
  // lg:inline` فتقرّر العتبةُ في CSS بمعزل عن النموذج، ويقول الزرّ «فرد» على
  // شاشةٍ فيها أيقونات عارية. صار القرار في `resolveTabsMode` وحدها (T-1319).
  const tabsMode = useResolvedTabsMode();

  const tabs = BASE_TABS.filter((tab) => {
    const isSessionTab = tab.id === 'chat' || tab.id === 'shell';
    if (sessionTabsOnly) return isSessionTab;
    return !(excludeSessionTabs && isSessionTab) && (!hideProjectTools || isSessionTab);
  });


  return (
    <PillBar className={sessionTabsOnly ? 'gap-px rounded-md bg-muted/40 p-0.5' : undefined}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = t(tab.labelKey);

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <Pill
              data-main-content-tab={tab.id}
              aria-label={displayLabel}
              isActive={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={sessionTabsOnly ? 'h-7 w-7 justify-center p-0' : 'px-2.5 py-[5px] text-xs leading-5'}
            >
              <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              {!sessionTabsOnly && tabsMode === 'full' && <span>{displayLabel}</span>}
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
