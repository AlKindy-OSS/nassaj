/**
 * platformKey.ts — one truthful label for the search shortcut.
 *
 * The wiki used to advertise the same shortcut two different ways on the same
 * screen: the index button printed a hard-coded `⌘K` and the landing page a
 * hard-coded `Ctrl K`. On any one machine at least one of them was a lie.
 *
 * `useWikiKeyboard` binds `ctrlKey || metaKey`, so both modifiers really do
 * work everywhere; what the label has to say is which one the reader's own
 * keyboard has. Only macOS prints the command glyph.
 */

type PlatformSource = {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
};

/**
 * True on macOS. `navigator.platform` is deprecated but is still the only
 * universally implemented signal, so the modern `userAgentData.platform` is
 * preferred and the old fields are the fallback chain. Anything unknown —
 * including a server render — answers "not a Mac", which yields the `Ctrl`
 * label: the safer wrong answer, since Ctrl+K is bound on macOS too.
 */
export function isMacPlatform(source?: PlatformSource): boolean {
  const nav =
    source ?? (typeof navigator === 'undefined' ? undefined : (navigator as PlatformSource));
  if (!nav) return false;
  const hint = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
  return /mac/i.test(hint);
}

/** Label for the "open search" shortcut, e.g. `⌘K` or `Ctrl K`. */
export function searchShortcutLabel(source?: PlatformSource): string {
  return isMacPlatform(source) ? '⌘K' : 'Ctrl K';
}
