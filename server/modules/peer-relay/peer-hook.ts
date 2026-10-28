/**
 * ADR-219 م-6 — the relay's in-process SDK PreToolUse callback.
 *
 * Armed on every Claude spawn (never a shell hook), it fires for subagent calls
 * too (`agent_id` present) and reads the run state at call time; in `native`
 * mode it is a no-op. In `relay` mode:
 *   - SendMessage: grammar-first classification; a session address becomes a
 *     relay row and the deny reason states success; subagent recipients pass.
 *   - ListAgents/ListPeers: replaced by the caller user's own sessions.
 *   - CronCreate/ScheduleWakeup/RemoteTrigger/Workflow: denied while the
 *     effective hop is > 0 (ح-2 a), subagents included.
 * `refuse` is the security boundary; this hook is routing (threat model).
 */

import { effectiveHop, nextHop, PEER_SCHEDULING_TOOLS, schedulingDenied } from './peer-policy.js';
import { classifyRecipient, readRecipient, type ListedSession, type RecipientClass } from './peer-recipient.js';
import { isUnverifiedCli, type PeerRunState } from './peer-run.js';
import type { PeerSendOutcome, PeerSendRequest } from './peer-relay.service.js';

export const PEER_HOOK_MATCHER = 'SendMessage|ListAgents|ListPeers|CronCreate|ScheduleWakeup|RemoteTrigger|Workflow';

const SCHEDULING = new Set<string>(PEER_SCHEDULING_TOOLS);
const LIST_TOOLS = new Set(['ListAgents', 'ListPeers']);

export type PeerHookDependencies = {
  /** ADR-218 registry: is `value` an agent id of this session. */
  isKnownAgent: (sessionId: string, value: string) => boolean;
  agentOriginHop: (sessionId: string, agentId: string) => number;
  listOwnSessions: (userId: number | null, excludeSessionId: string | null) => ListedSession[];
  formatSessionList: (sessions: readonly ListedSession[]) => string;
  enqueue: (request: PeerSendRequest) => PeerSendOutcome;
  audit: (action: 'peer_relay_unregistered_agent_send', userId: number | null, metadata: Record<string, unknown>) => void;
};

type HookInput = {
  hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; session_id?: unknown; agent_id?: unknown;
};

export type PreToolUseDecision = Record<string, never> | {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
};

const ALLOW: PreToolUseDecision = {};

/** A PreToolUse deny carrying `reason` as the text the model reads. */
export function denyWith(reason: string): PreToolUseDecision {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

type CallContext = { run: PeerRunState; sessionId: string | null; agentId: string | null; effective: number };

function readContext(run: PeerRunState, input: HookInput, deps: PeerHookDependencies): CallContext {
  const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : run.sessionId;
  if (sessionId && !run.sessionId) run.sessionId = sessionId;
  const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
  const originHop = agentId && sessionId ? deps.agentOriginHop(sessionId, agentId) : 0;
  return { run, sessionId, agentId, effective: effectiveHop(run.peerHop, originHop) };
}

function readMessage(toolInput: unknown): { text: string | null; structured: boolean } {
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
  const value = input.message !== undefined ? input.message : input.content;
  if (typeof value === 'string') return { text: value, structured: false };
  return { text: null, structured: value !== undefined && value !== null };
}

/** The relayed send: identity from the run entry, hop from the run (never the input). */
function relaySend(ctx: CallContext, target: { sessionId: string }, toolInput: unknown, deps: PeerHookDependencies): PreToolUseDecision {
  if (isUnverifiedCli(ctx.run)) return denyWith('relay unavailable: unverified CLI');
  const message = readMessage(toolInput);
  if (message.structured) return denyWith('refused: structured messages (shutdown or plan approval) cannot be relayed to a session');
  if (!message.text || !message.text.trim()) return denyWith('refused: an empty message cannot be relayed');
  const hop = nextHop(ctx.effective);
  if (hop === null) return denyWith('refused: hop limit reached (4); this message would extend a relay chain too far');
  if (!ctx.sessionId) return denyWith('relay unavailable: the sending session has no id yet');
  const input = toolInput as Record<string, unknown>;
  const outcome = deps.enqueue({
    run: ctx.run, senderSessionId: ctx.sessionId, senderAgentId: ctx.agentId, targetSessionId: target.sessionId,
    message: message.text, summary: typeof input.summary === 'string' ? input.summary : null, hop,
    notifyWhenIdle: input.notify_when_idle === true,
  });
  return denyWith(outcome.text);
}

function onSendMessage(ctx: CallContext, toolInput: unknown, deps: PeerHookDependencies): PreToolUseDecision {
  const recipient = readRecipient(toolInput);
  if (!recipient) return ALLOW;
  const sessionId = ctx.sessionId;
  const verdict: RecipientClass = classifyRecipient(recipient, {
    isKnownAgent: (value) => Boolean(sessionId) && deps.isKnownAgent(sessionId as string, value),
    listedSessions: () => deps.listOwnSessions(ctx.run.userId, sessionId),
  });
  if (verdict.kind === 'allow') return ALLOW;
  if (verdict.kind === 'allow-audit') {
    deps.audit('peer_relay_unregistered_agent_send', ctx.run.userId, { sessionId, recipient, agentId: ctx.agentId });
    return ALLOW;
  }
  if (verdict.kind === 'deny') {
    return denyWith('refused: that recipient is not a known agent of this session or one of your nassaj sessions; '
      + 'use ListAgents to see the sessions you can message');
  }
  if ('unresolved' in verdict.target) {
    return denyWith('refused: that address does not resolve to one of your nassaj sessions; use ListAgents');
  }
  return relaySend(ctx, verdict.target, toolInput, deps);
}

/** Routes one PreToolUse call. Pure over `deps`; the caller wraps it so it never throws. */
export function decidePeerToolUse(run: PeerRunState, input: HookInput, deps: PeerHookDependencies): PreToolUseDecision {
  if (run.relayMode !== 'relay') return ALLOW;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ctx = readContext(run, input, deps);
  if (SCHEDULING.has(tool)) {
    return schedulingDenied(ctx.effective)
      ? denyWith(`${tool} is not available in a turn woken by another session (no scheduling from relayed work)`)
      : ALLOW;
  }
  if (LIST_TOOLS.has(tool)) return denyWith(deps.formatSessionList(deps.listOwnSessions(run.userId, ctx.sessionId)));
  if (tool === 'SendMessage') return onSendMessage(ctx, input.tool_input, deps);
  return ALLOW;
}

/**
 * The fail-closed answer when routing itself failed: a session-shaped send or a
 * list is refused, scheduling in a peer-woken run is refused, anything else passes.
 */
function failClosed(run: PeerRunState, input: HookInput): PreToolUseDecision {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (run.relayMode !== 'relay') return ALLOW;
  if (SCHEDULING.has(tool)) return run.peerHop > 0 ? denyWith(`${tool} is not available in this turn`) : ALLOW;
  if (LIST_TOOLS.has(tool)) return denyWith('relay unavailable: the session list could not be read; try again later');
  if (tool === 'SendMessage') return denyWith('relay unavailable: the message was not sent; try again later');
  return ALLOW;
}

/** The SDK `hooks.PreToolUse` entry for one run. */
export function buildPeerRelayHookMatcher(run: PeerRunState, deps: PeerHookDependencies) {
  return {
    matcher: PEER_HOOK_MATCHER,
    hooks: [async (input: HookInput): Promise<PreToolUseDecision> => {
      try {
        return decidePeerToolUse(run, input ?? {}, deps);
      } catch {
        return failClosed(run, input ?? {});
      }
    }],
  };
}
