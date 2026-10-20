import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';

import { PromptInputButton } from '../../shared/view/ui';
import { cn } from '../../lib/utils';
import { COMPOSER_ICON_BUTTON_CLASS } from '../chat/view/subcomponents/composerToolbarStyles';

import { useInternalMentionCount } from './internalSessionChatStore';

type Props = {
  sessionId: string;
  active: boolean;
  onToggle: () => void;
};

/**
 * ADR-187 team chat entry point: a frameless composer-toolbar icon that puts
 * the main composer in team mode. A dot marks unread mentions; the count is
 * spoken in the label, never conveyed by colour alone.
 */
export default function TeamChatToggle({ sessionId, active, onToggle }: Props) {
  const { t } = useTranslation('chat');
  const mentions = useInternalMentionCount(sessionId);
  const label = t('internalChat.button');
  const spoken = mentions > 0 ? t('internalChat.toggleWithMentions', { count: mentions }) : label;
  return (
    <PromptInputButton
      className={cn(
        COMPOSER_ICON_BUTTON_CLASS,
        'relative',
        active && 'bg-[color:var(--session-internal-accent)]/15 text-foreground hover:bg-[color:var(--session-internal-accent)]/20',
      )}
      tooltip={{ content: label }}
      aria-label={spoken}
      aria-pressed={active}
      data-testid="composer-team-toggle"
      onClick={onToggle}
    >
      <Users aria-hidden="true" className={cn(active && 'text-[color:var(--session-internal-accent)]')} />
      {mentions > 0 && (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 size-2 rounded-full bg-[color:var(--session-internal-accent)] ring-2 ring-background"
        />
      )}
    </PromptInputButton>
  );
}
