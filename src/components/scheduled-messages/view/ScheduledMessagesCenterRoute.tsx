import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../../types/app';
import { setPageBaseTitle } from '../../../utils/pageTitleNotification';
import { useAllScheduledMessages } from '../hooks/useAllScheduledMessages';

import ScheduledMessagesCenter from './ScheduledMessagesCenter';

/** Route boundary: the content-bearing queue hook exists only on `/scheduled`. */
export default function ScheduledMessagesCenterRoute({ projects, onOpenSession }: { projects: Project[]; onOpenSession: (sessionId: string) => void }) {
  const controller = useAllScheduledMessages();
  const { t } = useTranslation('chat');

  useEffect(() => {
    const previousTitle = document.title;
    setPageBaseTitle(`${t('scheduled.center.title')} — Nassaj`);
    requestAnimationFrame(() => document.getElementById('scheduled-center-title')?.focus());
    return () => { setPageBaseTitle(previousTitle); };
  }, [t]);

  return <ScheduledMessagesCenter controller={controller} projects={projects} onOpenSession={onOpenSession} />;
}
