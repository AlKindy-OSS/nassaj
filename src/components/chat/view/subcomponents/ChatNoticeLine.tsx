import { useTranslation } from 'react-i18next';
import { ChevronDown, CircleAlert, Info, KeyRound, TriangleAlert } from 'lucide-react';

import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import type { ChatMessage } from '../../types/types';

import { isNoticeForUser, noticeText } from './noticeText';

type ChatNoticeLineProps = {
  message: ChatMessage;
  /** Base direction of the server text (neutral notices show it as sent). */
  contentDir?: 'rtl' | 'ltr';
  /** Signed-in user, for owner-only detail folded into a shared line. */
  viewerUserId?: number | string | null;
};

/** Claude account section in Settings, where the sign-in is renewed (re-link). */
const CLAUDE_ACCOUNT_SETTINGS = { tab: 'agents', agent: 'claude', category: 'account' } as const;

const ICON = 'mt-0.5 h-3.5 w-3.5 flex-shrink-0';

/** Localized date/time of an ISO instant, or the raw text when unreadable. */
function formatInstant(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Text behind a hook warning's disclosure. A hook failure's shared line carries a
 * generic text; its server detail is owner-only (folded in, or its own owner row).
 */
function hookDetail(message: ChatMessage, viewerUserId: number | string | null | undefined): string {
  if (message.noticeCode !== 'hook_failed' || message.noticeDetailOf) return message.content ?? '';
  const visible = isNoticeForUser({ audienceUserId: message.noticeDetailAudience }, viewerUserId);
  return message.noticeDetail && message.noticeDetailAudience !== undefined && visible ? message.noticeDetail : '';
}

/** T-2113: a hook warning: one quiet line, the CLI's own wording behind a disclosure. */
function HookWarningLine({ message, viewerUserId }: { message: ChatMessage; viewerUserId?: number | string | null }) {
  const { t } = useTranslation('chat');
  const detail = hookDetail(message, viewerUserId);
  if (!detail) {
    return (
      <p className="flex w-full items-start gap-2 py-0.5 text-xs text-muted-foreground" data-chat-notice>
        <TriangleAlert className={`${ICON} text-warning`} aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{noticeText(message, t)}</span>
      </p>
    );
  }
  return (
    <details className="group/notice w-full py-0.5" data-chat-notice>
      <summary className="flex cursor-pointer list-none items-start gap-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <TriangleAlert className={`${ICON} text-warning`} aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{noticeText(message, t)}</span>
        <span className="sr-only">{t('chatNotice.hookDetails')}</span>
        <ChevronDown className={`${ICON} transition-transform group-open/notice:rotate-180`} aria-hidden="true" />
      </summary>
      <pre
        className="mt-1 whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground"
        dir="ltr"
        data-notice-detail
      >
        {detail}
      </pre>
    </details>
  );
}

/** T-2113: part of the session was not saved (disk full or quota): an error alert. */
function WritesLostLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat');
  return (
    <div role="alert" className="flex w-full items-start gap-2 py-0.5 text-xs text-danger" data-chat-notice>
      <CircleAlert className={ICON} aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words font-medium">{noticeText(message, t)}</span>
    </div>
  );
}

/** T-2113: the run owner's Claude sign-in ends within 3 days: warning plus re-link entry. */
function CredentialExpiringLine({ message }: { message: ChatMessage }) {
  const { t, i18n } = useTranslation('chat');
  const { openSettings } = usePaletteOps();
  const reason = message.noticeReason === 'expired' ? 'expired' : 'soon';
  const date = formatInstant(message.credentialExpiresAt ?? '', i18n.language);
  return (
    <div role="status" className="flex w-full items-start gap-2 py-0.5 text-xs" data-chat-notice>
      <KeyRound className={`${ICON} text-warning`} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words text-foreground">{t(`chatNotice.credentialExpiring.${reason}`, { date })}</p>
        <button
          type="button"
          className="inline-flex min-h-6 items-center rounded-sm font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openSettings('agents', { ...CLAUDE_ACCOUNT_SETTINGS })}
        >
          {t('chatNotice.credentialExpiring.action')}
        </button>
      </div>
    </div>
  );
}

/**
 * One chat notice row (B-1624 neutral line; T-2113 hook health, lost writes and an
 * ending sign-in). Never an error bubble, never grouped, never a delivery verdict.
 */
export default function ChatNoticeLine({ message, contentDir, viewerUserId }: ChatNoticeLineProps) {
  const { t } = useTranslation('chat');
  switch (message.noticeCode) {
    case 'hook_no_verdict':
    case 'hook_failed':
      return <HookWarningLine message={message} viewerUserId={viewerUserId} />;
    case 'session_writes_lost':
      return <WritesLostLine message={message} />;
    case 'credential_expiring':
      return <CredentialExpiringLine message={message} />;
    default:
      return (
        <p className="flex w-full items-start gap-2 py-0.5 text-xs text-muted-foreground" data-chat-notice>
          <Info className={ICON} aria-hidden="true" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" dir={contentDir}>
            {noticeText(message, t)}
          </span>
        </p>
      );
  }
}
