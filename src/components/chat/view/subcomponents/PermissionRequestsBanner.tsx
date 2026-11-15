import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hourglass, ShieldAlertIcon } from 'lucide-react';

import type { PendingPermissionRequest, Question } from '../../types/types';
import type { PendingQuestionState } from '../../utils/pendingQuestionState';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getClaudeSettings } from '../../utils/chatStorage';
import { SHARED_DENY_NOTE_MAX_CHARS, capDenyNote, permissionAnswerRole } from '../../utils/sharedWriting';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from '../../../../shared/view/ui';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  /** Display state per requestId (see classifyPendingQuestions); absent = active. */
  pendingQuestionStates?: Map<string, PendingQuestionState>;
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  /** ADR-173 P6: the signed-in user; with `runStarterUserId`, decides the non-starter controls. */
  viewerUserId?: number | null;
  /** ADR-173 P6: users.id of the member who started the running turn; null when unknown. */
  runStarterUserId?: number | null;
  /** ADR-173 P6: users.id → display name from the session roster. */
  resolveName?: (userId: number | null) => string | null;
}

/** FSI/PDI isolation for a name inside a translated sentence. */
const isolate = (text: string) => `\u2068${text}\u2069`;

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  pendingQuestionStates,
  handlePermissionDecision,
  handleGrantToolPermission,
  viewerUserId = null,
  runStarterUserId = null,
  resolveName,
}: PermissionRequestsBannerProps) {
  const { t } = useTranslation('chat');
  // Filter out plan tool requests — they are handled inline by PlanDisplay
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode'
  );

  if (!filteredRequests.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        const state = pendingQuestionStates?.get(request.requestId) ?? 'active';
        if (state !== 'active') {
          return <InactiveQuestionNotice key={request.requestId} request={request} state={state} />;
        }
        // ADR-173 P5/P6: a member who did not start the turn answers within the
        // server's rules — read-only for starter-only prompts, allow/deny otherwise.
        const answerRole = permissionAnswerRole(request, viewerUserId, runStarterUserId);
        if (answerRole !== 'starter') {
          const starterName = isolate(
            resolveName?.(request.starterUserId ?? runStarterUserId)
              ?? t('sharedWriting.approval.starterFallback'),
          );
          return answerRole === 'read_only' ? (
            <StarterOnlyRequestNotice key={request.requestId} request={request} starterName={starterName} />
          ) : (
            <NonStarterRequestCard
              key={request.requestId}
              request={request}
              starterName={starterName}
              onDecision={handlePermissionDecision}
            />
          );
        }
        const CustomPanel = getPermissionPanel(request.toolName);
        if (CustomPanel) {
          return (
            <CustomPanel
              key={request.requestId}
              request={request}
              onDecision={handlePermissionDecision}
            />
          );
        }

        const rawInput = formatToolInputForDisplay(request.input);
        const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
        const settings = getClaudeSettings();
        const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
        const rememberLabel = alreadyAllowed ? t('permissions.allowSaved') : t('permissions.allowAndRemember');
        const matchingRequestIds = permissionEntry
          ? pendingPermissionRequests
              .filter(
                (item) =>
                  buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry,
              )
              .map((item) => item.requestId)
          : [request.requestId];

        return (
          <Confirmation key={request.requestId} approval="pending">
            <ConfirmationTitle className="flex items-start gap-3">
              <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <ConfirmationRequest>
                <div>
                  <span className="font-medium text-foreground">{t('permissions.required')}</span>
                  <span className="ms-2 text-muted-foreground">
                    {t('permissions.tool')} <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
                  </span>
                </div>
                {permissionEntry && !request.steerTainted && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('permissions.allowRule')} <code className="rounded bg-muted px-1 py-0.5 text-xs">{permissionEntry}</code>
                  </div>
                )}
                {/* T-1903 (ADR-190): طلبٌ تلا توجيهاً من زميل — تنبيهٌ صريح
                    ولا خيار حفظ قاعدة (أدناه). التصلّب الفعلي خادميّ؛ هذا
                    عرضٌ صادقٌ له لا فرضٌ عميليّ. */}
                {request.steerTainted && (
                  <div className="mt-1 text-xs text-[color:var(--session-steer-accent)]">
                    {t('permissions.steerTaintedNote', {
                      defaultValue: 'This request follows a colleague’s steer — only allow once or deny.',
                    })}
                  </div>
                )}
              </ConfirmationRequest>
            </ConfirmationTitle>

            {rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {t('permissions.viewInput')}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  {rawInput}
                </pre>
              </details>
            )}

            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: 'User denied tool use' })}
              >
                {t('permissions.deny')}
              </ConfirmationAction>
              {/* T-1903 (ADR-190): لا خيار «اسمح واحفظ» على طلبٍ مُلطَّخ
                  بتوجيه — قاعدة محفوظة تحت تلطّخ تُوافق ضمناً على تشغيلاتٍ
                  لاحقة غير مرتبطة، وهذا يخالف نيّة التلطّخ (لمرّة واحدة). */}
              {!request.steerTainted && (
                <ConfirmationAction
                  variant="outline"
                  onClick={() => {
                    if (permissionEntry && !alreadyAllowed) {
                      handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                    }
                    handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                  }}
                  disabled={!permissionEntry}
                >
                  {rememberLabel}
                </ConfirmationAction>
              )}
              <ConfirmationAction
                variant="default"
                onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
              >
                {t('permissions.allowOnce')}
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        );
      })}
    </div>
  );
}

/** ADR-173 P6: the tool name and its raw input, shared by the non-starter cards. */
function RequestSummary({ request }: { request: PendingPermissionRequest }) {
  const { t } = useTranslation('chat');
  const rawInput = formatToolInputForDisplay(request.input);
  return (
    <>
      <div>
        <span className="font-medium text-foreground">{t('permissions.required')}</span>
        <span className="ms-2 text-muted-foreground">
          {t('permissions.tool')} <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
        </span>
      </div>
      {rawInput && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {t('permissions.viewInput')}
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
            {rawInput}
          </pre>
        </details>
      )}
    </>
  );
}

/**
 * ADR-173 P5/P6: a prompt only the turn's starter may answer — a connector tool
 * acting under the starter's own account, or a question answered by edited input.
 */
function StarterOnlyRequestNotice({ request, starterName }: { request: PendingPermissionRequest; starterName: string }) {
  const { t } = useTranslation('chat');
  const waitingKey = request.toolName === 'AskUserQuestion'
    ? 'sharedWriting.approval.waitingQuestion' : 'sharedWriting.approval.waitingFor';
  return (
    <div
      role="status"
      data-permission-readonly=""
      className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm"
    >
      <RequestSummary request={request} />
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Hourglass className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        {t(waitingKey, { name: starterName })}
      </p>
    </div>
  );
}

/**
 * ADR-173 P5/P6: another shared writer answering the starter's prompt — allow
 * once or deny with an optional note (capped as the server caps it, sent with
 * the writer's name). No "allow & remember": a saved rule is the starter's call.
 */
function NonStarterRequestCard({
  request,
  starterName,
  onDecision,
}: {
  request: PendingPermissionRequest;
  starterName: string;
  onDecision: PermissionRequestsBannerProps['handlePermissionDecision'];
}) {
  const { t } = useTranslation('chat');
  const [note, setNote] = useState('');
  const noteId = `deny-note-${request.requestId}`;
  const deny = () => {
    const message = capDenyNote(note);
    onDecision(request.requestId, { allow: false, message: message || 'User denied tool use' });
  };
  return (
    <Confirmation approval="pending">
      <ConfirmationTitle className="flex items-start gap-3">
        <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <ConfirmationRequest>
          <RequestSummary request={request} />
          <div className="mt-1 text-xs text-muted-foreground">
            {t('sharedWriting.approval.nonStarterNote', { name: starterName })}
          </div>
        </ConfirmationRequest>
      </ConfirmationTitle>
      <div className="mt-2 space-y-1">
        <label htmlFor={noteId} className="block text-xs font-medium text-foreground">
          {t('sharedWriting.approval.denyNoteLabel')}
        </label>
        <textarea
          id={noteId}
          value={note}
          maxLength={SHARED_DENY_NOTE_MAX_CHARS}
          onChange={(event) => setNote(event.target.value.slice(0, SHARED_DENY_NOTE_MAX_CHARS))}
          rows={2}
          aria-describedby={`${noteId}-hint`}
          className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div id={`${noteId}-hint`} className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('sharedWriting.approval.denyNoteHint')}</span>
          <span aria-live="polite" className="tabular-nums">
            {t('sharedWriting.approval.counter', { count: note.length, max: SHARED_DENY_NOTE_MAX_CHARS })}
          </span>
        </div>
      </div>
      <ConfirmationActions>
        <ConfirmationAction variant="outline" onClick={deny}>
          {t('permissions.deny')}
        </ConfirmationAction>
        <ConfirmationAction variant="default" onClick={() => onDecision(request.requestId, { allow: true })}>
          {t('permissions.allowOnce')}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

/**
 * Read-only stand-in for a question that can no longer be answered (settled in
 * the transcript or replaced by a newer ask). Keeps the text reachable without
 * offering any control that would answer a dead tool_use.
 */
function InactiveQuestionNotice({
  request,
  state,
}: {
  request: PendingPermissionRequest;
  state: Exclude<PendingQuestionState, 'active'>;
}) {
  const { t } = useTranslation('chat');
  const questions = ((request.input as { questions?: Question[] } | undefined)?.questions) ?? [];
  return (
    <details
      className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      data-question-state={state}
    >
      <summary className="cursor-pointer">{t(`askUser.${state}`)}</summary>
      {questions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 ps-4">
          {questions.map((q, i) => (
            <li key={i}>{q.question}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
