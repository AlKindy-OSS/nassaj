/**
 * Names the transcript removal primitive parks an entry under before it
 * unlinks it (session-transcript-removal.ts). Two forms are recognised, so a
 * name parked by either release is found again (B-1612 N2) and swept at boot
 * (B-1608 T2):
 *   - B-1596: `.<name>.nassaj-removing-<16 hex>` — carries the original name;
 *   - B-1613: `.nassaj-removing-<16 hex>` (33 bytes, NAME_MAX-safe, see
 *     `parkName` in session-transcript-removal.ts) — carries no name.
 * Only the shape is checked here; whether a parked file belongs to a session
 * is decided by pinning it and binding its content, never by this name.
 */

const LONG_FORM = /^\.(.+)\.nassaj-removing-[0-9a-f]{16}$/;
const SHORT_FORM = /^\.nassaj-removing-[0-9a-f]{16}$/;

/** The original name a B-1596 park name carries, `null` for a B-1613 short name, `undefined` for any other name. */
export function parkedOriginalOf(name: string): string | null | undefined {
  const long = LONG_FORM.exec(name);
  if (long) return long[1];
  return SHORT_FORM.test(name) ? null : undefined;
}

/** True for a name in either park form. */
export function isParkName(name: string): boolean {
  return parkedOriginalOf(name) !== undefined;
}
