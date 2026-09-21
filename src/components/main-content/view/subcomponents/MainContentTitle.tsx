import { useTranslation } from 'react-i18next';

import GovernanceBadge from '../../../../shared/view/GovernanceBadge';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { useConversationClosed } from '../../../chat/hooks/useConversationClosed';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
};

function getTabTitle(activeTab: AppTab, t: (key: string) => string) {
  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'board') {
    return t('tabs.board');
  }

  if (activeTab === 'wiki') {
    return t('wiki.title');
  }

  return 'Project';
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
}: MainContentTitleProps) {
  const { t } = useTranslation(['common', 'chat']);
  const showChatNewSession = (activeTab === 'chat' || activeTab === 'shell') && !selectedSession;
  // The header is a sibling of the close control.  Subscribe to the shared
  // optimistic state as well as the persisted session row, otherwise its label
  // waits for a sidebar refresh even though the close action has succeeded.
  const conversationClosed = useConversationClosed(selectedSession?.id, {
    initialClosed: selectedSession?.closed ?? false,
  });

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      <div className="min-w-0 flex-1">
        {(activeTab === 'chat' || activeTab === 'shell') && selectedSession ? (
          <div className="flex items-center gap-2 whitespace-nowrap">
            <GovernanceBadge provider={selectedSession.__provider} />
            {conversationClosed.closed && (
              <span className="text-xs font-medium text-muted-foreground">
                {t('chat:closeConversation.closedBadge', { defaultValue: 'Closed' })}
              </span>
            )}
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, t)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
