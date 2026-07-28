/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

/**
 * True when a sub-agent container's `tool_result` is a background-launch
 * ACKNOWLEDGMENT, not the real completion (B-63/T-143 root cause).
 *
 * Verified against real production transcripts (this project's
 * `~/.claude/projects/.../*.jsonl` + `subagents/agent-*.jsonl`, thousands of
 * real `Agent`-tool delegations): when a sub-agent is launched in the
 * background (the default execution mode), its container's tool_result
 * arrives ~3-7ms after the tool_use with `toolUseResult` shaped
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile, ... }` —
 * the delegated work has barely started and continues out-of-process for the
 * rest of the turn (and often past it), reporting real completion later via a
 * separate task-notification message, never a second tool_result on this same
 * toolId. Treating that acknowledgment as `isComplete` (as the container
 * branch below used to, unconditionally) flipped the sub-agent to "done"
 * within milliseconds of delegation, so useRunProgress's activeSubagent /
 * agentsDone and the per-agent strip row showed it finished for the rest of
 * the run even though it was still working — foreclosing any chance of the
 * live "still working" signal (or a later TodoWrite) ever being attributed to
 * a container the UI hadn't already written off as resolved.
 *
 * Foreground (blocking) delegations are unaffected: their tool_result has no
 * `isAsync`/`status:'async_launched'` marker and still resolves isComplete
 * exactly as before.
 */
function isAsyncLaunchAck(toolUseResult: unknown): boolean {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return false;
  const tur = toolUseResult as Record<string, unknown>;
  return tur.isAsync === true && tur.status === 'async_launched';
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  // Pre-pass (B-63 live counter): fold *live* sub-agent tool rows into their
  // container. The SDK streams a sub-agent's tool_use/tool_result blocks during
  // a delegation run (no flag needed — "enough for a heartbeat counter", see
  // @anthropic-ai/claude-agent-sdk sdk.d.ts ~L1525), each stamped with
  // `parent_tool_use_id` = the id of the parent `Task`/`Agent` tool_use block.
  // The server (claude-sdk.js transformMessage → parentToolUseId, copied onto
  // every normalized row) forwards it; the client appends it verbatim. That id
  // equals the container row's `toolId`, which the live normalizer derives from
  // the same tool_use block id (`part.id`, claude-sessions.provider.ts ~L567).
  //
  // Without this, each live child arrives as an independent top-level tool_use
  // row, renders orphaned, and is never seen by useRunProgress (which only
  // descends into `subagentState.childTools`). Here we group those children by
  // their parent id into the same SubagentChildTool shape the history path
  // builds, so the container branch below can merge them and useRunProgress can
  // count the sub-agent's TodoWrite live. The map is order-independent: a child
  // that arrives before its container is still attached when the container is
  // converted, because both passes run over the full `messages` array.
  const liveChildMap = new Map<string, SubagentChildTool[]>();
  for (const msg of messages) {
    if (msg.kind !== 'tool_use' || !msg.parentToolUseId || !msg.toolId) continue;
    const tr = msg.toolResult || toolResultMap.get(msg.toolId) || null;
    const child: SubagentChildTool = {
      toolId: msg.toolId,
      toolName: msg.toolName || '',
      toolInput: msg.toolInput,
      toolResult: tr
        ? {
            content: formatToolResultContent(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: (tr as any).toolUseResult,
          }
        : null,
      timestamp: new Date(msg.timestamp || Date.now()),
    };
    const bucket = liveChildMap.get(msg.parentToolUseId);
    if (bucket) bucket.push(child);
    else liveChildMap.set(msg.parentToolUseId, [child]);
  }

  for (const msg of messages) {
    const sharedMetadata = {
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
      // Per-message coordinator attribution (server commit 9c61b60). Carried on
      // every converted row via the shared spread; only assistant rows ever
      // hold a value (user rows use `userId`), and MessageComponent resolves it
      // against the participant roster, falling back to the session owner when
      // null/absent.
      coordinatorId: msg.coordinatorId,
      // Machine-origin discriminator (server commit 91b8b39). Present only on
      // kind:'text' role:'user' rows that were written programmatically (no
      // userId). MessageComponent uses this to render coordinator-to-subagent
      // prompts distinctly from human input.
      originKind: msg.originKind,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          // Parse task notifications (B-94 / C1-C2 fix, validated 184/184 on real
          // SDK transcripts). Real notifications observed in the wild:
          //   - "stopped": <task-id> + <tool-use-id> + <status> + <summary>.
          //   - "completed": <task-id> + <tool-use-id> AND <output-file> together,
          //     followed (after </summary>) by a <result>…</result> block (whose
          //     body contains unbalanced "<") and a <usage>…</usage> block.
          // The previous regex required exactly one optional inner block AND a
          // closing </task-notification> anchor, so it failed every completed
          // notification (only ~6.5% matched). This pattern allows any number of
          // inner <tag>…</tag> blocks between <task-id> and <status> (lazily, so a
          // bare notification with <status> immediately after <task-id> still
          // matches) and drops the trailing anchor so the <result>/<usage> blocks
          // never have to parse. Defined fresh per message (no /g flag → no
          // lastIndex carry-over across rows). Capture groups: [1]=task-id,
          // [2]=status, [3]=summary.
          const taskNotifRegex =
            /<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*(?:<[a-z-]+>[^<]*<\/[a-z-]+>\s*)*?<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>/;
          const taskNotifMatch = taskNotifRegex.exec(content);
          if (taskNotifMatch) {
            // Extract wfId so reconcile cards can match (B-94 / C2). The real
            // task-id is NOT the workflow id (it is the per-task SDK id, e.g.
            // "wyb0qkwy5"); the workflow id lives in the summary as
            // `resumeFromRunId: "wf_…"`. Read it from the full content: prefer the
            // explicit resumeFromRunId, then fall back to any bare wf_<hex> token.
            const wfMatch =
              /resumeFromRunId:\s*"(wf_[^"]+)"/.exec(content)
              || /\b(wf_[0-9a-f]+(?:-[0-9a-f]+)?)\b/.exec(content);
            const wfId = wfMatch ? wfMatch[1] : undefined;
            converted.push({
              id: msg.id,
              type: 'assistant',
              content: taskNotifMatch[3]?.trim() || 'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotifMatch[2]?.trim() || 'completed',
              wfId,
              ...sharedMetadata,
            });
          } else {
            converted.push({
              id: msg.id,
              type: 'user',
              content: unescapeWithMathProtection(decodeHtmlEntities(content)),
              timestamp: msg.timestamp,
              // Real author (users.id). Absent = unknown author; the renderer
              // must not attribute the message to the viewing user.
              userId: msg.userId,
              ...sharedMetadata,
            });
          }
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        // Live sub-agent child tool (carries parentToolUseId): already folded
        // into its container's childTools in the pre-pass. Do NOT also emit it as
        // a flat top-level row, or it renders orphaned and double-counts (B-63).
        if (msg.parentToolUseId) {
          break;
        }

        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        // Sub-agent container: the coordinator delegating a run. Two tool names
        // delegate in this codebase — Claude's native `Task` and the agy /
        // Antigravity `Agent` tool (the only one actually used in nassaj runs,
        // 2114 uses vs 0 for `Task`). Both attach their child tools via
        // `subagentTools` on the result, so both must be recognised or the live
        // active-agent chip and the history child-tool descent in useRunProgress
        // never fire for real nassaj delegation runs (B-63).
        const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';

        // Build child tools from subagentTools (history aggregate) and merge the
        // live children folded in the pre-pass (B-63). Dedup by toolId — the same
        // tool can appear in both once a run finishes and its children are also
        // aggregated onto the container — keeping the history copy as canonical.
        const childTools: SubagentChildTool[] = [];
        const seenChildIds = new Set<string>();
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
            if (tool.toolId) seenChildIds.add(tool.toolId);
          }
        }
        if (isSubagentContainer && msg.toolId) {
          const liveChildren = liveChildMap.get(msg.toolId);
          if (liveChildren) {
            for (const child of liveChildren) {
              if (child.toolId && seenChildIds.has(child.toolId)) continue;
              childTools.push(child);
              if (child.toolId) seenChildIds.add(child.toolId);
            }
          }
        }

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        converted.push({
          id: msg.id,
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                // A background-launch acknowledgment is not real completion
                // (B-63/T-143) — keep the container "running" so the live
                // agent-working signal survives for the rest of the turn.
                isComplete: Boolean(toolResult) && !isAsyncLaunchAck(toolResult?.toolUseResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          id: msg.id,
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          // Carry the stale-resume signal so the renderer can offer an explicit
          // "start new session" action instead of a plain error bubble.
          errorCode: msg.code,
          staleSessionId: msg.staleSessionId,
          failedCommand: msg.command,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          wfId: msg.wfId,
          ...sharedMetadata,
        });
        break;

      // Synthetic reconcile row injected from a REST/WS reconcile result (B-94).
      // The row carries isTaskNotification:true so it flows through the existing
      // card path in MessageComponent with no further changes needed there.
      //
      // C5: the backend distinguishes two terminal outcomes via `taskStatus`:
      //   'completed' — every agent in the workflow finished.
      //   'settled'   — the workflow quiesced but some agents never completed.
      // Reflect that in both the headline copy and the card's taskStatus (do NOT
      // hardcode 'completed'); fall back to 'completed' for legacy rows that omit
      // it. The (done/total) counts are appended when present.
      case 'task_reconcile': {
        const reconcileStatus =
          (msg as NormalizedMessage & { taskStatus?: string }).taskStatus === 'settled'
            ? 'settled'
            : 'completed';
        const hasCounts = msg.agentsDone != null && msg.agentsTotal != null;
        const reconcileContent =
          reconcileStatus === 'settled'
            ? (hasCounts
                ? `هدأ في الخلفية (${msg.agentsDone}/${msg.agentsTotal} — بعض الوكلاء لم يُكملوا)`
                : (msg.summary || 'هدأ في الخلفية — بعض الوكلاء لم يُكملوا'))
            : (hasCounts
                ? `اكتمل في الخلفية (${msg.agentsDone}/${msg.agentsTotal})`
                : (msg.summary || 'اكتمل في الخلفية'));
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: reconcileContent,
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: reconcileStatus,
          wfId: msg.wfId,
          isReconcile: true,
          ...sharedMetadata,
        });
        break;
      }

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseIds.has(msg.toolId)) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        // Orphaned result: its tool_use fell outside the loaded window (page
        // cut, realtime cap, or mid-run reattach). Render it as a collapsed
        // generic tool block — never as plain assistant prose, which dumps
        // raw line-numbered file content into the transcript.
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: 'ToolResult',
          toolInput: '',
          toolId: msg.toolId,
          toolResult: {
            content,
            isError: Boolean(msg.isError),
            toolUseResult: (msg as any).toolUseResult,
          },
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }
  }

  // ── Reconcile pass (B-94 / C3) ─────────────────────────────────────────────
  // A task_reconcile card replaces the stopped notification for the same
  // workflow (isTaskNotification + same wfId + taskStatus:'stopped'); the
  // reconcile card lands at the stopped card's position and the standalone
  // reconcile row is removed. If a workflow has a reconcile card but no stopped
  // card, the reconcile card stays where it is (timestamp order is already
  // correct because computeMerged sorts the source rows chronologically).
  //
  // The previous implementation collected (recIdx, stoppedIdx) pairs and spliced
  // them out back-to-front, but each pair was computed against the ORIGINAL
  // indices: once one splice shifted the array, the remaining stale indices
  // corrupted the order of two interleaved workflows (architect-verified failing
  // case [recA, stopB, recB, stopA]). This is a single O(n) rebuild instead:
  //   1. Map<wfId, reconcileCard> keeping the LAST reconcile per wfId (dedup).
  //   2. The subset of those wfIds that actually have a stopped card.
  //   3. One left-to-right pass over `converted`:
  //        - a stopped card whose wfId is in that subset → emit the (last)
  //          reconcile card in its place, once, and drop the stopped card;
  //        - any reconcile card whose wfId is in that subset → drop (it has been
  //          / will be emitted at the stopped slot);
  //        - a superseded duplicate reconcile (same wfId, no stopped card) → drop
  //          so only the last survives;
  //        - everything else → keep verbatim.
  // Handles: interleaved workflows, two reconcile cards for one wfId (collapse to
  // one), and a reconcile with no stopped card (stays appended).
  const reconcileByWf = new Map<string, ChatMessage>();
  for (const m of converted) {
    if (m.isReconcile && m.wfId) reconcileByWf.set(m.wfId, m);
  }
  if (reconcileByWf.size === 0) return converted;

  const stoppedWfIds = new Set<string>();
  for (const m of converted) {
    if (
      m.isTaskNotification
      && !m.isReconcile
      && m.wfId
      && m.taskStatus === 'stopped'
      && reconcileByWf.has(m.wfId)
    ) {
      stoppedWfIds.add(m.wfId);
    }
  }

  const rebuilt: ChatMessage[] = [];
  const placed = new Set<string>();
  for (const m of converted) {
    if (
      m.isTaskNotification
      && !m.isReconcile
      && m.wfId
      && m.taskStatus === 'stopped'
      && stoppedWfIds.has(m.wfId)
    ) {
      // Stopped card with a reconcile: emit the canonical reconcile card here once.
      if (!placed.has(m.wfId)) {
        rebuilt.push(reconcileByWf.get(m.wfId)!);
        placed.add(m.wfId);
      }
      continue;
    }
    if (m.isReconcile && m.wfId) {
      // Reconcile card that belongs at a stopped slot → drop its standalone copy.
      if (stoppedWfIds.has(m.wfId)) continue;
      // Superseded duplicate reconcile (no stopped card) → keep only the last.
      if (reconcileByWf.get(m.wfId) !== m) continue;
    }
    rebuilt.push(m);
  }

  return rebuilt;
}
