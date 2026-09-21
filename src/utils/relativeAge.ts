/**
 * relativeAge — one shared rendering of "how long ago", in seconds.
 *
 * Extracted from PendingActionsPanel (T-1684) so the history tab and the live
 * session lists read an age the same way. Kept outside both components because
 * neither owns it: it is a formatting rule, not view state.
 */

/** Render a duration in seconds as a localized short age ("14 د" / "9 s"). */
export function formatAge(
  ageS: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ageS < 60) return t('pendingActions.sessionAge_second', { seconds: Math.max(0, Math.floor(ageS)) });
  return t('pendingActions.sessionAge_minute', { minutes: Math.floor(ageS / 60) });
}
