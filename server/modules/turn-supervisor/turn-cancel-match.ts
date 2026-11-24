/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL), QA condition 3 — which active supervised
 * turn a stop may cancel. Shared by the hosted and CLI supervisors.
 *
 * The provider and starter checks are exactly the pre-existing ones (the starter
 * rule is tracked separately as B-1765). New: a stop that carries the clientMsgId
 * of the turn it means cancels nothing when another turn is active.
 */
export function isCancellableActiveTurn(
  active: { provider: string; userId: number; clientMsgId: string } | undefined,
  input: { provider: string; userId: number | null; clientMsgId?: string },
): boolean {
  if (!active || active.provider !== input.provider) return false;
  if (input.userId == null || active.userId !== input.userId) return false;
  return !input.clientMsgId || input.clientMsgId === active.clientMsgId;
}
