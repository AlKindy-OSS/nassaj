/**
 * Test fixture: an instruction file ending in a correct `NASSAJ-INSTR-REV:` line,
 * computed like nassaj-core's build-agents rev_line (sha256 of everything above,
 * first 12 hex). `tier` null = the full file (no tag). Never pin a real sha.
 */
import crypto from 'node:crypto';

/** Body plus its REV line for `tier` (null = full file). */
export function withRev(body: string, tier: string | null): string {
  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `${body}NASSAJ-INSTR-REV: ${digest}${tier ? ` tier=${tier}` : ''}\n`;
}

/** The header line a genuine local32 file carries (nassaj-core build-agents). */
export const LOCAL_TIER_HEADER = '# AGENTS.local.md — Nassaj compact instructions (tier local32)';

/** A genuine local32 fixture: generated banner, header, body, tagged REV. */
export function localFixture(body: string): string {
  return withRev(`<!-- GENERATED (fixture) -->\n\n${LOCAL_TIER_HEADER}\n\n${body}`, 'local32');
}
