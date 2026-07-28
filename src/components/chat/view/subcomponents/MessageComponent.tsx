import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import ParticipantAvatar from '../../../participants/ParticipantAvatar';
import type { SessionParticipant } from '../../../participants/types';
import { avatarColorForUser } from '../../../participants/utils';
import { useAuth } from '../../../auth/context/AuthContext';
import { cn } from '../../../../lib/utils';
import type { SessionOwner, Project  } from '../../../../types/app';
import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
  Provider,
} from '../../types/types';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { resolveTextDirection } from '../../../../utils/textDirection';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../../shared/view/ui';
import { getProviderDisplayName } from '../../constants/providerCapabilities';
import { ChatActionsContext } from '../../context/ChatActionsContext';
import { useServerActionCatalog } from '../../../../hooks/useServerActionCatalog';

import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';
import { shouldHideToolCallMessage } from './hideToolCalls';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  onStartNewSession?: (command: string) => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  hideToolCalls?: boolean;
  selectedProject?: Project | null;
  // Owner of the active session (C-MU-UX-MSG-IDENTITY). Threaded from the chat
  // view's selectedSession.owner. `null`/undefined for legacy sessions, where
  // we fall back to the generic provider-logo + "Claude" rendering.
  owner?: SessionOwner | null;
  // Session participants keyed by String(userId), used to resolve a user
  // message's `userId` author stamp to the real sender's avatar/name/colour
  // (B-MU-UX-FIX-MSG-AUTHOR). Optional so standalone renders degrade safely.
  participantsById?: Map<string, SessionParticipant>;
  provider: Provider | string;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, onStartNewSession, autoExpandTools, showRawParameters, showThinking, hideToolCalls, selectedProject, owner, participantsById, provider }: MessageComponentProps) => {
  const { t, i18n } = useTranslation('chat');

  // اتجاه أساس واحد لنصّ الرسالة الخام (غير الماركداون). `dir="auto"` كان
  // يستنتجه من أول حرف قوي، فرسالة عربية تبدأ بأمر لاتيني تُحسب LTR فينقلب
  // ترتيب مقاطعها — نفس عطل فقاعة الماركداون. التفصيل في utils/textDirection.
  const contentDir = useMemo(
    () => resolveTextDirection(message.content) ?? undefined,
    [message.content]
  );
  const { user } = useAuth();
  const { catalog, runAction, liveStatusOf } = useServerActionCatalog();
  // Build a minimal participant view of the signed-in user so the chat reuses
  // the shared avatar component (image with coloured-initial fallback) instead
  // of a hard-coded "U" placeholder.
  const currentUserParticipant = useMemo<SessionParticipant>(() => {
    const username = user?.username ?? '';
    return {
      userId: user?.id ?? username ?? 'me',
      username,
      role: typeof user?.role === 'string' ? user.role : 'user',
      first_seen: '',
      last_seen: '',
      message_count: 0,
      avatarUrl: typeof user?.avatarUrl === 'string' ? user.avatarUrl : null,
    };
  }, [user?.id, user?.username, user?.role, user?.avatarUrl]);

  // Session owner identity (C-MU-UX-MSG-IDENTITY). Owner colour = which brother;
  // shape (owner avatar vs agent pill) = coordinator vs sub-agent. Null owner
  // (legacy session) falls back to the generic provider-logo rendering.
  const ownerParticipant = useMemo<SessionParticipant | null>(() => {
    if (!owner) {
      return null;
    }
    return {
      userId: owner.userId,
      username: owner.username,
      role: 'owner',
      first_seen: '',
      last_seen: '',
      message_count: 0,
      avatarUrl: owner.avatarUrl ?? null,
    };
  }, [owner]);

  // Real author of this user message (B-MU-UX-FIX-MSG-AUTHOR). `message.userId`
  // is the numeric users.id stamped by the server on live WS payloads and
  // history rows (and locally on optimistic sends). Resolution order:
  //   1. matches the signed-in viewer  → their own participant view (avatar);
  //   2. found in the session roster   → that participant (name/avatar/colour);
  //   3. known id, roster not loaded   → deterministic colour from the id;
  //   4. no userId at all              → null = unknown author; the renderer
  //      shows a neutral placeholder and must NOT fall back to the viewer.
  const messageUserId = typeof message.userId === 'number' ? message.userId : undefined;
  const isOwnMessage =
    messageUserId !== undefined && user?.id !== undefined && Number(user.id) === messageUserId;
  const authorParticipant = useMemo<SessionParticipant | null>(() => {
    if (messageUserId === undefined) return null;
    if (isOwnMessage) return currentUserParticipant;
    const known = participantsById?.get(String(messageUserId));
    if (known) return known;
    return {
      userId: messageUserId,
      username: '',
      role: 'user',
      first_seen: '',
      last_seen: '',
      message_count: 0,
    };
  }, [messageUserId, isOwnMessage, currentUserParticipant, participantsById]);

  // Per-message coordinator attribution (server commit 9c61b60). An assistant
  // reply carries `coordinatorId` = the participant who LAUNCHED the run that
  // produced it, which may differ from the session owner (the brother who
  // *created* the session). Resolution:
  //   1. coordinatorId resolves in the roster → that participant (name/colour);
  //   2. coordinatorId === the viewer        → the viewer's participant view;
  //   3. coordinatorId set, roster not loaded → minimal view (deterministic id
  //      colour) so the right brother's colour still shows;
  //   4. no coordinatorId (legacy/unknown)   → fall back to the session owner.
  // COLOR still = which brother; only the *source* of identity changes so the
  // header names the brother actually replying, not whoever opened the session.
  const messageCoordinatorId =
    typeof message.coordinatorId === 'number' ? message.coordinatorId : undefined;
  const coordinatorParticipant = useMemo<SessionParticipant | null>(() => {
    if (messageCoordinatorId === undefined) {
      return ownerParticipant;
    }
    if (user?.id !== undefined && Number(user.id) === messageCoordinatorId) {
      return currentUserParticipant;
    }
    const known = participantsById?.get(String(messageCoordinatorId));
    if (known) return known;
    return {
      userId: messageCoordinatorId,
      username: '',
      role: 'owner',
      first_seen: '',
      last_seen: '',
      message_count: 0,
    };
  }, [messageCoordinatorId, ownerParticipant, participantsById, currentUserParticipant, user?.id]);
  const coordinatorColorClass =
    coordinatorParticipant != null ? avatarColorForUser(coordinatorParticipant.userId) : null;

  // Owner-authored user prompt. The HUMAN side of the conversation: a user
  // (blue-bubble) message whose userId stamp matches the session owner is
  // attributed to the owner BY NAME ("User: <owner>"), never as "Coordinator"
  // — that label is reserved for the assistant side (b24c7b1), so viewers can
  // always tell what the human typed apart from what the coordinator replied.
  // Requires the owner identity (b24c7b1's `owner` prop) AND a matching userId
  // stamp; legacy/unstamped rows and other participants are unaffected and
  // keep their B-MU-UX-FIX-MSG-AUTHOR rendering.
  const isOwnerAuthoredMessage =
    message.type === 'user' &&
    owner != null &&
    messageUserId !== undefined &&
    messageUserId === owner.userId;

  // Externally-originated user prompt: a user row with NO userId stamp. These
  // rows were written straight into the provider transcript from outside the
  // UI (an agent running `claude -p`, a direct CLI session, legacy history) so
  // there is no message_authors row to resolve. Rendered with an explicit
  // "Created outside the UI" caption and a terminal-icon avatar — never a
  // person icon — so viewers cannot mistake machine-injected prompts for a
  // human sender.
  // Note: originKind rows are excluded from this bucket — they are handled by
  // isCoordinatorPrompt / isSystemOriginMessage below.
  const messageOriginKind = typeof message.originKind === 'string' ? message.originKind : undefined;
  const isCoordinatorPrompt = message.type === 'user' && messageOriginKind === 'coordinator';
  const isSystemOriginMessage =
    message.type === 'user' &&
    messageOriginKind !== undefined &&
    messageOriginKind !== 'coordinator';
  // Pure external: no userId AND no originKind (legacy CLI / direct injection)
  const isExternalOriginMessage =
    message.type === 'user' &&
    messageUserId === undefined &&
    messageOriginKind === undefined;

  // Consecutive user messages only group when they share an author AND origin
  // kind, so coordinator prompts never merge visually with human bubbles and
  // vice-versa.
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user' &&
        prevMessage.userId === message.userId &&
        (prevMessage.originKind ?? undefined) === messageOriginKind) ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(String(message.content || '')),
    [message.content]
  );
  const assistantCopyContent = message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;

  // Context value for inline exec buttons — inlineExecEnabled=true فقط
  // لرسائل المساعد الرئيسية (ليس tool use ولا thinking).
  const assistantActionsCtx = useMemo(
    () => ({
      catalog,
      runAction,
      userRole: user?.role,
      inlineExecEnabled: true,
      liveStatusOf,
    }),
    [catalog, runAction, user?.role, liveStatusOf],
  );

  useEffect(() => {
    const node = messageRef.current;
    if (!autoExpandTools || !node || !message.isToolUse) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExpanded) {
            setIsExpanded(true);
            const details = node.querySelectorAll<HTMLDetailsElement>('details');
            details.forEach((detail) => {
              detail.open = true;
            });
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, [autoExpandTools, isExpanded, message.isToolUse]);

  const formattedTime = useMemo(() => {
    const d = new Date(message.timestamp);
    // Guard against missing/invalid timestamps (e.g. some agy tool_use or
    // thinking events arrive without one) so we never render "Invalid Date".
    if (Number.isNaN(d.getTime())) return '';
    const timeStr = d.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    // Force day-month-year order regardless of locale (toLocaleDateString orders
    // by locale: en-US puts month first, we always want day first).
    const day = d.getDate();
    const month = d.toLocaleString(i18n.language, { month: 'short' });
    const year = d.getFullYear();
    // Bug 7: the "،" (Arabic comma) between the date and time was hard-coded
    // regardless of the active locale, so it also showed up in English/other
    // locales (e.g. "25 Jul 2026، 10:30 PM"). Use the locale-appropriate list
    // separator instead of a fixed Arabic punctuation mark.
    const separator = i18n.language.startsWith('ar') ? '،' : ',';
    return `${day} ${month} ${year}${separator} ${timeStr}`;
  }, [message.timestamp, i18n.language]);

  const fullDateTime = useMemo(() => {
    const d = new Date(message.timestamp);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(i18n.language, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }, [message.timestamp, i18n.language]);

  // `<time dateTime>` requires a string; normalise the (string | number | Date)
  // timestamp to a machine-readable ISO value, falling back to an empty string
  // for invalid dates so the attribute stays valid.
  const isoTimestamp = useMemo(() => {
    const d = new Date(message.timestamp);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);
  // "Hide tool calls": drop tool-use cards and sub-agent containers from the
  // transcript while keeping interactive prompts and errored results visible.
  const shouldHideToolCall = shouldHideToolCallMessage(message, hideToolCalls);
  // Stale-resume error: the backend reported the conversation no longer exists
  // instead of silently restarting. Surface an explicit retry action.
  const isSessionNotResumable =
    message.type === 'error' && message.errorCode === 'conversation_not_found';

  if (shouldHideThinkingMessage) {
    return null;
  }

  if (shouldHideToolCall) {
    return null;
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${
        message.type === 'user' && !isCoordinatorPrompt && !isSystemOriginMessage
          ? 'flex justify-end px-3 sm:px-0'
          : 'px-3 sm:px-0'
      }`}
    >
      {isCoordinatorPrompt ? (
        /* ── Coordinator → Sub-agent prompt ─────────────────────────────────
         * A user-role row carrying originKind:'coordinator': the main agent
         * (coordinator) directed a sub-agent via Task/Agent tool. Never a
         * blue human bubble. Rendered on the LEFT as a distinct machine row
         * with an amber/orange accent so it is visually unambiguous. */
        <div
          className="w-full"
          aria-label={t('coordinatorPrompt.ariaLabel', { defaultValue: 'Coordinator prompt to sub-agent' })}
        >
          {!isGrouped && (
            <div className="mb-1.5 flex items-center gap-2">
              {/* Agent delegation icon */}
              <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400" aria-hidden="true">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5 4.5 4.5m0 0L16.5 12M21 3H7.5" />
                </svg>
              </span>
              <span className="text-[11px] font-semibold uppercase text-amber-600 dark:text-amber-400">
                {t('coordinatorPrompt.label', { defaultValue: 'Coordinator → Sub-agent' })}
              </span>
            </div>
          )}
          <div className="ms-9 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2 dark:border-amber-700/40 dark:bg-amber-900/10">
            <div
              className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200"
              dir={contentDir}
            >
              {message.content}
            </div>
            <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-amber-500 dark:text-amber-400">
              {shouldShowUserCopyControl && (
                <MessageCopyControl content={userCopyContent} messageType="user" />
              )}
              {formattedTime && (
                <time dateTime={isoTimestamp} title={fullDateTime} className="cursor-default">
                  {formattedTime}
                </time>
              )}
            </div>
          </div>
        </div>
      ) : isSystemOriginMessage ? (
        /* ── System / automated message (peer / channel / task-notification) ─
         * Other machine-originated originKind values. Rendered as a neutral
         * inline system note — no bubble, no human attribution. */
        <div
          className="w-full"
          aria-label={t('systemMessage.ariaLabel', { defaultValue: 'Automated system message' })}
        >
          <div className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gray-400 dark:bg-gray-500" aria-hidden="true" />
            {/* التسمية والمحتوى شقيقان لا متداخلان: `dir="auto"` على الغلاف
                كان يقرأ أول حرف قوي فيجده حرف التسمية المترجَمة دائماً، فلا
                رأي للمحتوى في اتجاه نفسه. الآن كلٌّ يحسم اتجاهه بمحتواه. */}
            <span className="text-xs italic text-gray-500 dark:text-gray-400">
              <span className="me-1 font-medium not-italic text-gray-400 dark:text-gray-500">
                [{t('systemMessage.label', { defaultValue: 'System message' })}]
              </span>
              <span dir={contentDir}>{message.content}</span>
            </span>
            {formattedTime && (
              <time dateTime={isoTimestamp} title={fullDateTime} className="ms-auto cursor-default text-[10px] text-gray-400 dark:text-gray-500">
                {formattedTime}
              </time>
            )}
          </div>
        </div>
      ) : message.type === 'user' ? (
        /* ── Human user bubble on the right ─────────────────────────────── */
        <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className="group flex-1 rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4">
            {/* Owner-authored prompt: a "User: <owner>" caption attributing
             * this blue bubble to the human who typed it — never the
             * "Coordinator" label, which belongs to the assistant side only.
             * Shown once per group (the avatar beside the bubble carries the
             * same identity). */}
            {isOwnerAuthoredMessage && !isGrouped && ownerParticipant && (
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-blue-100">
                <span dir="auto">
                  {t('userAuthor.withName', { username: ownerParticipant.username, defaultValue: 'User: {{username}}' })}
                </span>
              </div>
            )}
            {/* Externally-originated prompt: explicit terminal-icon caption so
             * the bubble is never mistaken for a human sender (the grey
             * terminal avatar beside the bubble carries the same identity, but
             * is hidden on mobile — the caption is the always-visible cue). */}
            {isExternalOriginMessage && !isGrouped && (
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-blue-100">
                <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M5.25 20.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                </svg>
                <span dir="auto">
                  {t('externalOrigin.label', { defaultValue: 'Created outside the UI' })}
                </span>
              </div>
            )}
            <div
              className="whitespace-pre-wrap break-words text-sm"
              dir={contentDir}
            >
              {message.content}
            </div>
            {message.images && message.images.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {message.images.map((img, idx) => (
                  <img
                    key={img.name || idx}
                    src={img.data}
                    alt={img.name}
                    className="h-auto max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                    onClick={() => window.open(img.data, '_blank')}
                  />
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-blue-100">
              {shouldShowUserCopyControl && (
                <MessageCopyControl content={userCopyContent} messageType="user" />
              )}
              {formattedTime && (
                <time
                  dateTime={isoTimestamp}
                  title={fullDateTime}
                  className="cursor-default"
                >
                  {formattedTime}
                </time>
              )}
            </div>
          </div>
          {!isGrouped && (
            <div className="hidden flex-shrink-0 sm:flex">
              {isOwnerAuthoredMessage && ownerParticipant ? (
                /* Owner-authored prompt: the owner's coloured avatar labelled
                 * with the owner's own name ("User: <owner>"), keeping
                 * COLOR = which brother while the "Coordinator" identity stays
                 * exclusive to the assistant side (b24c7b1). */
                <ParticipantAvatar
                  participant={ownerParticipant}
                  size="sm"
                  locale={i18n.language}
                  t={t}
                  stacked={false}
                  avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                  ariaLabel={t('userAuthor.withName', { username: ownerParticipant.username, defaultValue: 'User: {{username}}' })}
                />
              ) : authorParticipant ? (
                <ParticipantAvatar
                  participant={authorParticipant}
                  size="sm"
                  locale={i18n.language}
                  t={t}
                  stacked={false}
                  avatarUrl={authorParticipant.avatarUrl ?? undefined}
                />
              ) : (
                /* No userId stamp — the row was written to the transcript from
                 * outside the UI (agent `claude -p`, direct CLI, legacy
                 * history): neutral grey TERMINAL avatar, never a person icon
                 * and never the viewing user's avatar. */
                <span
                  role="img"
                  aria-label={t('externalOrigin.label', { defaultValue: 'Created outside the UI' })}
                  title={t('externalOrigin.label', { defaultValue: 'Created outside the UI' })}
                  className="inline-flex h-6 w-6 select-none items-center justify-center rounded-full bg-gray-400 text-white dark:bg-gray-600"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M5.25 20.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                </span>
              )}
            </div>
          )}
        </div>
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left (B-94).
         * Reconcile cards (isReconcile) share the same layout but carry a
         * green indicator and a faint inset-start border to signal the
         * background completion that was missed by the stopped notification. */
        <div className="w-full">
          {/* الاتجاه على span النصّ وحده. كان `dir="auto"` على صفّ الـflex
              نفسه فيقلب **التخطيط** (موضع نقطة الحالة وشريط `border-s-2`) لا
              ترتيب النصّ — ومقيس أن 1742 من 1744 ملخّص إشعار حقيقي يبدأ بحرف
              لاتيني، فـ`auto` كانت تعطي ltr دوماً مهما كان المحتوى عربياً. */}
          <div
            className={`flex items-center gap-2 py-0.5${message.isReconcile ? ' border-s-2 border-green-400/50 ps-2 dark:border-green-500/40' : ''}`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                message.taskStatus === 'completed'
                  ? 'bg-green-400 dark:bg-green-500'
                  : 'bg-amber-400 dark:bg-amber-500'
              }`}
            />
            <span className="text-xs text-gray-500 dark:text-gray-400" dir={contentDir}>
              {message.content}
            </span>
          </div>
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div aria-hidden="true" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div aria-hidden="true" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                  🔧
                </div>
              ) : (
                /* Coordinator (main assistant): provider logo plus, when the
                 * coordinator of THIS reply is known, that brother's coloured
                 * avatar — resolved per-message from `coordinatorId`, falling
                 * back to the session owner — so the brother actually replying
                 * is obvious at a glance (no hover), even mid-handover. */
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
                    <SessionProviderLogo provider={provider} className="h-full w-full" />
                  </div>
                  {coordinatorParticipant && (
                    <ParticipantAvatar
                      participant={coordinatorParticipant}
                      size="sm"
                      locale={i18n.language}
                      t={t}
                      stacked={false}
                      avatarUrl={coordinatorParticipant.avatarUrl ?? undefined}
                    />
                  )}
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error'
                  ? t('messageTypes.error')
                  : message.type === 'tool'
                    ? t('messageTypes.tool')
                    : coordinatorParticipant && coordinatorParticipant.username
                      ? t('coordinator.withName', { username: coordinatorParticipant.username, defaultValue: 'Coordinator: {{username}}' })
                      // T-224 (م0): اسم العرض من الواصف — hermes/kimi/deepseek/glm
                      // تظهر بأسمائها الصحيحة بدل «Claude» الخاطئة.
                      : getProviderDisplayName(provider)}
              </div>
            </div>
          )}

          <div className="w-full">

            {isSessionNotResumable ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
                <p className="text-sm text-red-800 dark:text-red-200" dir="auto">
                  {t('sessionNotResumable.message')}
                </p>
                <button
                  type="button"
                  onClick={() => onStartNewSession?.(String(message.failedCommand || ''))}
                  disabled={!message.failedCommand || !onStartNewSession}
                  aria-label={t('sessionNotResumable.startNew')}
                  className="mt-3 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-600"
                >
                  {t('sessionNotResumable.startNew')}
                </button>
              </div>
            ) : message.isToolUse ? (
              <>
                {/*
                 * Sub-agent badge: any `Task` tool call delegates to a child
                 * agent (subagent). Surfaced as a small pill so the user can
                 * tell the work is being done by a delegated agent rather
                 * than the primary model.
                 */}
                {message.toolName === 'Task' && (
                  <div className="mb-1.5 flex">
                    {coordinatorParticipant && coordinatorParticipant.username && coordinatorColorClass ? (
                      /* Sub-agent launched within a coordinator's run: tint the
                       * pill with that brother's colour (COLOR = which brother),
                       * resolved per-message from `coordinatorId`, while the pill
                       * SHAPE keeps it distinct from the coordinator avatar. */
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white',
                          coordinatorColorClass,
                        )}
                        aria-label={t('subagent.badgeLabel', { defaultValue: 'Sub-agent task' })}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-white/80" aria-hidden="true" />
                        {t('subagent.shortBadge', { defaultValue: 'Sub-agent' })}
                        <span className="font-normal normal-case opacity-90">· {coordinatorParticipant.username}</span>
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 rounded-md border border-purple-300/70 bg-purple-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-purple-700 dark:border-purple-700/60 dark:bg-purple-900/30 dark:text-purple-200"
                        aria-label={t('subagent.badgeLabel', { defaultValue: 'Sub-agent task' })}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-purple-500 dark:bg-purple-400" aria-hidden="true" />
                        {t('subagent.shortBadge', { defaultValue: 'Sub-agent' })}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none dark:prose-invert">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    autoExpandTools={autoExpandTools}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {/* Tool Result Section */}
                {message.toolResult && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    // Error results - red error box with content
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 scroll-mt-4 rounded border border-red-200/60 bg-red-50/50 p-3 dark:border-red-800/40 dark:bg-red-950/10"
                    >
                      <div className="relative mb-2 flex items-center gap-1.5">
                        <svg className="h-4 w-4 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-red-700 dark:text-red-300">{t('messageTypes.error')}</span>
                      </div>
                      <div className="relative text-sm text-red-900 dark:text-red-100">
                        <Markdown className="prose prose-sm prose-red max-w-none dark:prose-invert">
                          {String(message.toolResult.content || '')}
                        </Markdown>
                      </div>
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        autoExpandTools={autoExpandTools}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500">
                    <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-amber-900 dark:text-amber-100">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          {/* سؤال المزوّد وخياراته نصّ حرّ بلغة المستخدم —
                              كلٌّ يحسم اتجاهه بمحتواه لا بلغة الواجهة. */}
                          <p
                            className="mb-4 text-sm text-amber-800 dark:text-amber-200"
                            dir={resolveTextDirection(questionLine) ?? undefined}
                          >
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-start transition-all ${option.isSelected
                                  ? 'border-amber-600 bg-amber-600 text-white shadow-md dark:border-amber-700 dark:bg-amber-700'
                                  : 'border-amber-300 bg-white text-amber-900 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-100'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-white/20'
                                    : 'bg-amber-100 dark:bg-amber-800/50'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span
                                    className="flex-1 text-sm font-medium sm:text-base"
                                    dir={resolveTextDirection(option.text) ?? undefined}
                                  >
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-amber-100 p-3 dark:bg-amber-800/30">
                            <p className="mb-1 text-sm font-medium text-amber-900 dark:text-amber-100">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                    {message.content}
                  </Markdown>
                  <div className="mt-3 flex items-center text-[11px]">
                    <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                  </div>
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                {/* Reasoning accordion */}
                {showThinking && message.reasoning && (
                  <Reasoning className="mb-3" defaultOpen={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-gray-100 dark:text-gray-200">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <ChatActionsContext.Provider value={assistantActionsCtx}>
                      {/* `streaming` يمنع اهتزاز اتجاه الفقاعة بينما ينمو النصّ
                          10 مرات/ثانية (14.4% من الرسائل العربية الحقيقية كانت
                          تنقلب وسط القراءة). التفصيل في utils/textDirection. */}
                      <Markdown
                        className="prose prose-sm prose-gray max-w-none dark:prose-invert"
                        streaming={message.isStreaming === true}
                      >
                        {content}
                      </Markdown>
                    </ChatActionsContext.Provider>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
              {shouldShowAssistantCopyControl && (
                <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
              )}
              {formattedTime && (
                <time
                  dateTime={isoTimestamp}
                  title={fullDateTime}
                  className="cursor-default"
                >
                  {formattedTime}
                </time>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;

