/** DOM id of the grant section on an agent's Account tab (T-2083 deep link target). */
export const CREDENTIAL_GRANTS_SECTION_ID = 'credential-grants-section';

const POLL_MS = 50;
const MAX_ATTEMPTS = 40;
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'] as const;

/**
 * Scrolls a settings section into view and focuses it once it has rendered.
 * The tab and its data mount after the settings dialog opens, so the element
 * may not exist yet, and sections around it keep growing as they load (a
 * scroll taken too early is clamped short). For about two seconds it keeps the
 * section in view, unless the user scrolls or types first. Returns a cancel
 * function.
 */
export function revealSettingsSection(id: string): () => void {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let element: HTMLElement | null = null;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    USER_SCROLL_EVENTS.forEach((type) => window.removeEventListener(type, stop, true));
  };
  const tick = () => {
    attempts += 1;
    if (!element) {
      element = document.getElementById(id);
      element?.focus({ preventScroll: true });
    }
    element?.scrollIntoView?.({ block: 'start' });
    if (attempts < MAX_ATTEMPTS) timer = setTimeout(tick, POLL_MS);
    else stop();
  };
  USER_SCROLL_EVENTS.forEach((type) => window.addEventListener(type, stop, true));
  timer = setTimeout(tick, 0);
  return stop;
}
