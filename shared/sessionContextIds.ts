/**
 * Shared session-id shape for the batched session-context lookup (B-1431 /
 * T-1949). One id failing this pattern 400s the WHOLE batch server-side
 * (`server/modules/projects/projects.routes.ts`'s `parseSessionContextIds`),
 * so the client filters against the SAME pattern before sending — a single
 * malformed candidate (e.g. a stray provider-prefixed or otherwise
 * differently-shaped id slipping into an indicator store) must not sink every
 * other id in the batch.
 */
export const SESSION_CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
