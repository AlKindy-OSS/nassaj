/**
 * ADR-219 م-3 — SendMessage recipient classification, grammar first.
 *
 *  1. Session-address grammar (`nassaj:<id>`, `uds:…`, `name [ref]`) → relay.
 *  2. `main`, or an agent id/name the ADR-218 registry knows for this session → allow (D4).
 *  3. An agentId-shaped value with no registry match → allow and audit (an agent
 *     born after the last registry write, or a post-restart gap).
 *  4. A bare name matching one of the caller's listed sessions → relay.
 *  5. Anything else → deny, fail closed.
 *
 * Pure: the registry lookup and the caller's session list are passed in.
 */

/** Agent id shape measured on CLI 2.1.306 (`a` + 16 hex, e.g. `af6f1f72c47f9b6ff`). */
export const AGENT_ID_SHAPE = /^a[0-9a-f]{16}$/u;

const NASSAJ_ADDRESS = /^nassaj:([A-Za-z0-9_-]{1,64})$/u;
const UDS_ADDRESS = /^uds:/u;
/** `name [ref]` — a listed peer addressed with its bracketed reference. */
const NAME_REF_ADDRESS = /^(.+?)\s*\[([^\]\s]{1,128})\]$/u;

export type RecipientClass =
  | { kind: 'relay'; target: { sessionId: string } | { unresolved: string } }
  | { kind: 'allow' }
  | { kind: 'allow-audit' }
  | { kind: 'deny'; reason: string };

export type ListedSession = { sessionId: string; title: string | null };

export type ClassifyContext = {
  /** True when the ADR-218 registry knows `value` as an agent of the caller's session. */
  isKnownAgent: (value: string) => boolean;
  /** The caller's own sessions, as ListAgents shows them. */
  listedSessions: () => readonly ListedSession[];
};

/** The SendMessage recipient, from the current field or the legacy hook copy. */
export function readRecipient(toolInput: unknown): string | null {
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
  const value = typeof input.to === 'string' ? input.to : typeof input.recipient === 'string' ? input.recipient : null;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Resolves a `name [ref]` or bare name against the caller's listed sessions. */
function resolveListed(name: string, ref: string | null, listed: readonly ListedSession[]): string | null {
  const byRef = ref ? listed.find((s) => s.sessionId === ref || `nassaj:${s.sessionId}` === ref) : undefined;
  if (byRef) return byRef.sessionId;
  const byTitle = listed.filter((s) => s.title !== null && s.title.trim() === name);
  return byTitle.length === 1 ? byTitle[0]!.sessionId : null;
}

/** Classifies one recipient string. */
export function classifyRecipient(recipient: string, ctx: ClassifyContext): RecipientClass {
  const nassaj = NASSAJ_ADDRESS.exec(recipient);
  if (nassaj) return { kind: 'relay', target: { sessionId: nassaj[1]! } };
  if (UDS_ADDRESS.test(recipient)) return { kind: 'relay', target: { unresolved: recipient } };
  const nameRef = NAME_REF_ADDRESS.exec(recipient);
  if (nameRef) {
    const resolved = resolveListed(nameRef[1]!.trim(), nameRef[2]!, ctx.listedSessions());
    return { kind: 'relay', target: resolved ? { sessionId: resolved } : { unresolved: recipient } };
  }
  if (recipient === 'main' || ctx.isKnownAgent(recipient)) return { kind: 'allow' };
  if (AGENT_ID_SHAPE.test(recipient)) return { kind: 'allow-audit' };
  const listed = resolveListed(recipient, null, ctx.listedSessions());
  if (listed) return { kind: 'relay', target: { sessionId: listed } };
  return { kind: 'deny', reason: 'unresolved_session_address' };
}
