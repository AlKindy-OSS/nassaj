import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check } from 'lucide-react';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import SessionProcessBadge from '../../../../shared/view/SessionProcessBadge';
import WorkflowStatusBadge from '../../../../shared/view/WorkflowStatusBadge';
import GovernanceBadge from '../../../../shared/view/GovernanceBadge';
import { useWorkflowsEnvelope } from '../../../../stores/workflowStatusStore';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
};

function getTabTitle(activeTab: AppTab, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

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

function getSessionTitle(session: ProjectSession): string {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
}

/** First 8 hex chars of the session UUID — enough to identify, short enough to fit. */
function shortSessionId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function SessionIdBadge({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(sessionId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [sessionId],
  );

  const short = shortSessionId(sessionId);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('mainContent.sessionIdTooltip', {
        id: sessionId,
        defaultValue: 'Session ID: {{id}} — click to copy',
      })}
      aria-label={t('mainContent.sessionIdCopy', {
        id: short,
        defaultValue: 'Copy session ID {{id}}',
      })}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {short}
      {copied ? (
        <Check className="h-2.5 w-2.5 flex-shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <Copy className="h-2.5 w-2.5 flex-shrink-0 opacity-50" aria-hidden />
      )}
    </button>
  );
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const workflowEnvelope = useWorkflowsEnvelope();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {/* dir="auto": a session title is static text (never streamed), and
                  ~8% of real titles are all-Latin — without this they are laid
                  out against an RTL base and the trailing badges jump sides. */}
              <h2
                dir="auto"
                className="scrollbar-hide min-w-0 overflow-x-auto whitespace-nowrap text-sm font-semibold leading-tight text-foreground"
              >
                {getSessionTitle(selectedSession)}
              </h2>
              <SessionProcessBadge sessionId={selectedSession.id} />
              <WorkflowStatusBadge sessionId={selectedSession.id} />
              <GovernanceBadge provider={selectedSession.__provider} />
              {workflowEnvelope.capped && (
                <span
                  role="status"
                  title={t('workflowStatus.unknownHint')}
                  aria-label={t('workflowStatus.unknown')}
                  className="inline-flex flex-shrink-0 items-center rounded-full border border-slate-400/30 bg-slate-400/10 px-1.5 py-px text-[10px] text-muted-foreground"
                >
                  {t('workflowStatus.unknown')}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[11px] leading-tight text-muted-foreground">
                {selectedProject.displayName}
              </span>
              <span aria-hidden className="h-2.5 w-px flex-shrink-0 bg-border/60" />
              <SessionIdBadge sessionId={selectedSession.id} />
            </div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
