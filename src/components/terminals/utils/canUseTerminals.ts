/**
 * Terminals are an owner/admin surface (ADR-063 amend). The server enforces the
 * same role gate on REST and WS; the client uses this to avoid calling and
 * rendering a surface the user cannot use.
 */
export function canUseTerminals(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
