/**
 * T-2083 — "ask a member to share" opens the agent's Account tab and brings
 * the grant section into view with focus, once it has rendered.
 * RUNNER: vitest (jsdom).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CREDENTIAL_GRANTS_SECTION_ID, revealSettingsSection } from './credentialGrantsAnchor';

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

function section() {
  const el = document.createElement('div');
  el.id = CREDENTIAL_GRANTS_SECTION_ID;
  el.tabIndex = -1;
  el.scrollIntoView = vi.fn();
  return el;
}

describe('revealSettingsSection', () => {
  it('waits for the section to render, then scrolls to it and focuses it', () => {
    vi.useFakeTimers();
    revealSettingsSection(CREDENTIAL_GRANTS_SECTION_ID);
    vi.advanceTimersByTime(100);
    const el = section();
    document.body.appendChild(el);
    vi.advanceTimersByTime(100);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(el);
  });

  it('keeps the section in view while the tab is still loading, until the user scrolls', () => {
    vi.useFakeTimers();
    const el = section();
    document.body.appendChild(el);
    revealSettingsSection(CREDENTIAL_GRANTS_SECTION_ID);
    vi.advanceTimersByTime(10);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100); // content above/below still settling
    const followed = (el.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(followed).toBeGreaterThan(1);
    window.dispatchEvent(new Event('wheel'));
    vi.advanceTimersByTime(5000);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(followed);
  });

  it('gives up quietly when the section never renders, and can be cancelled', () => {
    vi.useFakeTimers();
    const cancel = revealSettingsSection(CREDENTIAL_GRANTS_SECTION_ID);
    cancel();
    const el = section();
    document.body.appendChild(el);
    vi.advanceTimersByTime(5000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });
});
