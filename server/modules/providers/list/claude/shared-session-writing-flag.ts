/** ADR-173 kill switch for shared writing (resolver path and transcript bridge): on by default, '0' turns it off. */
export function isSharedSessionWritingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NASSAJ_SHARED_SESSION_WRITING !== '0';
}
