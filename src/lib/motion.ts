/**
 * Returns true when the user has opted into reduced motion.
 *
 * Safe in every environment:
 *   - SSR / Node.js        : window is undefined  → false (no reduced motion assumed)
 *   - jsdom (test)         : window exists but matchMedia is missing → false
 *   - Real browser         : delegates to matchMedia as expected
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
